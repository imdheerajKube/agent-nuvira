/**
 * OpenAICompatAdapter — the generic OpenAI-compatible /v1 adapter (Issue 001).
 *
 * A single adapter serves EVERY catalog provider that speaks the OpenAI
 * `/v1/chat/completions` protocol: OpenAI, Mistral, Together, DeepInfra,
 * Fireworks, Perplexity, Azure OpenAI, LM Studio, Anyscale, vLLM/TGI,
 * DeepSeek, xAI, Replicate, the Nuvira gateway, OpenRouter, Groq, NIM — any
 * endpoint with a base URL + optional key. Provider-specific differences are
 * metadata, not code:
 *
 *   - baseUrl          — default endpoint (config.baseUrl overrides)
 *   - apiKeyHeader     — 'Authorization' (Bearer) or 'api-key' (Azure)
 *   - apiVersionQuery  — extra query string (Azure `api-version=...`)
 *   - providerId       — stable id used for cost tracking / reasoning cache
 *   - label            — display name
 *   - keyless          — no key needed (local runners, gateways)
 *
 * The behavior contract is inherited from the Nuvira Gateway adapter: shared
 * error-message classification (401/403→auth, 429→rate-limit, 5xx→server,
 * fetch→network, abort→timeout), wire-token cost metering (M2.2) when the
 * endpoint reports `usage`, reasoning caching (M4.2), and continuation retries
 * (M4.1) — so every OpenAI-compatible catalog provider learns through the SAME
 * failover/registry pipeline as the built-ins.
 */

import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { buildConversationKey, cacheReasoning } from '../learning/reasoning-cache.js';
import { getCatalogProvider } from './provider-catalog.js';

/** Metadata that differentiates one OpenAI-compatible provider from another. */
export interface OpenAICompatMeta {
  /** Stable provider id (cost tracking, reasoning cache, registry). */
  providerId: string;
  /** Human label (adapter `name`). */
  label: string;
  /** Default base URL (config.baseUrl overrides). */
  defaultBaseUrl: string;
  /** Auth header name — 'Authorization' (Bearer) or 'api-key' (Azure). */
  apiKeyHeader?: string;
  /** Extra query string appended to request URLs (Azure api-version). */
  apiVersionQuery?: string;
  /** No API key needed (local runners / gateways). */
  keyless?: boolean;
  /**
   * Azure OpenAI shape: chat lives at `/openai/deployments/{model}/chat/completions`
   * and the model list at `/openai/models` (the model id IS the deployment
   * name). When set, request URLs use the deployments path instead of the
   * plain `/chat/completions` convention.
   */
  azureDeployments?: boolean;
}

/** Fallback base URL for providers whose catalog entry lacks one. */
const FALLBACK_BASE_URL = 'http://127.0.0.1:8080/v1';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Normalize a base URL: strip trailing slashes, keep the /v1 suffix. */
function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const base = (raw || fallback).trim().replace(/\/+$/, '');
  return base;
}

/** Merge adapter-level extra headers (config.headers) — no header injection: keys are validated. */
function extraHeaders(config: ProviderConfig): Record<string, string> {
  const headers = (config as ProviderConfig & { headers?: Record<string, unknown> }).headers;
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    // Block header-injection vectors: no newlines/CR in keys or values.
    if (/[\r\n:]/.test(k)) continue;
    if (v !== undefined && v !== null && !/[\r\n]/.test(String(v))) {
      out[k] = String(v);
    }
  }
  return out;
}

/** Build the auth header for this provider (config key, or none when keyless). */
function buildAuthHeaders(meta: OpenAICompatMeta, config: ProviderConfig, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = apiKey || config.apiKey;
  if (!key) return headers;
  const header = meta.apiKeyHeader || 'Authorization';
  if (header.toLowerCase() === 'authorization') {
    headers[header] = `Bearer ${key}`;
  } else {
    headers[header] = key;
  }
  return headers;
}

/**
 * P4 M4.1: append a bounded continuation note to the prompt when retrying a
 * mid-stream failure.
 */
function withContinuation(prompt: string, options?: InferenceOptions): string {
  if (!options?.continuation) return prompt;
  return `${prompt}\n\n${options.continuation}`;
}

/**
 * P4 M4.2: build the messages array with an optional prior assistant
 * reasoning_content message.
 */
function buildMessages(prompt: string, options?: InferenceOptions): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (options?.reasoningContext) {
    messages.push({
      role: 'assistant',
      content: '',
      reasoning_content: options.reasoningContext,
    });
  }
  messages.push({ role: 'user', content: withContinuation(prompt, options) });
  return messages;
}

/** URL for a provider endpoint: base + path + optional api-version query. */
function endpointUrl(baseUrl: string, path: string, meta: OpenAICompatMeta): string {
  const q = meta.apiVersionQuery ? `?${meta.apiVersionQuery}` : '';
  return `${baseUrl}${path}${q}`;
}

/**
 * Chat-completions URL for a provider. Azure OpenAI hosts chat at
 * `/openai/deployments/{model}/chat/completions` (the model id is the
 * deployment name); every other OpenAI-compatible provider uses the plain
 * `/chat/completions` convention.
 */
