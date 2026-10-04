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
import { attachHttpContext } from './http-error.js';
import { parseSSELine } from './sse.js';

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
  /** Endpoint-reported token usage (and, for OpenRouter, the exact cost). */
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
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
   * P4 — external cancellation: when present, the request aborts on signal
   * (the dashboard's Cancel button). Absent → AbortSignal.timeout applies.
   */
  signal?: AbortSignal;
  /**
   * Cost-recording hook (quota ledger / cost tracker parity with generate()):
   * invoked with the flattened prompt + response content after a successful
   * call so adapters record wire-metered (or estimated) cost exactly like
   * their non-tool path. Absent → no recording. The third arg carries the
   * endpoint-reported usage when the streaming path captured it (M2.2).
   */
  onCost?: (promptText: string, contentText: string, usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number }) => void;
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
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    // Headers attached so extractRetryAfterMs() can read Retry-After /
    // x-ratelimit-reset-* and park for the provider's ACTUAL reset time.
    throw attachHttpContext(new Error(`Tool-calling API error (${response.status}): ${errorBody}`), response.status, response.headers);
  }

  const data = (await response.json()) as WireResponse;
  const result = parseToolCallResponse(data);
  if (opts.onCost) {
    try {
      // M2.2: pass the endpoint's own usage when it reported one (tokens and,
      // on OpenRouter, the exact cost) so adapters record MEASURED cost instead
      // of a length-based estimate.
      const usage = data.usage;
      const reported =
        usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              ...(typeof usage.cost === 'number' ? { costUsd: usage.cost } : {}),
            }
          : undefined;
      opts.onCost(
        opts.messages.map((m) => m.content).filter(Boolean).join('\n'),
        result.content,
        reported,
      );
    } catch {
      // Cost recording must never break the tool call.
    }
  }
  return result;
}

// ─── Streaming tool-calling (dashboard answer typewriter) ───────────────────
// The same OpenAI `tools`/`tool_calls` protocol, streamed: assistant content
// deltas are delivered to onToken as they arrive and tool_calls arrive as
// per-index fragments (id/name on the first chunk, arguments split across
// chunks) that must be accumulated before parsing.

/** The wire shape of one streaming tool_calls delta (fragments per index). */
interface WireStreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireStreamToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/** Accumulator for one streaming tool call (fragments joined per index). */
interface AccumulatedToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

/**
 * Parse the tool_calls delta from an SSE line, or null when the line carries
 * none (non-data lines, [DONE], content-only chunks).
 */
function parseSSEToolCallDeltas(line: string): WireStreamToolCallDelta[] | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as WireStreamChunk;
    return parsed?.choices?.[0]?.delta?.tool_calls ?? null;
  } catch {
    return null;
  }
}

/**
 * Streamed twin of chatCompletionsWithTools: POST with `stream: true` and
 * deliver content tokens to onToken as they arrive. Returns the same
 * ToolCallResponse shape as the non-streaming helper (tool_calls accumulated
 * from per-index fragments, arguments JSON-parsed). Best-effort measured
 * usage is captured from the final chunk (stream_options.include_usage).
 */
