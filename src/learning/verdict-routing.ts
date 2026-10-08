/**
 * Verdict → router: what an EXPLICIT user verdict does to model ROUTING.
 *
 * THE GAP THIS CLOSES. The derived correction signal (a regression reported in the
 * user's next message) already reaches the router bandit — `chat.ts` calls
 * `AutoModelRouter.recordUserRejection`, which applies the deferred
 * `userAccepted: false` delta to the arm that served the turn. An EXPLICIT verdict
 * (`nuvira rate bad`, the dashboard's 👎) did not: it recorded the label a quality
 * fit reads and stopped there. So the clearest statement a user can make — "this
 * turn was not what I wanted" — reached the dataset but never the router.
 *
 * This module is the bridge. It reads the trace the verdict names, recovers the arm
 * the turn was learned under (provider/model/complexity + the task intent the
 * router bucketed it by), and applies the SAME `α−δ / β+δ` the derived path uses —
 * once per trace, deduped in the bandit itself (`recordExplicitVerdict`).
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *  - It never applies an ACCEPTANCE to the bandit. A turn is recorded as its own
 *    outcome at the end of the turn (see `turnOutcomeObservation`); a 👍 adds no new
 *    observation, and inventing a second positive sample for it would be the same
 *    fabrication the label subsystem exists to avoid. The verdict is still stored —
 *    it is what the fitted quality model reads.
 *  - It never creates an arm. A rejection corrects one that already exists; a turn
 *    that was never routed (not auto, bandit off) has nothing to correct.
 *  - It is best-effort throughout. A missing trace, an unreadable config or a
 *    failed bandit write leaves the recorded label untouched and is reported, never
 *    thrown.
 */

import { getRouterBandit } from './router-bandit.js';
import { getTrace, type ReasoningTrace, type TraceRoutingSnapshot } from './reasoning-trace.js';
import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';
import { turnOutcomeObservation } from './outcome-observation.js';
import { ConfigManager } from '../config/manager.js';

/** What applying a verdict to the router did, for a caller to report honestly. */
export interface VerdictRoutingOutcome {
  /** True when the verdict was processed (the delta may or may not have moved a prior). */
  applied: boolean;
  /** True when this exact trace had already been applied — nothing moved twice. */
  alreadyApplied: boolean;
  /** How many Beta priors (provider and/or model) the delta moved. */
  moved: number;
  provider?: string;
  model?: string;
  complexity?: string;
  /** Why nothing applied, or what moved — always a human sentence. */
  reason: string;
}

const notApplied = (reason: string): VerdictRoutingOutcome => ({
  applied: false,
  alreadyApplied: false,
  moved: 0,
  reason,
});

/**
 * The routing snapshot the turn was learned under: the newest routing DECISION
 * event, else the first step that carries one. Read newest-first because a turn
 * that failed over ends on its final pair, which is the one the outcome was
 * attributed to.
 */
function routingOf(trace: ReasoningTrace): TraceRoutingSnapshot | undefined {
  const events = trace.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].routing) return events[i].routing;
  }
  for (const step of trace.steps) {
    if (step.routing) return step.routing;
  }
  return undefined;
}

/**
 * Apply the user's EXPLICIT verdict on `traceId` to the router bandit.
 *
 * `verdict === 'rejected'` is the only case that moves an arm — see the module
 * header for why an acceptance does not. Every early return names its reason so
 * the CLI can print the truth instead of a silent no-op.
 */
export function applyVerdictToRouter(
  traceId: string,
  verdict: 'accepted' | 'rejected',
): VerdictRoutingOutcome {
  if (verdict !== 'rejected') {
    return notApplied('accepted — the turn was recorded as its own outcome, so a 👍 adds nothing to routing');
  }

  let trace: ReturnType<typeof getTrace> = null;
  try {
    trace = getTrace(traceId);
  } catch {
    trace = null;
  }
  if (!trace) return notApplied('trace not found');

  // A rejection only carries an un-applied penalty when the turn was recorded as a
  // SUCCESS (the other branches never read `userAccepted`). Derive the outcome from
  // the turn's OWN evidence, the same translation the record path used.
  const observation = turnOutcomeObservation(trace.turnReport);
  if (!observation) return notApplied('the turn carries no verdict about the model — nothing to correct');

  // Routing learning is switchable; honour the same gate the record path uses.
  try {
    if (new ConfigManager().getAll().routing?.bandit === false) {
      return notApplied('router learning is switched off (routing.bandit = false)');
    }
  } catch {
    // An unreadable config leaves the default (learning on), exactly like the record path.
  }

  const snap = routingOf(trace);
  const provider = snap?.provider ?? trace.provider;
  if (!provider) return notApplied('the trace records no provider to correct');
  const model = snap?.model ?? trace.model;
  const complexity: ComplexityLevel =
    (snap?.complexity as ComplexityLevel | undefined) ?? analyzeComplexity(trace.goal);

  try {
    const res = getRouterBandit().recordExplicitVerdict({
      traceId,
      provider,
      complexity,
      ...(snap?.taskIntent ? { taskIntent: snap.taskIntent } : {}),
      ...(model ? { model } : {}),
      outcome: observation.outcome,
    });
    return {
      applied: res.applied,
      alreadyApplied: res.alreadyApplied,
      moved: res.moved,
      reason: res.reason,
      provider,
      ...(model ? { model } : {}),
      complexity,
    };
  } catch {
    return notApplied('the bandit write failed (learning is best-effort)');
  }
}
