/**
 * Blip patience — the policy table, one row at a time.
 *
 * WHY THIS FILE IS A TABLE. The rule being encoded is "do not trade a
 * competent model for a less competent one over a two-second blink", and the
 * mistake it guards against is not a crash — it is a plausible-looking schedule
 * that is wrong in one cell. Every row below states the situation, the schedule
 * chosen, and WHY, so a reviewer can disagree with a specific decision rather
 * than with a blob of logic. The module is deliberately pure (no clock, no
 * registry, no config), which is what makes the table possible at all: the
 * caller gathers the evidence, the policy answers.
 *
 * The observed motivation (repeatedly, on `deepseek`): a cloud endpoint returns
 * 200, then a few empty/5xx responses over a handful of seconds, then serves
 * normally again. Failing fast over that means silently dropping to a weaker
 * model; waiting blindly on a genuinely dead pair means every user pays ~a
 * minute. The schedule's SHAPE is therefore part of the contract: retries at
 * ≈1s/3s/7s catch a blink, and the sparse tail still rides out a real spike.
 */

import { describe, it, expect } from 'vitest';

import {
  planBlipPatience,
  TRANSIENT_BLIP_DELAYS_MS,
  TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS,
  TRANSIENT_LAST_RESORT_DELAYS_MS,
  EMPTY_PATIENCE_MS,
  EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS,
  PROVEN_ERROR_RATE_MAX,
  type PatienceEvidence,
} from '../../src/learning/retry-patience.js';
import { capabilityClassOf } from '../../src/learning/model-capability.js';

/** A proven pair: verified by real traffic, essentially no errors. */
const PROVEN: PatienceEvidence = { verified: true, source: 'telemetry', errorRate: 0.01 };

describe('the schedule SHAPE — dense early, sparse late', () => {
  it('catches a seconds-long blink instead of sleeping through it', () => {
    // The whole point: the first retry must land INSIDE a blink, not after it.
    // A 2-second blip is still open at t≈1s and already closed by t=5s (the old
    // first delay), which is exactly how a healthy model used to be declared dead.
    expect(TRANSIENT_BLIP_DELAYS_MS[0]).toBeLessThanOrEqual(1_000);
    // The attempt times (cumulative) must stay dense for the first few steps.
    const attemptTimes = TRANSIENT_BLIP_DELAYS_MS.reduce<number[]>((acc, d) => {
      acc.push((acc[acc.length - 1] ?? 0) + d);
      return acc;
    }, []);
    expect(attemptTimes[0]).toBe(1_000);
    expect(attemptTimes[1]).toBe(3_000);
    expect(attemptTimes[2]).toBe(7_000);
  });

  it('still spans a real spike before the walk declares the pair dead', () => {
    const total = TRANSIENT_BLIP_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(60_000);
    expect(TRANSIENT_BLIP_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
  });

  it('never spends the long schedule when a same-band replacement is free', () => {
    const long = TRANSIENT_BLIP_DELAYS_MS.reduce((a, b) => a + b, 0);
    const short = TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(short).toBeLessThanOrEqual(2_000);
    expect(short).toBeLessThan(long);
    // And a stranger's last-resort wait is a token one, not patience.
    expect(TRANSIENT_LAST_RESORT_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  it('grants more empty-response patience when every alternative de-escalates', () => {
    const fold = EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS.reduce((a, b) => a + b, 0);
    const normal = EMPTY_PATIENCE_MS.reduce((a, b) => a + b, 0);
    expect(fold).toBeGreaterThan(normal);
  });
});

describe('planBlipPatience — the decision table', () => {
  // Sanity-pin the capability bands the rows below rely on, so a change in the
  // heuristic shows up HERE (as a broken row) rather than as a silently
  // different routing decision in production.
  it('uses bands that mean what the rows assume', () => {
    expect(capabilityClassOf('deepseek-v4-pro')).toBe('high');
    expect(capabilityClassOf('openai/gpt-oss-120b')).toBe('high');
    expect(capabilityClassOf('allam-2-7b')).toBe('medium');
    expect(capabilityClassOf('qwen2.5:0.5b')).toBe('low');
  });

  it('ROW 1 — the same pair failing an earlier step is a pattern, not a blip', () => {
    const plan = planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      // Even with a strong alternative AND a proven record, patience collapses.
      alternatives: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
      evidence: PROVEN,
      failedEarlierStep: true,
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_LAST_RESORT_DELAYS_MS]);
    expect(plan.emptyResponseDelaysMs).toEqual([]);
    expect(plan.reason).toContain('not a blip');
  });

  it('ROW 2 — a same-or-better band is reachable, so walking is free and waiting is waste', () => {
    const plan = planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      alternatives: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
      evidence: PROVEN,
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS]);
    expect(plan.foldingWouldDegrade).toBe(false);
    expect(plan.bestAlternativeBand).toBe('high');
    expect(plan.reason).toContain('costs no quality');
  });

  it('ROW 2b — but a proven pair still gets its two short empty waits', () => {
    const plan = planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      alternatives: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
      evidence: PROVEN,
    });
    expect(plan.emptyResponseDelaysMs).toEqual([...EMPTY_PATIENCE_MS]);
  });

  it('ROW 3 — a proven pair facing ONLY degrading alternatives waits rather than folds', () => {
    const plan = planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      // Every alternative is a band down: "fail over" here means "de-escalate".
      alternatives: [
        { provider: 'groq', model: 'allam-2-7b' },
        { provider: 'local', model: 'qwen2.5:0.5b' },
      ],
      evidence: PROVEN,
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_BLIP_DELAYS_MS]);
    expect(plan.emptyResponseDelaysMs).toEqual([...EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS]);
    expect(plan.foldingWouldDegrade).toBe(true);
    expect(plan.reason).toContain('de-escalating');
  });

  it('ROW 3b — no alternative at all, but a proven pair: waiting is the only remedy', () => {
    const plan = planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      alternatives: [],
      evidence: PROVEN,
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_BLIP_DELAYS_MS]);
    expect(plan.emptyResponseDelaysMs).toEqual([...EMPTY_PATIENCE_WAIT_BEATS_FOLDING_MS]);
    // Nothing to fold DOWN to, so this is not a downgrade — it is the only lever.
    expect(plan.foldingWouldDegrade).toBe(false);
    expect(plan.reason).toContain('only remedy');
  });

  it('ROW 4 — an unproven pair with a band-UP alternative still walks freely', () => {
    const plan = planBlipPatience({
      current: { provider: 'openrouter', model: 'vendor/unknown-model' },
      alternatives: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }],
      // No evidence recorded at all — but nothing is lost by walking, so there is
      // no reason to be patient with a stranger.
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_FREE_ALTERNATIVE_DELAYS_MS]);
    expect(plan.emptyResponseDelaysMs).toEqual([]);
    expect(plan.reason).toContain('costs no quality');
  });

  it('ROW 4c — an unproven pair facing only degrading alternatives gets a token wait, then the walk', () => {
    const plan = planBlipPatience({
      current: { provider: 'openrouter', model: 'vendor/unknown-model' },
      alternatives: [{ provider: 'local', model: 'qwen2.5:0.5b' }],
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_LAST_RESORT_DELAYS_MS]);
    expect(plan.emptyResponseDelaysMs).toEqual([]);
    expect(plan.reason).toContain('no track record');
  });

  it('ROW 4b — unproven and nowhere else to go: short empty patience, never a long blind wait', () => {
    const plan = planBlipPatience({
      current: { provider: 'openrouter', model: 'vendor/unknown-model' },
      alternatives: [],
    });
    expect(plan.transientDelaysMs).toEqual([...TRANSIENT_LAST_RESORT_DELAYS_MS]);
    // Nothing to walk TO, so the cheap certainty is a couple of short empty waits
    // (never the long blind wait a PROVEN pair earns).
    expect(plan.emptyResponseDelaysMs).toEqual([...EMPTY_PATIENCE_MS]);
    expect(plan.transientDelaysMs.reduce((a, b) => a + b, 0)).toBeLessThan(
      TRANSIENT_BLIP_DELAYS_MS.reduce((a, b) => a + b, 0),
    );
  });
});

