/**
 * Model capability (`src/learning/model-capability.ts`) — a deterministic,
 * provider-agnostic estimate of how much REASONING a model id implies, from its
 * own name.
 *
 * WHY THIS EXISTS
 * ---------------
 * The registry's model ranking (`preferredModelsFor`) is a HEALTH ranking:
 * error rate, then latency, then recency. That is the right question for "which
 * of two known-good models wastes less of the user's time", and it is the WRONG
 * question for "which model can actually do this work" — a 2-7B toy answers in
 * 124ms with a 0% error rate, so it sorts FIRST, ahead of a 27B or a 120B that
 * is slower and has ever been rate-limited once. Found live: a pinned
 * `openai/gpt-oss-120b` was quota-parked for one window, the router repaired it
 * to the healthiest sibling, and the "best available model" became
 * `allam-2-7b` — the weakest model the provider serves.
 *
 * The router's own capability profiles live PER PROVIDER (`auto-router.ts`),
 * which is the wrong grain here: this needs to compare two models the SAME
 * provider is already known to serve. So this module answers exactly that one
 * question, by name, and nothing else.
 *
 * IT IS A HEURISTIC, AND IT IS ONLY USED TO PREVENT A DOWNGRADE. It never
 * upgrades a selection on its own, never excludes a model, and is never the
 * sole reason a model is picked: it is a tie-break layer used by `model-validator`
 * when a DEAD pin must be repaired, so "repair" cannot mean "silently replace a
 * strong model with a weak one when a comparable sibling is right there".
 *
 * NOTHING HERE NAMES A MODEL. It reads parameter counts (`120b`, `27b`, `e4b`,
 * `a4b`) and family/qualifier words (`pro`, `opus`, `sonnet`, `flash`,
 * `flash-lite`, `mini`, `nano`, `lite`, `small`, `tiny`). A model whose name
 * carries no signal reads as the neutral 0.55 — an unknown is not a failure,
 * and must not be treated as one.
 */

/** Capability bands, so callers reason in human terms rather than raw floats. */
export type CapabilityBand = 'high' | 'medium' | 'low';

/** The band boundaries. `high` is the same 0.7 the router's reasoning floor uses. */
export const CAPABILITY_HIGH_MIN = 0.7;
export const CAPABILITY_MEDIUM_MIN = 0.45;

/** The neutral score for a model id that carries no capability signal at all. */
export const NEUTRAL_CAPABILITY = 0.55;

/** Family/qualifier words that imply a stronger model (added, then capped). */
const STRONG_QUALIFIER_RE = /\b(?:pro|opus|sonnet|max|large|xl|ultra|reasoning|think)\b/i;

/**
 * Family/qualifier words that imply a SMALLER/faster model (subtracted). These
 * are the ids that legitimately win a health ranking and must not be mistaken
 * for a capability match: `flash-lite`, `mini`, `nano`, and friends.
 */
const SMALL_QUALIFIER_RE = /\b(?:flash[- ]?lite|mini|nano|micro|tiny|small|lite|light|instant|speed)\b/i;
/** A single `flash`/`fast` tier: capable-ish but deliberately cheap. */
const FAST_TIER_RE = /\b(?:flash|fast|turbo)\b/i;

/**
 * Parameter-count candidates in a model id. Matches `120b`, `27b`, `e4b`,
 * `a4b`, `8x7b` (the LAST group is the operative size), `70B`. Deliberately does
 * NOT match a bare version like `3.1` — that is a release number, not a size.
 */
function parameterCount(modelId: string): number | undefined {
  const id = modelId.toLowerCase();
  const matches = [...id.matchAll(/(\d+(?:\.\d+)?)\s*b\b/g)];
  if (matches.length === 0) return undefined;
  // The LAST `<n>b` is the model's size (`mixtral-8x7b` → 7, `qwen3.8-27b` → 27).
  const last = matches[matches.length - 1][1];
  const n = Number.parseFloat(last);
  return Number.isFinite(n) ? n : undefined;
}

