/**
 * ErrorRepairModule — Automatic error-repair loop for self-healing agent pipelines.
 *
 * When an agent fails during execution, the ErrorRepairModule analyzes the error,
 * classifies its type, applies repair strategies (re-prompt with error context,
 * switch model, adjust temperature), and tracks a configurable retry budget.
 *
 * A human-approval gate can be triggered for errors that require user consent
 * (e.g., switching to a more expensive model, destroying files).
 *
 * Designed to be integrated into the Orchestrator's executeSingleTask() method,
 * wrapping agent execution in a repair loop.
 *
 * ## Repair Strategies
 *
 * | Strategy | When applied | Effect |
 * |---|---|---|
 * | `re-prompt` | LLM returned invalid output | Re-invoke LLM with error context appended to the prompt |
 * | `switch-model` | Provider errors, persistent LLM failures | Retry with an alternative model/provider |
 * | `adjust-temperature` | Repetitive or hallucinated output | Lower temperature to 0.2 for more deterministic output |
 * | `retry-tool` | Tool call failed with retryable error | Retry the same call after a brief delay |
 * | `skip-step` | Budget exhausted or non-repairable | Gracefully skip the failing step |
 *
 * ## Error Classification
 *
 * | Category | Examples | Repairable? |
 * |---|---|---|
 * | `llm-error` | JSON parse failure, invalid output format | ✅ Repairable (re-prompt) |
 * | `provider-error` | Rate limit, server 5xx, timeout | ✅ Repairable (switch-model or retry) |
 * | `process-error` | Subprocess crashed, non-zero exit | ⚠️ Conditionally repairable |
 * | `injection-blocked` | Security guardrail triggered | ❌ Not repairable (abort) |
 * | `context-limit` | Context too large for model | ✅ Repairable (prune then retry) |
 * | `budget-exhausted` | Retry budget used up | ❌ Not repairable |
 * | `unknown` | Unclassifiable error | ⚠️ Conditionally repairable |
 */
import type { AgentContext, AgentResult, LLMCallFn } from '../agents/agent.js';
/** Categories of errors that the repair system can classify */
export type ErrorCategory = 'llm-error' | 'provider-error' | 'process-error' | 'injection-blocked' | 'context-limit' | 'budget-exhausted' | 'unknown';
/** Repair strategies that can be applied */
export type RepairStrategy = 're-prompt' | 'switch-model' | 'adjust-temperature' | 'retry-tool' | 'skip-step';
/** Mode of operation for the repair loop */
export type RepairMode = 'auto' | 'prompt' | 'off';
/** Result of a single repair attempt */
export interface RepairAttempt {
    /** Which strategy was attempted */
    strategy: RepairStrategy;
    /** Whether the repair was successful */
    success: boolean;
    /** Error from the repair attempt, if any */
    error?: string;
    /** The agent result after the repair, if successful */
    result?: AgentResult;
    /** Duration of the repair attempt in ms */
    durationMs: number;
    /** Index within the repair loop (1-based) */
    attemptNumber: number;
}
/** Engine options */
export interface ErrorRepairOptions {
    /** Maximum number of repair attempts per task (default: 3) */
    maxRepairs: number;
    /** Repair mode (default: 'auto') */
    repairMode: RepairMode;
    /** Whether to log repair details (default: false) */
    verbose?: boolean;
    /** Models to try when switching (default: []) */
    fallbackModels?: string[];
    /** Timeout per repair attempt in ms (default: 30000) */
    repairTimeoutMs?: number;
    /** Current provider name, used for logging */
    currentProvider?: string;
}
/**
 * Classify an error string into a category.
 * Uses keyword matching against known error patterns.
 */
export declare function classifyError(error: string | undefined | null): ErrorCategory;
/**
 * Determine if an error category is repairable.
 */
export declare function isRepairable(category: ErrorCategory): boolean;
/**
 * Determine the best repair strategy for a given error category.
 */
export declare function selectStrategy(category: ErrorCategory, attemptNumber: number, options: ErrorRepairOptions): RepairStrategy;
/**
 * Tracks repair attempts per task and across a session.
 */
export declare class RepairBudget {
    /** Total repair attempts used in the current session */
    private totalUsed;
    /** Repair attempts per task ID */
    private perTask;
    /** Repair mode */
    private mode;
    /** Max repairs per task */
    private maxPerTask;
    /** Max total repairs across the session (maxPerTask * 10 as a safety net) */
    private maxTotal;
    constructor(maxPerTask?: number, mode?: RepairMode);
    /** Check if a task has remaining budget */
    hasBudget(taskId: string): boolean;
    /** Consume one repair attempt for a task */
    consume(taskId: string): void;
    /** Get the number of attempts used for a task */
    getAttempts(taskId: string): number;
    /** Get total attempts across the session */
    get totalAttempts(): number;
    /** Reset the budget (for a new session) */
    reset(): void;
    /** Get budget summary for logging */
    getSummary(taskId: string): string;
}
/**
 * Determine whether human approval is needed for a given strategy.
 * Only prompts when repairMode is 'prompt'.
 */
export declare function needsApproval(strategy: RepairStrategy, mode: RepairMode): boolean;
/**
 * The main error-repair engine. Designed to be called by the orchestrator
 * when an agent execution fails.
 *
 * Typical usage:
 *
 * ```typescript
 * const repair = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'auto' });
 * const result = await repair.repair(task, vault.context, callLLM, error);
 * ```
 */
export declare class ErrorRepairEngine {
    readonly options: ErrorRepairOptions;
    readonly budget: RepairBudget;
    constructor(options?: Partial<ErrorRepairOptions>);
    /**
     * Attempt to repair a failed agent execution.
     *
     * @param taskId - ID of the failing task
     * @param context - The agent context (for re-prompting)
     * @param callLLM - LLM call function
     * @param originalError - The error message from the failed agent execution
     * @param executeFn - A function that executes the agent given updated context + callLLM
     * @returns The repair result
     */
    repair(taskId: string, context: AgentContext, callLLM: LLMCallFn, originalError: string, executeFn: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>): Promise<AgentResult>;
    /** Reset the repair budget (e.g., for a new pipeline) */
    reset(): void;
}
/**
 * Format a repair result for display in verbose mode.
 */
export declare function formatRepairSummary(taskId: string, category: ErrorCategory, finalResult: AgentResult, budget: RepairBudget): string;
//# sourceMappingURL=error-repair.d.ts.map