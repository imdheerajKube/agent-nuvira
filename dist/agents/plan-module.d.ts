/**
 * PlanModule — Decomposes user goals into structured, dependency-aware execution
 * plans. Phase 7 of the architecture migration: extract from PlannerAgent into
 * a pluggable module with EventBus integration.
 *
 * @see ARCHITECTURE.md §3.1 — Plan Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn, TaskStep } from './agent.js';
/** Parameters for the PlanModule.plan() method */
export interface PlanParams {
    /** The user's goal / task description */
    goal: string;
    /** Working directory of the project */
    workingDirectory: string;
    /** Optional LLM call function for generating the plan */
    callLLM?: LLMCallFn;
    /** Optional project file tree text (injected by caller) */
    projectFileTree?: string;
    /** Optional memory/few-shot context for the LLM */
    memoryContext?: string;
    /** Optional task descriptions to constrain the plan */
    taskDescriptions?: string[];
}
/** Output of the planning phase */
export interface PlanOutput {
    /** Ordered list of task steps */
    steps: TaskStep[];
    /** Human-readable summary of the plan */
    summary: string;
    /** How many steps were generated */
    stepCount: number;
}
/**
 * PlanModule — Decompose user goals into structured execution plans.
 *
 * @example
 * ```typescript
 * const module = new DefaultPlanModule();
 * const plan = await module.plan({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 *   callLLM,
 * });
 * console.log(`Created ${plan.stepCount} steps`);
 * ```
 */
export interface PlanModule {
    /**
     * Generate an execution plan from a goal and project context.
     */
    plan(params: PlanParams): Promise<PlanOutput>;
}
/**
 * DefaultPlanModule — Built-in plan module implementation.
 *
 * Builds a structured prompt from the goal, project file tree, and memory
 * context; calls the LLM; parses the response into TaskStep[]; normalizes
 * and validates each step.
 */
export declare class DefaultPlanModule implements PlanModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Generate an execution plan from a goal and project context.
     */
    plan(params: PlanParams): Promise<PlanOutput>;
    /**
     * Build the LLM prompt from the goal and project context.
     */
    private buildPrompt;
    /**
     * Parse the LLM response into raw TaskStep arrays.
     * Tries JSON.parse first, then code blocks, then array extraction.
     */
    private parsePlan;
    /**
     * Normalize raw step objects into validated TaskStep arrays.
     * Handles LLM quirks: numeric IDs, null dependsOn, different formats.
     */
    private normalizeSteps;
}
//# sourceMappingURL=plan-module.d.ts.map