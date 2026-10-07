/**
 * Turn outcome → router learning signal.
 *
 * WHY THIS EXISTS. `RouterBandit` has always carried a measured-quality reward model — `testPassed`,
 * `userAccepted`, `verificationPassed`, `qualityScore` — with arms for the provider AND the concrete
 * model, and `applyReward` already folds all four into the reward. But nothing on the real path ever
 * filled it in: `AutoModelRouter.recordOutcome` forwarded `undefined` to every arm, so the reward was
 * a cost-adjusted coin flip on "the agent did not throw". That is the D2 defect one layer down — a
 * response that was empty or useless still counted as a success for the purpose of learning.
 *
 * The harness ALREADY derives the honest signal: `TurnReport.verification` is built from recorded tool
 * and plan evidence and can never be talked up by the model's narration. This module is the single
 * pure translation between that verdict and the learning payload, so the mapping is ONE reviewable
 * decision instead of a payload assembled ad hoc at each call site.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 * - It records NOTHING when the report carries no verdict about the model. A plain answer with no
 *   plan and no changes is not evidence of quality, and inventing a neutral sample for it would
 *   dilute the samples that are real.
 * - It never guesses a `qualityScore`. That needs a measured scale (see
 *   `docs/DESIGN_CAPABILITY_BY_MEASUREMENT.md`), and a made-up number written into a learning record
 *   is worse than a missing one — the record outlives whoever knows it was fabricated.
 * - It never attributes an environmental failure to the model: a `blocked` turn is a wall the run hit,
 *   not a capability verdict.
 */

import type { TurnReport } from './turn-report.js';
import type { BanditOutcome, BanditOutcomeData } from './router-bandit.js';

export interface TurnOutcomeObservation {
  outcome: BanditOutcome;
  outcomeData: Partial<BanditOutcomeData>;
}

/**
 * Map a turn's verification verdict to what the router should learn from it.
 * Returns `null` when the turn carries no evidence about the model.
 */
export function turnOutcomeObservation(
  report: TurnReport | null | undefined,
): TurnOutcomeObservation | null {
  if (!report) return null;
  // ACCURACY EVIDENCE — the turn's own checks, when it ran any. `checksPassed` is
  // tri-state precisely so that "nobody checked" contributes no `testPassed` sample:
  // a plain question and a failing test suite must not teach the same lesson.
  const checkData = report.checksPassed === undefined ? {} : { testPassed: report.checksPassed };
  switch (report.verification) {
    case 'verified':
      // A change was made and an observation followed it.
      return { outcome: 'success', outcomeData: { verificationPassed: true, ...checkData } };
    case 'unverified':
      // The turn ran, and its work could not be confirmed (an edit with no
      // observation, an honesty flag, or an unobserved mutation). Booked as a
      // success WITH `verificationPassed: false` rather than as a hard failure:
      // the model DID answer, and the reward model's own penalty for an
      // unverified success is the calibrated weight for exactly this shape.
      // Calling it a failure outright would double-penalise one event.
      return { outcome: 'success', outcomeData: { verificationPassed: false, ...checkData } };
    default:
      // 'blocked' — a step could not complete (often environmental, not the
      // model's doing). 'not-applicable' — nothing checkable happened. Neither
      // is evidence about the model, so neither is recorded.
      return null;
  }
}
