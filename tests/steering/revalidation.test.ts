/**
 * Revalidation of the plan's hard guarantees.
 *
 * These are the gaps the first implementation left: mutation of a running task,
 * reordering completed work, non-idempotent apply after a crash, an interrupted
 * triage that stayed invisible, a Steward context missing the contract, an
 * unredacted guidance path, approval expiry, and acceptance criteria that never
 * reached the executor directive.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyAccepted,
  triagePending,
} from '../../src/steering/scheduler.js';
import {
  expireApprovals,
  requestApproval,
} from '../../src/steering/approvals.js';
import {
  getGuidance,
  submitGuidance,
  updateGuidance,
} from '../../src/steering/inbox.js';
import { openSteeringRun } from '../../src/steering/runtime.js';
import {
  applyPlanOps,
  commitPlan,
  findPlanVersionForChange,
  latestPlan,
  planDirective,
} from '../../src/steering/plan.js';
import {
  buildStewardMessages,
  runChangeSteward,
} from '../../src/steering/steward.js';
import { readApprovals, readContract, readJournal } from '../../src/steering/store.js';
import type {
  ChangeAssessment,
  ChangeRequestRecord,
  PlanDiff,
  RunRecord,
  SteeringPlan,
  SteeringPlanAdapter,
  SteeringPlanStep,
  TaskContract,
} from '../../src/steering/types.js';

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

function plan(steps: SteeringPlanStep[], runId = `reval-${randomUUID()}`): SteeringPlan {
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

function assessment(proposedOps: ChangeAssessment['proposedOps'] = []): ChangeAssessment {
  return {
    relation: 'on_task',
    kind: 'add',
    timing: 'next_safe_point',
    impact: 'medium',
    confidence: 0.9,
    affectedStepIds: [],
    conflictsWith: [],
    supersedes: [],
    conflict: 'none',
    requiresApproval: false,
    rationale: 'Adds a concrete requirement to the active plan.',
    proposedOps,
  };
}

function changeRecord(overrides: Partial<ChangeRequestRecord> = {}): ChangeRequestRecord {
  return {
    id: 'G-1',
    runId: 'run-1',
    source: 'cli',
    author: 'tester',
    rawText: 'Add audit logging.',
    submittedAt: new Date(1_000).toISOString(),
    planVersionAtSubmit: 0,
    idempotencyKey: 'key-1',
    contentHash: 'hash-1',
    status: 'received',
    ...overrides,
  };
}

function runRecord(): RunRecord {
  return {
    runId: 'run-1',
    goal: 'build the service',
    cwd: '/tmp/project',
    engine: 'loop',
    surface: 'cli',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    planVersion: 0,
    contractVersion: 1,
    stopRequested: false,
    pauseRequested: false,
    sequence: 0,
  };
}

function adapter(runId: string): SteeringPlanAdapter {
  return {
    engine: 'loop',
    getVersion: () => latestPlan(runId)?.version ?? 0,
    getGoal: () => 'test goal',
    getSteps: () => [step('step-1')],
    applyPlanVersion: () => undefined,
    projectForExecutor: () => '',
  };
}

describe('plan mutator protects work in flight', () => {
  it('refuses to mutate a running step', () => {
    const result = applyPlanOps(plan([step('step-1', 'running')]), [
      { op: 'update_step', stepId: 'step-1', patch: { description: 'rewritten mid-task' } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/running; changes apply only at a safe point/i);
  });

  it('reorders only future work and leaves done/running positions fixed', () => {
    const base = plan([
      step('step-1', 'done'),
      step('step-2', 'running'),
      step('step-3', 'pending'),
      step('step-4', 'pending'),
    ]);
    const result = applyPlanOps(base, [{ op: 'reorder', stepIds: ['step-4', 'step-3'] }]);
    expect(result.ok).toBe(true);
    expect(result.plan?.steps.map((s) => s.id)).toEqual([
      'step-1',
      'step-2',
      'step-4',
      'step-3',
    ]);
  });

  it('refuses to reorder a completed or running step and to reprioritize one', () => {
    const base = plan([step('step-1', 'done'), step('step-2', 'running')]);
    for (const op of [
      { op: 'reorder', stepIds: ['step-1'] },
      { op: 'reorder', stepIds: ['step-2'] },
      { op: 'set_priority', stepIds: ['step-1'], priority: 'high' },
      { op: 'set_priority', stepIds: ['step-2'], priority: 'low' },
    ] as const) {
      const result = applyPlanOps(base, [op]);
      expect(result.ok).toBe(false);
    }
  });

  it('puts acceptance criteria in the executor directive', () => {
    const accepted = step('step-2');
    accepted.acceptanceCriteria = ['audit events include actor and target'];
    const p: SteeringPlan = {
      ...plan([step('step-1'), accepted]),
      version: 2,
      parentVersion: 1,
    };
    const directive = planDirective(p, [], {
      ...EMPTY_DIFF,
      added: ['step-2'],
    });
    expect(directive).toContain('acceptance: audit events include actor and target');
  });

  it('finds the committed version for a change, which is the apply idempotency key', () => {
    const base = plan([step('step-1')]);
    const commit = commitPlan({
      runId: base.runId,
      expectedVersion: 0,
      plan: base,
      changeIds: ['G-1'],
      reason: 'first',
      createdBy: 'test',
    });
    expect(commit.ok).toBe(true);
    expect(findPlanVersionForChange(base.runId, 'G-1')?.version).toBe(1);
    expect(findPlanVersionForChange(base.runId, 'G-missing')).toBeNull();
  });
});

describe('crash-safe scheduler', () => {
  it('does not duplicate a step when a crash happened between commit and applied status', async () => {
    const runId = `reval-${randomUUID()}`;
    openSteeringRun({ runId, goal: 'test goal', cwd: '/tmp/reval' });
    const submitted = submitGuidance({ runId, text: 'Add audit logging.', now: 1_000 });
    expect(submitted.ok).toBe(true);
    updateGuidance(runId, submitted.change!.id, {
      status: 'accepted',
      assessment: assessment([
        {
          op: 'add_step',
          step: { description: 'Add audit logging', acceptanceCriteria: ['events recorded'] },
        },
      ]),
    });

    const first = await applyAccepted({ runId, adapter: adapter(runId), now: 2_000 });
    expect(first.appliedChangeIds).toEqual([submitted.change!.id]);
    expect(latestPlan(runId)?.version).toBe(2);
    expect(latestPlan(runId)?.steps).toHaveLength(2);
    expect(
      readContract(runId)?.amendments.some((amendment) => amendment.changeId === submitted.change!.id),
    ).toBe(true);

    // Simulate a process that committed the plan but died before marking applied.
    // The recovery tick adopts the committed version and REPORTS it as applied:
    // the user's change did take effect in this tick, and hiding it made a
    // successful recovery look like a no-op.
    updateGuidance(runId, submitted.change!.id, { status: 'accepted' });
    const second = await applyAccepted({ runId, adapter: adapter(runId), now: 3_000 });
    expect(second.appliedChangeIds).toEqual([submitted.change!.id]);
    expect(latestPlan(runId)?.version).toBe(2);
    expect(latestPlan(runId)?.steps).toHaveLength(2);
    expect(getGuidance(runId, submitted.change!.id)?.status).toBe('applied');
    expect(readContract(runId)?.amendments).toHaveLength(1);
  });

  it('takes a workspace checkpoint before applying a high-impact change', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'steering-checkpoint-'));
    writeFileSync(join(cwd, 'app.ts'), 'export const version = 1;\n');
    const runId = `reval-${randomUUID()}`;
    openSteeringRun({ runId, goal: 'test goal', cwd });
    const submitted = submitGuidance({ runId, text: 'Add audit logging.', now: 1_000 });
    const highImpact = { ...assessment([{ op: 'add_step' as const, step: { description: 'Add audit logging' } }]), impact: 'high' as const };
    updateGuidance(runId, submitted.change!.id, {
      status: 'accepted',
      assessment: highImpact,
    });

    const tick = await applyAccepted({ runId, adapter: adapter(runId), now: 2_000 });
    expect(tick.appliedChangeIds).toEqual([submitted.change!.id]);
    expect(getGuidance(runId, submitted.change!.id)?.workspaceCheckpointId).toBeTruthy();
    expect(readJournal(runId).some((event) => event.type === 'workspace.checkpoint_created')).toBe(
      true,
    );
    rmSync(cwd, { recursive: true, force: true });
  });

  it('recovers a triage that was interrupted before recording a decision', async () => {
    const runId = `reval-${randomUUID()}`;
    openSteeringRun({ runId, goal: 'test goal', cwd: '/tmp/reval' });
    const submitted = submitGuidance({ runId, text: 'Add audit logging.', now: 1_000 });
    updateGuidance(runId, submitted.change!.id, {
      status: 'triaging',
      triagingAt: new Date(0).toISOString(),
    });

    await triagePending({ runId, now: Date.now() });
    expect(getGuidance(runId, submitted.change!.id)?.status).not.toBe('triaging');
    expect(readJournal(runId).some((event) => event.type === 'guidance.triage_recovered')).toBe(
      true,
    );
  });

  it('expires an unanswered approval and leaves it visible as deferred', () => {
    const runId = `reval-${randomUUID()}`;
    openSteeringRun({ runId, goal: 'test goal', cwd: '/tmp/reval' });
    const submitted = submitGuidance({ runId, text: 'Use Postgres instead of SQLite.', now: 1_000 });
    updateGuidance(runId, submitted.change!.id, { status: 'needs_approval' });
    expect(requestApproval(runId, submitted.change!.id, 1_000)).not.toBeNull();

    const expired = expireApprovals(runId, readApprovals(runId), 1_000, 5_000);
    expect(expired).toHaveLength(1);
    expect(getGuidance(runId, submitted.change!.id)?.status).toBe('deferred');
  });
});

describe('steward context and failure behavior', () => {
  const contract: TaskContract = {
    runId: 'run-1',
    goal: 'build the service',
    cwd: '/tmp/project',
    createdAt: new Date(0).toISOString(),
    deliverables: ['versioned API'],
    nonGoals: ['payments'],
    acceptanceCriteria: ['tests pass'],
    amendments: [
      {
        at: new Date(0).toISOString(),
        changeId: 'G-0',
        kind: 'constraint',
        text: 'never touch payments',
      },
    ],
  };

  it('includes the contract, plan events and redacts a secret from guidance', () => {
    const messages = buildStewardMessages({
      change: changeRecord({
        rawText:
          'Add audit logging. Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      }),
      run: runRecord(),
      contract,
      plan: null,
      recentEvents: ['plan.version_created', 'guidance.received (G-1)'],
    });
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toContain('DELIVERABLES');
    expect(text).toContain('versioned API');
    expect(text).toContain('NON-GOALS');
    expect(text).toContain('payments');
    expect(text).toContain('ACCEPTANCE CRITERIA');
    expect(text).toContain('tests pass');
    expect(text).toContain('guidance.received (G-1)');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).toContain('untrustedUserData');
  });

  it('retries one invalid schema answer and then accepts a valid one', async () => {
    let calls = 0;
    const valid = {
      relation: 'on_task',
      kind: 'add',
      timing: 'next_safe_point',
      impact: 'medium',
      confidence: 0.9,
      affectedStepIds: [],
      conflictsWith: [],
      supersedes: [],
      conflict: 'none',
      requiresApproval: false,
      rationale: 'Adds a concrete requirement.',
      proposedOps: [{ op: 'add_constraint', constraint: 'versioned APIs' }],
      newTask: null,
    };
    const result = await runChangeSteward({
      generate: async () => {
        calls += 1;
        return calls === 1 ? 'not json' : JSON.stringify(valid);
      },
      change: changeRecord(),
      run: runRecord(),
      contract,
      plan: null,
    });
    expect(calls).toBe(2);
    expect(result.source).toBe('model');
    expect(result.assessment.proposedOps).toHaveLength(1);
  });

  it('falls back safely when the provider is unavailable', async () => {
    const result = await runChangeSteward({
      generate: async () => {
        throw new Error('provider down');
      },
      change: changeRecord(),
      run: runRecord(),
      contract,
      plan: null,
    });
    expect(result.source).toBe('fallback');
    // The fallback is bounded (never as confident as a real assessment) but it is
    // ACTIONABLE: an explicit additive instruction becomes a typed plan op, so a
    // provider outage cannot turn it into a permanent `answer_only` dead end.
    expect(result.assessment.confidence).toBeLessThanOrEqual(0.7);
    expect(result.assessment.proposedOps.map((op) => op.op)).toEqual(['add_step']);
    expect(result.assessment.rationale).toMatch(/provider down/i);
  });
});
