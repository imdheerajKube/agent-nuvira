/**
 * The Safe-Point Scheduler — where accepted guidance becomes an applied plan.
 *
 * The executor calls `runSafePoint` at a step boundary (before the next model call,
 * after tool results are recorded; between pipeline batches). It NEVER runs during
 * a file write, shell command, or model stream. That single rule is why a plan
 * cannot be corrupted mid-step.
 *
 * Two phases, deliberately separate:
 *   1. TRIAGE interprets guidance and applies policy. It is safe to run any time
 *      because it never mutates the plan (the dashboard may trigger it on submit).
 *   2. APPLY commits accepted changes at a safe point, one immutable version per
 *      change, compare-and-swap on the parent version. A stale writer marks its
 *      change `stale` rather than overwriting newer work.
 */

import { join } from 'node:path';

import { createWorkspaceCheckpoint } from '../learning/workspace-checkpoint.js';
import {
  appendAmendment,
  appendJournal,
  claimLease,
  patchRun,
  readChanges,
  readContract,
  readJournal,
  readRun,
  runDir,
} from './store.js';
import { setStatus, updateGuidance } from './inbox.js';
import {
  applyPlanOps,
  commitInitialPlan,
  commitPlan,
  createInitialPlan,
  findPlanVersionForChange,
  latestPlan,
  planDirective,
} from './plan.js';
import { decide, statusForDecision } from './policy.js';
import { addBacklogItem } from './backlog.js';
import { expireApprovals, requestApproval } from './approvals.js';
import { fallbackAssessment, runChangeSteward, type StewardGenerate } from './steward.js';
import { classifyDeterministically, prefilterGuidance } from './prefilter.js';
import { DEFAULT_STEERING_POLICY } from './types.js';
import type {
  ChangeAssessment,
  ChangeRequestRecord,
  PlanDiff,
  SteeringDecision,
  SteeringPlan,
  SteeringPlanAdapter,
  SteeringPlanStep,
  SteeringPolicy,
  SteeringTickResult,
} from './types.js';

/** One triage at a time per run, so a double submission cannot be classified twice. */
const TRIAGE_LOCKS = new Map<string, Promise<TriageResult>>();

export interface TriageResult {
  triaged: ChangeRequestRecord[];
  stopped: boolean;
  paused: boolean;
  /** Semantic items left `received` because this process has no Steward model. */
  awaitingModel: number;
}

const EMPTY_TICK: SteeringTickResult = {
  stop: false,
  pause: false,
  directive: null,
  appliedChangeIds: [],
  changedIds: [],
};

function emptyDiff(): PlanDiff {
  return { added: [], updated: [], removed: [], cancelled: [], constraintsAdded: [], reordered: false };
}

function mergeDiff(target: PlanDiff, next: PlanDiff): PlanDiff {
  return {
    added: [...new Set([...target.added, ...next.added])],
    updated: [...new Set([...target.updated, ...next.updated])],
    removed: [...new Set([...target.removed, ...next.removed])],
    cancelled: [...new Set([...target.cancelled, ...next.cancelled])],
    constraintsAdded: [...new Set([...target.constraintsAdded, ...next.constraintsAdded])],
    reordered: target.reordered || next.reordered,
  };
}

function assessmentForControl(change: ChangeRequestRecord): ChangeAssessment {
  const gate = prefilterGuidance(change.rawText);
  const base = classifyDeterministically(change.rawText, change.intentHint, gate.control);
  return {
    relation: base.relation,
    kind: base.kind,
    timing: base.timing,
    impact: base.impact,
    confidence: base.confidence,
    affectedStepIds: [],
    conflictsWith: [],
    supersedes: [],
    conflict: 'none',
    requiresApproval: false,
    rationale: base.rationale,
    proposedOps: [],
  };
}

