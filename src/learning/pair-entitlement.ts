/**
 * PAIR ENTITLEMENT — of two providers that both list the same model, which one
 * can actually serve it RIGHT NOW?
 *
 * THE DEFECT THIS CLOSES (reported 2026-10-07). Four providers list a DeepSeek
 * model. One key genuinely has access to it; on the others the account has no
 * model access and no free tokens. Ranking is per MODEL, so all four twins
 * present the same capability rank — and the router, ordering on rank (and, on
 * a tie, on whichever provider it happened to score first), could spend the
 * turn's first call on a pair the registry had ALREADY recorded as refused:
 * a `402 Insufficient credits` / `403` / `credit-exhausted` round trip, then a
 * failover, then the turn finally starts. Measured in run D of this programme:
 * a strict pin at `openrouter/deepseek/deepseek-v4.1-flash` failed in 6 SECONDS
 * with `402 Insufficient credits` — while `deepseek/deepseek-flash`, the same
 * model on a funded account, sat in the pool.
 *
 * The registry already knew. `ModelRegistryEntry` carries `status`,
 * `lastError`, `deadPair` and `quotaParkedUntil` for every provider × model
 * pair, and two predicates in `model-registry.ts` interpret them
 * (`isEntitlementFailure`, `isNonexistentPair`). What did not exist was a single
 * answer to "may the router call THIS PAIR", asked before the call instead of
 * after it.
 *
 * ─── DOCTRINE (read before changing the order below) ───────────────────────
 *
 * 1. **The verdict is per PAIR, never per model.** `openrouter`'s exhausted
 *    credit balance and `deepseek`'s funded account are facts about two
 *    different ACCOUNTS. Two twins may share a canonical model id and still
 *    have opposite verdicts, and each verdict is read from ITS OWN registry row.
 *    Nothing here ever infers "this provider is funded because its twin is" —
 *    that is the F6 defect (an availability verdict erased by unrelated
 *    evidence) wearing a new hat.
 * 2. **A refusal is a NO, and it is FINAL while a funded alternative exists.**
 *    `refused` means the account cannot serve this pairing: no credits, no
 *    billing, a rejected key, or the id does not exist on that endpoint. None
 *    of those are repaired by retrying, so a refused pair is never picked while
 *    anything else can be. `stalled` (a quota park, or proof that aged out) is
 *    the opposite: it clears by itself, so it stays eligible and simply sinks.
 * 3. **Never dead-end.** This module never REMOVES a candidate — it orders them
 *    (`orderByEntitlement` is a stable partition). If every provider refuses the
 *    model, the refused pairs are still there, in their old relative order, and
 *    the router can still try them. "Use every model we can actually call;
 *    reject only when nothing is left" survives.
 * 4. **Ties go to the funded twin.** The user's rule, verbatim: "the rank of a
 *    model can be the same across providers, but the agent should only pick the
 *    one which has genuine token budget available". Because the ordering is a
 *    partition applied AFTER scoring, a funded twin outranks a refused twin even
 *    when the refused twin scored higher — a rank advantage cannot buy a call
 *    that is certain to fail.
 *
 * The labels below are printed (`model explain`, the fallback chain), so an
 * operator can see WHY a twin was passed over instead of having to guess.
 */

import { DEFAULT_STALE_MS, isEntitlementFailure, isNonexistentPair } from './model-registry.js';

/**
 * What the registry says about ONE provider × model pair's right to be called.
 *
 * Four states, not a boolean, because they need OPPOSITE handling and a
 * two-valued answer would flatten them into one: `refused` is a permanent no
 * (skip it), `stalled` is a temporary no (it may recover, so keep it), `unknown`
 * is not a failure at all (never tried), and `funded` is a proven yes.
 */
export type PairEntitlement =
  /** Verified and usable right now — a real call proved THIS ACCOUNT serves THIS model. */
  | 'funded'
  /** No entry, or an unverified one. Nothing has ever been tried: an unknown, not a failure. */
  | 'unknown'
  /** Provably served before, but not right now, for a reason that clears by itself (quota park, stale proof, a transient failure). */
  | 'stalled'
  /** The account was REFUSED this pairing: credit-exhausted / auth / billing / 40x, or the id does not exist on that endpoint. */
  | 'refused';

