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
 * wire stays byte-identical. Once it does, EVERY assistant turn without one is
 * filled: measured 2026-10-29, a thinking thread with a plain prose turn that
 * lacked reasoning was rejected exactly like a tool-call turn without it, so the
 * narrower "tool-call turns only" rule left the request invalid.
 *
 * THE THREAD IS NOT THE SIGNAL (measured 2026-10-29). That narrowness was WRONG,
 * and it cost four to five rejected model calls on every thinking-mode turn:
 *
 *   POST api.deepseek.com/chat/completions, deepseek-flash, tools present
 *   · thread where NO assistant turn carries reasoning  → 400 "The
 *     `reasoning_content` in the thinking mode must be passed back to the API"
 *   · the same thread with reasoning on the ONE tool-call turn → 200
 *
 * So the endpoint decides from the REQUEST (a thinking model with tools), not
 * from whether we have ever sent reasoning. Once a turn's reasoning is dropped —
 * thread trimming, a mid-turn continuation that rebuilds the thread, a provider
 * that omitted it for one step — the predicate above went quiet exactly when the
 * rule started applying, and the loop retried the same invalid request (3-4
 * "Model call failed mid-turn — resuming" lines per bench turn, each with a fresh
 * request_id).
 *
 * Hence two ways to arm it: the thread's own evidence (predictive, unchanged), or
 * the endpoint's rejection (`force`, applied once on a `isReasoningReplayRejection`
 * and retried). The rejection is the reliable signal — it is the API stating the
 * invariant, not us guessing which models enforce it — and it costs no extra
 * model round trip, because the retry replaces a call that had already failed.
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
 * What a CONTENT-ONLY gap is filled with.
 *
 * The endpoint's rule turned out to cover every assistant turn, not only the
 * tool-call ones (measured 2026-10-29, see the module header): a thread with
 * reasoning on one turn and a plain prose turn without it is rejected just the
 * same. The placeholder is worded for the turn it lands on, because the model
 * reads it back and must not be told something false.
 */
export const REASONING_NOT_RETAINED_TURN = '(reasoning for this turn was not retained)';

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
 * Is this the endpoint enforcing the replay rule?
 *
 * Matched on the provider's own words, not on a provider or model name: any
 * endpoint that enforces the contract says so (DeepSeek's exact text is above;
 * gateways in front of it relay the same sentence), and one that does not can
 * never match. 400 and 422 are the codes an integration proxy uses for an
 * invalid request body.
 */
export function isReasoningReplayRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /reasoning_content/i.test(body) && /pass(?:ed)?\s*back|must be passed/i.test(body);
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
  opts: {
    /**
     * Fill even when the thread shows no reasoning. Set ONLY in response to the
     * endpoint rejecting the request for a missing `reasoning_content`: the API
     * has then stated the rule itself, and a thread that lost its reasoning is
     * exactly the case the evidence-based check cannot see.
     */
    force?: boolean;
  } = {},
): { messages: readonly ToolMessage[]; filled: number } {
  if (!opts.force && !conversationCarriesReasoning(messages)) return { messages, filled: 0 };

  let filled = 0;
  const out = messages.map((m) => {
    if (m.role !== 'assistant') return m;
    if (m.reasoningContent) return m;
    filled += 1;
    // EVERY assistant turn, not only the tool-call ones. Measured against the
    // endpoint: a thinking conversation with reasoning on one turn and a plain
    // prose turn without it is rejected exactly like a missing tool-call
    // reasoning (400, same sentence). Filling only the tool-call turns is what
    // made the first repair of this rule incomplete — the loop kept failing on
    // the turn that carried the answer.
    return {
      ...m,
      reasoningContent: m.toolCalls && m.toolCalls.length > 0 ? REASONING_NOT_RETAINED : REASONING_NOT_RETAINED_TURN,
    };
  });

  return { messages: filled > 0 ? out : messages, filled };
}
