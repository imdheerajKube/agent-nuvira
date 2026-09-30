/**
 * Model reachability — the classifier the dashboard counts, filters and badges on.
 *
 * The load-bearing property is that `classifyReachability` AGREES WITH
 * `ModelRegistry.isUsable()`: a page whose "Routable" count disagrees with what
 * the router actually picks is the exact defect this module was written to close
 * (the old Timeline answered "is this available" three different ways and they
 * contradicted each other). So the tests below pin the clause order, including
 * the two that are easy to get wrong:
 *
 *   1. a PROVIDER-level park does NOT exclude a verified model — only a
 *      MODEL-level park (`providerParked === false`) does;
 *   2. the status check comes FIRST, so `unavailable` + parked reads as
 *      proven-dead, not parked.
 */

import { describe, it, expect } from 'vitest';
import {
  FRESH_DAYS,
  REMOVED_DAYS,
  classifyFreshness,
  classifyReachability,
  isRoutable,
} from '../../src/learning/model-reachability.js';
import { DEFAULT_STALE_MS } from '../../src/learning/model-registry.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('classifyReachability — mirrors isUsable', () => {
  it('is routable only for verified, un-parked, recently-verified entries', () => {
    expect(classifyReachability({ status: 'verified', lastVerifiedAt: NOW - DAY }, NOW)).toBe('routable');
    // Exactly at the cutoff is still inside it (`>` is the comparison).
    expect(classifyReachability({ status: 'verified', lastVerifiedAt: NOW - DEFAULT_STALE_MS }, NOW)).toBe('routable');
  });

  it('reports a verified entry whose proof has aged out as proof-expired, not dead', () => {
    // The distinction matters: this one is repaired by re-probing, and it is the
    // state quietly shrinking a routing pool.
    const at = NOW - DEFAULT_STALE_MS - 1;
    expect(classifyReachability({ status: 'verified', lastVerifiedAt: at }, NOW)).toBe('proof-expired');
    expect(classifyReachability({ status: 'verified' }, NOW)).toBe('proof-expired');
  });

  it('reports a MODEL-level park as parked, and a PROVIDER-level park as still routable', () => {
    const parked = { status: 'verified', lastVerifiedAt: NOW - DAY, quotaParkedUntil: NOW + 60_000 };
    // providerParked === false → the park is model-specific, so it blocks.
    expect(classifyReachability({ ...parked, providerParked: false }, NOW)).toBe('parked');
    // providerParked true (or absent, as legacy data has it) → a sibling model's
    // rate limit must never exclude a proven model.
    expect(classifyReachability({ ...parked, providerParked: true }, NOW)).toBe('routable');
    expect(classifyReachability(parked, NOW)).toBe('routable');
  });

  it('treats a lapsed park as routable without any cleanup step', () => {
    const lapsed = {
      status: 'verified',
      lastVerifiedAt: NOW - DAY,
      quotaParkedUntil: NOW - 1,
      providerParked: false,
    };
    expect(classifyReachability(lapsed, NOW)).toBe('routable');
  });

  it('reports a model nothing has ever tried as never-verified — NOT as unreachable', () => {
    // The word matters. "Unreachable" is a claim about a test; this row has had
    // none, so the state is an unknown. 514 of the author's 555 rows are here.
    expect(classifyReachability({ status: 'unverified' }, NOW)).toBe('never-verified');
    expect(classifyReachability({ status: 'unverified', lastProbedAt: NOW }, NOW)).toBe('never-verified');
  });

  it('checks status FIRST, so an unavailable entry is proven-dead even when parked', () => {
    const dead = { status: 'unavailable', lastVerifiedAt: 0, quotaParkedUntil: NOW + 60_000, providerParked: false };
    expect(classifyReachability(dead, NOW)).toBe('proven-dead');
  });

  it('never calls an unverified model routable, whatever its timestamps say', () => {
    const lying = { status: 'unverified', lastVerifiedAt: NOW, providerParked: false, quotaParkedUntil: 0 };
    expect(classifyReachability(lying, NOW)).not.toBe('routable');
    expect(isRoutable(classifyReachability(lying, NOW))).toBe(false);
  });

  it('classifies the real profile that produced the bug', () => {
    // The measured shape: 555 tracked, 17 verified, 531 freshly probed. The old
    // page showed "Fresh (531)" and then badged 514 of those rows "Unverified".
    const verifiedFresh = { status: 'verified', lastVerifiedAt: NOW - DAY };
    const verifiedExpired = { status: 'verified', lastVerifiedAt: NOW - 8.19 * DAY };
    const neverTried = { status: 'unverified', lastProbedAt: NOW };
    const dead = { status: 'unavailable', lastProbedAt: NOW };

    expect(classifyReachability(verifiedFresh, NOW)).toBe('routable');
    expect(classifyReachability(verifiedExpired, NOW)).toBe('proof-expired');
    expect(classifyReachability(neverTried, NOW)).toBe('never-verified');
    expect(classifyReachability(dead, NOW)).toBe('proven-dead');
    // Both of the first two are "fresh" by probe age — which is exactly why
    // freshness cannot be the axis the availability count is computed on.
    expect(classifyFreshness(NOW, 0, NOW)).toBe('fresh');
  });
});

describe('classifyFreshness — the other axis', () => {
  it('separates fresh, stale and likely-removed by probe age and error rate', () => {
    expect(classifyFreshness(NOW - 1 * DAY, 0, NOW)).toBe('fresh');
    expect(classifyFreshness(NOW - (FRESH_DAYS + 0.01) * DAY, 0, NOW)).toBe('stale');
    expect(classifyFreshness(NOW - (REMOVED_DAYS + 1) * DAY, 0, NOW)).toBe('stale');
    // Long-unprobed AND failing is what makes "likely removed" a statement we
    // can defend; age alone is not.
    expect(classifyFreshness(NOW - (REMOVED_DAYS + 1) * DAY, 0.9, NOW)).toBe('likely-removed');
  });

  it('treats a never-probed entry as likely removed, and does not throw on missing fields', () => {
    expect(classifyFreshness(undefined, undefined, NOW)).toBe('likely-removed');
    expect(classifyFreshness(0, 0, NOW)).toBe('likely-removed');
  });
});
