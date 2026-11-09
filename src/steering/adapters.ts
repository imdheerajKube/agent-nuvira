/**
 * Engine-neutral plan adapters.
 *
 * Steering semantics must not depend on which engine owns the plan. The loop has a
 * linear checklist (`PlanStore`); the pipeline has a dependency DAG (`TaskStep[]`).
 * Both are projected into the same `SteeringPlanStep` shape, and a committed
 * version is written back through the engine's own API.
 *
 * The adapters are STRUCTURAL: they declare the few methods they need instead of
 * importing the engines, so this module stays dependency-light and a test can use
 * a fake vault without constructing an orchestrator.
 */

import type {
  ChangeRequestRecord,
  SteeringEngine,
  SteeringPlan,
  SteeringPlanAdapter,
  SteeringPlanStep,
  SteeringStepStatus,
} from './types.js';
import { planDirective } from './plan.js';

/** The slice of `tools/plan-store.ts` this adapter needs. */
export interface LoopPlanStoreLike {
  snapshot(): {
    goal: string;
    steps: Array<{ id: string; description: string; status: string; note?: string }>;
    revision: number;
  } | null;
  create(goal: string, steps: Array<{ id: string; description: string }>): unknown;
}

/** The slice of `agents/context-vault.ts` this adapter needs. */
export interface PipelineVaultLike {
  context: {
    goal: string;
    workingDirectory: string;
    taskPlan: Array<{
      id: string;
      description: string;
      agentType: string;
      dependsOn: string[];
      status: string;
      result?: string;
      expectedFiles?: string[];
    }>;
    metadata: Record<string, unknown>;
  };
  setTaskPlan(steps: PipelineVaultLike['context']['taskPlan']): void;
  getMeta<T = unknown>(key: string): T | undefined;
  setMeta(key: string, value: unknown): void;
}

function loopStatus(status: string): SteeringStepStatus {
  if (status === 'done') return 'done';
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function pipelineStatus(status: string): SteeringStepStatus {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'blocked';
  if (status === 'running') return 'running';
  return 'pending';
}

function toPipelineStatus(status: SteeringStepStatus): string {
  if (status === 'done') return 'completed';
  if (status === 'blocked') return 'failed';
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'failed';
  return 'pending';
}

/** The loop engine's adapter (linear checklist). */
export class LoopPlanAdapter implements SteeringPlanAdapter {
  readonly engine: SteeringEngine = 'loop';

  constructor(
    private readonly store: LoopPlanStoreLike,
    private readonly fallbackGoal: string,
  ) {}

  getVersion(): number {
    return this.store.snapshot()?.revision ?? 0;
  }

  getGoal(): string {
    return this.store.snapshot()?.goal || this.fallbackGoal;
  }

  getSteps(): SteeringPlanStep[] {
    const plan = this.store.snapshot();
    if (!plan) return [];
    return plan.steps.map((step) => ({
      id: step.id,
      description: step.description,
      status: loopStatus(step.status),
      dependsOn: [],
      acceptanceCriteria: [],
      priority: 'normal',
      ...(step.note ? { note: step.note } : {}),
    }));
  }

  /**
   * Re-declare the plan through `create`. It carries a step's status by id (and
   * by normalized description when the id changed), so completed work survives a
   * steering rewrite. Cancelled steps are omitted from the engine's checklist:
   * they remain visible in the steering version and its diff.
   */
  applyPlanVersion(plan: SteeringPlan): void {
    const steps = plan.steps
      .filter((step) => step.status !== 'cancelled')
      .map((step) => ({ id: step.id, description: step.description }));
    this.store.create(plan.goal || this.fallbackGoal, steps);
  }

  projectForExecutor(plan: SteeringPlan, changes: ChangeRequestRecord[]): string {
    return planDirective(plan, changes, plan.diff);
  }
}

/** The pipeline engine's adapter (dependency DAG). */
export class PipelinePlanAdapter implements SteeringPlanAdapter {
  readonly engine: SteeringEngine = 'pipeline';
  private static readonly VERSION_KEY = 'steeringPlanVersion';

  constructor(private readonly vault: PipelineVaultLike) {}

  getVersion(): number {
    const value = this.vault.getMeta<number>(PipelinePlanAdapter.VERSION_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  getGoal(): string {
    return this.vault.context.goal;
  }

  getSteps(): SteeringPlanStep[] {
    return this.vault.context.taskPlan.map((step) => ({
      id: step.id,
      description: step.description,
      status: pipelineStatus(step.status),
      dependsOn: [...step.dependsOn],
      acceptanceCriteria: [],
      priority: 'normal',
      agentType: step.agentType,
      ...(step.result ? { note: step.result } : {}),
    }));
  }

  /**
   * Write the version back into the vault. Original TaskStep fields (agent type,
   * expected files, routing hints, result) are preserved: steering changes the
   * PLAN, not the agent that executes a step.
   */
  applyPlanVersion(plan: SteeringPlan): void {
    const originals = new Map(this.vault.context.taskPlan.map((step) => [step.id, step]));
    const next = plan.steps
      // A cancelled step is future work that no longer exists. The steering
      // version and its diff keep the record; the engine's plan drops it.
      .filter((step) => step.status !== 'cancelled')
      .map((step) => {
        const original = originals.get(step.id);
        const status = toPipelineStatus(step.status);
        if (original) {
          return {
            ...original,
            description: step.description,
            dependsOn: [...step.dependsOn],
            status,
          };
        }
        return {
          id: step.id,
          description: step.description,
          agentType: step.agentType ?? 'writer',
          dependsOn: [...step.dependsOn],
          status,
        };
      });
    this.vault.setTaskPlan(next);
    this.vault.setMeta(PipelinePlanAdapter.VERSION_KEY, plan.version);
  }

  projectForExecutor(plan: SteeringPlan, changes: ChangeRequestRecord[]): string {
    return planDirective(plan, changes, plan.diff);
  }
}
