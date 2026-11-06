/**
 * Endpoint headroom — "can this account still serve the next call?"
 *
 * The invariant under test is NON-DEGRADATION: with no measured window the score
 * is 1 (behaviour unchanged), and a measured shortfall can only LOWER it. A pair
 * is never removed: the failover chain keeps every twin, it only tries the one
 * that can carry the call first.
 */

import { describe, it, expect } from 'vitest';
import {
  endpointHeadroom,
  nextCallDemandTokens,
  AMPLE_HEADROOM_CALLS,
  DEFAULT_CALL_TOKENS,
  SHORT_HEADROOM_FLOOR,
} from '../../src/learning/endpoint-headroom.js';
import {
  buildTieredFailoverChain,
  quotaDimensionFor,
  type ModelCandidate,
} from '../../src/learning/model-first-router.js';
import type { ModelRegistryEntry } from '../../src/learning/model-registry.js';

function entry(overrides: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry {
  return {
    provider: 'groq',
    model: 'deepseek-flash',
    status: 'verified',
    lastVerifiedAt: 1,
    lastProbedAt: 1,
    lastUsedAt: 1,
    errorRate: 0,
    quotaParkedUntil: 0,
    source: 'telemetry',
    ...overrides,
  };
}

const NOW = 1_800_000_000_000;

function candidate(provider: string, model: string, e?: ModelRegistryEntry): ModelCandidate {
  return {
    provider,
    model,
    score: 0.8,
    dimensions: {
      costPerMToken: 0,
      costScore: 1,
      capabilityFit: 0.8,
      health: 1,
      quotaAvailability: 1,
      providerSpeed: 1,
      verification: 1,
    },
    reason: 'test candidate',
    entry: e,
  };
}

describe('endpointHeadroom — unmeasured means unchanged', () => {
  it('returns 1 for a pair with no registry row', () => {
    const h = endpointHeadroom(undefined, 8000, NOW);
    expect(h.score).toBe(1);
    expect(h.measured).toBe(false);
    expect(h.calls).toBeUndefined();
  });

  it('returns 1 when no window limit is recorded (-1 / absent)', () => {
    expect(endpointHeadroom(entry({ remainingTokens: -1 }), 8000, NOW).score).toBe(1);
    expect(endpointHeadroom(entry(), 8000, NOW).score).toBe(1);
  });

  it('never changes a pair that has plenty of window', () => {
    const h = endpointHeadroom(entry({ remainingTokens: 500_000 }), 8000, NOW);
    expect(h.score).toBe(1);
    expect(h.calls).toBe(Math.floor(500_000 / 8000));
  });
});

describe('endpointHeadroom — a measured shortfall only lowers the score', () => {
  it('a window that cannot carry the next call lands on the floor, not zero', () => {
    const h = endpointHeadroom(entry({ remainingTokens: 200 }), 8000, NOW);
    expect(h.score).toBe(SHORT_HEADROOM_FLOOR);
    expect(h.calls).toBe(0);
    expect(h.reason).toContain('cannot carry the next call');
  });

  it('scales between the floor and 1 across the short range', () => {
    const oneCall = endpointHeadroom(entry({ remainingTokens: 8000 }), 8000, NOW);
    expect(oneCall.calls).toBe(1);
    expect(oneCall.score).toBeCloseTo(1 / AMPLE_HEADROOM_CALLS, 5);

    const threeCalls = endpointHeadroom(entry({ remainingTokens: 24_000 }), 8000, NOW);
    expect(threeCalls.calls).toBe(3);
    expect(threeCalls.score).toBeCloseTo(3 / AMPLE_HEADROOM_CALLS, 5);
    expect(threeCalls.score).toBeLessThan(1);
    expect(oneCall.score).toBeGreaterThan(SHORT_HEADROOM_FLOOR);
  });

  it('a parked pair reads 0 — the same value scoring already assigns', () => {
    const h = endpointHeadroom(entry({ remainingTokens: 1_000_000, quotaParkedUntil: NOW + 60_000 }), 8000, NOW);
    expect(h.score).toBe(0);
    expect(h.reason).toBe('quota-parked');
  });
});

describe('nextCallDemandTokens — measured first, then a conservative default', () => {
  it('uses the provider-measured EMAs when they exist', () => {
    const e = entry({ measuredInputTokens: 1200, measuredOutputTokens: 3000, measuredSamples: 4 });
    expect(nextCallDemandTokens(e)).toBe(4200);
    expect(endpointHeadroom(e, undefined, NOW).demandTokens).toBe(4200);
  });

  it('ignores EMAs that carry no samples', () => {
    const e = entry({ measuredInputTokens: 1200, measuredOutputTokens: 3000, measuredSamples: 0 });
    expect(nextCallDemandTokens(e)).toBe(DEFAULT_CALL_TOKENS);
  });

  it('pads a declared task estimate for the answer it will also spend', () => {
    expect(nextCallDemandTokens(undefined, 20_000)).toBe(30_000);
    // A tiny estimate never drops below the default — under-estimating demand
    // would hide exactly the shortfall this exists to find.
    expect(nextCallDemandTokens(undefined, 10)).toBe(DEFAULT_CALL_TOKENS);
  });
});

describe('quotaDimensionFor — the ruling is the ceiling, headroom can only lower it', () => {
  it('keeps the existing value for a verified pair with no measured window', () => {
    expect(quotaDimensionFor(entry(), undefined, NOW)).toBe(1);
  });

  it('keeps the unverified prior (0.6) even when the window is ample', () => {
    const e = entry({ status: 'unverified', remainingTokens: 1_000_000 });
    expect(quotaDimensionFor(e, undefined, NOW)).toBe(0.6);
  });

  it('lowers a verified pair whose ledger says the next call does not fit', () => {
    const e = entry({ remainingTokens: 200 });
    expect(quotaDimensionFor(e, 8000, NOW)).toBe(SHORT_HEADROOM_FLOOR);
  });

  it('never lets headroom raise a refused pair', () => {
    const e = entry({ status: 'unavailable', remainingTokens: 1_000_000 });
    expect(quotaDimensionFor(e, undefined, NOW)).toBe(0.1);
  });

  it('reads 0 for a parked pair and 1 for no entry at all', () => {
    expect(quotaDimensionFor(entry({ quotaParkedUntil: NOW + 1 }), undefined, NOW)).toBe(0);
    expect(quotaDimensionFor(undefined, undefined, NOW)).toBe(1);
  });
});

describe('same-model twins are ordered by headroom — and never dropped', () => {
  it('tries the funded twin before the nearly-empty one', () => {
    const free = candidate('groq', 'deepseek-flash', entry({ provider: 'groq', remainingTokens: 200 }));
    const paid = candidate(
      'deepseek',
      'deepseek-flash',
      entry({ provider: 'deepseek', remainingTokens: 2_000_000 }),
    );

    const tiers = buildTieredFailoverChain(free, [free, paid]);
    const sameModel = tiers.find((t) => t.phase === 'same-model');

    expect(sameModel).toBeDefined();
    expect(sameModel!.candidates.map((c) => c.provider)).toEqual(['deepseek']);
  });

  it('keeps a twin with no headroom in the chain instead of filtering it', () => {
    const empty = candidate('nim', 'deepseek-flash', entry({ provider: 'nim', remainingTokens: 0 }));
    const paid = candidate(
      'deepseek',
      'deepseek-flash',
      entry({ provider: 'deepseek', remainingTokens: 2_000_000 }),
    );
    const best = candidate('groq', 'deepseek-flash', entry({ provider: 'groq', remainingTokens: 100 }));

    const tiers = buildTieredFailoverChain(best, [best, empty, paid]);
    const sameModel = tiers.find((t) => t.phase === 'same-model');

    expect(sameModel!.candidates.map((c) => c.provider)).toEqual(['deepseek', 'nim']);
    // Still reachable somewhere in the walk — ordering, not exclusion.
    const reachable = tiers.flatMap((t) => t.candidates.map((c) => c.provider));
    expect(reachable).toContain('nim');
  });

  it('leaves the order untouched when no window is measured', () => {
    const best = candidate('groq', 'deepseek-flash', entry({ provider: 'groq', remainingTokens: -1 }));
    const b = candidate('openrouter', 'deepseek-flash', entry({ provider: 'openrouter' }));
    const c = candidate('nim', 'deepseek-flash', entry({ provider: 'nim' }));

    const tiers = buildTieredFailoverChain(best, [best, b, c]);
    const sameModel = tiers.find((t) => t.phase === 'same-model');

    // Stable: the scorer's order survives because headroom is unknown for both.
    expect(sameModel!.candidates.map((c2) => c2.provider)).toEqual(['openrouter', 'nim']);
  });
});
