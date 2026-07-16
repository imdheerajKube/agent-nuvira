import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string };
  }>;
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
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

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

    // Track cost
    try {
      getCostTracker().recordCallEstimated('openrouter', model, prompt, content);
    } catch { /* Non-critical */ }

    return content;
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
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`OpenRouter: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    // OpenRouter uses OpenAI-compatible streaming SSE, same as Groq/NIM
    const fullContent = await streamCompletion(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/buff-cli/buff',
        'X-Title': 'Buff CLI',
      },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
    );

    // Track cost for streaming response
    try {
      getCostTracker().recordCallEstimated('openrouter', model, prompt, fullContent);
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
      const data = (await response.json()) as { data: Array<{ id: string; name?: string; description?: string }> };
      return (data.data || []).map((m: { id: string; name?: string; description?: string }) => ({
        id: m.id,
        name: m.name || m.id,
        provider: 'openrouter',
        description: m.description,
        tags: getModelTags(m.id),
      }));
    } catch {
      return [];
    }
  }
}