function chatUrl(baseUrl: string, model: string, meta: OpenAICompatMeta): string {
  const q = meta.apiVersionQuery ? `?${meta.apiVersionQuery}` : '';
  if (meta.azureDeployments) {
    return `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions${q}`;
  }
  return `${baseUrl}/chat/completions${q}`;
}

/** Models-list URL for a provider (Azure: `/openai/models`). */
function modelsUrl(baseUrl: string, meta: OpenAICompatMeta): string {
  const q = meta.apiVersionQuery ? `?${meta.apiVersionQuery}` : '';
  return meta.azureDeployments ? `${baseUrl}/openai/models${q}` : `${baseUrl}/models${q}`;
}

export class OpenAICompatAdapter implements InferenceProvider {
  readonly name: string;
  private config: ProviderConfig;
  private baseUrl: string;
  private meta: OpenAICompatMeta;

  constructor(config: ProviderConfig, meta: OpenAICompatMeta) {
    this.config = config;
    this.meta = meta;
    this.name = meta.label;
    // Explicit catalog baseUrl wins over the adapter default; config.baseUrl
    // (user override) wins over both — resolved at construction.
    const catalogBase = getCatalogProvider(meta.providerId)?.baseUrl;
    this.baseUrl = normalizeBaseUrl(config.baseUrl || catalogBase || meta.defaultBaseUrl, FALLBACK_BASE_URL);
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || 'default';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`${this.meta.label}: Generating with model=${model} via ${this.baseUrl}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders(this.config),
      ...buildAuthHeaders(this.meta, this.config, options?.apiKey),
    };

    const response = await fetch(chatUrl(this.baseUrl, model, this.meta), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: buildMessages(prompt, options),
        temperature,
        max_tokens: maxTokens,
      }),
      // A dead endpoint should fail fast and let the shared failover walk move
      // on — never hang a pipeline for minutes. 30s generous cap; callers with
      // tighter needs set config.timeoutMs (enforced at the fetch layer).
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Status code in the message → classifyFallbackError buckets correctly.
      throw new Error(`${this.meta.label} API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content || '';
    if (!content && !data.choices) {
      throw new Error(`${this.meta.label} API error (empty response)`);
    }

    // Cost tracking (M2.2 wire-token metering): when the endpoint reports exact
    // `usage` we record MEASURED tokens; otherwise the length-based estimate.
    try {
      recordCallWithUsage(
        getCostTracker(),
        this.meta.providerId,
        model,
        prompt,
        content,
        data.usage
          ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
          : undefined,
      );
    } catch {
      // Non-critical.
    }

    return content;
  }

  async generateStream(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    const model = options?.model || this.config.model || 'default';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`${this.meta.label}: Streaming with model=${model} via ${this.baseUrl}`);

    const headers: Record<string, string> = {
      ...extraHeaders(this.config),
      ...buildAuthHeaders(this.meta, this.config, options?.apiKey),
    };

    // NOTE: streamCompletion takes no signal, so timeoutMs applies to the
    // non-streaming path only (documented asymmetry, inherited behavior).
    // M2.2: the final SSE chunk may carry the endpoint's `usage` — capture it
    // for MEASURED cost recording over the estimate.
    // P4 M4.2: reasoning deltas are captured and cached per (provider, model,
    // conversation) so a retry to this provider can re-inject them.
    let streamUsage: { promptTokens?: number; completionTokens?: number } | undefined;
    const reasoningChunks: string[] = [];
    const conversationKey = buildConversationKey([{ role: 'user', content: prompt }]);
    const fullContent = await streamCompletion(
      chatUrl(this.baseUrl, model, this.meta),
      headers,
      { model, messages: buildMessages(prompt, options), temperature, max_tokens: maxTokens },
      onToken,
      (u) => {
        streamUsage = u;
      },
      (r) => {
        reasoningChunks.push(r);
      },
    );

    // Best-effort: persist the reasoning for M4.2 replay on a later retry.
    if (reasoningChunks.length > 0) {
      try {
        cacheReasoning({
          provider: this.meta.providerId,
          model,
          conversationKey,
          reasoningContent: reasoningChunks.join(''),
        });
      } catch {
        // Non-critical.
      }
    }

    try {
      recordCallWithUsage(getCostTracker(), this.meta.providerId, model, prompt, fullContent, streamUsage);
    } catch {
      // Non-critical.
    }

    return fullContent;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const headers = {
        ...extraHeaders(this.config),
        ...buildAuthHeaders(this.meta, this.config),
      };
      const response = await fetch(modelsUrl(this.baseUrl, this.meta), {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): string {
    return [
      `Provider: ${this.meta.label} (OpenAI-compatible)`,
      `Base URL: ${this.baseUrl}`,
      `Model: ${this.config.model || 'default'}`,
    ].join('\n');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const headers = {
        ...extraHeaders(this.config),
        ...buildAuthHeaders(this.meta, this.config),
      };
      const response = await fetch(modelsUrl(this.baseUrl, this.meta), {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };
      // Empty /models is a valid "nothing listed" state — not an error.
      return (data.data || []).map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id,
        provider: this.meta.providerId,
        owner: m.owned_by || this.meta.providerId,
        tags: getModelTags(m.id, m.owned_by),
      }));
    } catch {
      return [];
    }
  }
}