/**
 * TRIAGE ONLY. Interprets every `received` change and records a policy decision.
 * Never mutates a plan, so a surface may call it the moment guidance arrives and
 * show the user a triage card before the next safe point.
 */
export async function triagePending(input: {
  runId: string;
  generate?: StewardGenerate;
  policy?: Partial<SteeringPolicy>;
  now?: number;
}): Promise<TriageResult> {
  const existing = TRIAGE_LOCKS.get(input.runId);
  if (existing) return existing;
  const work = triagePendingUnlocked(input).finally(() => {
    TRIAGE_LOCKS.delete(input.runId);
  });
  TRIAGE_LOCKS.set(input.runId, work);
  return work;
}

async function triagePendingUnlocked(input: {
  runId: string;
  generate?: StewardGenerate;
  policy?: Partial<SteeringPolicy>;
  now?: number;
}): Promise<TriageResult> {
  const now = input.now ?? Date.now();
  const policy: SteeringPolicy = { ...DEFAULT_STEERING_POLICY, ...(input.policy ?? {}) };
  const run = readRun(input.runId);
  if (!run) return { triaged: [], stopped: false, paused: false, awaitingModel: 0 };

  // CRASH RECOVERY: a process can die between `triaging` and the decision. The
  // record must not stay invisible forever. A triage older than five minutes is
  // returned to `received` and retried; a live triage is left alone. A per-process
  // lock already serializes callers inside this process.
  const recoveryCutoff = now - 5 * 60 * 1000;
  for (const change of readChanges(input.runId).filter((entry) => entry.status === 'triaging')) {
    const started = change.triagingAt ? Date.parse(change.triagingAt) : 0;
    if (Number.isFinite(started) && started >= recoveryCutoff) continue;
    updateGuidance(input.runId, change.id, { status: 'received', triagingAt: undefined });
    appendJournal(input.runId, {
      type: 'guidance.triage_recovered',
      actor: 'system',
      changeId: change.id,
      data: { reason: 'the previous triage was interrupted before a decision was recorded' },
    });
  }

  const pending = readChanges(input.runId).filter((change) => change.status === 'received');
  const contract = readContract(input.runId);
  const recentEvents = readJournal(input.runId, 20)
    .reverse()
    .map((event) => `${event.type}${event.changeId ? ` (${event.changeId})` : ''}`);
  const triaged: ChangeRequestRecord[] = [];
  let stopped = false;
  let paused = false;
  let awaitingModel = 0;

  for (const change of pending) {
    updateGuidance(input.runId, change.id, {
      status: 'triaging',
      triagingAt: new Date(now).toISOString(),
    });
    appendJournal(input.runId, {
      type: 'guidance.triaging',
      actor: 'system',
      changeId: change.id,
    });

    const gate = prefilterGuidance(change.rawText);
    if (!gate.ok) {
      const decision: SteeringDecision = {
        action: 'reject',
        reason: gate.reason ?? 'Guidance was refused.',
        escalations: gate.malicious ? ['policy_override_attempt'] : [],
      };
      const rejected = setStatus(input.runId, change.id, 'rejected', {
        decision,
        triagedAt: new Date(now).toISOString(),
        triageLatencyMs: Math.max(0, now - Date.parse(change.submittedAt)),
      });
      if (rejected) triaged.push(rejected);
      continue;
    }

    // CROSS-PROCESS OWNERSHIP. A separate `nuvira steer` process (or any surface
    // without the run's engine) has no Steward model. A model-less semantic
    // decision must never be final: measured 2026-11-09, a 3 ms fallback triage
    // recorded `confirm_interpretation` at confidence 0.45, the run owner never
    // revisited a `triaged` item, and a clear scope change died in the queue.
    // Explicit controls and tags are decidable here; everything else waits for
    // the run's next safe point, where the real model is attached.
    const deterministic = classifyDeterministically(change.rawText, change.intentHint, gate.control);
    const decidableWithoutModel =
      Boolean(input.generate) ||
      gate.control !== 'none' ||
      deterministic.relation === 'meta' ||
      deterministic.kind === 'question' ||
      deterministic.relation === 'new_task';
    if (!decidableWithoutModel) {
      updateGuidance(input.runId, change.id, { status: 'received', triagingAt: undefined });
      appendJournal(input.runId, {
        type: 'guidance.awaiting_model',
        actor: 'system',
        changeId: change.id,
        data: {
          reason:
            'no assessing model is attached to this process; the run owner will triage it at its next safe point',
        },
      });
      awaitingModel += 1;
      continue;
    }

    let assessment: ChangeAssessment;
    if (gate.control !== 'none') {
      // Controls are decidable without a model and must not wait for one.
      assessment = assessmentForControl(change);
    } else if (input.generate && change.intentHint !== 'question' && change.intentHint !== 'new_task') {
      const steward = await runChangeSteward({
        generate: input.generate,
        change,
        run,
        contract,
        plan: latestPlan(input.runId),
        recentEvents,
      });
      assessment = steward.assessment;
    } else {
      const explicitTag = change.intentHint === 'question' || change.intentHint === 'new_task';
      assessment = {
        relation: deterministic.relation,
        kind: deterministic.kind,
        timing: deterministic.timing,
        impact: deterministic.impact,
        confidence: Math.min(deterministic.confidence, 0.5),
        affectedStepIds: change.targetStepId ? [change.targetStepId] : [],
        conflictsWith: [],
        supersedes: [],
        conflict: 'none',
        requiresApproval: false,
        rationale: `${deterministic.rationale} (${
          explicitTag ? 'explicit user tag' : 'assessed deterministically without a model'
        })`,
        proposedOps: [],
      };
    }

    const plan = latestPlan(input.runId);
    const all = readChanges(input.runId);
    const decision = decide({
      change,
      assessment,
      run,
      plan,
      openChanges: all.filter(
        (c) =>
          c.status !== 'applied' &&
          c.status !== 'rejected' &&
          c.status !== 'withdrawn' &&
          c.status !== 'answer_only' &&
          c.status !== 'backlog',
      ).length,
      appliedChanges: all.filter((c) => c.status === 'applied').length,
      policy,
    });
    const status = statusForDecision(decision.action);
    const triagedAt = new Date(now).toISOString();
    const updated = setStatus(input.runId, change.id, status, {
      assessment,
      decision,
      triagedAt,
      triageLatencyMs: Math.max(0, now - Date.parse(change.submittedAt)),
    });
    if (!updated) continue;

    if (decision.action === 'needs_approval') requestApproval(input.runId, change.id, now);
    if (decision.action === 'backlog') {
      addBacklogItem({ runId: input.runId, change: updated, assessment, now });
    }
    if (decision.action === 'stop') {
      stopped = true;
      patchRun(input.runId, { stopRequested: true, status: 'stopped' }, now);
      appendJournal(input.runId, { type: 'run.stopped', actor: 'user', changeId: change.id });
    }
    if (decision.action === 'pause') {
      paused = true;
      patchRun(input.runId, { pauseRequested: true, status: 'paused' }, now);
      appendJournal(input.runId, { type: 'run.paused', actor: 'user', changeId: change.id });
    }
    triaged.push(updated);
  }

  // Expire pending approvals past their TTL. A missed approval must not block the
  // run forever, and the outcome is visible as `deferred`.
  expireApprovals(input.runId, (await import('./store.js')).readApprovals(input.runId), policy.approvalTtlMs, now);

  return { triaged, stopped, paused, awaitingModel };
}