/** The fields of a registry row this classifier reads. Deliberately minimal. */
export interface EntitlementInput {
  status?: string;
  lastError?: string;
  deadPair?: boolean;
  quotaParkedUntil?: number;
  providerParked?: boolean;
  lastVerifiedAt?: number;
}

/**
 * Classify one pair. Pure and total — never throws, never returns undefined.
 *
 * CLAUSE ORDER IS LOAD-BEARING, and `status` comes FIRST — exactly as in
 * `classifyReachability`. That is not cosmetic; getting it backwards creates a
 * brand-new false refusal:
 *
 *   - `verified` is a LATCH. Two different writes can leave a row `verified`
 *     while an old refusal still sits in `lastError`: `markVerified`
 *     deliberately PRESERVES `lastError` across a success (it rebuilds the entry
 *     field by field and keeps `existing?.lastError`), and `recordCall` succeeds
 *     through `markVerified`. So after a user tops up their credits and the next
 *     call works, the row is `verified` + `"credit-exhausted (…)"` — the model is
 *     being served RIGHT NOW.
 *   - Checking `isEntitlementFailure(lastError)` before `status` would call that
 *     pair refused and skip the funded account we just proved works. It is the
 *     same mistake in the other direction (a stale verdict outranking fresh
 *     evidence), so an entitlement refusal only counts while the entry is still
 *     sitting in the state that refusal produced — the registry's own guard,
 *     `existing?.status === 'unavailable' && isEntitlementFailure(...)` in
 *     `markListed`.
 *
 * The clauses:
 *
 *   1. A NONEXISTENT pair is refused whatever the status says: `deadPair` is an
 *      explicit "this id does not exist on this endpoint" and the provider's own
 *      model list is what clears it. (`isNonexistentPair` also covers an
 *      `unavailable` row whose recorded reason is a not-found — legacy data.)
 *   2. `unverified` / absent is `unknown` — never a failure. Most of any registry
 *      is here, and treating "never tried" as "cannot work" would empty the pool.
 *   3. `unavailable` + an entitlement reason is `refused` (credit-exhausted /
 *      auth / billing / 40x — what run D hit). Any other `unavailable` reason is
 *      `stalled`: rate limits, timeouts and 5xx are transient by the registry's
 *      own doctrine and must not be treated as a permanent no.
 *   4. A `verified` entry is `funded` unless a MODEL-level park or a stale proof
 *      holds it back. A PROVIDER-level park does not count — that is the Gemini
 *      parking bug, and `isUsable()` skips it for proven models too.
 */
export function classifyPairEntitlement(
  entry: EntitlementInput | undefined,
  now: number = Date.now(),
): PairEntitlement {
  if (!entry) return 'unknown';
  // 1. "This model does not exist here" — provider-declared, status-independent.
  if (isNonexistentPair(entry)) return 'refused';
  const status = entry.status ?? 'unverified';
  // 2. Never tried — an unknown, not a refusal.
  if (status === 'unverified') return 'unknown';
  // 3. Unavailable: refused if the ACCOUNT was refused, otherwise a no for now.
  if (status !== 'verified') {
    return isEntitlementFailure(entry.lastError) ? 'refused' : 'stalled';
  }
  // 4. Verified: only a MODEL-level park or an aged-out proof holds it back.
  const parkedUntil = entry.quotaParkedUntil ?? 0;
  if (parkedUntil > now && entry.providerParked === false) return 'stalled';
  if (now - (entry.lastVerifiedAt ?? 0) > DEFAULT_STALE_MS) return 'stalled';
  return 'funded';
}

/**
 * The pick order: funded, then never-tried, then stalled, then refused.
 *
 * `unknown` deliberately outranks `stalled`: `stalled` is "no budget right
 * now" (the exact thing this module exists to avoid spending a round on), while
 * `unknown` may simply work. This also matches how the model scorer already
 * weights the two (`quotaAvailability` 0.6 for unverified vs 0.0 for parked).
 */
export const ENTITLEMENT_ORDER: Record<PairEntitlement, number> = {
  funded: 0,
  unknown: 1,
  stalled: 2,
  refused: 3,
};

