/**
 * Versioned plans — the only place a run's executable plan changes.
 *
 * Every accepted change produces a new IMMUTABLE version with a parent pointer, the
 * change ids that produced it, and a diff. There is no unversioned mutation. The
 * commit is compare-and-swap on the parent version, so a stale writer is refused
 * instead of silently overwriting newer work.
 *
 * The mutator is deliberately strict:
 *  - removing or rewriting a COMPLETED step is an error, never a quiet deletion;
 *  - an unknown step id fails the whole batch (atomic, no partial plans);
 *  - cancellation only touches future (`pending`/`blocked`) steps.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { appendJournal, patchRun, planPath, plansDir, readJson, readRun, writeJson } from './store.js';
import type {
  ChangeRequestRecord,
  PlanDiff,
  PlanOp,
  SteeringPlan,
  SteeringPlanStep,
  SteeringStepStatus,
} from './types.js';

const STATUSES: SteeringStepStatus[] = ['pending', 'running', 'done', 'blocked', 'cancelled'];

function normalizeStep(raw: Partial<SteeringPlanStep>, index: number): SteeringPlanStep {
  return {
    id: String(raw.id ?? `step-${index + 1}`),
    description: String(raw.description ?? '').trim(),
    status: STATUSES.includes(raw.status as SteeringStepStatus)
      ? (raw.status as SteeringStepStatus)
      : 'pending',
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String).filter(Boolean) : [],
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
      ? raw.acceptanceCriteria.map(String).filter(Boolean)
      : [],
    priority: raw.priority === 'low' || raw.priority === 'high' ? raw.priority : 'normal',
    ...(raw.agentType ? { agentType: String(raw.agentType) } : {}),
    ...(raw.note ? { note: String(raw.note) } : {}),
  };
}

/** A fresh v1 from an engine's current plan. */
export function createInitialPlan(input: {
  runId: string;
  goal: string;
  steps: SteeringPlanStep[];
  constraints?: string[];
  contractVersion?: number;
  createdBy?: string;
  reason?: string;
}): SteeringPlan {
  return {
    runId: input.runId,
    version: 1,
    parentVersion: 0,
    contractVersion: input.contractVersion ?? 1,
    goal: input.goal,
    steps: input.steps.map(normalizeStep),
    constraints: [...(input.constraints ?? [])],
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? 'system',
    reason: input.reason ?? 'run started',
    changeIds: [],
    diff: { added: [], updated: [], removed: [], cancelled: [], constraintsAdded: [], reordered: false },
  };
}

/** The newest plan version on disk, or null. */
export function latestPlan(runId: string): SteeringPlan | null {
  const dir = plansDir(runId);
  if (!existsSync(dir)) return null;
  let best: SteeringPlan | null = null;
  try {
    for (const name of readdirSync(dir)) {
      const match = /^v(\d+)\.json$/.exec(name);
      if (!match) continue;
      const plan = readJson<SteeringPlan>(join(dir, name));
      if (!plan || typeof plan.version !== 'number') continue;
      if (!best || plan.version > best.version) best = plan;
    }
  } catch {
    return null;
  }
  return best;
}

export function readPlanVersion(runId: string, version: number): SteeringPlan | null {
  return readJson<SteeringPlan>(planPath(runId, version));
}

/**
 * The version a change already produced, if any. This is the idempotency guard
 * for an apply that crashed after committing the plan but before marking the
 * change applied: the next safe point adopts the committed version instead of
 * adding the same step again.
 */
export function findPlanVersionForChange(runId: string, changeId: string): SteeringPlan | null {
  const dir = plansDir(runId);
  if (!existsSync(dir)) return null;
  let found: SteeringPlan | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^v\d+\.json$/.test(name)) continue;
      const plan = readJson<SteeringPlan>(join(dir, name));
      if (!plan || !Array.isArray(plan.changeIds) || !plan.changeIds.includes(changeId)) continue;
      if (!found || plan.version > found.version) found = plan;
    }
  } catch {
    return null;
  }
  return found;
}