/**
 * APPLY ONLY. Commits accepted changes at a safe point, one plan version each.
 * Refuses a plan write when another process owns the lease or the plan moved.
 */
export async function applyAccepted(input: {
  runId: string;
  adapter: SteeringPlanAdapter;
  policy?: Partial<SteeringPolicy>;
  now?: number;
}): Promise<SteeringTickResult> {
  const now = input.now ?? Date.now();
  const policy: SteeringPolicy = { ...DEFAULT_STEERING_POLICY, ...(input.policy ?? {}) };
  const run = readRun(input.runId);
  if (!run) return { ...EMPTY_TICK };
  if (run.stopRequested || run.status === 'stopped') {
    return { ...EMPTY_TICK, stop: true };
  }
  if (run.pauseRequested || run.status === 'paused') {
    return { ...EMPTY_TICK, pause: true };
  }

  const claim = claimLease(input.runId, { ttlMs: 10 * 60 * 1000, now });
  if (!claim.ok) {
    appendJournal(input.runId, {
      type: 'plan.change_refused',
      actor: 'system',
      data: { reason: claim.reason ?? 'run is leased by another process' },
    });
    return { ...EMPTY_TICK };
  }

  const accepted = readChanges(input.runId)
    .filter((change) => change.status === 'accepted')
    .slice(0, policy.maxChangesPerPlan);

  // Nothing to apply — do NOT invent an empty baseline. Measured 2026-11-09: a
  // baseline captured before `plan_todo` declared its steps stayed at v1 with
  // zero steps, so the surface showed no progress and the Steward had no ids.
  if (accepted.length === 0) return { ...EMPTY_TICK };

  // A run that already has guidance but no version still needs a v1 to mutate.
  if (!latestPlan(input.runId)) {
    const goal = input.adapter.getGoal() || run.goal;
    const initial = createInitialPlan({
      runId: input.runId,
      goal,
      steps: input.adapter.getSteps(),
      contractVersion: run.contractVersion,
      createdBy: 'engine',
      reason: 'baseline captured at the first steering safe point',
    });
    commitInitialPlan(initial);
  }

  const appliedChangeIds: string[] = [];
  const changedIds: string[] = [];
  const appliedChanges: ChangeRequestRecord[] = [];
  let combinedDiff: PlanDiff = emptyDiff();
  let finalPlan = latestPlan(input.runId);

  for (const change of accepted) {
    // IDEMPOTENCY / CRASH RECOVERY: the plan is committed before the change is
    // marked applied. If the process dies in that window, the next safe point
    // must adopt the committed version, not add the same step a second time.
    const alreadyApplied = findPlanVersionForChange(input.runId, change.id);
    if (alreadyApplied) {
      // The adapter can fail independently of the committed version (a provider
      // error, a locked vault). Leave the change actionable so the next safe point
      // retries the SAME version instead of marking a half-applied change done.
      try {
        input.adapter.applyPlanVersion(alreadyApplied);
      } catch (error) {
        appendJournal(input.runId, {
          type: 'change.apply_retry_pending',
          actor: 'system',
          changeId: change.id,
          planVersion: alreadyApplied.version,
          data: { reason: error instanceof Error ? error.message : String(error) },
        });
        finalPlan = alreadyApplied;
        changedIds.push(change.id);
        continue;
      }
      setStatus(input.runId, change.id, 'applied', {
        planVersion: alreadyApplied.version,
        planDiff: alreadyApplied.diff,
        appliedAt: change.appliedAt ?? new Date(now).toISOString(),
        directive: planDirective(alreadyApplied, [change], alreadyApplied.diff),
      });
      appendJournal(input.runId, {
        type: 'change.applied_recovered',
        actor: 'system',
        changeId: change.id,
        planVersion: alreadyApplied.version,
        data: { reason: 'plan version existed before the applied status was recorded' },
      });
      finalPlan = alreadyApplied;
      appliedChangeIds.push(change.id);
      changedIds.push(change.id);
      continue;
    }

    const ops = change.assessment?.proposedOps ?? [];
    if (ops.length === 0) {
      // Accepted with no plan operation is an assessment, not a version: be
      // honest about that rather than inventing an empty plan change.
      setStatus(input.runId, change.id, 'answer_only', {
        decision: {
          action: 'answer_only',
          reason:
            change.decision?.reason ||
            'Accepted as feedback, but it proposed no concrete plan change. Add a specific instruction to change the plan.',
        },
      });
      changedIds.push(change.id);
      continue;
    }

    // A high-impact change is checkpointed BEFORE the plan write. If the
    // snapshot cannot be taken, fail closed: do not apply a material change we
    // cannot undo. The checkpoint lives inside the run's steering directory so
    // the run remains self-contained.
    let workspaceCheckpointId: string | undefined;
    if (change.assessment?.impact === 'high') {
      try {
        const checkpoint = createWorkspaceCheckpoint(run.cwd, {
          label: `steering:${change.id}`,
          storeDir: join(runDir(input.runId), 'workspace-checkpoints'),
        });
        workspaceCheckpointId = checkpoint.id;
        appendJournal(input.runId, {
          type: 'workspace.checkpoint_created',
          actor: 'system',
          changeId: change.id,
          data: { checkpointId: checkpoint.id, files: checkpoint.totals.files },
        });
      } catch (error) {
        const reason = `Workspace checkpoint failed, so this high-impact change was not applied: ${
          error instanceof Error ? error.message : String(error)
        }`;
        setStatus(input.runId, change.id, 'failed', { failure: reason });
        appendJournal(input.runId, {
          type: 'workspace.checkpoint_failed',
          actor: 'system',
          changeId: change.id,
          data: { reason },
        });
        changedIds.push(change.id);
        continue;
      }
    }

    const current = latestPlan(input.runId);
    if (!current) break;
    const mutation = applyPlanOps(current, ops);
    if (!mutation.ok || !mutation.plan) {
      setStatus(input.runId, change.id, 'failed', {
        failure: mutation.error ?? 'the plan operations could not be applied',
      });
      appendJournal(input.runId, {
        type: 'change.failed',
        actor: 'policy',
        changeId: change.id,
        data: { reason: mutation.error ?? 'invalid plan operations' },
      });
      changedIds.push(change.id);
      continue;
    }

    const commit = commitPlan({
      runId: input.runId,
      expectedVersion: current.version,
      plan: mutation.plan,
      changeIds: [change.id],
      reason: change.decision?.reason || change.assessment?.rationale || 'user guidance',
      createdBy: 'steering',
    });
    if (!commit.ok) {
      setStatus(input.runId, change.id, 'stale', {
        failure: commit.reason,
      });
      appendJournal(input.runId, {
        type: 'change.stale',
        actor: 'system',
        changeId: change.id,
        data: { reason: commit.reason, currentVersion: commit.currentVersion },
      });
      changedIds.push(change.id);
      continue;
    }

    // P2.1: persist the exact bounded directive this change produced. The
    // executor receives it (or the adapter projects the same text), so the user
    // can audit what the model was actually told — never the raw guidance.
    const directive = planDirective(commit.plan, [change], commit.diff);
    try {
      input.adapter.applyPlanVersion(commit.plan);
    } catch (error) {
      // The plan version is already committed and immutable. Keep the change
      // ACCEPTED (actionable) rather than failed: the next safe point adopts this
      // version through the idempotency guard and retries the adapter. Marking it
      // failed would strand a committed plan the user was told was applied.
      updateGuidance(input.runId, change.id, {
        planVersion: commit.plan.version,
        planDiff: commit.diff,
        directive,
      });
      appendJournal(input.runId, {
        type: 'change.apply_retry_pending',
        actor: 'system',
        changeId: change.id,
        planVersion: commit.plan.version,
        data: { reason: error instanceof Error ? error.message : String(error) },
      });
      finalPlan = commit.plan;
      combinedDiff = mergeDiff(combinedDiff, commit.diff);
      changedIds.push(change.id);
      continue;
    }
    const applied = setStatus(input.runId, change.id, 'applied', {
      planVersion: commit.plan.version,
      planDiff: commit.diff,
      appliedAt: new Date(now).toISOString(),
      directive,
      ...(workspaceCheckpointId ? { workspaceCheckpointId } : {}),
    });
    appendJournal(input.runId, {
      type: 'plan.change_applied',
      actor: 'system',
      changeId: change.id,
      planVersion: commit.plan.version,
      data: { diff: commit.diff },
    });
    for (const constraint of commit.diff.constraintsAdded) {
      appendAmendment(input.runId, {
        at: new Date(now).toISOString(),
        changeId: change.id,
        kind: change.assessment?.kind ?? 'constraint',
        text: constraint,
      });
    }
    // A non-constraint approved scope change is also a contract amendment. The
    // original contract is never rewritten; this appends the approved change so
    // the next plan version and the Steward see the amended contract.
    if (commit.diff.constraintsAdded.length === 0) {
      appendAmendment(input.runId, {
        at: new Date(now).toISOString(),
        changeId: change.id,
        kind: change.assessment?.kind ?? 'modify',
        text: change.assessment?.rationale || change.decision?.reason || 'approved plan change',
      });
    }
    finalPlan = commit.plan;
    combinedDiff = mergeDiff(combinedDiff, commit.diff);
    appliedChangeIds.push(change.id);
    changedIds.push(change.id);
    if (applied) appliedChanges.push(applied);
  }

  const directive =
    finalPlan && appliedChanges.length > 0
      ? planDirective(finalPlan, appliedChanges, combinedDiff)
      : null;

  return {
    stop: false,
    pause: false,
    directive,
    ...(directive ? { key: `steering:${appliedChangeIds.join(',')}` } : {}),
    appliedChangeIds,
    changedIds,
  };
}

