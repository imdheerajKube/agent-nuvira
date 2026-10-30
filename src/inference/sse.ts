/**
 * Shared SSE streaming utilities for OpenAI-compatible APIs.
 * Used by Groq, NIM, and any future OpenAI-compatible adapters.
 */

/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns the content delta or null for non-content events (e.g., [DONE], usage info).
 */
export function parseSSELine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed?.choices?.[0]?.delta?.content || null;
  } catch {
    return null;
  }
}

/**
 * Parse the reasoning-content delta from an SSE line (P4 M4.2): some
 * reasoning models emit `delta.reasoning_content` alongside (or instead of)
 * `delta.content`. Returns the reasoning delta or null when absent.
 */
export function parseSSEReasoning(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    const reasoning = parsed?.choices?.[0]?.delta?.reasoning_content;
    return typeof reasoning === 'string' && reasoning.length > 0 ? reasoning : null;
  } catch {
    return null;
  }
}

/** The `usage` object of an OpenAI-compatible response (all fields optional). */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /**
   * DeepSeek: input tokens served from its automatic prompt cache. A SUBSET of
   * `prompt_tokens` — the tokens were still in the request, they were just billed
   * at the cache-hit rate.
   */
  prompt_cache_hit_tokens?: number;
  /** OpenAI (and OpenRouter's OpenAI-compatible shape): the same figure nested. */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Provider-reported cost (OpenRouter). */
  cost?: number;
}

/**
 * The cache-read input tokens a provider reported, when it reported any.
 *
 * WHY THIS EXISTS (measured). A Cline run of the same audit reported "58.5M in
 * (99.3% cache read)"; the same audit under this agent reported 5.77M with no
 * cache figure at all — not because the provider skipped the cache (it does not:
 * identical prefixes are cached automatically) but because this codebase threw
 * the two fields away and stored only `prompt_tokens`. The number the user reads
 * then looks like 10x more fresh compute than it was.
 *
 * Undefined when the endpoint does not report it — never 0, so "no cache data"
 * and "nothing was cached" stay distinguishable in the ledger.
 */
export function cachedPromptTokensOf(usage: WireUsage | undefined | null): number | undefined {
  if (!usage) return undefined;
  const direct = usage.prompt_cache_hit_tokens;
  const nested = usage.prompt_tokens_details?.cached_tokens;
  const value = typeof direct === 'number' ? direct : nested;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * How long a stream may go SILENT before it is treated as a dead connection.
 *
 * WHY THIS EXISTS (measured 2026-10-25). A benchmark turn streamed 41 tool calls
 * and then stopped dead: no output, no open socket, no child process, for the
 * remaining 25 minutes until the wall-clock cap killed it. This function's fetch
 * used to take no signal and `reader.read()` had no timeout, so a stream that
 * stops WITHOUT sending `end` or an error — a connection dropped mid-response —
 * parked the whole turn forever. Nothing about that is provider-specific, and the
 * only thing that ended it was the harness killing the process.
 *
 * An idle abort converts it into a `timeout`, which is the class the failover walk
 * already knows how to retry, so the turn continues on another pair instead of
 * hanging. The budget is per-CHUNK, not per-request: a slow model may legitimately
 * stream for minutes, and capping total duration would abort a healthy answer.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

/** The idle budget: `NUVIRA_STREAM_IDLE_TIMEOUT_MS`, else 120 s. */
export function streamIdleTimeoutMs(): number {
  const raw = Number(process.env.NUVIRA_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * `reader.read()` with a silence budget.
 *
 * WHY THE TIMER RACES THE READ instead of relying on the abort alone: whether a
 * PENDING read rejects when the request is aborted depends on the body
 * implementation, so a guard that only aborted would still park forever on the one
 * shape that matters (a body whose stream never settles). The race rejects the read
 * directly; `onIdle` then aborts the request so the socket is released rather than
 * left open behind a rejected promise.
 */
async function readWithIdleGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  onIdle: () => void,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onIdle();
          reject(new Error(`stream timeout: no data for ${idleMs} ms`));
        }, idleMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Measured token usage reported by an OpenAI-compatible endpoint. */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from the provider's prompt cache (see above). */
  cachedPromptTokens?: number;
  /**
   * Provider-reported cost in USD for this call, when the endpoint includes
   * one (OpenRouter carries `usage.cost`; most others omit it). It is the most
   * accurate value available — it reflects the account's credits/free tier.
   */
  costUsd?: number;
}

/**
 * Perform a streaming chat completion request for an OpenAI-compatible API.
 *
 * @param url - The full URL for the chat completions endpoint
 * @param headers - HTTP headers (including Authorization)
 * @param body - The JSON request body (stream: true will be added automatically)
 * @param onToken - Callback for each content token as it arrives
 * @param onUsage - Optional callback for the endpoint-reported token usage
 *   (M2.2 wire-token metering): some endpoints emit a final data chunk carrying
 *   a `usage` object (OpenAI stream_options.include_usage convention) — when
 *   present it is forwarded so adapters can record MEASURED cost instead of
 *   length-based estimates.
 * @returns The full concatenated response text
 */
export async function streamCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
  onUsage?: (usage: UsageInfo) => void,
  onReasoning?: (text: string) => void,
): Promise<string> {
  const idleMs = streamIdleTimeoutMs();
  // One controller for the whole exchange: aborting it releases the connection,
  // which is what actually stops a dead stream from holding the socket open.
  const controller = new AbortController();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      stream: true,
    }),
    signal: controller.signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  const fullContent: string[] = [];
  let buffer = '';

  // M2.2: capture the endpoint-reported usage from any data chunk that carries
  // it (final chunk before [DONE] in the OpenAI include_usage convention).
  const captureUsage = (trimmed: string): void => {
    if (!onUsage || !trimmed.startsWith('data: ')) return;
    const data = trimmed.slice(6).trim();
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as { usage?: WireUsage };
      if (
        parsed?.usage &&
        typeof parsed.usage.prompt_tokens === 'number' &&
        typeof parsed.usage.completion_tokens === 'number'
      ) {
        const cached = cachedPromptTokensOf(parsed.usage);
        onUsage({
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
          ...(typeof parsed.usage.cost === 'number' ? { costUsd: parsed.usage.cost } : {}),
        });
      }
    } catch {
      // Non-JSON data lines are ignored.
    }
  };

  try {
    while (true) {
      const { done, value } = await readWithIdleGuard(reader, idleMs, () => controller.abort());
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from the buffer
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const token = parseSSELine(trimmed);
        if (token) {
          fullContent.push(token);
          onToken(token);
        }
        // P4 M4.2: forward reasoning-content deltas (cached by adapters for
        // reasoning-replay on retry).
        const reasoning = onReasoning ? parseSSEReasoning(trimmed) : null;
        if (reasoning) onReasoning!(reasoning);
        captureUsage(trimmed);
      }
    }

    // Process remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      const token = parseSSELine(remaining);
      if (token) {
        fullContent.push(token);
        onToken(token);
      }
      const reasoning = onReasoning ? parseSSEReasoning(remaining) : null;
      if (reasoning) onReasoning!(reasoning);
      captureUsage(remaining);
    }
  } catch (err) {
    // Release the connection and any pending read; a rejected read otherwise keeps
    // the body locked (and the socket open) for the rest of the process's life.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  return fullContent.join('');
}
