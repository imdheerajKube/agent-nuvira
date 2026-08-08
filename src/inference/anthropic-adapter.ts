/**
 * AnthropicAdapter — native Anthropic Messages API adapter (Issue 001).
 *
 * Anthropic does NOT speak the OpenAI /v1/chat/completions protocol, so it
 * gets a small native adapter instead of the shared OpenAICompatAdapter:
 *
 *   POST https://api.anthropic.com/v1/messages
 *     headers: x-api-key, anthropic-version: 2023-06-01, content-type
 *     body:    { model, max_tokens, system?, messages: [{role, content}] }
 *
 * Streaming uses Anthropic's event-stream protocol (content_block_delta →
 * text_delta). Wire-token usage comes from the final message_delta event
 * (M2.2 measured cost) and input_tokens/output_tokens on non-stream responses.
 *
 * Error mapping keeps the shared classification contract (the message text is
 * what classifyFallbackError buckets): 401/403→auth, 429→rate-limit,
 * 5xx→server, fetch→network, abort→timeout.
 */

import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Parse an Anthropic SSE line → text delta (content_block_delta) or null. */
function parseAnthropicSSE(line: string): { text?: string; usage?: { inputTokens?: number; outputTokens?: number } } | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      return { text: parsed.delta.text };
    }
    if (parsed.type === 'message_delta' && parsed.usage) {
      return {
        usage: { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens },
      };
    }
    // Some gateways mirror the request body's usage on a final message event.
    if (parsed.type === 'message_stop' && parsed.message?.usage) {
      return {
        usage: { inputTokens: parsed.message.usage.input_tokens, outputTokens: parsed.message.usage.output_tokens },
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class AnthropicAdapter implements InferenceProvider {
  readonly name = 'Anthropic';
  private config: ProviderConfig;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.baseUrl = (config.baseUrl || ANTHROPIC_BASE_URL).trim().replace(/\/+$/, '');
  }

  private headers(apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const key = apiKey || this.config.apiKey;
    if (key) headers['x-api-key'] = key;
    return headers;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || 'default';
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    logger.debug(`Anthropic: Generating with model=${model} via ${this.baseUrl}`);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(options?.apiKey),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicMessageResponse;
    const content = (data.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join('');
    if (!content) {
      throw new Error('Anthropic API error (empty response)');
    }

    try {
      recordCallWithUsage(
        getCostTracker(),
        'anthropic',
        model,
        prompt,
        content,
        data.usage
          ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
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
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    logger.debug(`Anthropic: Streaming with model=${model} via ${this.baseUrl}`);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(options?.apiKey),
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Anthropic API error (no readable stream)');

    const decoder = new TextDecoder();
    const fullContent: string[] = [];
    let buffer = '';
    let streamUsage: { inputTokens?: number; outputTokens?: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseAnthropicSSE(line.trim());
          if (!parsed) continue;
          if (parsed.text) {
            fullContent.push(parsed.text);
            onToken(parsed.text);
          }
          if (parsed.usage) streamUsage = parsed.usage;
        }
      }
      const remaining = buffer.trim();
      if (remaining) {
        const parsed = parseAnthropicSSE(remaining);
        if (parsed?.text) {
          fullContent.push(parsed.text);
          onToken(parsed.text);
        }
        if (parsed?.usage) streamUsage = parsed.usage;
      }
    } finally {
      reader.releaseLock();
    }

    try {
      recordCallWithUsage(getCostTracker(), 'anthropic', model, prompt, fullContent.join(''), streamUsage
        ? { promptTokens: streamUsage.inputTokens, completionTokens: streamUsage.outputTokens }
        : undefined);
    } catch {
      // Non-critical.
    }

    return fullContent.join('');
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getInfo(): string {
    return [
      'Provider: Anthropic (native Messages API)',
      `Base URL: ${this.baseUrl}`,
      `Model: ${this.config.model || 'default'}`,
    ].join('\n');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
      return (data.data || []).map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        provider: 'anthropic',
        owner: 'anthropic',
        tags: ['chat', 'code', 'reasoning'],
      }));
    } catch {
      return [];
    }
  }
}
