/**
 * P3.3 — provider/adapter outage replay.
 *
 * A failure at ANY phase must leave the user's guidance actionable, not terminal:
 *  - a Steward outage falls back to the deterministic classifier and can still
 *    produce a real plan version for an explicit instruction;
 *  - an adapter outage AFTER the plan version is committed leaves the change
 *    accepted, and the next safe point adopts the SAME version exactly once.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  getGuidance,
  latestPlan,
  runSafePoint,
  submitGuidance,
} from '../../src/steering/index.js';
import type { StewardGenerate, SteeringPlanAdapter, SteeringPlanStep } from '../../src/steering/index.js';
import { readChanges } from '../../src/steering/store.js';

class FlakyAdapter implements SteeringPlanAdapter {
  readonly engine = 'loop' as const;
  steps: SteeringPlanStep[] = [];
  failApplies = 0;

  getVersion(): number {
    return 1;
  }

  getGoal(): string {
    return 'resilience test goal';
  }

  getSteps(): SteeringPlanStep[] {
    return this.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  }

  applyPlanVersion(plan: { steps: SteeringPlanStep[] }): void {
    if (this.failApplies > 0) {
      this.failApplies -= 1;
      throw new Error('adapter unavailable');
    }
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

function addStep(description: string): StewardGenerate {
  return async () =>
    stewardJson({ proposedOps: [{ op: 'add_step', step: { description } }] });
}

function freshRun(): string {
  return `test-resilience-${randomUUID()}`;
}

describe('Steward outage (P3.3)', () => {
  it('turns a thrown provider error into an actionable deterministic plan', async () => {
    const runId = freshRun();
    const submitted = submitGuidance({
      runId,
      text: 'Create resilience.txt containing the recovery status.',
      now: 1_000,
    });
    const adapter = new FlakyAdapter();
    const tick = await runSafePoint({
      runId,
      adapter,
      generate: async () => {
        throw new Error('provider down');
      },
      now: 2_000,
    });

    expect(tick.appliedChangeIds).toEqual([submitted.change!.id]);
    const change = getGuidance(runId, submitted.change!.id)!;
    expect(change.status).toBe('applied');
    expect(change.assessment?.rationale).toContain('assessed deterministically');
    expect(latestPlan(runId)?.steps).toHaveLength(1);
    expect(adapter.steps).toHaveLength(1);
  });

  it('falls back when the model returns unusable JSON twice', async () => {
    const runId = freshRun();
    const submitted = submitGuidance({
      runId,
      text: 'Create invalid-json.txt as a deliverable.',
      now: 1_000,
    });
    const adapter = new FlakyAdapter();
    await runSafePoint({
      runId,
      adapter,
      generate: async () => 'I think this is probably a change, but here is prose.',
      now: 2_000,
    });

    const change = getGuidance(runId, submitted.change!.id)!;
    expect(change.status).toBe('applied');
    expect(change.assessment?.confidence).toBeGreaterThan(0);
    expect(latestPlan(runId)?.steps).toHaveLength(1);
  });
});

describe('adapter outage after commit (P3.3)', () => {
  it('keeps the change accepted, then applies the committed version exactly once', async () => {
    const runId = freshRun();
    const submitted = submitGuidance({
      runId,
      text: 'Create retry.txt with the retry marker.',
      now: 1_000,
    });
    const adapter = new FlakyAdapter();
    adapter.failApplies = 1;

    const first = await runSafePoint({
      runId,
      adapter,
      generate: addStep('Create retry.txt with the retry marker.'),
      now: 2_000,
    });

    expect(first.appliedChangeIds).toEqual([]);
    const queued = getGuidance(runId, submitted.change!.id)!;
    expect(queued.status).toBe('accepted');
    expect(queued.planVersion).toBe(2);
    expect(queued.directive).toContain('STEERING UPDATE');
    // The plan version exists; the engine simply has not accepted it yet.
    expect(latestPlan(runId)?.steps).toHaveLength(1);
    expect(adapter.steps).toHaveLength(0);

    const retry = await runSafePoint({
      runId,
      adapter,
      generate: addStep('This model answer must not create a second step.'),
      now: 3_000,
    });

    expect(retry.appliedChangeIds).toEqual([submitted.change!.id]);
    const applied = getGuidance(runId, submitted.change!.id)!;
    expect(applied.status).toBe('applied');
    expect(applied.planVersion).toBe(2);
    expect(latestPlan(runId)?.version).toBe(2);
    expect(latestPlan(runId)?.steps).toHaveLength(1);
    expect(adapter.steps).toHaveLength(1);
    // No duplicate: the idempotency guard adopted the committed version.
    expect(readChanges(runId)).toHaveLength(1);
  });
});
