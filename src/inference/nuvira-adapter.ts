/**
 * Nuvira Gateway Adapter — OpenAI-compatible provider (Nuvira-Router P1 M1.1).
 *
 * Talks to ANY OpenAI-compatible /v1 endpoint — an enterprise gateway, a
 * self-hosted router, vLLM, LM Studio, LiteLLM, or a future `buff nuvira
 * serve` central mode (M6.4). This is the "unified endpoint" done safely:
 * the adapter is the ONLY surface a gateway needs, and because it implements
 * the same InferenceProvider interface as the built-ins, every existing
 * capability applies with zero changes: auto routing, the model-availability
 * registry, per-action "learned from real usage" telemetry, the quota ledger,
 * the failover walk, `models status`, and the dashboard.
 *
 * Config (ProviderConfig, already has baseUrl):
 *   baseUrl   — gateway base, default http://127.0.0.1:20128/v1
 *   apiKey    — optional (many local gateways need none)
 *   model     — default model id
 *   extraHeaders are merged via configManager at creation time (M1.2 wires
 *   the field; the adapter reads config.headers when present).
 *
 * Error mapping keeps the shared classification contract (the message text is
 * what classifyFallbackError buckets): 401/403→auth, 429→rate-limit,
 * 5xx→server, fetch/network→network, abort/timeout→timeout. A dead gateway
 * therefore learns through the SAME pipeline as any provider — it gets parked
 * or blocked predictively, never failed into repeatedly.
 */

import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { buildConversationKey, cacheReasoning } from '../learning/reasoning-cache.js';

const DEFAULT_NUVIRA_BASE_URL = 'http://127.0.0.1:20128/v1';

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
function normalizeBaseUrl(raw: string | undefined): string {
  const base = (raw || DEFAULT_NUVIRA_BASE_URL).trim().replace(/\/+$/, '');
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

/**
 * P4 M4.1: append a bounded continuation note to the prompt when retrying a
 * mid-stream failure. Builds the note lazily (the partial output is the caller's
 * already-streamed text) so a caller that only carries a partial string can pass
 * it directly via options.continuation OR via the partial-output convenience.
 */
function withContinuation(prompt: string, options?: InferenceOptions): string {
  if (!options?.continuation) return prompt;
  return `${prompt}\n\n${options.continuation}`;
}

/**
 * P4 M4.2: build the messages array with an optional prior assistant
 * reasoning_content message. Strict reasoning providers 400 on a conversation
 * that omits the reasoning that produced a prior turn — replaying it (from
 * the reasoning cache) makes the retry acceptable.
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

export class NuviraAdapter implements InferenceProvider {
  readonly name = 'Nuvira Gateway';
  private config: ProviderConfig;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || 'default';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`Nuvira: Generating with model=${model} via ${this.baseUrl}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extraHeaders(this.config),
    };
    // M2.3: options.apiKey overrides the configured key (multi-account rotation).
    const apiKey = options?.apiKey || this.config.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: buildMessages(prompt, options),
        temperature,
        max_tokens: maxTokens,
      }),
      // A dead gateway should fail fast and let the shared failover walk move
      // on — never hang a pipeline for minutes. 30s generous cap; callers with
      // tighter needs set config.timeoutMs (enforced at the fetch layer).
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Status code in the message → classifyFallbackError buckets correctly.
      throw new Error(`Nuvira API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content || '';
    if (!content && !data.choices) {
      throw new Error('Nuvira API error (empty response)');
    }

    // Cost tracking (M2.2 wire-token metering): when the gateway reports exact
    // `usage` in the response we record MEASURED tokens (cost from real wire
    // counts × pricing, flagged measured in the dashboard + routing scoring);
    // otherwise fall back to the length-based estimate.
    try {
      recordCallWithUsage(
        getCostTracker(),
        'nuvira',
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

    logger.debug(`Nuvira: Streaming with model=${model} via ${this.baseUrl}`);

    const headers: Record<string, string> = {
      ...extraHeaders(this.config),
    };
    // M2.3: options.apiKey overrides the configured key (multi-account rotation).
    const apiKey = options?.apiKey || this.config.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // NOTE: streamCompletion takes no signal, so timeoutMs applies to the
    // non-streaming path only (the shared SSE reader drives streaming and a
    // stalled idle stream is surfaced by the caller's read timeout). Documented
    // asymmetry — threading a signal through streamCompletion is a P1 follow-up.
    // M2.2: the final SSE chunk may carry the gateway's `usage` — capture it
    // for MEASURED cost recording (exact wire tokens) over the estimate.
    // P4 M4.2: reasoning deltas are captured and cached per (provider, model,
    // conversation) so a retry to this provider can re-inject them.
    let streamUsage: { promptTokens?: number; completionTokens?: number } | undefined;
    const reasoningChunks: string[] = [];
    const conversationKey = buildConversationKey([{ role: 'user', content: prompt }]);
    const fullContent = await streamCompletion(
      `${this.baseUrl}/chat/completions`,
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
          provider: 'nuvira',
          model,
          conversationKey,
          reasoningContent: reasoningChunks.join(''),
        });
      } catch {
        // Non-critical.
      }
    }

    try {
      recordCallWithUsage(getCostTracker(), 'nuvira', model, prompt, fullContent, streamUsage);
    } catch {
      // Non-critical.
    }

    return fullContent;
  }

  async isAvailable(): Promise<boolean> {
    // A gateway is "available" when it answers /models (short timeout). No
    // key required — local gateways often run keyless. Deliberately probes
    // with the CONFIG (primary) key, not a rotated one: endpoint availability
    // is account-independent, and the M2.3 rotation walk handles per-key
    // auth/rate-limit at generate time.
    try {
      const headers = extraHeaders(this.config);
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      const response = await fetch(`${this.baseUrl}/models`, {
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
      'Provider: Nuvira Gateway (OpenAI-compatible)',
      `Base URL: ${this.baseUrl}`,
      `Model: ${this.config.model || 'default'}`,
    ].join('\n');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Primary-key probe by design (see isAvailable): the model list is shared
    // across accounts of the same provider.
    try {
      const headers = extraHeaders(this.config);
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      const response = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> };
      // Empty /models is a valid "nothing listed" state — not an error.
      return (data.data || []).map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id,
        provider: 'nuvira',
        owner: m.owned_by || 'nuvira',
        tags: getModelTags(m.id, m.owned_by),
      }));
    } catch {
      return [];
    }
  }
}
