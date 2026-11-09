/**
 * The only writer of executable plans.
 *
 * Pinned here: no unversioned mutation, compare-and-swap refuses a stale writer,
 * completed work cannot be deleted or rewritten by a plan op, cancellation only
 * touches future work, and one invalid op fails the whole atomic batch.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { applyPlanOps, commitPlan, diffPlans, latestPlan, readPlanVersion } from '../../src/steering/plan.js';
import type { PlanDiff, SteeringPlan, SteeringPlanStep } from '../../src/steering/types.js';

const EMPTY_DIFF: PlanDiff = {
  added: [],
  updated: [],
  removed: [],
  cancelled: [],
  constraintsAdded: [],
  reordered: false,
};

function step(
  id: string,
  status: SteeringPlanStep['status'] = 'pending',
  description = id,
): SteeringPlanStep {
  return {
    id,
    description,
    status,
    dependsOn: [],
    acceptanceCriteria: [],
    priority: 'normal',
  };
}

function plan(steps: SteeringPlanStep[], runId = `test-plan-${randomUUID()}`): SteeringPlan {
  return {
    runId,
    version: 1,
    parentVersion: 0,
    contractVersion: 1,
    goal: 'test goal',
    steps,
    constraints: [],
    createdAt: new Date(0).toISOString(),
    createdBy: 'engine',
    reason: 'baseline',
    changeIds: [],
    diff: EMPTY_DIFF,
  };
}

describe('plan mutation protections', () => {
  it('refuses to remove a completed step', () => {
    const result = applyPlanOps(plan([step('step-1', 'done'), step('step-2')]), [
      { op: 'remove_step', stepId: 'step-1' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to delete completed step/i);
    expect(result.plan).toBeUndefined();
  });

  it('refuses to rewrite a completed step description', () => {
    const result = applyPlanOps(plan([step('step-1', 'done')]), [
      { op: 'update_step', stepId: 'step-1', patch: { description: 'different meaning' } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rewrite completed step/i);
  });

  it('refuses to un-complete a completed step', () => {
    const result = applyPlanOps(plan([step('step-1', 'done')]), [
      { op: 'update_step', stepId: 'step-1', patch: { status: 'pending' } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/un-complete/i);
  });

  it('refuses to remove a running step (changes only at safe points)', () => {
    const result = applyPlanOps(plan([step('step-1', 'running')]), [
      { op: 'remove_step', stepId: 'step-1' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/running; changes apply only at safe points/i);
  });

  it('cancels only future work and leaves completed/running work alone', () => {
    const result = applyPlanOps(
      plan([step('step-1', 'done'), step('step-2', 'pending'), step('step-3', 'running'), step('step-4', 'blocked')]),
      [{ op: 'cancel_pending_after', stepId: 'step-1' }],
    );
    expect(result.ok).toBe(true);
    const statuses = Object.fromEntries(result.plan!.steps.map((s) => [s.id, s.status]));
    expect(statuses['step-1']).toBe('done');
    expect(statuses['step-2']).toBe('cancelled');
    expect(statuses['step-3']).toBe('running');
    expect(statuses['step-4']).toBe('cancelled');
  });

  it('fails the whole batch on an unknown anchor, never a partial plan', () => {
    const result = applyPlanOps(plan([step('step-1')]), [
      { op: 'add_step', step: { description: 'first valid' } },
      { op: 'add_step', after: 'missing', step: { description: 'invalid' } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(result.error).toMatch(/unknown anchor/i);
  });

  it('fails on unknown step ids for update, remove, reorder and priority', () => {
    const base = plan([step('step-1')]);
    for (const op of [
      { op: 'update_step', stepId: 'nope', patch: {} },
      { op: 'remove_step', stepId: 'nope' },
      { op: 'reorder', stepIds: ['nope'] },
      { op: 'set_priority', stepIds: ['nope'], priority: 'high' },
      { op: 'cancel_pending_after', stepId: 'nope' },
    ] as const) {
      const result = applyPlanOps(base, [op]);
      expect(result.ok).toBe(false);
    }
  });

  it('adds a constraint once, even if repeated', () => {
    const result = applyPlanOps(plan([]), [
      { op: 'add_constraint', constraint: 'Do not touch payments' },
      { op: 'add_constraint', constraint: 'Do not touch payments' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.plan?.constraints).toEqual(['Do not touch payments']);
  });

  it('places an added step after the named anchor', () => {
    const result = applyPlanOps(plan([step('step-1'), step('step-2')]), [
      { op: 'add_step', after: 'step-1', step: { description: 'between' } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.plan?.steps.map((s) => s.description)).toEqual(['step-1', 'between', 'step-2']);
  });

  it('removes dependencies on a removed step so the DAG cannot deadlock', () => {
    const dependent = { ...step('step-2'), dependsOn: ['step-1'] };
    const result = applyPlanOps(plan([step('step-1'), dependent]), [
      { op: 'remove_step', stepId: 'step-1' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.plan?.steps[0].dependsOn).toEqual([]);
  });
});

describe('diff and immutable commit', () => {
  it('derives added, updated, cancelled and constraint changes', () => {
    const before = plan([step('step-1'), step('step-2')]);
    const after: SteeringPlan = {
      ...before,
      steps: [
        { ...before.steps[0], status: 'cancelled' },
        { ...before.steps[1], description: 'changed' },
        step('step-3'),
      ],
      constraints: ['versioned APIs'],
    };
    const diff = diffPlans(before, after);
    expect(diff.cancelled).toContain('step-1');
    expect(diff.updated).toContain('step-2');
    expect(diff.added).toContain('step-3');
    expect(diff.constraintsAdded).toEqual(['versioned APIs']);
  });

  it('commits v1 with CAS from expectedVersion 0 and writes an immutable file', () => {
    const base = plan([step('step-1')]);
    const commit = commitPlan({
      runId: base.runId,
      expectedVersion: 0,
      plan: base,
      changeIds: ['G-1'],
      reason: 'first change',
      createdBy: 'test',
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.plan.version).toBe(1);
    expect(commit.plan.parentVersion).toBe(0);
    expect(readPlanVersion(base.runId, 1)?.changeIds).toEqual(['G-1']);
    expect(latestPlan(base.runId)?.version).toBe(1);
  });

  it('refuses a stale writer instead of overwriting a newer plan', () => {
    const base = plan([step('step-1')]);
    const first = commitPlan({
      runId: base.runId,
      expectedVersion: 0,
      plan: base,
      changeIds: ['G-1'],
      reason: 'first',
      createdBy: 'test',
    });
    expect(first.ok).toBe(true);
    const stale = commitPlan({
      runId: base.runId,
      expectedVersion: 0,
      plan: base,
      changeIds: ['G-2'],
      reason: 'stale',
      createdBy: 'test',
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.currentVersion).toBe(1);
    expect(latestPlan(base.runId)?.version).toBe(1);
    expect(latestPlan(base.runId)?.changeIds).toEqual(['G-1']);
  });

  it('commits the next version from the current parent and records the diff', () => {
    const base = plan([step('step-1')]);
    const first = commitPlan({
      runId: base.runId,
      expectedVersion: 0,
      plan: base,
      changeIds: ['G-1'],
      reason: 'first',
      createdBy: 'test',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const mutation = applyPlanOps(first.plan, [
      { op: 'add_step', step: { description: 'Add versioning' } },
      { op: 'add_constraint', constraint: 'APIs are versioned' },
    ]);
    expect(mutation.ok).toBe(true);
    const second = commitPlan({
      runId: base.runId,
      expectedVersion: 1,
      plan: mutation.plan!,
      changeIds: ['G-2'],
      reason: 'second',
      createdBy: 'test',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan.version).toBe(2);
    expect(second.plan.parentVersion).toBe(1);
    expect(second.diff.added).toHaveLength(1);
    expect(second.diff.constraintsAdded).toEqual(['APIs are versioned']);
    // v1 remains exactly as committed.
    expect(readPlanVersion(base.runId, 1)?.steps).toHaveLength(1);
  });
});
