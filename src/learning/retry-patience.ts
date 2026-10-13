/**
 * Blip patience — how long to STAY on the pair that just failed, and whether
 * walking away is even a remedy.
 *
 * THE OBSERVED PROBLEM THIS ENCODES. A cloud provider does not go down for a
 * turn: it returns 200, then a few empty/5xx responses for a handful of seconds,
 * then serves normally again (measured repeatedly on `deepseek`). Two opposite
 * mistakes are available, and the codebase has made both:
 *
 *   - FAIL FAST: give up after seconds and fold onto the next candidate — which
 *     for that blip means silently dropping from a strong model to a weak one.
 *     The result is answered, badly, by a model the user did not choose.
 *   - WAIT BLINDLY: sit out a long fixed backoff on a pair that is actually
 *     dead, and make every user of a broken provider pay for it.
 *
 * A timeout cannot tell those apart, so a fixed schedule is the wrong shape
 * either way. What CAN tell them apart is the evidence already in hand:
 *
 *   1. THE ALTERNATIVES. Walking away is only a remedy when it does not cost
 *      quality. If every alternative sits in a LOWER capability band, then
 *      "fail over" means "de-escalate", and for a blip that is the worse trade —
 *      so we wait instead. If a same-or-better band is reachable, failing over is
 *      free and waiting is pure waste.
 *   2. THE PAIR'S TRACK RECORD. A pair that has served real traffic with a low
 *      error rate earns patience; a never-proven id does not.
 *   3. THE SHAPE OF THE FAILURE. One failing step is a blip. The SAME pair
 *      failing two steps in a row is not — patience collapses there, whatever
 *      the alternatives look like.
 *
 * And the schedule's SHAPE matters as much as its total: a 2-second blink is
 * caught by a retry at t≈1s, not at t=5s, so the early delays are dense and the
 * late ones sparse ({@link TRANSIENT_BLIP_DELAYS_MS} → attempts at ≈1, 3, 7, 15,
 * 30, 60s). That rides out both a blink and a real minute-long spike.
 *
 * PURE AND DETERMINISTIC. This module reads no clock, no registry and no config:
 * the caller gathers the evidence (it has the registry and the ranked pool) and
 * gets back a plan it can log. That is what makes the policy reviewable and
 * testable one row at a time — see the table in the tests.
 */

import { bandRank, capabilityClassOf, type CapabilityBand } from './model-capability.js';

/**
 * Transient (server/network/timeout) backoff, dense early and sparse late:
 * attempts at ≈1s, 3s, 7s, 15s, 30s, 60s. Used exactly when WAITING beats
 * walking away — no alternative, or only degrading ones.
 */
export const TRANSIENT_BLIP_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/**
 * Transient backoff when a same-or-better-band candidate IS reachable: a short
 * courtesy retry (two blinks' worth, <2s) and then the walk. Spending longer is
 * waste — the replacement costs nothing in quality.
 */
export const TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS = [500, 1_500] as const;

/**
 * Transient backoff for a pair we have no reason to trust and no alternative to:
 * a token wait (≈5s), then the honest failure.
 */
export const TRANSIENT_LAST_RESORT_DELAYS_MS = [1_000, 4_000] as const;

/** Empty-response patience for a proven pair — the "final verse" case. */
export const EMPTY_PATIENCE_MS = [2_000, 5_000] as const;

/**
 * Empty-response patience when EVERY alternative would de-escalate. Longer, and
 * deliberately so: this is the one situation where the choice is literally
 * "wait a few more seconds" vs "answer with a weaker model".
 */
export const EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS = [2_000, 5_000, 10_000] as const;

/**
 * Error rate at or below which a verified pair counts as a proven track record.
 * Above it the pair has failed roughly 1 call in 5, which is not something a
 * blip explains away.
 */
export const PROVEN_ERROR_RATE_MAX = 0.2;

/** Registry evidence for the failing pair, as the caller reads it. */
export interface PatienceEvidence {
  /** `status === 'verified'` in the Model Availability Registry. */
  verified: boolean;
  /**
   * Where that verification came from. Real traffic (`telemetry`) is strong
   * evidence; a bare catalog `probe` is not (it proves the id exists, nothing
   * about answers), so it cannot on its own earn the long patience.
   */
  source?: 'telemetry' | 'spot-check' | 'probe';
  /** Rolling error rate 0–1, when recorded. */
  errorRate?: number;
}

export interface PatienceInput {
  /** The pair that just failed. */
  current: { provider: string; model: string };
  /**
   * The pairs this surface could switch to, best first (provider + the model it
   * would actually serve). Empty = this surface has nowhere else to go — a
   * pinned turn, a single configured provider, the last candidate.
   */
  alternatives: ReadonlyArray<{ provider: string; model: string }>;
  /** Registry evidence for {@link current}; omit when nothing is recorded. */
  evidence?: PatienceEvidence;
  /** Did this pair already fail an EARLIER step of this same turn? */
  failedEarlierStep?: boolean;
  /** Has this turn already produced completed tool work? */
  deliveredWorkThisTurn?: boolean;
}

