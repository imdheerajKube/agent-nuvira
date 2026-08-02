/**
 * RecoverModule — Modular interface for error recovery in the agent execution engine.
 *
 * Phase 1 of the architecture migration: extract the RecoverModule interface from the
 * existing ErrorRepairEngine. The module defines a clean boundary for diagnosing
 * failures and applying targeted repair strategies with configurable retry budgets.
 *
 * @see ARCHITECTURE.md §3.5 — Recover Module specification
 * @see ./error-repair.ts — Existing implementation that this module wraps
 */
import { ErrorRepairEngine } from './error-repair.js';
import type { ErrorCategory, RepairBudget, ErrorRepairOptions } from './error-repair.js';
import type { AgentContext, AgentResult, LLMCallFn } from '../agents/agent.js';
import type { EventBus } from '../observability/event-bus.js';
/**
 * Represents a failure that occurred during agent execution.
 * Carries enough context for the RecoverModule to diagnose and repair.
 */
export interface AgentFailure {
    /** The raw error message or description */
    error: string;
    /** Optional pre-classified error category */
    category?: ErrorCategory;
    /** Optional ID of the task that failed */
    taskId?: string;
    /** Optional agent type that produced the failure (e.g. 'writer', 'runner') */
    agentType?: string;
    /** Optional structured details (stack trace, exit code, etc.) */
    details?: string;
}
/**
 * Repair strategies with typed parameters.
 *
 * More elaborate than the existing string-union `RepairStrategy` — each variant
 * carries the data needed to apply it, so the module doesn't need to reconstruct
 * context from the error alone.
 */
export type RecoverRepairStrategy = {
    type: 'retry-same';
} | {
    type: 'rephrase-prompt';
    newPrompt: string;
} | {
    type: 'switch-model';
    model: string;
} | {
    type: 'simplify-goal';
    simplifiedGoal: string;
} | {
    type: 'split-task';
    subTasks: string[];
} | {
    type: 'bypass';
    reason: string;
};
/** Outcome of a single repair attempt */
export type RecoverAttemptOutcome = 'success' | 'failed' | 'skipped';
/** Record of a single repair attempt */
export interface RecoverAttempt {
    /** Attempt number (1-based) */
    attempt: number;
    /** Strategy used for this attempt */
    strategy: RecoverRepairStrategy;
    /** Outcome of the attempt */
    outcome: RecoverAttemptOutcome;
    /** Duration in milliseconds */
    durationMs: number;
    /** Error message if the attempt failed */
    error?: string;
}
/** Final result of the repair process */
export interface RecoverResult {
    /** Whether the repair was ultimately successful */
    success: boolean;
    /** All repair attempts made */
    attempts: RecoverAttempt[];
    /** Final error if all attempts failed */
    finalError?: string;
    /** Model that was switched to (if applicable) */
    switchedModel?: string;
}
/**
 * Classification result returned by `classifyError`.
 */
export interface ErrorClassification {
    /** The error category */
    category: ErrorCategory;
    /** Whether this error type is repairable */
    repairable: boolean;
    /** Suggested initial strategy based on classification */
    suggestedStrategy?: RecoverRepairStrategy;
    /** Human-readable explanation of the classification */
    explanation: string;
}
/**
 * RecoverModule — Diagnose failures and apply targeted repair strategies.
 *
 * Each module implementation owns a RepairBudget that prevents infinite retry
 * loops and can be configured for different repair modes (auto, prompt, off).
 */
export interface RecoverModule {
    /**
     * Attempt to repair a failed agent execution.
     *
     * @param params.taskId - ID of the failing task
     * @param params.failure - The failure details (error, category, context)
     * @param params.context - The agent context (for re-prompting)
     * @param params.callLLM - LLM call function
     * @param params.executeAgent - Function to re-execute the agent
     * @param params.budget - Repair budget tracking remaining attempts
     * @param params.fallbackModels - Optional fallback models for switch-model strategy
     * @returns The repair result with all attempts and final outcome
     */
    repair(params: {
        taskId: string;
        failure: AgentFailure;
        context: AgentContext;
        callLLM: LLMCallFn;
        executeAgent: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>;
        budget: RepairBudget;
        fallbackModels?: string[];
    }): Promise<RecoverResult>;
    /**
     * Classify an error string into a structured classification.
     *
     * @param error - The raw error message
     * @returns A structured classification with category, repairability, and suggestion
     */
    classifyError(error: string): ErrorClassification;
}
/**
 * Adapter class that implements RecoverModule by wrapping the existing ErrorRepairEngine.
 *
 * This is the migration bridge — it delegates to the existing engine while exposing
 * the new modular interface. Once all consumers migrate to RecoverModule, the
 * ErrorRepairEngine can be refactored into a pure implementation behind this interface.
 *
 * @example
 * ```typescript
 * const module = new ErrorRepairRecoverModule({ maxRepairs: 3, repairMode: 'auto' });
 * const result = await module.repair({
 *   taskId: 'task-1',
 *   failure: { error: 'LLM returned invalid JSON' },
 *   context,
 *   callLLM,
 *   executeAgent: myExecuteFn,
 *   budget: module.engine.budget,
 * });
 * ```
 */
export declare class ErrorRepairRecoverModule implements RecoverModule {
    /** The underlying engine (exposed for direct access in migration) */
    readonly engine: ErrorRepairEngine;
    /** The repair budget (shared reference) */
    readonly budget: RepairBudget;
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(options?: Partial<ErrorRepairOptions>, eventBus?: EventBus);
    /**
     * Reset the repair budget (e.g., for a new pipeline).
     */
    reset(): void;
    repair(params: {
        taskId: string;
        failure: AgentFailure;
        context: AgentContext;
        callLLM: LLMCallFn;
        executeAgent: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>;
        budget: RepairBudget;
        fallbackModels?: string[];
    }): Promise<RecoverResult>;
    classifyError(error: string): ErrorClassification;
}
/**
 * Re-export the existing types so consumers can import everything from one module.
 * During migration, use `import type { ... } from './recover-module.js'` instead of
 * `from './error-repair.js'`.
 */
export type { ErrorCategory, RepairMode, RepairBudget, ErrorRepairOptions, } from './error-repair.js';
export { classifyError, isRepairable, selectStrategy, needsApproval } from './error-repair.js';
//# sourceMappingURL=recover-module.d.ts.map