describe('hasProvenTrackRecord — what counts as a track record', () => {
  const plan = (evidence?: PatienceEvidence): readonly number[] =>
    planBlipPatience({
      current: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      alternatives: [],
      evidence,
    }).transientDelaysMs;

  it('counts real traffic', () => {
    expect(plan(PROVEN)).toEqual([...TRANSIENT_BLIP_DELAYS_MS]);
  });

  it('counts a spot-check (the model answered a real request)', () => {
    expect(plan({ verified: true, source: 'spot-check', errorRate: 0 })).toEqual([
      ...TRANSIENT_BLIP_DELAYS_MS,
    ]);
  });

  it('does NOT count a bare catalog probe — it proves the id exists, not that it answers', () => {
    expect(plan({ verified: true, source: 'probe', errorRate: 0 })).toEqual([
      ...TRANSIENT_LAST_RESORT_DELAYS_MS,
    ]);
  });

  it('does NOT count an unverified row, however clean it looks', () => {
    expect(plan({ verified: false, source: 'telemetry', errorRate: 0 })).toEqual([
      ...TRANSIENT_LAST_RESORT_DELAYS_MS,
    ]);
  });

  it('does NOT count a pair that fails about one call in five', () => {
    // A rate this high is not something a blip explains away.
    expect(plan({ verified: true, source: 'telemetry', errorRate: PROVEN_ERROR_RATE_MAX + 0.01 })).toEqual([
      ...TRANSIENT_LAST_RESORT_DELAYS_MS,
    ]);
    // …while a rate at the bar is still a track record.
    expect(plan({ verified: true, source: 'telemetry', errorRate: PROVEN_ERROR_RATE_MAX })).toEqual([
      ...TRANSIENT_BLIP_DELAYS_MS,
    ]);
  });

  it('counts work already delivered THIS turn, even with nothing in the registry', () => {
    const p = planBlipPatience({
      current: { provider: 'openrouter', model: 'vendor/unknown-model' },
      alternatives: [],
      deliveredWorkThisTurn: true,
    });
    expect(p.transientDelaysMs).toEqual([...TRANSIENT_BLIP_DELAYS_MS]);
  });
});
