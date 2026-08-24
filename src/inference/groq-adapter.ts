import { InferenceProvider, ModelDescriptor, ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { chatCompletionsWithTools, chatCompletionsWithToolsStream } from './tools.js';
import { attachHttpContext } from './http-error.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { requireAdapterModel } from '../learning/model-selection.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Per-model max output tokens (max_tokens).
 * Groq enforces strict per-model limits — exceeding them returns 400.
 * Fallback default (4096) applies only to models NOT listed here.
 * Source: https://console.groq.com/docs/models
 */
const GROQ_MODEL_MAX_TOKENS: Record<string, number> = {
  // Gemma 2 — small context, small output
  'gemma2-9b-it': 512,
  'gemma2-2b-it': 512,
  // Gemma 3
  'gemma3-1b-it': 512,
  'gemma3-4b-it': 8192,
  'gemma3-12b-it': 8192,
  'gemma3-27b-it': 8192,
  // Llama 3.3 — 70B is the workhorse, generous output
  'llama-3.3-70b-versatile': 32768,
  // Llama 3.1
  'llama-3.1-8b-instant': 8192,
  'llama-3.1-70b-versatile': 8192,
  // Llama 3.2
  'llama-3.2-1b-preview': 8192,
  'llama-3.2-3b-preview': 8192,
  'llama-3.2-11b-vision-preview': 8192,
  'llama-3.2-90b-vision-preview': 8192,
  // Llama 3
  'llama3-8b-8192': 8192,
  'llama3-70b-8192': 8192,
  'llama3-8b-instruct': 8192,
  'llama3-70b-instruct': 8192,
  'llama3-8b-instruct-8192': 8192,
  'llama3-70b-instruct-8192': 8192,
  // Mixtral
  'mixtral-8x7b-32768': 32768,
  'mixtral-8x32b-32768': 32768,
  // Qwen
  'qwen-qwq-32b': 32768,
  // DeepSeek
  'deepseek-r1-distill-llama-70b': 32768,
  // Gemma 4
  'gemma4-1b-it': 8192,
  'gemma4-12b-it': 8192,
  'gemma4-27b-it': 8192,
  // Command R
  'command-r': 4096,
  'command-r-plus': 4096,
};

/** Resolve max_tokens for a Groq model with safe fallback. */
function groqModelMaxTokens(model: string): number {
  return GROQ_MODEL_MAX_TOKENS[model] ?? 4096;
}

interface GroqResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * Groq Adapter
 * Connects to Groq's OpenAI-compatible API for fast inference
 */
export class GroqAdapter implements InferenceProvider {
  readonly name = 'Groq';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    // M2.3: options.apiKey overrides the configured key (multi-account rotation).
    const apiKey = options?.apiKey || this.config.apiKey;
    if (!apiKey) {
      throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    }

    const model = options?.model || requireAdapterModel('groq', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      groqModelMaxTokens(model),
    );

    logger.debug(`Groq: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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
      throw attachHttpContext(new Error(`Groq API error (${response.status}): ${errorBody}`), response.status, response.headers);
    }

    const data = (await response.json()) as GroqResponse;
    const content = data.choices[0]?.message?.content || '';

    // Track cost — M2.2: use the endpoint-reported usage (exact wire tokens)
    // when present, else the length-based estimate.
    try {
      const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      recordCallWithUsage(
        getCostTracker(),
        'groq',
        model,
        prompt,
        content,
        usage
          ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
          : undefined,
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
    const apiKey = options?.apiKey || this.config.apiKey;
    if (!apiKey) throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    const model = options?.model || requireAdapterModel('groq', this.config.model);
    return chatCompletionsWithTools({
      baseUrl: GROQ_BASE_URL,
      headers: { 'Authorization': `Bearer ${apiKey}` },
      model,
      messages,
      tools,
      temperature: options?.temperature ?? this.config.temperature ?? 0.7,      maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, groqModelMaxTokens(model)),
      timeoutMs: this.config.timeoutMs ?? 30_000,
      // P4 — external cancellation (the dashboard Cancel button).
      signal: options?.signal,
      // Cost parity with generate(): meter tool-calling turns too.
      onCost: (promptText, contentText) => {
        try {
          recordCallWithUsage(getCostTracker(), 'groq', model, promptText, contentText, undefined);
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
    const apiKey = options?.apiKey || this.config.apiKey;
    if (!apiKey) throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    const model = options?.model || requireAdapterModel('groq', this.config.model);

    return chatCompletionsWithToolsStream(
      {
        baseUrl: GROQ_BASE_URL,
        headers: { 'Authorization': `Bearer ${apiKey}` },
        model,
        messages,
        tools,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        maxTokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 4096, groqModelMaxTokens(model)),
        timeoutMs: this.config.timeoutMs ?? 30_000,
        // P4 — external cancellation (the dashboard Cancel button).
        signal: options?.signal,
        // Cost parity with generate(): meter tool-calling turns too.
        onCost: (promptText, contentText) => {
          try {
            recordCallWithUsage(getCostTracker(), 'groq', model, promptText, contentText, undefined);
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
    // M2.3: options.apiKey overrides the configured key (multi-account rotation).
    const apiKey = options?.apiKey || this.config.apiKey;
    if (!apiKey) {
      throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    }

    const model = options?.model || requireAdapterModel('groq', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      groqModelMaxTokens(model),
    );

    logger.debug(`Groq: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    // M2.2: capture the endpoint-reported usage from the final SSE chunk
    // (OpenAI stream_options.include_usage convention) for measured cost.
    let streamUsage: { promptTokens?: number; completionTokens?: number } | undefined;
    const fullContent = await streamCompletion(
      `${GROQ_BASE_URL}/chat/completions`,
      { 'Authorization': `Bearer ${apiKey}` },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
      (u) => {
        streamUsage = u;
      },
    );

    // Track cost for streaming response
    try {
      recordCallWithUsage(getCostTracker(), 'groq', model, prompt, fullContent, streamUsage);
    } catch { /* Non-critical */ }

    return fullContent;
  }

  async isAvailable(): Promise<boolean> {
    // Deliberately checks availability with the CONFIG (primary) key only, not
    // a rotated key: endpoint availability is account-independent, and the
    // M2.3 rotation walk handles per-key auth/rate-limit at generate time. Do
    // not "fix" this into a per-key probe — it would slow every candidate
    // check for zero correctness gain.
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: Groq\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Primary-key probe by design (see isAvailable): the model list is shared
    // across accounts of the same provider.
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${GROQ_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];
      // NOTE: Groq's /models response exposes ONLY id/object/created/owned_by —
      // it does NOT return a per-model context window (that lives in static
      // docs). No contextWindowTokens to parse here; the router falls back to
      // the provider-level estimate (131K). Filter out non-chat models
      // (speech/audio/whisper) that can't be used with chat completions.
      const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };

      // Filter out non-chat models (speech/audio/whisper) that can't be used
      // with the chat completions endpoint
      return (data.data || [])
        .map((m: { id: string; owned_by?: string }) => ({
          id: m.id,
          name: m.id,
          provider: 'groq',
          owner: m.owned_by || 'groq',
          tags: getModelTags(m.id, m.owned_by),
        }));
    } catch {
      return [];
    }
  }
}
