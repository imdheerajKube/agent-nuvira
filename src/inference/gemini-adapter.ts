import { InferenceProvider, ModelDescriptor } from './interface.js';
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { getModelTags } from './model-catalog.js';
import { getCostTracker } from '../learning/cost-tracker.js';
import { requireAdapterModel } from '../learning/model-selection.js';
import { attachHttpContext } from './http-error.js';
import {
  toGeminiContents,
  toGeminiFunctionDeclarations,
  parseGeminiToolResponse,
  parseGeminiToolSSEChunk,
} from './native-tools.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
    finishReason?: string;
  }>;
}

/** Response shape for tool-calling calls (re-exported alias for readability). */
type GeminiToolResponseShape = import('./native-tools.js').GeminiToolResponse;

/** Flatten a thread's text content for cost metering (best-effort estimate). */
function promptDigest(messages: ToolMessage[]): string {
  return messages.map((m) => m.content).filter(Boolean).join('\n');
}

/**
 * Parse a Gemini SSE streaming response line.
 * Gemini's streaming format differs from OpenAI's SSE:
 * - Each line has `data: ` prefix (like SSE)
 * - The JSON payload has `candidates[].content.parts[].text`
 * - A `data: [DONE]` or empty line signals the end
 */
function parseGeminiSSELine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (!data || data === '[DONE]') return null;

  try {
    const parsed = JSON.parse(data) as GeminiResponse;
    return parsed?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}

/**
 * Google Gemini Adapter (free tier)
 * Connects to Google Gemini API
 */