/**
 * Stable partition of candidates by entitlement — funded pairs first, refused
 * pairs last, everything else untouched inside its group (and the input array
 * never mutated). A PARTITION and not a filter: see doctrine 3 (never dead-end).
 */
export function orderByEntitlement<T>(items: readonly T[], of: (item: T) => PairEntitlement): T[] {
  const buckets: Record<PairEntitlement, T[]> = { funded: [], unknown: [], stalled: [], refused: [] };
  for (const item of items) buckets[of(item)].push(item);
  return [...buckets.funded, ...buckets.unknown, ...buckets.stalled, ...buckets.refused];
}

/** Short chip for a verdict — CLI/dashboard labels. */
export const ENTITLEMENT_LABEL: Record<PairEntitlement, string> = {
  funded: '✅ funded',
  unknown: '❔ untried',
  stalled: '⏸ stalled',
  refused: '⛔ refused',
};

/**
 * One sentence naming the EVIDENCE, not just the verdict — an operator reading
 * `model explain` has to be able to tell a refused account from an untried one.
 */
export function entitlementNote(entitlement: PairEntitlement, entry?: EntitlementInput): string {
  switch (entitlement) {
    case 'funded':
      return 'proven to work on this account, and nothing is blocking it right now';
    case 'unknown':
      return 'never tried on this provider — no evidence either way (not a failure)';
    case 'stalled': {
      const parkedUntil = entry?.quotaParkedUntil ?? 0;
      if (parkedUntil > Date.now()) {
        const mins = Math.max(1, Math.round((parkedUntil - Date.now()) / 60_000));
        return `proven to work, but parked on its own quota window — free again in ~${mins}m`;
      }
      return 'proven to work once, but not provably servable right now (stale proof or a transient failure)';
    }
    case 'refused':
      return isNonexistentPair(entry ?? {})
        ? 'the provider says this model does not exist on this endpoint'
        : `this account was refused: ${entry?.lastError ?? 'no reason recorded'}`;
  }
}

/**
 * The model id two rows must share before they are treated as the same model
 * offered by different providers — the "twins" the user's rule is about.
 *
 * Deliberately an EXACT comparison after stripping a `vendor/` prefix, the same
 * honest rule `verifiedEquivalent()` uses: `deepseek-flash` and
 * `deepseek/deepseek-flash` are one model; `deepseek-flash` and
 * `deepseek-v4.1-flash` are NOT, however much they look alike (asserting that
 * from their spelling is the name-based judgement this programme removes). A
 * declared alias table may later widen this — it may never make it fuzzy.
 */
export function twinKey(model: string): string {
  const id = (model ?? '').trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/** Do these two model ids name the same model served by different providers? */
export function areTwins(a: string, b: string): boolean {
  const ka = twinKey(a);
  const kb = twinKey(b);
  return !!ka && ka === kb;
}

/** One twin in a same-model group, with the verdict read from ITS OWN row. */
export interface TwinVerdict<T> {
  item: T;
  provider: string;
  model: string;
  entitlement: PairEntitlement;
  note: string;
}

/**
 * Resolve a group of SAME-MODEL twins to the one the router may call, and say
 * what was passed over and why.
 *
 * This is the user's requirement as a function: identical ranks, one funded
 * twin, so the funded twin is the only acceptable pick — and each twin's verdict
 * comes from its own registry row (doctrine 1). The refused ones come back in
 * `passedOver` so the caller can PRINT them ("`openrouter` refuses this model —
 * credit-exhausted") instead of silently pretending they were never there.
 *
 * Never returns nothing when the group is non-empty: if EVERY twin is refused,
 * the first is still chosen (doctrine 3 — a certain failure beats no attempt at
 * all only when there is genuinely nothing else, and the caller decides).
 */
export function resolveFundedTwin<T>(
  twins: readonly TwinVerdict<T>[],
): { chosen?: TwinVerdict<T>; passedOver: TwinVerdict<T>[] } {
  if (twins.length === 0) return { passedOver: [] };
  const ordered = [...twins].sort(
    (a, b) => ENTITLEMENT_ORDER[a.entitlement] - ENTITLEMENT_ORDER[b.entitlement],
  );
  const [chosen, ...passedOver] = ordered;
  return { chosen, passedOver };
}