export async function chatCompletionsWithToolsStream(
  opts: Parameters<typeof chatCompletionsWithTools>[0],
  onToken: (token: string) => void,
): Promise<ToolCallResponse> {
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
      stream: true,
      // OpenAI convention for measured usage in the final chunk (Groq and
      // OpenRouter support it; providers that ignore it just omit usage).
      stream_options: { include_usage: true },
      // OpenRouter only reports `usage.cost` for streams when explicitly asked;
      // providers that don't understand this field ignore it.
      usage: { include: true },
    }),
    // P4 — external cancellation (the dashboard Cancel button). The streaming
    // path historically had no timeout; an explicit signal is the ONLY way to
    // stop it mid-stream.
    signal: opts.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    // Same attachHttpContext treatment as the non-streaming helper so shared
    // failover/classification (Retry-After / x-ratelimit-reset) works.
    throw attachHttpContext(
      new Error(`Tool-calling streaming API error (${response.status}): ${errorBody}`),
      response.status,
      response.headers,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  const contentParts: string[] = [];
  const toolCalls: AccumulatedToolCall[] = [];
  let buffer = '';
  // M2.2: capture the endpoint-reported usage from the final chunk
  // (stream_options.include_usage convention) so onCost records MEASURED cost
  // instead of a length-based estimate — the generateStream parity pattern.
  let streamUsage: { promptTokens?: number; completionTokens?: number; costUsd?: number } | undefined;
  /**
   * True once the body has produced a server-sent-event line we understood.
   *
   * A STREAM THAT CARRIES NO `data:` LINE AT ALL IS AN UNPARSEABLE RESPONSE, not
   * an empty answer — see the guard after the read loop. Tracked separately from
   * "the content is empty" because an empty completion is legitimate (a model may
   * return nothing with `finish_reason: stop`, and that arrives as a data line).
   */
  let sawSseLine = false;
  /** The first bytes of the body, for a failure report (bounded, one line). */
  let rawHead = '';

  /** Process one complete SSE line (content delta → onToken; tool_calls → accumulate). */
  const handleLine = (trimmed: string): void => {
    if (trimmed.startsWith('data:')) sawSseLine = true;
    const token = parseSSELine(trimmed);
    if (token) {
      contentParts.push(token);
      onToken(token);
    }
    const deltas = parseSSEToolCallDeltas(trimmed);
    if (deltas) {
      for (const d of deltas) {
        const acc = (toolCalls[d.index] ??= { id: '', name: '', argumentsRaw: '' });
        if (d.id) acc.id = d.id;
        if (d.function?.name) acc.name = d.function.name;
        if (d.function?.arguments) acc.argumentsRaw += d.function.arguments;
      }
    }
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6).trim();
      if (data !== '[DONE]') {
        try {
          const parsed = JSON.parse(data) as WireStreamChunk;
          if (
            parsed?.usage &&
            typeof parsed.usage.prompt_tokens === 'number' &&
            typeof parsed.usage.completion_tokens === 'number'
          ) {
            streamUsage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              ...(typeof parsed.usage.cost === 'number' ? { costUsd: parsed.usage.cost } : {}),
            };
          }
        } catch {
          // Non-JSON data lines are ignored.
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (rawHead.length < 200) rawHead += buffer.slice(rawHead.length, 200);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleLine(trimmed);
      }
    }
    const remaining = buffer.trim();
    if (remaining) handleLine(remaining);
  } finally {
    reader.releaseLock();
  }

  // A 200 that carried no SSE at all is a response NOTHING COULD PARSE, and it
  // used to be returned as `{ content: '', toolCalls: [] }` — an empty-but-valid
  // answer. Measured cost of that: the dashboard's turn read it as "the model said
  // nothing", retried until its step bound, and reported the turn as COMPLETED
  // ("I reached my step limit") while every non-streaming surface reported the
  // same backend response as a failure. That is the fabricated-success shape this
  // repo's truthfulness workstream exists to remove, so it throws here instead —
  // the caller's own failure handling then does the honest thing.
  if (!sawSseLine) {
    const head = rawHead.replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(
      'Tool-calling streaming API error: the response carried no server-sent events ' +
        '(no `data:` line), so nothing could be read from it' +
        (head ? ` — body began: ${head}` : ' — body was empty'),
    );
  }

  const parsedCalls: ToolCallResponse['toolCalls'] = [];
  for (const acc of toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(acc.argumentsRaw || '{}');
    } catch {
      args = {};
    }
    parsedCalls.push({ id: acc.id, name: acc.name, arguments: args });
  }
  const content = contentParts.join('');
  if (opts.onCost) {
    try {
      opts.onCost(
        opts.messages.map((m) => m.content).filter(Boolean).join('\n'),
        content,
        streamUsage,
      );
    } catch {
      // Cost recording must never break the stream.
    }
  }
  return { content, toolCalls: parsedCalls };
}