export interface PatiencePlan {
  /** Schedule for server/network/timeout failures (`[]` = do not retry). */
  transientDelaysMs: readonly number[];
  /** Schedule for an `empty-response` (`[]` = do not retry). */
  emptyResponseDelaysMs: readonly number[];
  /** The strongest band reachable elsewhere, when an alternative exists. */
  bestAlternativeBand?: CapabilityBand;
  /**
   * True when we are deliberately WAITING rather than folding down a band —
   * the situation the log line exists to make visible.
   */
  foldingWouldDegrade: boolean;
  /** Why this plan — printed once, so a slow turn is explainable after the fact. */
  reason: string;
}

/** Is the registry evidence strong enough to grant a pair extra patience? */
function hasProvenTrackRecord(evidence: PatienceEvidence | undefined): boolean {
  if (!evidence?.verified) return false;
  if ((evidence.errorRate ?? 0) > PROVEN_ERROR_RATE_MAX) return false;
  // A `probe` (catalog listing) is not evidence about answers; `telemetry` and
  // `spot-check` are.
  return evidence.source !== 'probe';
}

/**
 * Decide how patient to be with the pair that just failed, and say why.
 *
 * The whole policy, in order (see the tests for each row):
 *
 *   1. The pair already failed an earlier step of this turn → NOT a blip. One
 *      token wait, no empty patience.
 *   2. Nothing to gain by patience: a same-or-better band is reachable → short
 *      transient retry; empty patched only for a proven pair (a good pair's
 *      first blink is still worth two short waits).
 *   3. A PROVEN pair facing only degrading alternatives (or none) → long, dense
 *      transient patience, and extended empty patience. This is the row that
 *      stops a blinking strong model from being replaced by a weak one.
 *   4. An UNPROVEN pair with nowhere better to go → a token wait; the walk (or
 *      the honest failure) is the remedy, not optimism about a stranger.
 */
export function planBlipPatience(input: PatienceInput): PatiencePlan {
  const currentBand = capabilityClassOf(input.current.model);
  const currentRank = bandRank(currentBand);

  let bestRank = -1;
  let bestAlternativeBand: CapabilityBand | undefined;
  for (const alternative of input.alternatives) {
    if (!alternative?.model) continue;
    const band = capabilityClassOf(alternative.model);
    const rank = bandRank(band);
    if (rank > bestRank) {
      bestRank = rank;
      bestAlternativeBand = band;
    }
  }

  const hasAlternative = bestRank >= 0;
  const sameOrBetterReachable = bestRank >= currentRank;
  const foldingWouldDegrade = hasAlternative && !sameOrBetterReachable;
  const proven = hasProvenTrackRecord(input.evidence) || input.deliveredWorkThisTurn === true;

  // 1. Two failing steps in a row is a pattern, not a blip.
  if (input.failedEarlierStep) {
    return {
      transientDelaysMs: TRANSIENT_LAST_RESORT_DELAYS_MS,
      emptyResponseDelaysMs: [],
      bestAlternativeBand,
      foldingWouldDegrade: false,
      reason: `${input.current.provider}/${input.current.model} failed an earlier step too — not a blip, so no patience`,
    };
  }

  // 2. A same-or-better candidate is reachable: failing over costs no quality.
  if (sameOrBetterReachable) {
    return {
      transientDelaysMs: TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS,
      emptyResponseDelaysMs: proven ? EMPTY_PATIENCE_MS : [],
      bestAlternativeBand,
      foldingWouldDegrade: false,
      reason: `a ${bestAlternativeBand}-band candidate is reachable — failing over costs no quality`,
    };
  }

  // 3. Waiting beats folding down a band.
  if (foldingWouldDegrade && proven) {
    return {
      transientDelaysMs: TRANSIENT_BLIP_DELAYS_MS,
      emptyResponseDelaysMs: EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS,
      bestAlternativeBand,
      foldingWouldDegrade: true,
      reason:
        `waiting on ${input.current.provider}/${input.current.model} (${currentBand}) rather than ` +
        `de-escalating to ${bestAlternativeBand} — a blip is not a reason to downgrade`,
    };
  }

  // 3b. Nowhere else to go, but the pair has a track record: waiting is the only remedy.
  if (!hasAlternative && proven) {
    return {
      transientDelaysMs: TRANSIENT_BLIP_DELAYS_MS,
      emptyResponseDelaysMs: EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS,
      bestAlternativeBand,
      foldingWouldDegrade: false,
      reason: `no alternative is configured — waiting on ${input.current.provider}/${input.current.model} is the only remedy`,
    };
  }

  // 4. Unproven pair: a token wait, then the walk or the honest failure.
  return {
    transientDelaysMs: TRANSIENT_LAST_RESORT_DELAYS_MS,
    emptyResponseDelaysMs: hasAlternative ? [] : EMPTY_PATIENCE_MS,
    bestAlternativeBand,
    foldingWouldDegrade,
    reason: hasAlternative
      ? `${input.current.provider}/${input.current.model} has no track record — the walk is the remedy`
      : `nothing is proven for ${input.current.provider}/${input.current.model} and there is no alternative`,
  };
}
