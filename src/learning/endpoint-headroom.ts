/**
 * ENDPOINT HEADROOM — "can THIS provider × model still serve the next call?"
 *
 * THE GAP THIS CLOSES. The registry already carries quota TELEMETRY per pair —
 * `remainingTokens` in the current window, mirrored from the quota ledger — and
 * the models list prints it. Routing never read it: `scoreModelOnProvider` only
 * knew `quotaParkedUntil`, a binary that flips *after* the window is gone. So an
 * endpoint with 200 tokens left and 4 minutes to reset scored identically to one
 * with 2M tokens left, and the model with the cheaper endpoint won on `costScore`
 * — the free tier was chosen, the task ran dry mid-way, and the walk only moved
 * to the paid twin after a wasted call.
 *
 * WHAT THIS IS NOT. It is not a budget planner and not an exclusion. It never
 * removes a candidate, never touches `capabilityFit`, and never zeroes a pair:
 * a short window is a fact about the NEXT call, not a verdict about the model.
 * The worst it can do is rank an endpoint that literally cannot serve the call
 * below its own twin — which is the same model, so no capability is lost.
 *
 * THE MEASUREMENT RULE. `remainingTokens` is only present when the provider's
 * window actually has a token limit configured (`-1`/absent means "no limit
 * recorded"). With no measurement this module returns `score: 1` and changes
 * nothing, which is why enabling it is inert on a machine with no configured
 * token windows — verified on the live registry: 0 of 595 entries measured.
 */

import type { ModelRegistryEntry } from './model-registry.js';

/**
 * Assumed tokens for one call when nothing has been measured: input plus the
 * answer that spends the same window. Deliberately modest — an over-estimate
 * would demote a small-but-usable window, which costs money for no gain.
 */
export const DEFAULT_CALL_TOKENS = 8_000;

/** Calls of headroom at which the endpoint is simply "not short". */
export const AMPLE_HEADROOM_CALLS = 4;

/**
 * The floor a short window lands on. Not 0: a pair whose window is nearly gone
 * is still callable if everything else fails, and the walk must be able to reach
 * it. This dimension RANKS; `isCandidateAvailable` decides reachability.
 */
export const SHORT_HEADROOM_FLOOR = 0.15;

/** What one endpoint's remaining window can do for the next call. */
export interface EndpointHeadroom {
  /**
   * 0–1, where 1 means "no measured shortfall". Usable as a scoring dimension:
   * only a MEASURED, insufficient window can lower it.
   */
  score: number;
  /** Tokens left in the window, or -1 when no limit is recorded. */
  remainingTokens: number;
  /** Tokens the next call is expected to spend (measured EMA, else a default). */
  demandTokens: number;
  /** Whole calls the window can still serve, when it is measured. */
  calls: number | undefined;
  /** True when the number came from the ledger rather than a default. */
  measured: boolean;
  /** Plain-language basis, so a report never has to guess why the score moved. */
  reason: string;
}

/**
 * Tokens one call is expected to spend.
 *
 * Measured first: the registry keeps rolling EMAs of provider-reported input and
 * output tokens per call (`measuredInputTokens`/`measuredOutputTokens`), which is
 * the only evidence about THIS pair's real call size. Without them, fall back to
 * the task's own input estimate padded for the answer it will spend out of the
 * same window — never below {@link DEFAULT_CALL_TOKENS}.
 */
export function nextCallDemandTokens(
  entry?: ModelRegistryEntry,
  taskInputTokens?: number,
): number {
  const measuredIn = entry?.measuredInputTokens ?? 0;
  const measuredOut = entry?.measuredOutputTokens ?? 0;
  const hasMeasured = (entry?.measuredSamples ?? 0) > 0 && measuredIn + measuredOut > 0;
  if (hasMeasured) return Math.max(1, Math.ceil(measuredIn + measuredOut));

  const declared = typeof taskInputTokens === 'number' && Number.isFinite(taskInputTokens)
    ? Math.max(0, taskInputTokens)
    : 0;
  return Math.max(DEFAULT_CALL_TOKENS, Math.ceil(declared * 1.5));
}

/**
 * Measure one endpoint's headroom for the next call.
 *
 * Decision order, most specific fact first:
 *   1. PARKED      → 0. The window is known to be rejected right now (scoring
 *                    already gives this 0; kept here so the two cannot disagree).
 *   2. UNMEASURED  → 1. No limit recorded for this provider's window ⇒ no claim,
 *                    byte-for-byte the pre-existing behaviour.
 *   3. AMPLE       → 1. Four or more calls left is not a shortage.
 *   4. SHORT       → `calls / AMPLE_HEADROOM_CALLS`, floored at
 *                    {@link SHORT_HEADROOM_FLOOR}.
 */
export function endpointHeadroom(
  entry: ModelRegistryEntry | undefined,
  demandTokens: number = nextCallDemandTokens(entry),
  now: number = Date.now(),
): EndpointHeadroom {
  const demand = Math.max(1, Math.ceil(demandTokens));
  const unknown = (reason: string): EndpointHeadroom => ({
    score: 1,
    remainingTokens: -1,
    demandTokens: demand,
    calls: undefined,
    measured: false,
    reason,
  });

  if (!entry) return unknown('no registry row — headroom unknown');
  if (entry.quotaParkedUntil > now) {
    return {
      score: 0,
      remainingTokens: typeof entry.remainingTokens === 'number' ? entry.remainingTokens : -1,
      demandTokens: demand,
      calls: 0,
      measured: true,
      reason: 'quota-parked',
    };
  }

  const remaining = typeof entry.remainingTokens === 'number' ? entry.remainingTokens : -1;
  if (remaining < 0) return unknown('no window limit recorded');

  const calls = Math.floor(remaining / demand);
  if (calls >= AMPLE_HEADROOM_CALLS) {
    return {
      score: 1,
      remainingTokens: remaining,
      demandTokens: demand,
      calls,
      measured: true,
      reason: `${calls} calls of headroom`,
    };
  }

  return {
    score: Math.max(SHORT_HEADROOM_FLOOR, calls / AMPLE_HEADROOM_CALLS),
    remainingTokens: remaining,
    demandTokens: demand,
    calls,
    measured: true,
    reason:
      calls === 0
        ? `cannot carry the next call (~${demand} tokens needed, ${remaining} left)`
        : `only ${calls} call(s) of headroom (~${demand} tokens each, ${remaining} left)`,
  };
}