/** A compact before/after diff. */
export function diffPlans(before: SteeringPlan | null, after: SteeringPlan): PlanDiff {
  const beforeById = new Map((before?.steps ?? []).map((s) => [s.id, s]));
  const afterById = new Map(after.steps.map((s) => [s.id, s]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const cancelled: string[] = [];

  for (const step of after.steps) {
    const old = beforeById.get(step.id);
    if (!old) {
      added.push(step.id);
      continue;
    }
    if (old.status !== step.status && step.status === 'cancelled') cancelled.push(step.id);
    const a = JSON.stringify({ ...old, status: undefined });
    const b = JSON.stringify({ ...step, status: undefined });
    if (a !== b || old.status !== step.status) updated.push(step.id);
  }
  for (const step of before?.steps ?? []) {
    if (!afterById.has(step.id)) removed.push(step.id);
  }
  const beforeOrder = (before?.steps ?? []).map((s) => s.id).filter((id) => afterById.has(id));
  const afterOrder = after.steps.map((s) => s.id).filter((id) => beforeById.has(id));
  const beforeConstraints = new Set(before?.constraints ?? []);
  const constraintsAdded = after.constraints.filter((c) => !beforeConstraints.has(c));
  return {
    added,
    updated,
    removed,
    cancelled,
    constraintsAdded,
    reordered: beforeOrder.join('|') !== afterOrder.join('|'),
  };
}

export interface PlanMutationResult {
  ok: boolean;
  error?: string;
  plan?: SteeringPlan;
  diff?: PlanDiff;
}

function nextStepId(steps: SteeringPlanStep[]): string {
  let max = 0;
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `step-${max + 1}`;
}

/**
 * Apply typed operations to a plan, returning a NEW plan (same version; the
 * caller commits it as the next version). The batch is atomic: one invalid op
 * returns an error and no plan, so a partial change can never be committed.
 */
export function applyPlanOps(plan: SteeringPlan, ops: PlanOp[]): PlanMutationResult {
  const steps: SteeringPlanStep[] = plan.steps.map((s) => ({
    ...s,
    dependsOn: [...s.dependsOn],
    acceptanceCriteria: [...s.acceptanceCriteria],
  }));
  const constraints = [...plan.constraints];

  for (const op of ops) {
    switch (op.op) {
      case 'add_step': {
        const description = String(op.step.description ?? '').trim();
        if (!description) return { ok: false, error: 'add_step requires a description.' };
        let id = op.step.id?.trim() || nextStepId(steps);
        if (steps.some((s) => s.id === id)) id = nextStepId(steps);
        const step: SteeringPlanStep = {
          id,
          description,
          status: 'pending',
          dependsOn: [...(op.step.dependsOn ?? [])],
          acceptanceCriteria: [...(op.step.acceptanceCriteria ?? [])],
          priority: op.step.priority ?? 'normal',
          ...(op.step.agentType ? { agentType: op.step.agentType } : {}),
        };
        // An `after` anchor is a PLACEMENT HINT, not a mutation target. A model
        // that copies the plan's ordinal ("3") instead of the step id ("verify")
        // must not fail an otherwise valid additive batch. Measured 2026-11-09:
        // the benchmark's scope change was ACCEPTED and then died on this anchor.
        // Unknown TARGET ids (update/remove/reorder/cancel/priority) still fail
        // the whole batch, so atomicity for real edits is unchanged.
        const anchor = op.after ? steps.findIndex((s) => s.id === op.after) : -1;
        if (anchor >= 0) steps.splice(anchor + 1, 0, step);
        else steps.push(step);
        break;
      }
      case 'update_step': {
        const at = steps.findIndex((s) => s.id === op.stepId);
        if (at === -1) return { ok: false, error: `update_step: unknown step "${op.stepId}".` };
        const target = steps[at];
        if (target.status === 'running') {
          return {
            ok: false,
            error: `update_step: step "${op.stepId}" is running; changes apply only at a safe point, never mid-task.`,
          };
        }
        if (target.status === 'done' && op.patch.description !== undefined) {
          return {
            ok: false,
            error: `update_step: refusing to rewrite completed step "${op.stepId}" without approval.`,
          };
        }
        if (target.status === 'done' && op.patch.status !== undefined && op.patch.status !== 'done') {
          return {
            ok: false,
            error: `update_step: refusing to un-complete step "${op.stepId}" without approval.`,
          };
        }
        steps[at] = {
          ...target,
          ...(op.patch.description !== undefined ? { description: op.patch.description } : {}),
          ...(op.patch.dependsOn !== undefined ? { dependsOn: [...op.patch.dependsOn] } : {}),
          ...(op.patch.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: [...op.patch.acceptanceCriteria] }
            : {}),
          ...(op.patch.priority !== undefined ? { priority: op.patch.priority } : {}),
          ...(op.patch.status !== undefined ? { status: op.patch.status } : {}),
          ...(op.patch.note !== undefined ? { note: op.patch.note } : {}),
        };
        break;
      }
      case 'remove_step': {
        const at = steps.findIndex((s) => s.id === op.stepId);
        if (at === -1) return { ok: false, error: `remove_step: unknown step "${op.stepId}".` };
        const target = steps[at];
        if (target.status === 'done') {
          return {
            ok: false,
            error: `remove_step: refusing to delete completed step "${op.stepId}". Reduce future scope instead, or get approval for a remediation step.`,
          };
        }
        if (target.status === 'running') {
          return { ok: false, error: `remove_step: step "${op.stepId}" is running; changes apply only at safe points.` };
        }
        steps.splice(at, 1);
        // Dependencies on a removed step would deadlock the pipeline.
        for (const step of steps) {
          step.dependsOn = step.dependsOn.filter((d) => d !== op.stepId);
        }
        break;
      }
      case 'reorder': {
        const byId = new Map(steps.map((s) => [s.id, s]));
        const movable = new Set<string>();
        for (const id of op.stepIds) {
          const step = byId.get(id);
          if (!step) {
            return { ok: false, error: `reorder: unknown step "${id}".` };
          }
          if (step.status !== 'pending' && step.status !== 'blocked') {
            return {
              ok: false,
              error: `reorder: step "${id}" is ${step.status}; only pending/blocked steps may be reordered.`,
            };
          }
          movable.add(id);
        }
        const named = op.stepIds
          .map((id) => byId.get(id)!)
          .filter((step, index, all) => all.findIndex((s) => s.id === step.id) === index);
        const rest = steps.filter(
          (s) => !movable.has(s.id) && (s.status === 'pending' || s.status === 'blocked'),
        );
        const orderedMovable = [...named, ...rest];
        let cursor = 0;
        for (let index = 0; index < steps.length; index += 1) {
          if (steps[index].status !== 'pending' && steps[index].status !== 'blocked') continue;
          const next = orderedMovable[cursor];
          if (!next) break;
          steps[index] = next;
          cursor += 1;
        }
        break;
      }
      case 'add_constraint': {
        const constraint = String(op.constraint ?? '').trim();
        if (!constraint) return { ok: false, error: 'add_constraint requires text.' };
        if (!constraints.includes(constraint)) constraints.push(constraint);
        break;
      }
      case 'cancel_pending_after': {
        const at = steps.findIndex((s) => s.id === op.stepId);
        if (at === -1) return { ok: false, error: `cancel_pending_after: unknown step "${op.stepId}".` };
        for (const step of steps.slice(at + 1)) {
          if (step.status === 'pending' || step.status === 'blocked') step.status = 'cancelled';
        }
        break;
      }
      case 'set_priority': {
        for (const id of op.stepIds) {
          const target = steps.find((s) => s.id === id);
          if (!target) {
            return { ok: false, error: `set_priority: unknown step "${id}".` };
          }
          if (target.status !== 'pending' && target.status !== 'blocked') {
            return {
              ok: false,
              error: `set_priority: step "${id}" is ${target.status}; priority changes apply to future work only.`,
            };
          }
        }
        for (const step of steps) {
          if (op.stepIds.includes(step.id)) step.priority = op.priority;
        }
        break;
      }
      default:
        return { ok: false, error: `unknown plan operation "${(op as { op?: string }).op}".` };
    }
  }

  const next: SteeringPlan = { ...plan, steps, constraints };
  return { ok: true, plan: next, diff: diffPlans(plan, next) };
}

export interface CommitPlanInput {
  runId: string;
  expectedVersion: number;
  plan: SteeringPlan;
  changeIds: string[];
  reason: string;
  createdBy: string;
}

export type CommitPlanResult =
  | { ok: true; plan: SteeringPlan; diff: PlanDiff }
  | { ok: false; reason: string; currentVersion: number };

/**
 * Commit the next version with compare-and-swap. If another writer advanced the
 * plan first, nothing is written and the caller marks its changes stale.
 */
export function commitPlan(input: CommitPlanInput): CommitPlanResult {
  const latest = latestPlan(input.runId);
  const currentVersion = latest?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    return {
      ok: false,
      reason: `plan moved from v${input.expectedVersion} to v${currentVersion} before this change applied`,
      currentVersion,
    };
  }
  const version = currentVersion + 1;
  const diff = diffPlans(latest, input.plan);
  const contractVersion = readRun(input.runId)?.contractVersion ?? input.plan.contractVersion;
  const committed: SteeringPlan = {
    ...input.plan,
    runId: input.runId,
    version,
    parentVersion: currentVersion,
    contractVersion,
    changeIds: [...input.changeIds],
    reason: input.reason,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    diff,
  };
  if (!writeJson(planPath(input.runId, version), committed)) {
    return { ok: false, reason: 'could not persist the plan version', currentVersion };
  }
  patchRun(input.runId, { planVersion: version });
  appendJournal(input.runId, {
    type: 'plan.version_created',
    actor: 'system',
    planVersion: version,
    data: {
      parentVersion: currentVersion,
      changeIds: input.changeIds,
      added: diff.added,
      updated: diff.updated,
      removed: diff.removed,
      cancelled: diff.cancelled,
      constraintsAdded: diff.constraintsAdded,
      reason: input.reason,
    },
  });
  return { ok: true, plan: committed, diff };
}

