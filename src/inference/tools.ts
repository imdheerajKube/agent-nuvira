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

import type { ToolArgumentsError, ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { attachHttpContext } from './http-error.js';
import { cachedPromptTokensOf, parseSSELine, type WireUsage } from './sse.js';
// Every outbound string is made JSON-safe before it goes on the wire (see the
// module header: one unpaired surrogate made a whole request unparsable).
import { sanitizeWireValue } from './wire-sanitize.js';
import { applyThinkingReplayInvariant, isReasoningReplayRejection } from './thinking-replay.js';

/** OpenAI wire form of a tool call (arguments as a JSON string). */
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[]; reasoning_content?: string | null };
    /** `'length'` = the provider cut the response at the output-token cap. */
    finish_reason?: string | null;
  }>;
  /** Endpoint-reported token usage (and, for OpenRouter, the exact cost). */
  usage?: WireUsage;
}

/**
 * Build the wire `messages` array: assistant messages carry `tool_calls`,
 * tool messages carry `tool_call_id`.
 *
 * This is the ONE place every tool conversation is rendered for the wire (both
 * the streaming and non-streaming helpers below), so it is also the one place the
 * thinking-mode REPLAY INVARIANT has to hold: in a conversation that already
 * carries reasoning, every tool-call turn must carry it too, or the endpoint
 * rejects the request — see {@link applyThinkingReplayInvariant}, which fills the
 * gap the loop can leave behind. A conversation with no reasoning anywhere is
 * returned exactly as given, so nothing here changes a shape that was already
 * valid.
 */
export function buildWireMessages(messages: ToolMessage[]): Array<Record<string, unknown>> {
  const { messages: replayable } = applyThinkingReplayInvariant(messages);
  return replayable.map((m) => {
    // Reasoning replay: a thinking model (DeepSeek v4) requires its prior
    // `reasoning_content` echoed on the assistant turn that carried the tool
    // calls, or the NEXT request is rejected. Emitted only when present, so
    // every non-reasoning conversation keeps the exact wire shape it had.
    const reasoning = m.role === 'assistant' && m.reasoningContent ? { reasoning_content: m.reasoningContent } : {};
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
        ...reasoning,
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content, ...reasoning };
  });
}

/**
 * Parse an OpenAI-wire arguments string, SAYING WHY when it cannot be used.
 *
 * The old contract was `{}` on any failure, which made a call whose arguments
 * never arrived indistinguishable from a call that legitimately asked for
 * nothing — see {@link ToolArgumentsError} for the measured cost of that. This
 * keeps the `{}` (callers still get a usable object) but reports the reason
 * alongside it, so the loop can refuse the call and name the real cause.
 */
export function parseToolCallArguments(raw: string | undefined): {
  args: Record<string, unknown>;
  error?: ToolArgumentsError;
} {
  const text = (raw ?? '').trim();
  if (!text) return { args: {}, error: 'empty' };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, error: 'unparseable' };
  } catch {
    // Non-JSON argument bytes mean the JSON was cut off — the signature of an
    // output-token truncation, not of a model that "forgot" its arguments.
    return { args: {}, error: 'unparseable' };
  }
}