export class GeminiAdapter implements InferenceProvider {
  readonly name = 'Google Gemini';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
    }

    const model = options?.model || requireAdapterModel('gemini', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;

    logger.debug(`Gemini: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Headers attached so extractRetryAfterMs() can read Retry-After and
      // park for the provider's ACTUAL reset time (not a fixed window).
      throw attachHttpContext(new Error(`Gemini API error (${response.status}): ${errorBody}`), response.status, response.headers);
    }

    const data = (await response.json()) as GeminiResponse;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Track cost
    try {
      getCostTracker().recordCallEstimated('gemini', model, prompt, content);
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
      throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
    }

    const model = options?.model || requireAdapterModel('gemini', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;

    logger.debug(`Gemini: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    // Use Gemini's streamGenerateContent endpoint
    const url = `${GEMINI_BASE_URL}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw attachHttpContext(
        new Error(`Gemini streaming API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Gemini response body is not readable');
    }

    const decoder = new TextDecoder();
    const fullContent: string[] = [];
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from the buffer
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const token = parseGeminiSSELine(trimmed);
          if (token) {
            fullContent.push(token);
            onToken(token);
          }
        }
      }

      // Process remaining buffer
      const remaining = buffer.trim();
      if (remaining) {
        const token = parseGeminiSSELine(remaining);
        if (token) {
          fullContent.push(token);
          onToken(token);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = fullContent.join('');

    // Track cost for streaming response
    try {
      getCostTracker().recordCallEstimated('gemini', model, prompt, content);
    } catch { /* Non-critical */ }

    return content;
  }

  // ─── H1b/Phase 1.2 — native tool calling (Gemini function calling) ───────
  //
  // The assessment (Addendum v2 §D.3) found gemini riding the JSON fallback
  // ("0 generateTools matches") and marked native function-calling BLOCKING
  // for loop-default. This implements the v1beta generateContent function
  // calling protocol: system → systemInstruction, tool results →
  // functionResponse parts, tools → functionDeclarations (schema-sanitized
  // to Gemini's OpenAPI subset by native-tools.ts). Wire shape, parsing and
  // streaming accumulation live in native-tools.ts — this method is a thin
  // fetch. Cost parity with generate(): estimated metering per call.
  async generateTools(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options?: InferenceOptions,
  ): Promise<ToolCallResponse> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
    }
    const model = options?.model || requireAdapterModel('gemini', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;

    const { systemInstruction, contents } = toGeminiContents(messages);
    const body: Record<string, unknown> = {
      contents,
      tools: toGeminiFunctionDeclarations(tools),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    logger.debug(`Gemini: Tool-calling with model=${model}, tools=${tools.length}`);
    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal ?? AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw attachHttpContext(
        new Error(`Gemini tool-calling API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }
    const data = (await response.json()) as GeminiToolResponseShape;
    const result = parseGeminiToolResponse(data);

    // Cost parity with generate(): meter tool-calling turns too.
    try {
      getCostTracker().recordCallEstimated('gemini', model, promptDigest(messages), result.content);
    } catch { /* Non-critical */ }

    return result;
  }

  /**
   * P4/Phase 1.2 — streaming native tool-calling: same protocol with
   * streamGenerateContent?alt=sse; content tokens stream to onToken, tool
   * calls accumulate across chunks and parse at stream end.
   */
  async generateToolsStream(
    messages: ToolMessage[],
    tools: ToolSchema[],
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<ToolCallResponse> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
    }
    const model = options?.model || requireAdapterModel('gemini', this.config.model);
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;

    const { systemInstruction, contents } = toGeminiContents(messages);
    const body: Record<string, unknown> = {
      contents,
      tools: toGeminiFunctionDeclarations(tools),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    logger.debug(`Gemini: Streaming tool-calling with model=${model}, tools=${tools.length}`);
    const url = `${GEMINI_BASE_URL}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw attachHttpContext(
        new Error(`Gemini streaming tool-calling API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Gemini response body is not readable');

    const decoder = new TextDecoder();
    let buffer = '';
    const textChunks: string[] = [];
    const functionCalls: Array<{ name: string; args?: Record<string, unknown>; thoughtSignature?: string }> = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseGeminiToolSSEChunk(line.trim());
          if (!parsed) continue;
          if (parsed.text) {
            textChunks.push(parsed.text);
            onToken(parsed.text);
          }
          functionCalls.push(...parsed.functionCalls);
        }
      }
      const remaining = buffer.trim();
      if (remaining) {
        const parsed = parseGeminiToolSSEChunk(remaining);
        if (parsed) {
          if (parsed.text) {
            textChunks.push(parsed.text);
            onToken(parsed.text);
          }
          functionCalls.push(...parsed.functionCalls);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content = textChunks.join('');
    const toolCalls = functionCalls.map((fc, i) => ({
      id: `call_${i + 1}`,
      name: fc.name,
      arguments: fc.args ?? {},
      // Must survive the round trip: Gemini requires its own thoughtSignature
      // back on the next turn's functionCall part (see ToolCallRequest).
      ...(fc.thoughtSignature ? { providerMeta: { thoughtSignature: fc.thoughtSignature } } : {}),
    }));

    // Cost parity with generate(): meter tool-calling turns too.
    try {
      getCostTracker().recordCallEstimated('gemini', model, promptDigest(messages), content);
    } catch { /* Non-critical */ }

    return { content, toolCalls };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: Google Gemini\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${GEMINI_BASE_URL}?key=${apiKey}`);
      if (!response.ok) return [];
      // Gemini's models.list exposes each model's inputTokenLimit (its context
      // window) + supportedGenerationMethods — record the live window for
      // generation-capable models so the router's preflight uses the real spec.
      const data = (await response.json()) as {
        models?: Array<{
          name: string;
          displayName?: string;
          description?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      return (data.models || []).map(
        (m: {
          name: string;
          displayName?: string;
          description?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }) => {
          const id = m.name.replace('models/', '');
          // Only chat/generation-capable models get a live window — for
          // embedding/text-only methods inputTokenLimit means something else.
          const chatCapable = m.supportedGenerationMethods?.includes('generateContent');
          const ctx = chatCapable && typeof m.inputTokenLimit === 'number' && m.inputTokenLimit > 0
            ? m.inputTokenLimit
            : undefined;
          return {
            id,
            name: m.displayName || id,
            provider: 'gemini',
            description: m.description,
            tags: getModelTags(id),
            ...(ctx !== undefined ? { contextWindowTokens: ctx } : {}),
          };
        },
      );
    } catch {
      return [];
    }
  }
}
