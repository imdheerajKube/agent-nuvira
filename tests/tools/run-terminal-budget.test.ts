/**
 * The turn's wall clock outranks a command's own wait budget.
 *
 * Measured 2026-11-05, head-to-head audit cell: a turn with a 7-minute budget
 * called `pytest` on a 13.5-minute suite with `timeout_ms: 900000` and blocked
 * inside that single call until the harness killed it — a skeleton deliverable
 * and no findings. The suite was reasonable; waiting for it to the exclusion of
 * the deliverable was not.
 *
 * The clamp only shortens the WAIT. A run that outlives it is handed to
 * monitoring and keeps running, so nothing is lost except silence.
 */

import { describe, it, expect } from 'vitest';
import { clampWaitToBudget, resolveWaitMs } from '../../src/tools/run-terminal.js';

const SEVEN_MIN = 7 * 60_000;

describe('clampWaitToBudget', () => {
  it('leaves the wait alone when the turn has no wall clock', () => {
    expect(clampWaitToBudget(900_000, undefined)).toBe(900_000);
    expect(clampWaitToBudget(900_000, Infinity)).toBe(900_000);
  });

  it('does not extend a wait that already fits the budget', () => {
    expect(clampWaitToBudget(5_000, SEVEN_MIN)).toBe(5_000);
  });

  it('clamps a suite wait to the budget and keeps ~20% for closing', () => {
    // 420s turn -> 84s reserved -> at most 336s of waiting.
    const clamped = clampWaitToBudget(900_000, SEVEN_MIN);
    expect(clamped).toBe(SEVEN_MIN - Math.round(SEVEN_MIN * 0.2));
    expect(clamped).toBeLessThan(SEVEN_MIN);
    // The reserved share is the point: the turn must get control back in time
    // to write the deliverable.
    expect(SEVEN_MIN - clamped).toBeGreaterThanOrEqual(60_000);
  });

  it('reserves half on a short turn rather than starving the wait', () => {
    // The minute-long reserve is capped at half the remaining time, so a 90s
    // turn waits 45s and keeps 45s to write — never a zero-wait refusal.
    const clamped = clampWaitToBudget(900_000, 90_000);
    expect(clamped).toBe(45_000);
    expect(90_000 - clamped).toBe(45_000);
  });

  it('never returns a zero-wait that would look like a refusal', () => {
    expect(clampWaitToBudget(900_000, 1_000)).toBe(5_000);
    expect(clampWaitToBudget(900_000, 0)).toBe(5_000);
  });
});

describe('the defect this fixes', () => {
  it('a 900s suite wait inside a 7-minute turn is no longer 900s', () => {
    const assessed = resolveWaitMs('python3 -m pytest ifixai/tests', undefined, false);
    expect(assessed).toBe(900_000); // the command class really does ask for 15 min
    expect(clampWaitToBudget(assessed, SEVEN_MIN)).toBeLessThanOrEqual(SEVEN_MIN * 0.8);
  });
});
