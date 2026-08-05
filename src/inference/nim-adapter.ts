import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';

const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

interface NIMResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * NVIDIA NIM Adapter
 * Connects to NVIDIA NIM OpenAI-compatible API
 */
export class NIMAdapter implements InferenceProvider {
  readonly name = 'NVIDIA NIM';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    // M2.3: options.apiKey overrides the configured key (multi-account rotation).
    const apiKey = options?.apiKey || this.config.apiKey;
    if (!apiKey) {
      throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`NIM: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
    const url = `${baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
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
      throw new Error(`NVIDIA NIM API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as NIMResponse;
    const content = data.choices[0]?.message?.content || '';

    // Track cost — M2.2: use the endpoint-reported usage (exact wire tokens)
    // when present, else the length-based estimate.
    try {
      const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      recordCallWithUsage(
        getCostTracker(),
        'nim',
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
      throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`NIM: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;

    // M2.2: capture the endpoint-reported usage from the final SSE chunk
    // (OpenAI stream_options.include_usage convention) for measured cost.
    let streamUsage: { promptTokens?: number; completionTokens?: number } | undefined;
    const fullContent = await streamCompletion(
      `${baseUrl}/chat/completions`,
      { 'Authorization': `Bearer ${apiKey}` },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
      (u) => {
        streamUsage = u;
      },
    );

    // Track cost for streaming response
    try {
      recordCallWithUsage(getCostTracker(), 'nim', model, prompt, fullContent, streamUsage);
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
    return `Provider: NVIDIA NIM\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Primary-key probe by design (see isAvailable): the model list is shared
    // across accounts of the same provider.
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
      return (data.data || []).map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id.split('/').pop() || m.id,
        provider: 'nim',
        owner: m.owned_by || 'nvidia',
        tags: getModelTags(m.id, m.owned_by),
      }));
    } catch {
      return [];
    }
  }
}