/**
 * Keep the steering plan a mirror of the engine's own plan.
 *
 * The baseline used to be captured once, at the first safe point, and never
 * refreshed. If that point ran before `plan_todo` declared its steps, the steering
 * plan stayed at v1 with zero steps forever (measured 2026-11-09: engine 3/3 done,
 * steering plan v1 `steps: []`), so the surface rendered no progress and the
 * Steward had no step ids to target.
 *
 * Identity changes sync immediately. Status-only changes are throttled so a
 * per-model-call sync cannot create a plan version per step; a fully terminal
 * plan always syncs, so the last statuses are never lost.
 */
const SYNC_STATUS_INTERVAL_MS = 5_000;

function planSignature(steps: SteeringPlanStep[]): string {
  return steps
    .map((s) =>
      [s.id, s.status, s.description, s.dependsOn.join(','), s.acceptanceCriteria.join(','), s.priority, s.note ?? ''].join(
        '\u0000',
      ),
    )
    .join('\u0001');
}

function planIdentity(steps: SteeringPlanStep[]): string {
  return steps.map((s) => [s.id, s.description, s.dependsOn.join(',')].join('\u0000')).join('\u0001');
}

export function syncPlanFromEngine(input: {
  runId: string;
  adapter: SteeringPlanAdapter;
  now?: number;
}): SteeringPlan | null {
  const now = input.now ?? Date.now();
  const latest = latestPlan(input.runId);
  let engineSteps: SteeringPlanStep[];
  try {
    engineSteps = input.adapter.getSteps();
  } catch {
    return latest;
  }
  // No engine plan yet: leave the steering plan absent rather than writing an
  // empty version that can never be trusted to represent the work.
  if (engineSteps.length === 0) return latest;

  const run = readRun(input.runId);
  const goal = input.adapter.getGoal() || run?.goal || '';
  if (!latest) {
    return commitInitialPlan(
      createInitialPlan({
        runId: input.runId,
        goal,
        steps: engineSteps,
        contractVersion: run?.contractVersion ?? 1,
        createdBy: 'engine',
        reason: 'baseline captured from the engine plan',
      }),
    );
  }

  // STEERING-ADDED WORK MUST SURVIVE A LAG. An adapter that failed to write a
  // committed version, or an engine that has not yet refreshed, must not cause
  // the next sync to DELETE the accepted step. Carry missing future steps that
  // steering added; the engine remains authoritative for the steps it knows.
  const engineIds = new Set(engineSteps.map((step) => step.id));
  const carried = latest.steps.filter(
    (step) =>
      !engineIds.has(step.id) && (step.status === 'pending' || step.status === 'blocked'),
  );
  const syncedSteps = carried.length > 0 ? [...engineSteps, ...carried] : engineSteps;

  if (planSignature(syncedSteps) === planSignature(latest.steps)) return latest;
  const identityChanged = planIdentity(syncedSteps) !== planIdentity(latest.steps);
  const engineTerminal = syncedSteps.every((s) => s.status === 'done' || s.status === 'cancelled');
  const age = now - Date.parse(latest.createdAt);
  if (!identityChanged && !engineTerminal && Number.isFinite(age) && age < SYNC_STATUS_INTERVAL_MS) {
    return latest;
  }

  const commit = commitPlan({
    runId: input.runId,
    expectedVersion: latest.version,
    // Constraints are user authority: the engine's checklist cannot erase one.
    plan: { ...latest, goal: latest.goal || goal, steps: syncedSteps },
    changeIds: [],
    reason: 'engine plan synced at a safe point',
    createdBy: 'engine',
  });
  if (!commit.ok) return latest;
  appendJournal(input.runId, {
    type: 'plan.engine_synced',
    actor: 'system',
    planVersion: commit.plan.version,
    data: { steps: engineSteps.length, identityChanged, reason: 'engine plan changed' },
  });
  return commit.plan;
}

