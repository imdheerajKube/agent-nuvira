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
import { getCostTracker } from '../learning/cost-tracker.js';

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
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
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

    // Cost tracking (best-effort, estimate-based like every adapter). Exact
    // wire-token metering from the gateway's `usage` field is a P3 milestone;
    // the per-action registry/ledger attribution flows through the caller's
    // recordCall telemetry, so the adapter only needs the estimate here.
    try {
      const costTracker = getCostTracker();
      costTracker.recordCallEstimated('nuvira', model, prompt, content);
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
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // NOTE: streamCompletion takes no signal, so timeoutMs applies to the
    // non-streaming path only (the shared SSE reader drives streaming and a
    // stalled idle stream is surfaced by the caller's read timeout). Documented
    // asymmetry — threading a signal through streamCompletion is a P1 follow-up.
    const fullContent = await streamCompletion(
      `${this.baseUrl}/chat/completions`,
      headers,
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
    );

    try {
      const costTracker = getCostTracker();
      costTracker.recordCallEstimated('nuvira', model, prompt, fullContent);
    } catch {
      // Non-critical.
    }

    return fullContent;
  }

  async isAvailable(): Promise<boolean> {
    // A gateway is "available" when it answers /models (short timeout). No
    // key required — local gateways often run keyless.
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
