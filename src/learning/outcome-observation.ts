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
 * - It never GUESSES a `qualityScore`. It now carries one — but only from the FITTED
 *   acceptance model (`acceptance-model.ts`), which is a measured scale built from the user's own
 *   verdicts and which refuses to fit below its sample floor. On a machine with too few ratings the
 *   field is absent, exactly as before: a made-up number written into a learning record is worse
 *   than a missing one, because the record outlives whoever knows it was fabricated.
 *   (`NUVIRA_BANDIT_QUALITY=off` disables it outright.)
 * - It never attributes an environmental failure to the model: a `blocked` turn is a wall the run hit,
 *   not a capability verdict.
 */

import type { TurnReport } from './turn-report.js';
import type { BanditOutcome, BanditOutcomeData } from './router-bandit.js';
import {
  cachedAcceptanceFit,
  featuresFromReport,
  predictAcceptance,
  type AcceptanceFeatures,
} from './acceptance-model.js';
import { envBuff } from '../config/paths.js';

export interface TurnOutcomeObservation {
  outcome: BanditOutcome;
  outcomeData: Partial<BanditOutcomeData>;
}

/**
 * The Q off-switch. Unset/empty = ON; an explicit OFF word disables the measured
 * quality score so the router falls back to the derived signals it always had.
 * (`NUVIRA_BANDIT_QUALITY=off`.)
 */
const OFF_WORDS = new Set(['0', 'false', 'off', 'no']);

export function banditQualityEnabled(): boolean {
  const v = envBuff('BANDIT_QUALITY');
  if (v === undefined || v === '') return true;
  return !OFF_WORDS.has(v.toLowerCase());
}

/**
 * Seam for a caller (or a test) to supply the measured quality score instead of
 * the fitted model — and the way a caller says "no quality score this turn".
 */
export interface TurnObservationOptions {
  qualityScoreFor?: (features: AcceptanceFeatures) => number | undefined;
}

/**
 * The measured `qualityScore` for a turn, or `undefined`.
 *
 * `undefined` is the honest default: the fitted acceptance model refuses below
 * its sample floor, so on a machine with too few ratings the router learns
 * exactly what it learned before. A number is written ONLY when a trained model
 * exists — never a guessed constant (see `DESIGN_CAPABILITY_BY_MEASUREMENT.md`).
 */
function qualityScoreForTurn(
  report: TurnReport,
  opts: TurnObservationOptions,
): number | undefined {
  const features = featuresFromReport(report);
  if (opts.qualityScoreFor) return opts.qualityScoreFor(features);
  if (!banditQualityEnabled()) return undefined;
  const fit = cachedAcceptanceFit();
  return fit.ok ? predictAcceptance(fit.model, features) : undefined;
}

/**
 * Map a turn's verification verdict to what the router should learn from it.
 * Returns `null` when the turn carries no evidence about the model.
 */
export function turnOutcomeObservation(
  report: TurnReport | null | undefined,
  opts: TurnObservationOptions = {},
): TurnOutcomeObservation | null {
  if (!report) return null;
  // ACCURACY EVIDENCE — the turn's own checks, when it ran any. `checksPassed` is
  // tri-state precisely so that "nobody checked" contributes no `testPassed` sample:
  // a plain question and a failing test suite must not teach the same lesson.
  const checkData = report.checksPassed === undefined ? {} : { testPassed: report.checksPassed };
  // MEASURED QUALITY — the one input derived signals cannot supply (was the work
  // WANTED, not just "did it verify"). Present only when the acceptance model has
  // trained on enough of the user's own verdicts; otherwise omitted entirely.
  const quality = qualityScoreForTurn(report, opts);
  const qualityData = quality === undefined ? {} : { qualityScore: quality };
  switch (report.verification) {
    case 'verified':
      // A change was made and an observation followed it.
      return { outcome: 'success', outcomeData: { verificationPassed: true, ...checkData, ...qualityData } };
    case 'unverified':
      // The turn ran, and its work could not be confirmed (an edit with no
      // observation, an honesty flag, or an unobserved mutation). Booked as a
      // success WITH `verificationPassed: false` rather than as a hard failure:
      // the model DID answer, and the reward model's own penalty for an
      // unverified success is the calibrated weight for exactly this shape.
      // Calling it a failure outright would double-penalise one event.
      return { outcome: 'success', outcomeData: { verificationPassed: false, ...checkData, ...qualityData } };
    default:
      // 'blocked' — a step could not complete (often environmental, not the
      // model's doing). 'not-applicable' — nothing checkable happened. Neither
      // is evidence about the model, so neither is recorded.
      return null;
  }
}
