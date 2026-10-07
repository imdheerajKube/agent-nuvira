/**
 * PAIR ENTITLEMENT — four providers list the same model; only one key can
 * actually serve it.
 *
 * The reported defect (2026-10-07): "suppose we have 4 providers and everyone
 * provides deepseek — only one provider's key actually provides deepseek, where
 * as the user has not purchased model access on the other providers or there is
 * no free tokens offered by those providers… the rank of a model can be the same,
 * but the agent should only pick, or only be allowed to access, the one which has
 * a genuine token budget available, rather than going for rounds unnecessarily."
 *
 * These tests pin the three properties that make that true:
 *
 *   1. the VERDICT is read per pair, from that pair's own registry row — a twin
 *      never inherits another account's verdict (`classifyPairEntitlement`);
 *   2. a funded pair outranks a refused one even when the refused one scores
 *      higher — entitlement is a partition applied after the score sort, so a
 *      rank advantage cannot buy a call that is certain to fail;
 *   3. nothing is REMOVED: if every twin is refused the pool still contains them
 *      ("use every model we can actually call; reject only when nothing is left").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ENTITLEMENT_ORDER,
  areTwins,
  classifyPairEntitlement,
  entitlementNote,
  orderByEntitlement,
  resolveFundedTwin,
  twinKey,
  type PairEntitlement,
} from '../../src/learning/pair-entitlement.js';
import {
  getModelRegistry,
  resetModelRegistry,
  isNonexistentPair,
} from '../../src/learning/model-registry.js';
import {
  buildModelCandidates,
  pickBestModelCandidate,
  isCandidateAvailable,
} from '../../src/learning/model-first-router.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('classifyPairEntitlement — the verdict comes from THIS pair\'s row', () => {
  it('calls a fresh verified entry funded', () => {
    expect(classifyPairEntitlement({ status: 'verified', lastVerifiedAt: NOW - DAY }, NOW)).toBe('funded');
  });

  it('treats "never tried" as an unknown, never as a refusal', () => {
    // The registry is mostly this. "Never tried" is not "cannot work" — treating
    // it as a refusal would empty the pool of every model on a fresh install.
    expect(classifyPairEntitlement(undefined, NOW)).toBe('unknown');
    expect(classifyPairEntitlement({ status: 'unverified' }, NOW)).toBe('unknown');
  });

  it('refuses an unavailable pair whose recorded reason is an ACCOUNT refusal', () => {
    // The run-D shape: `402 Insufficient credits` on a provider whose public
    // catalogue lists the model. The account cannot pay, so retrying is a
    // guaranteed failed round trip.
    for (const reason of [
      'credit-exhausted (that provider account cannot pay for this call)',
      'auth (invalid key / forbidden)',
      'insufficient credit',
      '403 permission denied',
    ]) {
      expect(classifyPairEntitlement({ status: 'unavailable', lastError: reason }, NOW), reason).toBe('refused');
    }
  });

  it('refuses a pair the provider says does not exist, whatever the status says', () => {
    expect(classifyPairEntitlement({ status: 'unavailable', lastError: 'model not found' }, NOW)).toBe('refused');
    // The flag is the primary signal and can sit on a row whose status is
    // `verified` (the latch) — `Provider X has no such model` is not repaired by
    // a previous success.
    expect(classifyPairEntitlement({ status: 'verified', deadPair: true, lastVerifiedAt: NOW }, NOW)).toBe('refused');
  });

  it('treats a transient failure as STALLED, not as a refusal', () => {
    // Rate limits, timeouts and 5xx are repairable by the registry's own
    // doctrine — calling them refusals would permanently kill a provider that is
    // merely busy.
    for (const reason of ['rate-limit', 'timed out', 'server error (503)']) {
      expect(classifyPairEntitlement({ status: 'unavailable', lastError: reason }, NOW), reason).toBe('stalled');
    }
  });

  it('treats a MODEL-level quota park as stalled, and a PROVIDER-level park as funded', () => {
    const parked = {
      status: 'verified',
      lastVerifiedAt: NOW - DAY,
      quotaParkedUntil: NOW + 60_000,
    };
    // providerParked === false → the park is this model's own quota window: no
    // budget right now, which is exactly the user's "no free tokens" case.
    expect(classifyPairEntitlement({ ...parked, providerParked: false }, NOW)).toBe('stalled');
    // providerParked true/absent → a SIBLING model's rate limit; a proven model
    // must not be excluded by it (the Gemini parking bug).
    expect(classifyPairEntitlement({ ...parked, providerParked: true }, NOW)).toBe('funded');
    expect(classifyPairEntitlement(parked, NOW)).toBe('funded');
  });

  it('reports a verified entry whose proof has aged out as stalled, not refused', () => {
    expect(classifyPairEntitlement({ status: 'verified', lastVerifiedAt: NOW - 8 * DAY }, NOW)).toBe('stalled');
  });

  it('does NOT call a topped-up account refused just because the old error lingers', () => {
    // THE FALSE-REFUSAL GUARD, and the reason `status` is checked FIRST.
    // `markVerified` PRESERVES `lastError` across a success (it rebuilds the entry
    // and keeps `existing?.lastError`), so after a user tops up their credits and
    // the next call succeeds, the row is `verified` + "credit-exhausted (…)" while
    // the model is being served RIGHT NOW. Checking the error before the status
    // would skip the very account we just proved works — a stale verdict
    // outranking fresh evidence, the same defect class in the other direction.
    expect(
      classifyPairEntitlement(
        {
          status: 'verified',
          lastVerifiedAt: NOW - 60_000,
          lastError: 'credit-exhausted (that provider account cannot pay for this call)',
        },
        NOW,
      ),
    ).toBe('funded');
  });

  it('never throws on a bare/partial row', () => {
    expect(classifyPairEntitlement({}, NOW)).toBe('unknown');
    expect(() => entitlementNote('refused', {})).not.toThrow();
    expect(entitlementNote('refused', { lastError: 'credit-exhausted' })).toContain('credit-exhausted');
    expect(isNonexistentPair({})).toBe(false);
  });
});

describe('ordering — a funded twin beats a refused one even when the refused one scores higher', () => {
  it('puts funded first and refused last, whatever the caller\'s own metric says', () => {
    type Item = { provider: string; score: number; entitlement: PairEntitlement };
    const items: Item[] = [
      { provider: 'openrouter', score: 0.99, entitlement: 'refused' },
      { provider: 'groq', score: 0.90, entitlement: 'stalled' },
      { provider: 'nim', score: 0.20, entitlement: 'unknown' },
      { provider: 'deepseek', score: 0.10, entitlement: 'funded' },
    ];
    // The refused twin is the BEST by score — which is the whole point: score
    // answers "which model is better", never "may this account be called".
    const ordered = orderByEntitlement(items, (i) => i.entitlement);
    expect(ordered.map((i) => i.provider)).toEqual(['deepseek', 'nim', 'groq', 'openrouter']);
  });

  it('is a stable partition — it never drops a candidate and never reorders equals', () => {
    const refused = ['a', 'b', 'c'].map((p) => ({ p, e: 'refused' as PairEntitlement }));
    const funded = ['d', 'e'].map((p) => ({ p, e: 'funded' as PairEntitlement }));
    const input = [...refused, ...funded];
    const out = orderByEntitlement(input, (i) => i.e);
    expect(out).toHaveLength(input.length); // nothing removed — "reject only when nothing is left"
    expect(out.map((i) => i.p)).toEqual(['d', 'e', 'a', 'b', 'c']);
    // The input array itself is untouched.
    expect(input.map((i) => i.p)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('ranks funded < untried < stalled < refused', () => {
    expect(ENTITLEMENT_ORDER.funded).toBeLessThan(ENTITLEMENT_ORDER.unknown);
    expect(ENTITLEMENT_ORDER.unknown).toBeLessThan(ENTITLEMENT_ORDER.stalled);
    expect(ENTITLEMENT_ORDER.stalled).toBeLessThan(ENTITLEMENT_ORDER.refused);
  });
});

describe('twins — the same model on different providers', () => {
  it('groups an exact id and a vendor-prefixed one, and refuses to guess from spelling', () => {
    expect(twinKey('deepseek/deepseek-flash')).toBe('deepseek-flash');
    expect(areTwins('deepseek/deepseek-flash', 'deepseek-flash')).toBe(true);
    // These are NOT one model, however alike they look. Asserting otherwise from
    // the name is the judgement this programme exists to remove (A1 handles true
    // aliases through a DECLARED table, never by string similarity).
    expect(areTwins('deepseek-flash', 'deepseek-v4.1-flash')).toBe(false);
    expect(areTwins('', '')).toBe(false);
  });

  it('resolves 4 same-model twins to the ONE funded account, and says what was passed over', () => {
    const twins = [
      { item: 1, provider: 'openrouter', model: 'deepseek/deepseek-flash', entitlement: 'refused' as PairEntitlement, note: 'credit-exhausted' },
      { item: 2, provider: 'groq', model: 'deepseek-flash', entitlement: 'stalled' as PairEntitlement, note: 'no free tokens left in the window' },
      { item: 3, provider: 'deepseek', model: 'deepseek-flash', entitlement: 'funded' as PairEntitlement, note: 'proven to work' },
      { item: 4, provider: 'nim', model: 'deepseek-flash', entitlement: 'unknown' as PairEntitlement, note: 'never tried' },
    ];
    const { chosen, passedOver } = resolveFundedTwin(twins);
    expect(chosen?.provider).toBe('deepseek');
    expect(passedOver.map((t) => t.provider)).toEqual(['nim', 'groq', 'openrouter']);
  });

  it('still chooses SOMETHING when every twin is refused (never dead-end)', () => {
    const twins = ['a', 'b'].map((p) => ({
      item: p,
      provider: p,
      model: 'deepseek-flash',
      entitlement: 'refused' as PairEntitlement,
      note: 'refused',
    }));
    const { chosen, passedOver } = resolveFundedTwin(twins);
    expect(chosen?.provider).toBe('a');
    expect(passedOver).toHaveLength(1);
    expect(resolveFundedTwin([]).chosen).toBeUndefined();
  });
});

// ─── The reported scenario, end to end, through the real registry ───────────

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-entitlement-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const MODEL = 'deepseek-flash';
const FOUR = ['openrouter', 'groq', 'nim', 'deepseek'];

describe('the model-first pool obeys the funded twin (the reported scenario)', () => {
  function seed(): void {
    const registry = getModelRegistry();
    for (const provider of FOUR) registry.markListed(provider, [MODEL]);
    // Three accounts that cannot serve it: one has never bought access (402),
    // one has no free tokens left in its window (parked), one has never been
    // tried. Only `deepseek` is genuinely funded.
    registry.markUnavailable('openrouter', MODEL, 'credit-exhausted (that provider account cannot pay for this call)', 'telemetry');
    // A free tier that WAS serving this model and has run out of tokens for its
    // window: proven once, no budget right now.
    registry.markVerified('groq', MODEL, 'spot-check', 300);
    registry.recordCall('groq', MODEL, false, 'rate-limit', 'chat', 120, 0, undefined, 15 * 60_000);
    registry.markVerified('deepseek', MODEL, 'telemetry', 400);
  }

  it('reads each verdict from its OWN row — no twin inherits another account\'s verdict', () => {
    seed();
    const registry = getModelRegistry();
    expect(classifyPairEntitlement(registry.getEntry('openrouter', MODEL))).toBe('refused');
    expect(classifyPairEntitlement(registry.getEntry('groq', MODEL))).toBe('stalled');
    expect(classifyPairEntitlement(registry.getEntry('nim', MODEL))).toBe('unknown');
    expect(classifyPairEntitlement(registry.getEntry('deepseek', MODEL))).toBe('funded');
  });

  it('picks the funded twin, and still carries the others as last resorts', () => {
    seed();
    // `deepseek` LAST in the provider order, so nothing here can pass by accident
    // through the order the pool was built in.
    const providers = ['openrouter', 'groq', 'nim', 'deepseek'];
    const candidates = buildModelCandidates('implement a feature', 'moderate', undefined, providers);

    // All four twins are present — the pool is a partition, not a filter.
    expect(new Set(candidates.map((c) => c.provider))).toEqual(new Set(providers));
    // …and the funded one is FIRST, so both the model-first override and the
    // failover builder start from a pair that can actually be called.
    expect(candidates[0].provider).toBe('deepseek');
    expect(candidates[0].entitlement).toBe('funded');
    expect(candidates.at(-1)?.entitlement).toBe('refused');
    expect(pickBestModelCandidate('implement a feature', 'moderate', undefined, providers)?.provider).toBe('deepseek');
  });

  it('refuses to offer a pair whose ACCOUNT was refused', () => {
    seed();
    const registry = getModelRegistry();
    const candidates = buildModelCandidates('implement a feature', 'moderate', undefined, ['openrouter']);
    expect(candidates).toHaveLength(1);
    expect(classifyPairEntitlement(registry.getEntry('openrouter', MODEL))).toBe('refused');
    expect(isCandidateAvailable(candidates[0])).toBe(false);
  });

  it('does not strand a single-provider pool: the refused pair is still the only candidate', () => {
    seed();
    const candidates = buildModelCandidates('implement a feature', 'moderate', undefined, ['openrouter']);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider).toBe('openrouter');
    expect(candidates[0].entitlement).toBe('refused');
  });
});

describe('a twin with no budget cannot win on rank alone (the non-vacuous case)', () => {
  /**
   * The exact situation the ordering exists to close, and the only construction
   * in which scoring ALONE chooses wrong: the funded account is serving poorly
   * right now (high latency, near-100% error rate) while a free-tier twin is
   * pristine but PARKED — its quota window is exhausted, which is the user's
   * "there is no free tokens offered by those providers".
   *
   * Score is a rank: it answers "which model is better", so a healthy-looking
   * parked twin can outscore a degraded-but-funded one. Access is not a rank —
   * it is a fact about an account — so entitlement is applied as a partition
   * AFTER the score sort and the funded pair starts the pool regardless.
   *
   * `byScore` is asserted on purpose: it proves the test is not passing for free.
   * If a future weight change makes the scored order agree with the entitlement
   * order, this test fails and has to be re-derived rather than quietly becoming
   * a tautology.
   */
  it('starts the pool on the funded twin even when the parked twin scores higher', () => {
    const registry = getModelRegistry();
    registry.markListed('openrouter', [MODEL]);
    registry.markListed('groq', [MODEL]);
    // Funded, but this account is currently serving the model badly.
    registry.markVerified('openrouter', MODEL, 'telemetry', 6400);
    for (let i = 0; i < 20; i++) registry.recordCall('openrouter', MODEL, false, 'server-error', 'chat', 6400);
    // No budget in this window, but otherwise pristine.
    registry.markVerified('groq', MODEL, 'spot-check', 0);
    registry.recordCall('groq', MODEL, false, 'rate-limit', 'chat', 90, 0, undefined, 15 * 60_000);

    const candidates = buildModelCandidates('implement a feature', 'moderate', undefined, ['openrouter', 'groq']);
    const byScore = [...candidates].sort((a, b) => b.score - a.score);

    // The premise: scoring alone would start on the twin with no budget.
    expect(byScore[0].provider).toBe('groq');
    expect(byScore[1].provider).toBe('openrouter');
    // The fix: the funded account starts the pool anyway, and the parked
    // sibling is still there (later) rather than dropped.
    expect(candidates.map((c) => c.provider)).toEqual(['openrouter', 'groq']);
    expect(candidates[0].entitlement).toBe('funded');
    expect(candidates[1].entitlement).toBe('stalled');
    expect(pickBestModelCandidate('implement a feature', 'moderate', undefined, ['openrouter', 'groq'])?.provider).toBe('openrouter');
  });
});
