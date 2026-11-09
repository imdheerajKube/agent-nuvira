/**
 * P3.2 — two real processes write one run.
 *
 * Two child processes submit guidance concurrently (the `nuvira steer` shape),
 * then the run owner applies at its safe point. This pins the two properties a
 * single-process test cannot: guidance cannot be lost between processes, and an
 * applied change cannot be duplicated into two identical plan steps.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  latestPlan,
  readChanges,
  runSafePoint,
  submitGuidance,
} from '../../src/steering/index.js';
import type { StewardGenerate, SteeringPlanAdapter, SteeringPlanStep } from '../../src/steering/index.js';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('../fixtures/steer-submit.ts', import.meta.url));

class FakeAdapter implements SteeringPlanAdapter {
  readonly engine = 'loop' as const;
  steps: SteeringPlanStep[] = [];

  getVersion(): number {
    return 1;
  }

  getGoal(): string {
    return 'multi-process goal';
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

/** The run owner's model: one distinct step per submitted instruction. */
const ownerSteward: StewardGenerate = async (messages) => {
  const content = messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n');
  // Match the GUIDANCE marker, not the run goal: every Steward call includes the
  // goal, so a bare "alpha"/"two deliverables" test classified all three the same.
  const description = content.includes('alpha marker')
    ? 'Write alpha.txt'
    : content.includes('beta marker')
      ? 'Write beta.txt'
      : 'Write both deliverables';
  return stewardJson({ proposedOps: [{ op: 'add_step', step: { description } }] });
};

describe('two-process guidance (P3.2)', () => {
  it('keeps both submissions and applies each exactly once', async () => {
    const runId = `test-multiprocess-${randomUUID()}`;
    // The owner creates the manifest first, exactly like a live run.
    submitGuidance({
      runId,
      text: 'Write alpha.txt and beta.txt as two deliverables.',
      now: 1_000,
    });

    const submissions = [
      { text: 'Create alpha.txt with the alpha marker.', key: 'child-alpha' },
      { text: 'Create beta.txt with the beta marker.', key: 'child-beta' },
    ];
    const results = await Promise.all(
      submissions.map((entry) =>
        execFileAsync(
          process.execPath,
          ['--import', 'tsx', CHILD, runId, entry.text, entry.key],
          { cwd: ROOT, env: process.env, timeout: 20_000 },
        ),
      ),
    );

    const childIds = results.map((result) => result.stdout.trim());
    expect(new Set(childIds).size).toBe(2);
    expect(readChanges(runId)).toHaveLength(3);

    const adapter = new FakeAdapter();
    const tick = await runSafePoint({
      runId,
      adapter,
      generate: ownerSteward,
      now: 60_000,
    });

    // The owner's own opening guidance also applies; every item is accounted for.
    expect(tick.appliedChangeIds).toHaveLength(3);
    const plan = latestPlan(runId)!;
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.map((step) => step.id)).toEqual(['step-1', 'step-2', 'step-3']);
    // The two children submit CONCURRENTLY, so their relative order is not a
    // property of the system. The properties are: one step each, no duplicate,
    // and no lost guidance.
    expect(new Set(plan.steps.map((step) => step.description))).toEqual(
      new Set(['Write both deliverables', 'Write alpha.txt', 'Write beta.txt']),
    );

    const changes = readChanges(runId);
    for (const change of changes) {
      expect(change.status).toBe('applied');
      expect(change.directive).toContain('STEERING UPDATE');
    }
    for (const id of childIds) {
      expect(changes.find((change) => change.id === id)?.status).toBe('applied');
    }

    // A second safe point must not add the same work again.
    await runSafePoint({ runId, adapter, generate: ownerSteward, now: 61_000 });
    expect(latestPlan(runId)?.version).toBe(plan.version);
    expect(latestPlan(runId)?.steps).toHaveLength(3);
  }, 30_000);
});
