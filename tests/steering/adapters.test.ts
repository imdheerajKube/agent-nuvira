/**
 * Engine parity: steering semantics must be the same whether the owner is the
 * loop's linear checklist or the pipeline's dependency DAG.
 *
 * The adapters are structural, so these fakes are the contract: status mapping,
 * cancelled-work filtering, original TaskStep field preservation, and the bounded
 * executor directive. No orchestrator or PlanStore is constructed.
 */

import { describe, expect, it } from 'vitest';

import {
  LoopPlanAdapter,
  PipelinePlanAdapter,
  type LoopPlanStoreLike,
  type PipelineVaultLike,
} from '../../src/steering/adapters.js';
import type { PlanDiff, SteeringPlan, SteeringPlanStep } from '../../src/steering/types.js';

const DIFF: PlanDiff = {
  added: ['step-2'],
  updated: [],
  removed: [],
  cancelled: ['step-3'],
  constraintsAdded: ['All public APIs are versioned'],
  reordered: false,
};

function step(id: string, status: SteeringPlanStep['status']): SteeringPlanStep {
  return {
    id,
    description: id,
    status,
    dependsOn: [],
    acceptanceCriteria: [],
    priority: 'normal',
  };
}

function plan(): SteeringPlan {
  return {
    runId: 'run-contract',
    version: 3,
    parentVersion: 2,
    contractVersion: 1,
    goal: 'build the service',
    steps: [step('step-1', 'done'), step('step-2', 'pending'), step('step-3', 'cancelled')],
    constraints: ['All public APIs are versioned'],
    createdAt: new Date(0).toISOString(),
    createdBy: 'test',
    reason: 'contract test',
    changeIds: ['G-1'],
    diff: DIFF,
  };
}

type LoopCreated = Array<{ goal: string; steps: Array<{ id: string; description: string }> }>;

function loopStore(): LoopPlanStoreLike & { created: LoopCreated } {
  const created: LoopCreated = [];
  return {
    created,
    snapshot: () => ({
      goal: 'loop goal',
      revision: 4,
      steps: [
        { id: 'step-1', description: 'completed', status: 'done' },
        { id: 'step-2', description: 'running', status: 'running' },
        { id: 'step-3', description: 'blocked', status: 'blocked' },
        { id: 'step-4', description: 'pending', status: 'pending' },
      ],
    }),
    create: (goal, steps) => {
      created.push({ goal, steps });
      return created[created.length - 1];
    },
  };
}

function pipelineVault(): PipelineVaultLike & { taskPlan: PipelineVaultLike['context']['taskPlan'] } {
  const meta = new Map<string, unknown>();
  const taskPlan: PipelineVaultLike['context']['taskPlan'] = [
    {
      id: 'step-1',
      description: 'completed',
      agentType: 'writer',
      dependsOn: [],
      status: 'completed',
      result: 'done result',
      expectedFiles: ['src/auth.ts'],
    },
    { id: 'step-2', description: 'running', agentType: 'verifier', dependsOn: ['step-1'], status: 'running' },
    { id: 'step-3', description: 'failed', agentType: 'writer', dependsOn: [], status: 'failed' },
    { id: 'step-4', description: 'pending', agentType: 'writer', dependsOn: [], status: 'pending' },
  ];
  const vault: PipelineVaultLike & { taskPlan: PipelineVaultLike['context']['taskPlan'] } = {
    context: { goal: 'pipeline goal', workingDirectory: '/tmp/project', taskPlan, metadata: {} },
    taskPlan,
    setTaskPlan(next) {
      vault.taskPlan = next;
      vault.context.taskPlan = next;
    },
    getMeta<T = unknown>(key: string): T | undefined {
      return meta.get(key) as T | undefined;
    },
    setMeta(key, value) {
      meta.set(key, value);
    },
  };
  return vault;
}

describe('engine-neutral steering adapter contract', () => {
  it('maps loop statuses and reports its version/goal', () => {
    const adapter = new LoopPlanAdapter(loopStore(), 'fallback');
    expect(adapter.engine).toBe('loop');
    expect(adapter.getVersion()).toBe(4);
    expect(adapter.getGoal()).toBe('loop goal');
    expect(adapter.getSteps().map((s) => s.status)).toEqual(['done', 'running', 'blocked', 'pending']);
  });

  it('maps pipeline statuses and preserves the DAG dependencies', () => {
    const adapter = new PipelinePlanAdapter(pipelineVault());
    expect(adapter.engine).toBe('pipeline');
    expect(adapter.getSteps().map((s) => s.status)).toEqual(['done', 'running', 'blocked', 'pending']);
    expect(adapter.getSteps()[1].dependsOn).toEqual(['step-1']);
  });

  it('drops cancelled work from both engines while keeping the version/diff', () => {
    const loop = loopStore();
    const pipeline = pipelineVault();
    new LoopPlanAdapter(loop, 'fallback').applyPlanVersion(plan());
    new PipelinePlanAdapter(pipeline).applyPlanVersion(plan());

    expect(loop.created.at(-1)?.steps.map((s) => s.id)).toEqual(['step-1', 'step-2']);
    expect(pipeline.taskPlan.map((s) => s.id)).toEqual(['step-1', 'step-2']);
  });

  it('preserves pipeline-only TaskStep fields and records the plan version', () => {
    const vault = pipelineVault();
    const adapter = new PipelinePlanAdapter(vault);
    adapter.applyPlanVersion(plan());
    const done = vault.taskPlan.find((s) => s.id === 'step-1');
    expect(done?.agentType).toBe('writer');
    expect(done?.expectedFiles).toEqual(['src/auth.ts']);
    expect(done?.result).toBe('done result');
    expect(done?.status).toBe('completed');
    expect(adapter.getVersion()).toBe(3);
  });

  it('projects the same bounded directive for both engines, never the raw guidance', () => {
    const directive = new LoopPlanAdapter(loopStore(), 'fallback').projectForExecutor(plan(), []);
    expect(directive).toContain('STEERING UPDATE');
    expect(directive).toContain('plan v3');
    expect(directive).toContain('NEW CONSTRAINTS');
    expect(directive).toContain('CANCELLED');
    expect(new PipelinePlanAdapter(pipelineVault()).projectForExecutor(plan(), [])).toBe(directive);
  });
});
