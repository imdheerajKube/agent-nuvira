/**
 * The steering projection — the read model every surface renders.
 *
 * This is what makes the channel trustworthy: a user can see, for every input,
 * what it was understood as, what policy decided, what changed, and why. The
 * projection is derived from durable state, so a page reload or a process restart
 * shows the same history rather than an empty panel.
 */

import { latestPlan } from './plan.js';
import { describeEscalations } from './policy.js';
import {
  readApprovals,
  readBacklog,
  readChanges,
  readContract,
  readJournal,
  readRun,
  runStaleness,
} from './store.js';
import type {
  ApprovalRecord,
  ChangeRequestRecord,
  SteeringMetrics,
  SteeringProjection,
} from './types.js';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

/** Derive the operational metrics from the records themselves. */
export function steeringMetrics(
  changes: ChangeRequestRecord[],
  approvals: ApprovalRecord[],
  planVersions: number,
): SteeringMetrics {
  const latencies = changes
    .map((c) => c.triageLatencyMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const approved = new Set(approvals.filter((a) => a.state === 'approved').map((a) => a.changeId));
  const appliedChanges = changes.filter((c) => c.status === 'applied');
  const highImpactFalseAccepts = appliedChanges.filter(
    (c) => c.assessment?.impact === 'high' && !approved.has(c.id),
  ).length;
  const applyLatencies = appliedChanges
    .map((c) => {
      if (!c.appliedAt) return null;
      const elapsed = Date.parse(c.appliedAt) - Date.parse(c.submittedAt);
      return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    })
    .filter((v): v is number => v !== null);
  const decisionLatencies = approvals
    .map((a) => {
      if (!a.decidedAt) return null;
      const elapsed = Date.parse(a.decidedAt) - Date.parse(a.requestedAt);
      return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    })
    .filter((v): v is number => v !== null);
  const staleCount = changes.filter((c) => c.status === 'stale').length;
  const lowConfidenceCount = changes.filter(
    (c) => typeof c.assessment?.confidence === 'number' && c.assessment.confidence < 0.55,
  ).length;
  const lastTriaged = changes
    .map((c) => c.triagedAt)
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .pop();
  return {
    guidanceReceived: changes.length,
    applied: appliedChanges.length,
    rejected: changes.filter((c) => c.status === 'rejected').length,
    deferred: changes.filter((c) => c.status === 'deferred').length,
    backlogged: changes.filter((c) => c.status === 'backlog').length,
    needsApproval: changes.filter((c) => c.status === 'needs_approval').length,
    planVersions,
    avgTriageLatencyMs: latencies.length
      ? Math.round(latencies.reduce((sum, v) => sum + v, 0) / latencies.length)
      : 0,
    p95TriageLatencyMs: percentile(latencies, 95),
    avgTimeToApplyMs: applyLatencies.length
      ? Math.round(applyLatencies.reduce((sum, v) => sum + v, 0) / applyLatencies.length)
      : 0,
    staleRate: changes.length ? staleCount / changes.length : 0,
    avgApprovalLatencyMs: decisionLatencies.length
      ? Math.round(decisionLatencies.reduce((sum, v) => sum + v, 0) / decisionLatencies.length)
      : 0,
    abandonedApprovals: approvals.filter((a) => a.state === 'expired').length,
    lowConfidenceCount,
    replansPerAppliedChange:
      appliedChanges.length > 0 ? Math.max(0, planVersions - 1) / appliedChanges.length : 0,
    highImpactFalseAccepts,
    ...(lastTriaged ? { lastTriageAt: lastTriaged } : {}),
  };
}

/**
 * The audit trail of ONE change, as plain lines (P2.1 steer-with-proof).
 *
 * This is deliberately derived only from durable fields: receipt, triage
 * latency, decision/escalations, the plan diff, and the exact bounded directive
 * the executor was given. A surface that renders this cannot accidentally show a
 * raw message as if it had been injected into the thread.
 */
export function changeProof(change: ChangeRequestRecord): string[] {
  const lines: string[] = [
    `${change.id} · ${change.status}`,
    `Received ${change.submittedAt} from ${change.source} (${change.author}).`,
  ];
  if (change.triagedAt) {
    lines.push(
      `Triaged ${change.triagedAt}${
        typeof change.triageLatencyMs === 'number' ? ` — ${change.triageLatencyMs} ms after receipt` : ''
      }.`,
    );
  }
  if (change.appliedAt) lines.push(`Applied ${change.appliedAt}.`);
  if (change.decision) {
    lines.push(`Decision: ${change.decision.action} — ${change.decision.reason}`);
    if (change.decision.escalations?.length) {
      lines.push(`Escalated because: ${describeEscalations(change.decision.escalations).join('; ')}.`);
    }
    if (change.decision.approvalEffect) lines.push(change.decision.approvalEffect);
  }
  if (change.planDiff) {
    const diff = change.planDiff;
    const parts: string[] = [];
    if (diff.added.length) parts.push(`+${diff.added.join(',')}`);
    if (diff.updated.length) parts.push(`~${diff.updated.join(',')}`);
    if (diff.removed.length) parts.push(`-${diff.removed.join(',')}`);
    if (diff.cancelled.length) parts.push(`cancelled ${diff.cancelled.join(',')}`);
    if (diff.constraintsAdded.length) parts.push(`${diff.constraintsAdded.length} constraint(s)`);
    if (diff.reordered) parts.push('reordered');
    if (parts.length) lines.push(`Plan v${change.planVersion ?? '?'} diff: ${parts.join(' · ')}`);
  }
  if (change.failure) lines.push(`Failure: ${change.failure}`);
  if (change.directive) {
    lines.push('', 'Executor directive (bounded, derived from the applied version):', change.directive);
  }
  return lines;
}

/** Build the full view for one run. A missing run is a real, empty answer. */
export function projectRun(runId: string, options: { enabled?: boolean } = {}): SteeringProjection {
  const run = readRun(runId);
  const changes = run ? readChanges(runId) : [];
  const approvals = run ? readApprovals(runId) : [];
  const plan = run ? latestPlan(runId) : null;
  const backlog = run ? readBacklog(runId) : [];
  const contract = run ? readContract(runId) : null;
  const recentEvents = run ? readJournal(runId, 60).reverse() : [];
  // Derived at read time, never persisted: a surface cannot offer "close stale
  // run" unless the projection says the lease is actually dead.
  const staleness = run ? runStaleness(run) : null;
  const count = (status: ChangeRequestRecord['status']): number =>
    changes.filter((c) => c.status === status).length;
  const open = changes.filter(
    (c) =>
      c.status !== 'applied' &&
      c.status !== 'rejected' &&
      c.status !== 'withdrawn' &&
      c.status !== 'answer_only',
  ).length;
  return {
    enabled: options.enabled ?? true,
    run:
      run && staleness
        ? {
            ...run,
            stale: staleness.stale,
            ...(staleness.staleSince ? { staleSince: staleness.staleSince } : {}),
          }
        : null,
    plan,
    contract,
    changes,
    approvals,
    backlog,
    recentEvents,
    counts: {
      received: count('received'),
      triaged: count('triaged'),
      needsApproval: count('needs_approval'),
      accepted: count('accepted'),
      applied: count('applied'),
      deferred: count('deferred'),
      answerOnly: count('answer_only'),
      backlog: count('backlog'),
      rejected: count('rejected'),
      stale: count('stale'),
      failed: count('failed'),
      withdrawn: count('withdrawn'),
      open,
    },
    metrics: steeringMetrics(changes, approvals, plan?.version ?? 0),
  };
}
