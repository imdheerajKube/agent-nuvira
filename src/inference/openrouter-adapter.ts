import { InferenceProvider, ModelDescriptor, ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { chatCompletionsWithTools, chatCompletionsWithToolsStream } from './tools.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Common small models on OpenRouter that have low max_tokens.
 * OpenRouter exposes hundreds of models; for safety, we only cap known
 * small ones (≤2B params) and leave the default (4096) for larger models.
 */
const OPENROUTER_LOW_OUTPUT_MODELS: RegExp[] = [
  /gemma-?2-?[12]b/i,
  /gemma-?3-?1b/i,
  /llama-?3[._-]?2-?[12]b/i,
  /phi-?3-mini/i,
  /qwen-?2-?0.5b/i,
  /tinyllama/i,
  /starcoderbase/i,
];

/** Cap max_tokens for known small models on OpenRouter. */
function openRouterModelMaxTokens(model: string): number {
  if (OPENROUTER_LOW_OUTPUT_MODELS.some((rx) => rx.test(model))) return 1024;
  return 4096;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** OpenRouter's exact USD cost for this call (credits). */
  cost?: number;
}

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string };
  }>;
  usage?: OpenRouterUsage;
  /** Some responses mirror the request cost at the top level instead. */
  cost?: number;
}

/**
 * The exact cost OpenRouter billed for a call, when it reported one.
 *
 * This is authoritative: it already accounts for the account's credits, the
 * model's real price (including `:free` ids), and any discount — so we record
 * it verbatim instead of charging our generic per-provider rate. Returning
 * `undefined` (not 0) keeps "no cost reported" distinct from "cost is zero".
 */
function openRouterReportedCost(usage?: OpenRouterUsage, body?: { cost?: number }): number | undefined {
  const candidates = [usage?.cost, body?.cost];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return undefined;
}

/**
 * OpenRouter Adapter
 * Routes requests through OpenRouter's multi-provider API
 */
export class OpenRouterAdapter implements InferenceProvider {
  readonly name = 'OpenRouter';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      openRouterModelMaxTokens(model),
    );

    logger.debug(`OpenRouter: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/buff-cli/buff',
        'X-Title': 'Buff CLI',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const content = data.choices[0]?.message?.content || '';

    // Track cost — M2.2: prefer OpenRouter's own measured usage and its exact
    // reported `cost`; fall back to a length-based estimate only when the
    // response carried neither.
    try {
      const usage = data.usage;
      recordCallWithUsage(
        getCostTracker(),
        'openrouter',
        model,
        prompt,
        content,
        usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
          ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
          : undefined,
        openRouterReportedCost(usage, data),
      );
    } catch { /* Non-critical */ }

    return content;
  }

  /** H1 — native tool-calling via the OpenAI `tools` protocol. */
  async generateTools(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options?: InferenceOptions,
  ): Promise<ToolCallResponse> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
    const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
    return chatCompletionsWithTools({
      baseUrl: OPENROUTER_BASE_URL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/buff-cli/buff',
        'X-Title': 'Buff CLI',
      },
      model,
      messages,
      tools,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7,
      maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model)),
      timeoutMs: this.config.timeoutMs ?? 30_000,
      // P4 — external cancellation (the dashboard Cancel button).
      signal: options?.signal,
      // Cost parity with generate(): meter tool-calling turns too. The third
      // arg carries the endpoint's usage (and OpenRouter's reported cost) when
      // the helper captured it — otherwise this records an estimate.
      onCost: (promptText, contentText, usage) => {
        try {
          recordCallWithUsage(getCostTracker(), 'openrouter', model, promptText, contentText, usage);
        } catch {
          // Non-critical.
        }
      },
    });
  }

  /**
   * P4 — streaming native tool-calling: same wire protocol as generateTools
   * with `stream: true`; content tokens delivered to onToken as they arrive.
   */
  async generateToolsStream(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<ToolCallResponse> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
    const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
    return chatCompletionsWithToolsStream(
      {
        baseUrl: OPENROUTER_BASE_URL,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/buff-cli/buff',
          'X-Title': 'Buff CLI',
        },
        model,
        messages,
        tools,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, openRouterModelMaxTokens(model)),
        timeoutMs: this.config.timeoutMs ?? 30_000,
        // P4 — external cancellation (the dashboard Cancel button).
        signal: options?.signal,
        // Cost parity with generate(): meter tool-calling turns too. The third
        // arg carries the endpoint's usage (and OpenRouter's reported cost)
        // captured from the final SSE chunk.
        onCost: (promptText, contentText, usage) => {
          try {
            recordCallWithUsage(getCostTracker(), 'openrouter', model, promptText, contentText, usage);
          } catch {
            // Non-critical.
          }
        },
      },
      onToken,
    );
  }

  async generateStream(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured. Set OPENROUTER_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'mistralai/mistral-7b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      openRouterModelMaxTokens(model),
    );

    logger.debug(`OpenRouter: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    // M2.2: capture the endpoint-reported usage (and OpenRouter's `cost`) from
    // the final SSE chunk when present. `usage: { include: true }` asks
    // OpenRouter to emit it for streams — other OpenAI-compatible endpoints
    // ignore the field.
    let streamUsage: { promptTokens: number; completionTokens: number; costUsd?: number } | undefined;

    // OpenRouter uses OpenAI-compatible streaming SSE, same as Groq/NIM
    const fullContent = await streamCompletion(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/buff-cli/buff',
        'X-Title': 'Buff CLI',
      },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens, usage: { include: true } },
      onToken,
      (u) => { streamUsage = u; },
    );

    // Track cost for streaming response — measured usage + reported cost when
    // the stream carried them, estimate otherwise.
    try {
      recordCallWithUsage(getCostTracker(), 'openrouter', model, prompt, fullContent, streamUsage);
    } catch { /* Non-critical */ }

    return fullContent;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: OpenRouter\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];
      // OpenRouter's /models exposes each model's `context_length` — carry it
      // so the registry records the LIVE advertised window for preflight.
      const data = (await response.json()) as {
        data: Array<{ id: string; name?: string; description?: string; context_length?: number }>;
      };
      return (data.data || []).map((m: { id: string; name?: string; description?: string; context_length?: number }) => {
        const ctx = typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined;
        return {
          id: m.id,
          name: m.name || m.id,
          provider: 'openrouter',
          description: m.description,
          tags: getModelTags(m.id),
          ...(ctx !== undefined ? { contextWindowTokens: ctx } : {}),
        };
      });
    } catch {
      return [];
    }
  }
}
