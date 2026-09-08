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
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { getCostTracker, recordCallWithUsage } from '../learning/cost-tracker.js';
import { attachHttpContext } from './http-error.js';
import {
  toAnthropicMessages,
  toAnthropicToolDefs,
  parseAnthropicToolResponse,
  AnthropicToolStreamAccumulator,
} from './native-tools.js';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Per-model max_tokens for Anthropic. Claude 3 Haiku has a 8192 limit;
 * Claude 3.5 Sonnet/Opus support higher. Fallback 4096.
 */
function anthropicModelMaxTokens(model: string): number {
  if (/haiku/i.test(model)) return 8192;
  if (/sonnet|opus/i.test(model)) return 8192;
  return 4096;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Response shape for tool-calling calls (re-exported alias for readability). */
type AnthropicToolResponseShape = import('./native-tools.js').AnthropicToolResponse;

/** Flatten a thread's text content for cost metering (best-effort estimate). */
function promptDigest(messages: ToolMessage[]): string {
  return messages.map((m) => m.content).filter(Boolean).join('\n');
}

/**
 * Feed one raw SSE line into the tool-stream accumulator. Returns the text
 * delta to stream (or null). Non-data lines and [DONE] are ignored; malformed
 * JSON lines are dropped (the stream self-heals on the next event).
 */
function consumeAnthropicToolSSE(
  accumulator: import('./native-tools.js').AnthropicToolStreamAccumulator,
  line: string,
): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return accumulator.consume(JSON.parse(data) as object);
  } catch {
    return null;
  }
}

/** Parse an Anthropic SSE line → text delta (content_block_delta) or null. */
function parseAnthropicSSE(line: string): { text?: string; usage?: { inputTokens?: number; outputTokens?: number } } | null {  if (!line.startsWith('data: ')) return null;
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
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      anthropicModelMaxTokens(model),
    );
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
      throw attachHttpContext(new Error(`Anthropic API error (${response.status}): ${errorBody}`), response.status, response.headers);
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
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      anthropicModelMaxTokens(model),
    );
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
      throw attachHttpContext(new Error(`Anthropic API error (${response.status}): ${errorBody}`), response.status, response.headers);
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

  // ─── Phase 1.2 — native tool calling (Anthropic Messages tool use) ───────
  //
  // The assessment (Addendum v2 §D.3) found anthropic riding the JSON
  // fallback ("0 generateTools matches") and marked native function-calling
  // BLOCKING for loop-default. This implements the Messages tool-use
  // protocol: system → top-level `system`, tool results → tool_result blocks
  // merged into the following user message, tools → tools[{input_schema}].
  // Wire mapping, parsing, and the streaming accumulator live in
  // native-tools.ts — this method is a thin fetch. Cost parity with
  // generate(): recordCallWithUsage on both paths.
  async generateTools(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options?: InferenceOptions,
  ): Promise<ToolCallResponse> {
    const model = options?.model || this.config.model || 'default';
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      anthropicModelMaxTokens(model),
    );
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    const { system, messages: wireMessages } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: wireMessages,
      tools: toAnthropicToolDefs(tools),
    };
    if (system) body.system = system;

    logger.debug(`Anthropic: Tool-calling with model=${model}, tools=${tools.length} via ${this.baseUrl}`);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(options?.apiKey),
      body: JSON.stringify(body),
      signal: options?.signal ?? AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw attachHttpContext(
        new Error(`Anthropic tool-calling API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }

    const data = (await response.json()) as AnthropicToolResponseShape;
    const result = parseAnthropicToolResponse(data);

    try {
      recordCallWithUsage(
        getCostTracker(),
        'anthropic',
        model,
        promptDigest(messages),
        result.content,
        data.usage
          ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
          : undefined,
      );
    } catch {
      // Non-critical.
    }

    return result;
  }

  /**
   * P4/Phase 1.2 — streaming native tool-calling: same protocol with
   * `stream: true`; text deltas stream to onToken, tool_use blocks
   * accumulate from content_block_start + input_json_delta fragments via
   * the shared accumulator and finalize at message_stop.
   */
  async generateToolsStream(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<ToolCallResponse> {
    const model = options?.model || this.config.model || 'default';
    const maxTokens = Math.min(
      options?.maxTokens ?? this.config.maxTokens ?? 4096,
      anthropicModelMaxTokens(model),
    );
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    const { system, messages: wireMessages } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      messages: wireMessages,
      tools: toAnthropicToolDefs(tools),
    };
    if (system) body.system = system;

    logger.debug(`Anthropic: Streaming tool-calling with model=${model}, tools=${tools.length} via ${this.baseUrl}`);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(options?.apiKey),
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw attachHttpContext(
        new Error(`Anthropic streaming tool-calling API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Anthropic API error (no readable stream)');

    const decoder = new TextDecoder();
    let buffer = '';
    const accumulator = new AnthropicToolStreamAccumulator();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const text = consumeAnthropicToolSSE(accumulator, line.trim());
          if (text) onToken(text);
        }
      }
      const remaining = buffer.trim();
      if (remaining) {
        const text = consumeAnthropicToolSSE(accumulator, remaining);
        if (text) onToken(text);
      }
    } finally {
      reader.releaseLock();
    }

    const result = accumulator.finalize();

    try {
      recordCallWithUsage(
        getCostTracker(),
        'anthropic',
        model,
        promptDigest(messages),
        result.content,
        accumulator.streamUsage
          ? { promptTokens: accumulator.streamUsage.promptTokens, completionTokens: accumulator.streamUsage.completionTokens }
          : undefined,
      );
    } catch {
      // Non-critical.
    }

    return result;
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
