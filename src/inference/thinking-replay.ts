/**
 * THINKING-MODE REASONING REPLAY — the wire invariant DeepSeek's tool-calling
 * thinking mode enforces, kept true by the harness instead of by luck.
 *
 * THE CONTRACT (DeepSeek's own docs, quoted in full because the exact wording is
 * the whole argument): "For turns that do perform tool calls, the
 * `reasoning_content` must be fully passed back to the API in all subsequent
 * requests. If your code does not correctly pass back `reasoning_content`, the
 * API will return a 400 error."
 *
 * OBSERVED FAILURE (2026-10-16, a real assessment run on this repository —
 * `~/.nuvira/debug-logs/cli-chat-1792147116253.log`, provider `deepseek`,
 * model `deepseek-flash`, transport `native`). Late in the turn, after the loop
 * recovered a tool call the model had written as TEXT, four consecutive requests
 * were rejected:
 *
 *   400 {"error":{"message":"The `reasoning_content` in the thinking mode must
 *        be passed back to the API. (request_id: ffd98335-…)"}}
 *
 * …each with a DIFFERENT request_id and an identical body, so all four were the
 * same invalid request re-sent: the loop's bounded mid-turn continuation retried
 * the identical thread four times (`continuation 2/4` … `4/4`) and the turn only
 * completed because the provider walk eventually reached a candidate that
 * tolerated the thread. Nothing repaired the request, because nothing could see
 * what was wrong with it.
 *
 * WHAT WAS WRONG. The loop records `reasoningContent` on an assistant turn only
 * when that step's response carried one (`tool-loop.ts`: `...(response.reasoningContent
 * ? { reasoningContent: response.reasoningContent } : {})`), which is correct and
 * is not the bug. The bug is that a conversation can end up INCONSISTENT — some
 * assistant turns with reasoning, one tool-call turn without — because a single
 * step returned no reasoning (a provider/gateway that omits it for a tool call, or
 * a tool call recovered from text rather than a native `tool_calls` field).
 * Demonstrated deterministically against this repository's own loop: a mock
 * provider that reasons on step 1 and not on step 2 makes step 3's request carry
 * `toolCalls: [c2]` with no reasoning, while the sibling turn still has it.
 * Reported identically by other harnesses (opencode #24722, claude-code-router
 * #1378): "if ALL assistant messages consistently include `reasoning_content`
 * (including the `tool_calls` message), the request succeeds".
 *
 * THE REPAIR, AND WHY THIS ONE. The API accepts either consistent extreme, and
 * this module picks the one that never discards the model's own reasoning: a gap
 * is FILLED so the conversation stays uniform, rather than the whole thread being
 * stripped to match the gap. Stripping would throw away real reasoning from every
 * earlier turn (which the contract says the endpoint wants), so filling is both
 * the smaller loss and the remedy the API's own bug report suggests.
 *
 * MEASURED SAFE (2026-10-16, live, `api.deepseek.com`, model `deepseek-flash`,
 * via this repository's configured provider): a tool-call turn carrying the
 * placeholder below is accepted — HTTP 200 with a normal completion — exactly
 * like the same conversation with the gap unfilled and with all reasoning
 * stripped. So on today's endpoint this is a NO-OP for a thread that would
 * otherwise be served, and it closes the gap for the endpoint that enforces the
 * rule (the run above shows that endpoint exists and that we can meet it).
 *
 * NARROWNESS. Nothing is added unless the conversation ALREADY carries reasoning
 * on some assistant turn — a non-thinking provider's thread is untouched, and the
 * wire stays byte-identical. Only turns that carry `tool_calls` are filled, which
 * is the turn class the contract names; a content-only assistant turn is left
 * alone because no rule requires it and inventing text there would be noise.
 */

import type { ToolMessage } from './interface.js';

/**
 * What a gap is filled with.
 *
 * Deliberately a statement of FACT about our own bookkeeping rather than an
 * invented chain of thought: the endpoint requires the field's presence on a
 * tool-call turn, and the model reading it back must not be told a plausible lie
 * about what it was thinking. A thinking model that sees this knows only that the
 * reasoning for that call was not retained — which is true.
 */
export const REASONING_NOT_RETAINED = '(reasoning for this tool call was not retained)';

/**
 * True when any assistant turn in the conversation carries reasoning.
 *
 * That is the signal that this is a thinking-mode conversation: the endpoint is
 * already receiving `reasoning_content` on some turns, so it is entitled to
 * require it on the tool-call turns too (and does, per the contract above).
 * A thread with no reasoning anywhere is a non-thinking conversation and is left
 * completely untouched — missing reasoning is NOT an error by itself; the API
 * accepts a thread that never had any.
 */
function conversationCarriesReasoning(messages: readonly ToolMessage[]): boolean {
  return messages.some((m) => m.role === 'assistant' && Boolean(m.reasoningContent));
}

/**
 * Apply the invariant to a conversation, returning a NEW array only when a gap
 * had to be filled (otherwise the caller's array is returned unchanged, so a
 * valid conversation keeps the exact wire shape it had).
 *
 * Returns the messages plus how many gaps were filled, so a caller can log that
 * it happened — a repair nobody can see is indistinguishable from a request that
 * was always valid.
 */
export function applyThinkingReplayInvariant(
  messages: readonly ToolMessage[],
): { messages: readonly ToolMessage[]; filled: number } {
  if (!conversationCarriesReasoning(messages)) return { messages, filled: 0 };

  let filled = 0;
  const out = messages.map((m) => {
    if (m.role !== 'assistant') return m;
    if (!m.toolCalls || m.toolCalls.length === 0) return m;
    if (m.reasoningContent) return m;
    filled += 1;
    return { ...m, reasoningContent: REASONING_NOT_RETAINED };
  });

  return { messages: filled > 0 ? out : messages, filled };
}
