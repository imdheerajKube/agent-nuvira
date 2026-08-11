/**
 * H1 — Shared OpenAI-format tool-calling helper (`src/inference/tools.ts`).
 *
 * Every OpenAI-compatible adapter (openai-compat, groq, openrouter, nim)
 * speaks the same `/chat/completions` `tools`/`tool_calls` protocol — one
 * helper, four adapters (H1 acceptance: "for providers with native
 * tool-calling, pass tools to the request, parse tool_calls"). The same
 * helper rejects unknown tools structurally (the API 400s) and returns
 * parsed tool calls with `arguments` as an object (never a string).
 */

import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';

/** OpenAI wire form of a tool call (arguments as a JSON string). */
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
  }>;
}

/**
 * Build the wire `messages` array: assistant messages carry `tool_calls`,
 * tool messages carry `tool_call_id`.
 */
export function buildWireMessages(messages: ToolMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

/** Parse the wire response into ToolCallResponse (arguments as objects). */
export function parseToolCallResponse(data: WireResponse): ToolCallResponse {
  const message = data.choices?.[0]?.message;
  const content = message?.content || '';
  const toolCalls: ToolCallResponse['toolCalls'] = [];
  for (const tc of message?.tool_calls || []) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = {};
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
  }
  return { content, toolCalls };
}

/**
 * POST /chat/completions with `tools` and parse the tool_calls response.
 * Throws the provider-style error (status in the message) so shared
 * failover/classification works unchanged.
 */
export async function chatCompletionsWithTools(opts: {
  /**
   * Base URL — the helper appends `/chat/completions`. Providers with a
   * non-standard path (Azure deployments) pass `url` instead.
   */
  baseUrl: string;
  /** Explicit full endpoint URL — wins over baseUrl (Azure deployments). */
  url?: string;
  headers: Record<string, string>;
  model: string;
  messages: ToolMessage[];
  tools: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Cost-recording hook (quota ledger / cost tracker parity with generate()):
   * invoked with the flattened prompt + response content after a successful
   * call so adapters record wire-metered (or estimated) cost exactly like
   * their non-tool path. Absent → no recording.
   */
  onCost?: (promptText: string, contentText: string) => void;
}): Promise<ToolCallResponse> {
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;
  const url = opts.url || `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify({
      model: opts.model,
      messages: buildWireMessages(opts.messages),
      temperature,
      max_tokens: maxTokens,
      tools: opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Tool-calling API error (${response.status}): ${errorBody}`);
  }

  const result = parseToolCallResponse((await response.json()) as WireResponse);
  if (opts.onCost) {
    try {
      opts.onCost(
        opts.messages.map((m) => m.content).filter(Boolean).join('\n'),
        result.content,
      );
    } catch {
      // Cost recording must never break the tool call.
    }
  }
  return result;
}