/** Persist the initial v1 without CAS (only when no version exists). */
export function commitInitialPlan(plan: SteeringPlan): SteeringPlan | null {
  if (latestPlan(plan.runId)) return latestPlan(plan.runId);
  if (!writeJson(planPath(plan.runId, 1), plan)) return null;
  const run = readRun(plan.runId);
  patchRun(plan.runId, { planVersion: 1, ...(run ? { contractVersion: plan.contractVersion } : {}) });
  appendJournal(plan.runId, {
    type: 'plan.version_created',
    actor: 'system',
    planVersion: 1,
    data: { parentVersion: 0, changeIds: [], reason: plan.reason },
  });
  return plan;
}

/** The bounded directive shown to the executor. Never the raw guidance. */
export function planDirective(
  plan: SteeringPlan,
  changes: ChangeRequestRecord[],
  diff: PlanDiff,
): string {
  const lines: string[] = [
    `STEERING UPDATE — plan v${plan.version} is now in effect (was v${plan.parentVersion}).`,
    'This is an approved change to the plan, not a new conversation. Continue the work under it.',
  ];
  const byId = new Map(plan.steps.map((s) => [s.id, s]));
  const criteria = (step: SteeringPlanStep): string =>
    step.acceptanceCriteria.length > 0
      ? ` — acceptance: ${step.acceptanceCriteria.slice(0, 3).join('; ')}`
      : '';
  if (diff.added.length > 0) {
    lines.push('', 'ADDED STEPS:');
    for (const id of diff.added.slice(0, 12)) {
      const step = byId.get(id);
      if (step) lines.push(`- [${id}] ${step.description}${criteria(step)}`);
    }
  }
  if (diff.updated.length > 0) {
    lines.push('', 'CHANGED STEPS:');
    for (const id of diff.updated.slice(0, 12)) {
      const step = byId.get(id);
      if (step) lines.push(`- [${id}] (${step.status}) ${step.description}${criteria(step)}`);
    }
  }
  if (diff.removed.length > 0) lines.push('', `REMOVED FROM THE FUTURE PLAN: ${diff.removed.join(', ')}`);
  if (diff.cancelled.length > 0) {
    lines.push('', `CANCELLED (future work only — completed work is untouched): ${diff.cancelled.join(', ')}`);
  }
  if (diff.constraintsAdded.length > 0) {
    lines.push('', 'NEW CONSTRAINTS (binding on all further work):');
    for (const constraint of diff.constraintsAdded.slice(0, 12)) lines.push(`- ${constraint}`);
  }
  if (changes.length > 0) {
    lines.push('', 'WHY (user guidance that was accepted):');
    for (const change of changes.slice(0, 5)) {
      const reason = change.decision?.reason ?? change.assessment?.rationale ?? 'user guidance';
      lines.push(`- ${reason}`);
    }
  }
  lines.push(
    '',
    'Do not re-plan from scratch: adopt this version, finish the steps it names, and state plainly anything it makes impossible.',
  );
  return lines.join('\n');
}