/** A size → capability mapping aligned with the router's own calibration
 *  (`MAX_CAPABILITY_MIN_REASONING` documents "a 70B id ≈ 0.80"). */
function capabilityForSize(params: number): number {
  if (params >= 70) return 0.8;
  // A ~20-70B dense model is a genuinely capable model, in the same band the
  // router's reasoning floor is calibrated for — a 27B must NOT read as a
  // downgrade from a 120B, or the "don't drop a band" rule would help nothing.
  if (params >= 20) return 0.72;
  if (params >= 8) return 0.6;
  if (params >= 4) return 0.45;
  return 0.3;
}

/**
 * Estimate a model's reasoning capability from its id, as a 0–1 score.
 *
 * Deterministic and pure. Signals are combined by taking the STRONGEST evidence
 * (a model is as capable as its best signal says), because a name like
 * `gemini-3.1-pro-preview` is not discounted for lacking a parameter count.
 */
export function estimateModelCapability(modelId: string | undefined): number {
  const id = (modelId || '').trim();
  if (!id || id === 'default') return NEUTRAL_CAPABILITY;

  const candidates: number[] = [];

  // 1. Size, when the id names one.
  const params = parameterCount(id);
  if (params !== undefined) candidates.push(capabilityForSize(params));

  // 2. Family/qualifier words.
  if (STRONG_QUALIFIER_RE.test(id)) candidates.push(0.85);
  if (SMALL_QUALIFIER_RE.test(id)) candidates.push(0.4);
  // A plain fast tier (not already matched by the lite/small set).
  if (FAST_TIER_RE.test(id) && !SMALL_QUALIFIER_RE.test(id)) candidates.push(0.75);

  // A name with no recognisable signal is an unknown — neutral, never low.
  if (candidates.length === 0) return NEUTRAL_CAPABILITY;
  return Math.max(...candidates);
}

/** The band a capability score falls in. */
export function capabilityBand(score: number): CapabilityBand {
  if (score >= CAPABILITY_HIGH_MIN) return 'high';
  if (score >= CAPABILITY_MEDIUM_MIN) return 'medium';
  return 'low';
}

/** True when the model id implies a high-reasoning model. */
export function isHighCapabilityModel(modelId: string | undefined): boolean {
  return capabilityBand(estimateModelCapability(modelId)) === 'high';
}

/** Ordered rank of a band, for "at least as capable as" comparisons. */
const BAND_ORDER: Record<CapabilityBand, number> = { low: 0, medium: 1, high: 2 };

/**
 * Filter a HEALTH-ORDERED candidate list down to the models that are at least
 * as capable as `requestedModel` (same band or higher), preserving the input
 * order.
 *
 * The purpose is narrow and deliberate: when a DEAD pin must be repaired, the
 * replacement must not silently drop a capability band. If the health-first
 * candidate is in a lower band than the request, the at-least-as-capable
 * candidates are the honest set to choose from; if NO candidate reaches the
 * requested band (the provider simply has nothing comparable — `allam-2-7b`
 * while every strong sibling is rate-limited), the FULL list is returned so the
 * repair still makes the best attempt and never dead-ends.
 *
 * Candidate order is preserved, so this only ever NARROWS the health ranking —
 * it can never invent a preference the health ordering did not already hold.
 */
export function nonDowngradeCandidates(
  requestedModel: string | undefined,
  candidates: readonly string[],
): string[] {
  if (candidates.length === 0) return [];
  const wantRank = BAND_ORDER[capabilityBand(estimateModelCapability(requestedModel))];
  const atLeast = candidates.filter(
    (m) => BAND_ORDER[capabilityBand(estimateModelCapability(m))] >= wantRank,
  );
  return atLeast.length > 0 ? atLeast : [...candidates];
}
