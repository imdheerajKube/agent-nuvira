/**
 * Turn outcome → router learning signal.
 *
 * The bandit's reward model has always accepted `testPassed` / `userAccepted` /
 * `verificationPassed` / `qualityScore`, but the real path passed `undefined`, so the
 * router learned from a bare "the agent did not throw". These tests pin the mapping
 * from the turn report's DERIVED verification verdict, including the two shapes it
 * must refuse to score at all.
 *
 * `qualityScore` is now carried too — but ONLY from the fitted acceptance model,
 * which refuses below its sample floor. Every shape assertion below therefore
 * injects `NO_QUALITY` so it stays deterministic regardless of how many turns the
 * machine running the suite happens to have rated; the quality path has its own
 * describe block.
 */

import { describe, it, expect } from 'vitest';

import {
  turnOutcomeObservation,
  banditQualityEnabled,
  type TurnObservationOptions,
} from '../../src/learning/outcome-observation.js';
import { buildTurnReport } from '../../src/learning/turn-report.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

/** A report with no measured-quality scorer, so the exact shape is deterministic. */
const NO_QUALITY: TurnObservationOptions = { qualityScoreFor: () => undefined };

function report(verification: TurnReport['verification']): TurnReport {
  return { ...buildTurnReport({ goal: 'g' }), verification };
}

describe('turnOutcomeObservation — what the router learns from a turn', () => {
  it('scores a VERIFIED turn as a success with verificationPassed', () => {
    expect(turnOutcomeObservation(report('verified'), NO_QUALITY)).toEqual({
      outcome: 'success',
      outcomeData: { verificationPassed: true },
    });
  });

  it('scores an UNVERIFIED turn as a success that did NOT verify', () => {
    // Not a hard failure: the model answered, and the reward model's own -0.08 for
    // an unverified success is the calibrated weight. Calling it a failure would
    // penalise one event twice.
    expect(turnOutcomeObservation(report('unverified'), NO_QUALITY)).toEqual({
      outcome: 'success',
      outcomeData: { verificationPassed: false },
    });
  });

  it('refuses to score a BLOCKED turn — a wall is not a capability verdict', () => {
    expect(turnOutcomeObservation(report('blocked'), NO_QUALITY)).toBeNull();
  });

  it('refuses to score a turn with nothing to verify', () => {
    // A plain answer with no plan and no changes is not evidence about the model;
    // a neutral sample for it would dilute the samples that are real.
    expect(turnOutcomeObservation(report('not-applicable'), NO_QUALITY)).toBeNull();
  });

  it('refuses to score when there is no report at all', () => {
    expect(turnOutcomeObservation(undefined, NO_QUALITY)).toBeNull();
    expect(turnOutcomeObservation(null, NO_QUALITY)).toBeNull();
  });
});

describe('qualityScore — the measured input derived signals cannot supply', () => {
  it('carries a measured score when the acceptance model is trained', () => {
    // The scorer stands in for the fitted model: `P(accepted | features)`.
    const obs = turnOutcomeObservation(report('verified'), { qualityScoreFor: () => 0.82 })!;
    expect(obs.outcomeData.qualityScore).toBe(0.82);
  });

  it('omits qualityScore when no fitted model exists (the honest default)', () => {
    // This is the ordinary state on a machine with too few ratings: the reward
    // model learns exactly what it learned before. A fabricated number in a
    // learning record outlives whoever knew it was made up.
    for (const v of ['verified', 'unverified'] as const) {
      expect(turnOutcomeObservation(report(v), NO_QUALITY)!.outcomeData).not.toHaveProperty('qualityScore');
    }
  });

  it('is ON by default and disabled by an explicit OFF word', () => {
    const prev = process.env.NUVIRA_BANDIT_QUALITY;
    try {
      delete process.env.NUVIRA_BANDIT_QUALITY;
      expect(banditQualityEnabled()).toBe(true);
      process.env.NUVIRA_BANDIT_QUALITY = 'off';
      expect(banditQualityEnabled()).toBe(false);
      process.env.NUVIRA_BANDIT_QUALITY = '1';
      expect(banditQualityEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NUVIRA_BANDIT_QUALITY;
      else process.env.NUVIRA_BANDIT_QUALITY = prev;
    }
  });
});

describe('testPassed — the check’s own result, forwarded as evidence', () => {
  it('forwards a check that RAN and passed', () => {
    const r = buildTurnReport({
      goal: 'fix bug',
      toolCalls: ['edit_file', 'run_terminal'],
      successfulToolCalls: ['edit_file', 'run_terminal'],
      mutations: 1,
    });
    expect(turnOutcomeObservation(r, NO_QUALITY)).toEqual({
      outcome: 'success',
      outcomeData: { verificationPassed: true, testPassed: true },
    });
  });

  it('forwards a check that FAILED — the reward model needs the negative too', () => {
    const r = buildTurnReport({
      goal: 'fix bug',
      toolCalls: ['edit_file', 'run_terminal'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
    });
    expect(turnOutcomeObservation(r, NO_QUALITY)!.outcomeData.testPassed).toBe(false);
  });

  it('records NO testPassed sample when nothing was checked', () => {
    // An unverified turn with no check in it at all: the verdict is still recorded,
    // but a `testPassed: false` here would be a made-up failure.
    const r = buildTurnReport({
      goal: 'edit it',
      toolCalls: ['edit_file'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
      flags: { unverifiedEdit: true },
    });
    expect(r.verification).toBe('unverified');
    const obs = turnOutcomeObservation(r, NO_QUALITY)!;
    expect('testPassed' in obs.outcomeData).toBe(false);
    expect(obs.outcomeData.verificationPassed).toBe(false);
  });
});
