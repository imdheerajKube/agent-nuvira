/**
 * Can the router use this model RIGHT NOW — and if not, what exactly is wrong?
 *
 * WHY THIS MODULE EXISTS. The dashboard's Discovery Timeline answered that
 * question three different ways on one screen and they disagreed: the summary
 * cards and the filter classified on PROBE age (`lastProbedAt`), while each
 * row's badge checked verification `status` first. MEASURED on a real profile:
 * 555 tracked models, 17 verified, and 531 probed within 7 days — so the "Fresh
 * (531)" card opened a list in which 514 rows read "Unverified". Nothing was
 * broken and nothing agreed.
 *
 * The deeper fault was the question. "Fresh" and "unverified" are not two
 * answers to one question, they are two different questions:
 *
 *   - `lastProbedAt` — is the provider still listing this id? (discovery)
 *   - `status` / `lastVerifiedAt` — has a real turn been proven to work on it?
 *     (routing eligibility)
 *
 * A model can be freshly probed and never verified (the common case: a provider
 * lists hundreds of ids, none tried), or verified and long unprobed. Flattening
 * both into one label is what produced the contradiction, so this module keeps
 * them apart and names each state for what it actually is.
 *
 * THE ROUTING VERDICT IS NOT RE-DERIVED HERE. `classifyReachability` mirrors
 * `ModelRegistry.isUsable()` clause for clause, in its order, including the
 * subtlety that a verified model is blocked only by a MODEL-level park
 * (`providerParked === false`) and never by a provider-level one. Two copies of
 * this rule is exactly the divergence that made the Models page present a
 * listing as availability (see that panel's own history), so `routable` here
 * means "isUsable() would return true" and nothing else.
 */

import { DEFAULT_STALE_MS } from './model-registry.js';

/**
 * What the router would do with this model right now.
 *
 * An enum rather than a boolean because "not routable" is four different
 * situations behind one word, and they need opposite actions from a user:
 * one is unknown and will be resolved by a spot-check, one is proven dead, one
 * clears itself, and one is repaired by re-probing.
 */
export type ModelReachability =
  /** Verified, un-parked, verified within the staleness window — `isUsable() === true`. */
  | 'routable'
  /** Verified, but resting on a MODEL-level quota park. Clears by itself. */
  | 'parked'
  /** Verified, but the proof is older than `DEFAULT_STALE_MS` (7d) — re-probe to restore. */
  | 'proof-expired'
  /** `unavailable`: a real call established this id does not work here. */
  | 'proven-dead'
  /** `unverified`: the provider lists it and nothing has ever succeeded on it. NOT a failure. */
  | 'never-verified';

/** The subset of a registry entry this classifier reads. */
export interface ReachabilityInput {
  status: string;
  lastVerifiedAt?: number;
  quotaParkedUntil?: number;
  providerParked?: boolean;
}

/**
 * Mirror of `ModelRegistry.isUsable()`, clause for clause and in the same order.
 *
 * Order is load-bearing and is NOT the order you would guess: a model that is
 * `unavailable` AND parked reads as `proven-dead`, because the status check
 * comes first. Keeping the two functions adjacent in shape is what makes them
 * diffable by eye.
 */
export function classifyReachability(
  entry: ReachabilityInput,
  now: number = Date.now(),
): ModelReachability {
  if (entry.status !== 'verified') {
    return entry.status === 'unavailable' ? 'proven-dead' : 'never-verified';
  }
  // Model-specific park only — a provider-wide park deliberately does NOT
  // exclude a proven model (the "Gemini parking bug").
  const parkedUntil = entry.quotaParkedUntil ?? 0;
  if (parkedUntil > now && entry.providerParked === false) return 'parked';
  const verifiedAt = entry.lastVerifiedAt ?? 0;
  if (now - verifiedAt > DEFAULT_STALE_MS) return 'proof-expired';
  return 'routable';
}

/** How a state is worded. One place, so the page and any CLI cannot drift. */
export const REACHABILITY_COPY: Record<ModelReachability, { label: string; blurb: string; color: string }> = {
  routable: {
    label: 'Routable',
    blurb: 'Verified within 7 days and not parked — the router can pick this now.',
    color: '#3fb950',
  },
  parked: {
    label: 'Parked',
    blurb: 'Resting on a model-level quota window. It re-enters routing on its own when the window lapses.',
    color: '#d29922',
  },
  'proof-expired': {
    label: 'Proof expired',
    blurb: 'Was verified, but not within the last 7 days, so the registry no longer offers it. A re-probe restores it.',
    color: '#d29922',
  },
  'proven-dead': {
    label: 'Proven dead',
    blurb: 'A real call established this id does not work here — re-probing will not fix it.',
    color: '#f85149',
  },
  'never-verified': {
    label: 'Never verified',
    blurb:
      'The provider lists this id and nothing has ever been tried against it. This is an unknown, not a failure — ' +
      'background spot-checks work through these a few at a time.',
    color: '#58a6ff',
  },
};

/** Would the router pick this model right now? The one question routing asks. */
export function isRoutable(reachability: ModelReachability): boolean {
  return reachability === 'routable';
}

/**
 * Is the provider still listing this id?
 *
 * Deliberately separate from reachability: probe age says nothing about whether
 * a turn would work, and reachability says nothing about whether the model still
 * exists in the catalog. The old page treated them as one axis.
 */
export type ModelFreshness = 'fresh' | 'stale' | 'likely-removed';

/** Probe-age thresholds. Kept here so the numbers are stated once. */
export const FRESH_DAYS = 7;
export const REMOVED_DAYS = 30;
/** Error rate above which a long-unprobed model reads as actually gone. */
export const REMOVED_ERROR_RATE = 0.5;

export function classifyFreshness(
  lastProbedAt: number | undefined,
  errorRate: number | undefined,
  now: number = Date.now(),
): ModelFreshness {
  if (!lastProbedAt) return 'likely-removed';
  const days = (now - lastProbedAt) / (24 * 60 * 60 * 1000);
  if (days > REMOVED_DAYS && (errorRate ?? 0) > REMOVED_ERROR_RATE) return 'likely-removed';
  return days > FRESH_DAYS ? 'stale' : 'fresh';
}

/** How a freshness state is worded. */
export const FRESHNESS_COPY: Record<ModelFreshness, { label: string; blurb: string; color: string }> = {
  fresh: { label: 'Fresh', blurb: `Probed within ${FRESH_DAYS} days.`, color: '#3fb950' },
  stale: { label: 'Stale', blurb: `Not probed for over ${FRESH_DAYS} days.`, color: '#d29922' },
  'likely-removed': {
    label: 'Likely removed',
    blurb: `Not probed for over ${REMOVED_DAYS} days and failing — probably gone from the provider.`,
    color: '#f85149',
  },
};