/** Parse the wire response into ToolCallResponse (arguments as objects). */
export function parseToolCallResponse(data: WireResponse): ToolCallResponse {
  const message = data.choices?.[0]?.message;
  const content = message?.content || '';
  const toolCalls: ToolCallResponse['toolCalls'] = [];
  for (const tc of message?.tool_calls || []) {
    const { args, error } = parseToolCallArguments(tc.function.arguments);
    toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args, ...(error ? { argumentsError: error } : {}) });
  }
  // Capture reasoning so the caller can replay it (DeepSeek thinking mode).
  const reasoningContent =
    typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content
      : undefined;
  const finishReason =
    typeof data.choices?.[0]?.finish_reason === 'string' ? data.choices[0].finish_reason : undefined;
  // The provider's own counts, carried up so the trace/report can stop estimating
  // a number the endpoint already stated (see `ToolCallResponse.usage`).
  const usage = data.usage;
  const cached = cachedPromptTokensOf(usage);
  const reportedUsage =
    usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
        }
      : undefined;
  return {
    content,
    toolCalls,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(reportedUsage ? { usage: reportedUsage } : {}),
  };
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
   * Reasoning-token hook. DeepSeek-style thinking models stream
   * `delta.reasoning_content` alongside (or before) `delta.content`; the CLI
   * renders it as the model's working notes rather than leaving the screen to
   * tool cards alone. Display only — the accumulated text is ALSO returned as
   * `reasoningContent` for the reasoning-replay contract, and a provider that
   * emits none simply never calls this.
   */
  onReasoning?: (token: string) => void;
  /**
   * Cost-recording hook (quota ledger / cost tracker parity with generate()):
   * invoked with the flattened prompt + response content after a successful
   * call so adapters record wire-metered (or estimated) cost exactly like
   * their non-tool path. Absent → no recording. The third arg carries the
   * endpoint-reported usage when the streaming path captured it (M2.2).
   */
  onCost?: (promptText: string, contentText: string, usage?: { promptTokens?: number; completionTokens?: number; costUsd?: number }) => void;
  /**
   * Request-side reasoning fragment (e.g. `{ reasoning_effort: 'high' }`),
   * merged into the request body last. Resolved and gated by the adapter via
   * reasoning-effort.ts (default-deny); absent → body is byte-identical.
   */
  reasoningBody?: Record<string, unknown>;
}): Promise<ToolCallResponse> {
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 4096;
  const url = opts.url || `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const post = (messages: readonly ToolMessage[], signal: AbortSignal | undefined): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(
        // WIRE SANITISE — an unpaired surrogate anywhere in the thread is not
        // JSON-representable and a provider 400s the whole request (see
        // inference/wire-sanitize.ts). Applied to the FINAL body, so no field can
        // be forgotten. A clean payload is byte-identical, so the prompt cache is
        // unaffected.
        sanitizeWireValue({
          model: opts.model,
          messages: buildWireMessages([...messages]),
          temperature,
          max_tokens: maxTokens,
          tools: opts.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          ...(opts.reasoningBody || {}),
        }),
      ),
      signal: signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });

  let response = await post(opts.messages, opts.signal);
  let repairedReasoningTurns = 0;
  if (!response.ok) {
    const errorBody = await response.text();
    // THE ENDPOINT STATING THE RULE (2026-10-29). A thinking model with tools
    // rejects a tool-call turn that carries no `reasoning_content`, even when no
    // earlier turn ever carried one — so a thread that lost its reasoning to
    // trimming or a continuation is rejected no matter what the thread's own
    // evidence says. Fill the gaps and send the SAME request once more: this
    // replaces a call that had already failed, so it costs no model round trip,
    // and it is what stops the 3-5 wasted calls per thinking turn. See
    // inference/thinking-replay.ts for the measured requests.
    const repair = isReasoningReplayRejection(response.status, errorBody)
      ? applyThinkingReplayInvariant(opts.messages, { force: true })
      : { messages: opts.messages, filled: 0 };
    // Opt-in diagnosis (`NUVIRA_WIRE_DEBUG=1`): the request shape that the
    // endpoint refused, as roles plus whether each turn carried reasoning. This is
    // what made the remaining gap visible — the filled count looked right while a
    // turn of another kind was still missing its field.
    if (process.env.NUVIRA_WIRE_DEBUG) {
      const shape = opts.messages
        .map((m) => `${m.role}${m.toolCalls?.length ? `(${m.toolCalls.length})` : ''}${m.reasoningContent ? '+' : ''}`)
        .join(' ');
      console.error(`[wire-debug] ${response.status} rejected-for-reasoning filled=${repair.filled} ${shape}`);
    }
    if (repair.filled === 0) {
      // Headers attached so extractRetryAfterMs() can read Retry-After /
      // x-ratelimit-reset-* and park for the provider's ACTUAL reset time.
      throw attachHttpContext(new Error(`Tool-calling API error (${response.status}): ${errorBody}`), response.status, response.headers);
    }
    repairedReasoningTurns = repair.filled;
    response = await post(repair.messages, opts.signal);
    if (!response.ok) {
      throw attachHttpContext(
        new Error(`Tool-calling API error (${response.status}): ${await response.text()}`),
        response.status,
        response.headers,
      );
    }
  }

  const data = (await response.json()) as WireResponse;
  const result = parseToolCallResponse(data);
  if (repairedReasoningTurns > 0) result.repairedReasoningTurns = repairedReasoningTurns;
  if (opts.onCost) {
    try {
      // M2.2: pass the endpoint's own usage when it reported one (tokens and,
      // on OpenRouter, the exact cost) so adapters record MEASURED cost instead
      // of a length-based estimate.
      const usage = data.usage;
      const cached = cachedPromptTokensOf(usage);
      const reported =
        usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              // DeepSeek's cache hit count (or OpenAI's nested equivalent).
              ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
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
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: WireStreamToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage;
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

  const post = (messages: readonly ToolMessage[]): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(
        // WIRE SANITISE — see inference/wire-sanitize.ts. A lone surrogate in one
        // tool result made the whole request unparsable for the provider and the
        // turn unrecoverable; every string in the final body is made JSON-safe.
        sanitizeWireValue({
          model: opts.model,
          messages: buildWireMessages([...messages]),
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
          ...(opts.reasoningBody || {}),
        }),
      ),
      // P4 — external cancellation (the dashboard Cancel button). The streaming
      // path historically had no timeout; an explicit signal is the ONLY way to
      // stop it mid-stream.
      signal: opts.signal,
    });

  let response = await post(opts.messages);
  let repairedReasoningTurns = 0;
  if (!response.ok) {
    const errorBody = await response.text();
    // Same one-shot repair as the non-streaming helper (see the reasoning there):
    // the endpoint enforcing the replay rule is the signal, and the thread's own
    // evidence is not, because a thinking turn can lose its reasoning to
    // trimming or a continuation and then be rejected on every retry.
    const repair = isReasoningReplayRejection(response.status, errorBody)
      ? applyThinkingReplayInvariant(opts.messages, { force: true })
      : { messages: opts.messages, filled: 0 };
    if (repair.filled === 0) {
      // Same attachHttpContext treatment as the non-streaming helper so shared
      // failover/classification (Retry-After / x-ratelimit-reset) works.
      throw attachHttpContext(
        new Error(`Tool-calling streaming API error (${response.status}): ${errorBody}`),
        response.status,
        response.headers,
      );
    }
    repairedReasoningTurns = repair.filled;
    response = await post(repair.messages);
    if (!response.ok) {
      throw attachHttpContext(
        new Error(`Tool-calling streaming API error (${response.status}): ${await response.text()}`),
        response.status,
        response.headers,
      );
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  const contentParts: string[] = [];
  const toolCalls: AccumulatedToolCall[] = [];
  // DeepSeek thinking mode streams `delta.reasoning_content`; captured so the
  // caller can replay it on the next request (see ToolMessage.reasoningContent).
  const reasoningParts: string[] = [];
  let buffer = '';
  // M2.2: capture the endpoint-reported usage from the final chunk
  // (stream_options.include_usage convention) so onCost records MEASURED cost
  // instead of a length-based estimate — the generateStream parity pattern.
  let streamUsage:
    | { promptTokens?: number; completionTokens?: number; costUsd?: number; cachedPromptTokens?: number }
    | undefined;
  // The provider's own verdict on WHY it stopped. `'length'` is the one the
  // caller needs: a tool call whose arguments were cut off by the output budget
  // must be reported as TRUNCATED, not as a call the model sent with no
  // arguments (see ToolArgumentsError).
  let finishReason: string | undefined;
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
          const chunkFinish = parsed?.choices?.[0]?.finish_reason;
          if (typeof chunkFinish === 'string' && chunkFinish) finishReason = chunkFinish;
          const reasoningDelta = parsed?.choices?.[0]?.delta?.reasoning_content;
          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            reasoningParts.push(reasoningDelta);
            // Live display of the model's working notes (see `onReasoning`).
            opts.onReasoning?.(reasoningDelta);
          }
          if (
            parsed?.usage &&
            typeof parsed.usage.prompt_tokens === 'number' &&
            typeof parsed.usage.completion_tokens === 'number'
          ) {
            const cached = cachedPromptTokensOf(parsed.usage);
            streamUsage = {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
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
    const { args, error } = parseToolCallArguments(acc.argumentsRaw);
    parsedCalls.push({ id: acc.id, name: acc.name, arguments: args, ...(error ? { argumentsError: error } : {}) });
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
  const reasoningContent = reasoningParts.join('');
  return {
    content,
    toolCalls: parsedCalls,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(repairedReasoningTurns > 0 ? { repairedReasoningTurns } : {}),
  };
}
