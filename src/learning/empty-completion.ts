/**
 * WHY DID A STEP COME BACK WITH NOTHING?
 *
 * Every empty completion used to take the same road: counted as a provider
 * failure, the pair excluded for two minutes, the model's error rate raised, and
 * the turn handed to whatever else was configured. That is the right answer for
 * a dead endpoint and the WRONG answer for a reasoning model that spent its
 * entire output budget thinking — which is the exact shape `deepseek-v4-flash`
 * and `deepseek-v4-pro` produce. Measured: a `deepseek-v4-pro` step returned
 * `content: ''`, `reasoning_content` tens of thousands of characters long and
 * `finish_reason: 'length'`; the turn read that as "the provider returned
 * nothing", dropped a working model, and answered from something weaker.
 *
 * The wire already states which of those two happened, in fields the tool path
 * carries (`finishReason`, `reasoningContent`, `usage`) and the string path
 * discards. This module is the one place that reads them, so every seam reaches
 * the same verdict from the same evidence:
 *
 *   - `reasoning-budget` — reasoning was produced and the cap ended the step.
 *     The model was WORKING; re-ask the SAME pair with more room.
 *   - `output-budget` — the cap ended the step without captured reasoning
 *     (a truncated answer, or a provider that does not echo its thinking).
 *     Same remedy: more room, not a different model.
 *   - `no-answer` — a clean stop (or no finish reason at all) carrying nothing.
 *     No evidence of exhaustion, so the pair must be probed before it is judged.
 *   - `no-evidence` — the response carried no diagnostics whatsoever. Cannot
 *     attribute the empty, and must not pretend to: probe, then decide.
 *
 * PURE. No clock, no I/O, no registry. The caller supplies what the wire said;
 * the tests below are the whole policy table.
 */

/** What the transport reported about the step that carried nothing. */
export interface EmptyCompletionEvidence {
  /** The provider's `finish_reason`, when reported. `'length'` = cut at the cap. */
  finishReason?: string;
  /** Characters of `reasoning_content` the model produced (0 when none). */
  reasoningChars?: number;
  /** Characters of assistant CONTENT — expected 0; kept so the caller's trim is explicit. */
  contentChars?: number;
  /** The provider's own completion tokens for this step, when reported. */
  completionTokens?: number;
  /** The output cap THIS request sent (`max_tokens`), when known. */
  maxTokens?: number;
}

export type EmptyCompletionCause =
  | 'reasoning-budget'
  | 'output-budget'
  | 'no-answer'
  | 'no-evidence';

/**
 * What the caller should DO about it.
 *
 *   - `retry-same-pair-larger-budget` — the model proved it was producing
 *     tokens and the cap stopped it. Re-asking a DIFFERENT model here is how a
 *     working model gets silently replaced; re-ask the same pair once with more
 *     room.
 *   - `probe-then-retry` — nothing proves exhaustion. Ask the pair a one-word
 *     question: an answer proves it is up (retry the same pair), a refusal
 *     proves it is not (rotate with evidence), a timeout proves nothing (fall
 *     back to the existing patience policy).
 *   - `treat-as-failure` — reserved for callers that have no probe available.
 */
export type EmptyCompletionRecommendation =
  | 'retry-same-pair-larger-budget'
  | 'probe-then-retry'
  | 'treat-as-failure';

export interface EmptyCompletionDiagnosis {
  cause: EmptyCompletionCause;
  /** True only when the wire itself proves the output cap ended the step. */
  budgetExhausted: boolean;
  recommendation: EmptyCompletionRecommendation;
  /** The evidence the verdict rests on, as a short human phrase. */
  evidence: string;
  /** One sentence naming what happened — for the trace and the visible line. */
  summary: string;
}

/** Smallest output budget escalation. A 4K default starves a thinking model. */
export const MIN_ESCALATED_OUTPUT_TOKENS = 8_192;

/** Ceiling for the escalation — generous, but never unbounded. */
export const MAX_ESCALATED_OUTPUT_TOKENS = 32_768;