/**
 * The one call an executor makes at a safe point: triage anything new, then apply
 * anything already accepted (including a change the user approved since the last
 * boundary). Stop/pause are reported before any plan write.
 */
export async function runSafePoint(input: {
  runId: string;
  adapter: SteeringPlanAdapter;
  generate?: StewardGenerate;
  policy?: Partial<SteeringPolicy>;
  now?: number;
}): Promise<SteeringTickResult> {
  const run = readRun(input.runId);
  if (run?.stopRequested || run?.status === 'stopped') return { ...EMPTY_TICK, stop: true };
  if (run?.pauseRequested || run?.status === 'paused') return { ...EMPTY_TICK, pause: true };

  // MIRROR FIRST: the Steward should classify against the steps the engine has
  // now, not against a baseline captured before the plan existed.
  try {
    syncPlanFromEngine({ runId: input.runId, adapter: input.adapter, now: input.now });
  } catch {
    // Mirroring is advisory; a failure must never break the safe point.
  }

  const triage = await triagePending({
    runId: input.runId,
    generate: input.generate,
    policy: input.policy,
    now: input.now,
  });
  if (triage.stopped) return { ...EMPTY_TICK, stop: true, changedIds: triage.triaged.map((c) => c.id) };
  if (triage.paused) return { ...EMPTY_TICK, pause: true, changedIds: triage.triaged.map((c) => c.id) };

  const applied = await applyAccepted({
    runId: input.runId,
    adapter: input.adapter,
    policy: input.policy,
    now: input.now,
  });
  return {
    ...applied,
    changedIds: [...new Set([...triage.triaged.map((c) => c.id), ...applied.changedIds])],
  };
}

/** The bounded summary a resumed process shows before its first step. */
export function pendingGuidanceSummary(runId: string): string {
  const changes = readChanges(runId);
  const open = changes.filter(
    (c) => c.status !== 'applied' && c.status !== 'rejected' && c.status !== 'withdrawn',
  ).length;
  return open > 0 ? `resuming with ${open} pending guidance item(s)` : '';
}

export { fallbackAssessment };
