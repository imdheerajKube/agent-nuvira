/**
 * Turn outcome → router learning signal.
 *
 * The bandit's reward model has always accepted `testPassed` / `userAccepted` /
 * `verificationPassed` / `qualityScore`, but the real path passed `undefined`, so the
 * router learned from a bare "the agent did not throw". These tests pin the mapping
 * from the turn report's DERIVED verification verdict, including the two shapes it
 * must refuse to score at all.
 */

import { describe, it, expect } from 'vitest';

import { turnOutcomeObservation } from '../../src/learning/outcome-observation.js';
import { buildTurnReport } from '../../src/learning/turn-report.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

function report(verification: TurnReport['verification']): TurnReport {
  return { ...buildTurnReport({ goal: 'g' }), verification };
}

describe('turnOutcomeObservation — what the router learns from a turn', () => {
  it('scores a VERIFIED turn as a success with verificationPassed', () => {
    expect(turnOutcomeObservation(report('verified'))).toEqual({
      outcome: 'success',
      outcomeData: { verificationPassed: true },
    });
  });

  it('scores an UNVERIFIED turn as a success that did NOT verify', () => {
    // Not a hard failure: the model answered, and the reward model's own -0.08 for
    // an unverified success is the calibrated weight. Calling it a failure would
    // penalise one event twice.
    expect(turnOutcomeObservation(report('unverified'))).toEqual({
      outcome: 'success',
      outcomeData: { verificationPassed: false },
    });
  });

  it('refuses to score a BLOCKED turn — a wall is not a capability verdict', () => {
    expect(turnOutcomeObservation(report('blocked'))).toBeNull();
  });

  it('refuses to score a turn with nothing to verify', () => {
    // A plain answer with no plan and no changes is not evidence about the model;
    // a neutral sample for it would dilute the samples that are real.
    expect(turnOutcomeObservation(report('not-applicable'))).toBeNull();
  });

  it('refuses to score when there is no report at all', () => {
    expect(turnOutcomeObservation(undefined)).toBeNull();
    expect(turnOutcomeObservation(null)).toBeNull();
  });

  it('never invents a qualityScore', () => {
    // qualityScore needs a measured scale (docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md);
    // a fabricated number in a learning record outlives whoever knew it was made up.
    for (const v of ['verified', 'unverified'] as const) {
      expect(turnOutcomeObservation(report(v))!.outcomeData).not.toHaveProperty('qualityScore');
    }
  });
});