/**
 * The budget to use on the retry of a truncated step.
 *
 * Doubles what the pair actually consumed (so a model that used 4K gets 8K) with
 * a floor that clears the usual CoT budget, and a ceiling that keeps one bad
 * model from asking for a million tokens. `used` may be unknown (finish_reason
 * said `length` but the provider reported no usage): then escalate from the
 * request's own cap, or from the floor.
 */
export function escalatedOutputBudget(used?: number, requested?: number): number {
  const basis = Math.max(used ?? 0, requested ?? 0);
  const doubled = basis > 0 ? basis * 2 : MIN_ESCALATED_OUTPUT_TOKENS;
  return Math.min(MAX_ESCALATED_OUTPUT_TOKENS, Math.max(MIN_ESCALATED_OUTPUT_TOKENS, doubled));
}

/** Which step-level evidence proves the cap ended the response. */
function budgetProof(e: EmptyCompletionEvidence): { exhausted: boolean; evidence: string } {
  const completion = typeof e.completionTokens === 'number' ? e.completionTokens : undefined;
  const cap = typeof e.maxTokens === 'number' && e.maxTokens > 0 ? e.maxTokens : undefined;
  if (e.finishReason === 'length') {
    const tokens = completion !== undefined && cap !== undefined ? `${completion}/${cap} tokens` : 'no usage reported';
    return { exhausted: true, evidence: `finish_reason "length" (${tokens})` };
  }
  if (completion !== undefined && cap !== undefined && completion >= cap) {
    return { exhausted: true, evidence: `completion hit the cap (${completion}/${cap} tokens)` };
  }
  return { exhausted: false, evidence: 'no cap evidence reported' };
}

/**
 * Decide what an empty step actually means.
 *
 * Order matters: hard cap evidence first (it is provable), then a reasoning
 * trace with no answer and no cap evidence (probe — a shape is not a proof),
 * then a clean stop with nothing (probe), then no diagnostics at all (probe —
 * never guess). The rule throughout: rotate on evidence, never on a guess.
 */
export function diagnoseEmptyCompletion(e: EmptyCompletionEvidence = {}): EmptyCompletionDiagnosis {
  const reasoningChars = Math.max(0, e.reasoningChars ?? 0);
  const contentChars = Math.max(0, e.contentChars ?? 0);
  const { exhausted, evidence } = budgetProof(e);

  if (exhausted && reasoningChars > 0) {
    return {
      cause: 'reasoning-budget',
      budgetExhausted: true,
      recommendation: 'retry-same-pair-larger-budget',
      evidence: `${evidence}, ${reasoningChars} chars of reasoning and no answer`,
      summary:
        'the model spent its entire output budget thinking — the step was cut at the cap, ' +
        'not dropped by the provider',
    };
  }

  if (exhausted) {
    return {
      cause: 'output-budget',
      budgetExhausted: true,
      recommendation: 'retry-same-pair-larger-budget',
      evidence,
      summary: 'the provider cut the step at its output-token cap, so nothing usable was left',
    };
  }

  // Reasoning with no answer and NO cap evidence is a SHAPE, not a proof. It is
  // tempting to call it an exhausted budget, but the module's whole point is not
  // to claim what the wire did not say: probe first, then re-ask if the pair is
  // alive. (With `finish_reason: 'length'` or usage at the cap, the branch above
  // already retries with a larger budget on hard evidence.)
  if (reasoningChars > 0 && contentChars === 0) {
    return {
      cause: 'no-answer',
      budgetExhausted: false,
      recommendation: 'probe-then-retry',
      evidence: `${reasoningChars} chars of reasoning and no answer, cap not reported`,
      summary: 'the model produced reasoning and then finished with no answer',
    };
  }

  if (e.finishReason !== undefined || e.completionTokens !== undefined || contentChars > 0) {
    return {
      cause: 'no-answer',
      budgetExhausted: false,
      recommendation: 'probe-then-retry',
      evidence: e.finishReason ? `finish_reason "${e.finishReason}" with no content` : 'a clean completion with no content',
      summary: 'the provider finished the step cleanly but carried no answer text and no tool call',
    };
  }

  return {
    cause: 'no-evidence',
    budgetExhausted: false,
    recommendation: 'probe-then-retry',
    evidence: 'the response carried no finish reason, usage or reasoning',
    summary: 'the provider returned nothing and said nothing about why',
  };
}
