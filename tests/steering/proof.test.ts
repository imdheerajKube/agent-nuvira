/**
 * P2 — steer with proof, policy-aware escalation text, and stale-run closure.
 *
 * These tests pin what the user can AUDIT after a change: the receipt, triage
 * latency, the deterministic decision (including why it escalated), the plan
 * diff, and the exact bounded directive the executor received. They also pin
 * that a dead `running` manifest is reported stale and can be closed explicitly,
 * while a live lease is refused.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  closeSteeringRun,
  describeEscalations,
  getGuidance,
  listSteeringRuns,
  projectRun,
  runSafePoint,
  submitGuidance,
} from '../../src/steering/index.js';
import type { StewardGenerate, SteeringPlanAdapter, SteeringPlanStep } from '../../src/steering/index.js';
import { readJournal, readRun } from '../../src/steering/store.js';
import { patchRun } from '../../src/steering/store.js';
import { latestPlan } from '../../src/steering/plan.js';

class FakeAdapter implements SteeringPlanAdapter {
  readonly engine = 'loop' as const;
  steps: SteeringPlanStep[] = [];

  getVersion(): number {
    return 1;
  }

  getGoal(): string {
    return 'proof test goal';
  }

  getSteps(): SteeringPlanStep[] {
    return this.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  }

  applyPlanVersion(plan: { steps: SteeringPlanStep[] }): void {
    this.steps = plan.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  }

  projectForExecutor(): string {
    return '';
  }
}

function stewardJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    relation: 'on_task',
    kind: 'add',
    timing: 'next_safe_point',
    impact: 'low',
    confidence: 0.9,
    affectedStepIds: [],
    conflictsWith: [],
    supersedes: [],
    conflict: 'none',
    requiresApproval: false,
    rationale: 'Adds work inside the active objective.',
    proposedOps: [],
    ...overrides,
  });
}

function addStep(description: string, extra: Record<string, unknown> = {}): StewardGenerate {
  return async () =>
    stewardJson({
      proposedOps: [{ op: 'add_step', step: { description, acceptanceCriteria: ['exists'] } }],
      ...extra,
    });
}

function freshRun(): string {
  return `test-proof-${randomUUID()}`;
}

describe('steer with proof (P2.1, P2.4)', () => {
  it('records receipt, latency, diff and the exact directive the executor received', async () => {
    const runId = freshRun();
    const submitted = submitGuidance({
      runId,
      text: 'Create docs/proof.txt containing the word proof.',
      now: 1_000,
    });
    expect(submitted.ok).toBe(true);

    const adapter = new FakeAdapter();
    const tick = await runSafePoint({
      runId,
      adapter,
      generate: addStep('Create docs/proof.txt containing the word proof.'),
      now: 2_000,
    });

    expect(tick.appliedChangeIds).toEqual([submitted.change!.id]);
    const change = getGuidance(runId, submitted.change!.id)!;
    expect(change.status).toBe('applied');
    expect(change.submittedAt).toBe(new Date(1_000).toISOString());
    expect(change.triageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(change.appliedAt).toBeTruthy();
    expect(change.planVersion).toBe(2);
    expect(change.planDiff?.added).toHaveLength(1);
    expect(change.directive).toContain('STEERING UPDATE');
    expect(change.directive).toContain('docs/proof.txt');
    // The directive is derived from the plan, never the raw message itself.
    expect(change.directive).not.toBe(change.rawText);

    const view = projectRun(runId);
    expect(view.changes[0].directive).toBe(change.directive);
    expect(view.metrics.guidanceReceived).toBe(1);
    expect(view.metrics.applied).toBe(1);
    expect(view.metrics.planVersions).toBe(2);
    expect(view.metrics.avgTimeToApplyMs).toBeGreaterThanOrEqual(1_000);
    expect(view.metrics.staleRate).toBe(0);
    expect(view.metrics.abandonedApprovals).toBe(0);
  });

  it('states why a change escalated and what approval will do', async () => {
    const runId = freshRun();
    const submitted = submitGuidance({
      runId,
      text: 'Add a billing migration that rewrites the invoices table.',
      now: 1_000,
    });
    const adapter = new FakeAdapter();
    await runSafePoint({
      runId,
      adapter,
      generate: addStep('Rewrite the invoices table for billing.', { impact: 'high' }),
      now: 2_000,
    });

    const change = getGuidance(runId, submitted.change!.id)!;
    expect(change.status).toBe('needs_approval');
    expect(change.decision?.escalations).toContain('high_impact');
    expect(describeEscalations(change.decision!.escalations!)).toContain(
      'high impact — it can change material work',
    );
    expect(change.decision?.approvalEffect).toContain('workspace checkpoint');
    expect(change.decision?.approvalEffect).toContain('immutable plan version');
    expect(change.appliedAt).toBeUndefined();
  });
});

describe('stale run reaping (P3.1)', () => {
  it('marks an expired lease stale and closes it explicitly', () => {
    const runId = freshRun();
    submitGuidance({ runId, text: 'Create a stale-run fixture.', now: 1_000 });
    patchRun(
      runId,
      {
        status: 'running',
        updatedAt: new Date(1_000).toISOString(),
        lease: {
          pid: 999_999,
          hostname: 'test-host',
          acquiredAt: new Date(1_000).toISOString(),
          expiresAt: new Date(5_000).toISOString(),
        },
      },
      1_000,
    );

    const listed = listSteeringRuns().find((run) => run.runId === runId)!;
    expect(listed.stale).toBe(true);
    expect(listed.staleSince).toBe(new Date(5_000).toISOString());

    const closed = closeSteeringRun(runId, 'user', 10_000);
    expect(closed.ok).toBe(true);
    expect(readRun(runId)?.status).toBe('completed');
    expect(readJournal(runId).some((event) => event.type === 'run.closed_stale')).toBe(true);
  });

  it('projects derived staleness so a surface can actually offer the close action', () => {
    const runId = freshRun();
    submitGuidance({ runId, text: 'Create a projected-stale fixture.', now: 1_000 });
    patchRun(
      runId,
      {
        status: 'running',
        updatedAt: new Date(1_000).toISOString(),
        lease: {
          pid: 999_997,
          hostname: 'test-host',
          acquiredAt: new Date(1_000).toISOString(),
          expiresAt: new Date(5_000).toISOString(),
        },
      },
      1_000,
    );

    // The dashboard banner is gated on view.run.stale. Reading the raw manifest
    // here left that banner unreachable, so the close action could never appear.
    const view = projectRun(runId);
    expect(view.run?.stale).toBe(true);
    expect(view.run?.staleSince).toBe(new Date(5_000).toISOString());

    closeSteeringRun(runId, 'user', 10_000);
    expect(projectRun(runId).run?.stale).toBe(false);
  });

  it('refuses to close a run with a live lease', () => {
    const runId = freshRun();
    submitGuidance({ runId, text: 'Create a live-run fixture.', now: 1_000 });
    patchRun(
      runId,
      {
        status: 'running',
        updatedAt: new Date(1_000).toISOString(),
        lease: {
          pid: 999_998,
          hostname: 'test-host',
          acquiredAt: new Date(1_000).toISOString(),
          expiresAt: new Date(60_000).toISOString(),
        },
      },
      1_000,
    );

    const closed = closeSteeringRun(runId, 'user', 10_000);
    expect(closed.ok).toBe(false);
    expect(closed.error).toMatch(/live lease/i);
    expect(readRun(runId)?.status).toBe('running');
    expect(latestPlan(runId)).toBeNull();
  });
});
