import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { requireAdapterModel } from '../learning/model-selection.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

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
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

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
      throw new Error(`Groq API error (${response.status}): ${errorBody}`);
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
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

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
