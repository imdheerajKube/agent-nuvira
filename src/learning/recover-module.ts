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

import { ErrorRepairEngine, classifyError, isRepairable, selectStrategy, needsApproval } from './error-repair.js';
import type {
  ErrorCategory,
  RepairMode,
  RepairBudget,
  ErrorRepairOptions,
} from './error-repair.js';
import type { AgentContext, AgentResult, LLMCallFn } from '../agents/agent.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';

// ─── New Types (ARCHITECTURE.md §3.5) ──────────────────────────────────────

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
export type RecoverRepairStrategy =
  | { type: 'retry-same' }
  | { type: 'rephrase-prompt'; newPrompt: string }
  | { type: 'switch-model'; model: string }
  | { type: 'simplify-goal'; simplifiedGoal: string }
  | { type: 'split-task'; subTasks: string[] }
  | { type: 'bypass'; reason: string };

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

// ─── RecoverModule Interface ────────────────────────────────────────────────

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

// ─── Adapter: ErrorRepairEngine → RecoverModule ────────────────────────────

/**
 * Map an existing string-union RepairStrategy to the new discriminated union.
 */
function mapStrategy(
  oldStrategy: string,
  fallbackModel?: string,
): RecoverRepairStrategy {
  switch (oldStrategy) {
    case 're-prompt':
      return { type: 'rephrase-prompt', newPrompt: '' };
    case 'switch-model':
      return { type: 'switch-model', model: fallbackModel ?? '' };
    case 'adjust-temperature':
    case 'retry-tool':
      return { type: 'retry-same' };
    case 'skip-step':
    default:
      return { type: 'bypass', reason: 'Budget exhausted' };
  }
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
export class ErrorRepairRecoverModule implements RecoverModule {
  /** The underlying engine (exposed for direct access in migration) */
  public readonly engine: ErrorRepairEngine;
  /** The repair budget (shared reference) */
  public readonly budget: RepairBudget;
  /** The event bus for emitting observability events */
  private eventBus: EventBus;

  constructor(options: Partial<ErrorRepairOptions> = {}, eventBus?: EventBus) {
    this.engine = new ErrorRepairEngine(options);
    this.budget = this.engine.budget;
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Reset the repair budget (e.g., for a new pipeline).
   */
  reset(): void {
    this.engine.reset();
  }

  // ─── RecoverModule implementation ──────────────────────────────────────

  async repair(params: {
    taskId: string;
    failure: AgentFailure;
    context: AgentContext;
    callLLM: LLMCallFn;
    executeAgent: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>;
    budget: RepairBudget;
    fallbackModels?: string[];
  }): Promise<RecoverResult> {
    const { taskId, failure, context, callLLM, executeAgent, budget, fallbackModels } = params;

    const attempts: RecoverAttempt[] = [];
    let finalError: string | undefined;

    // Emit: error classified event
    const category = classifyError(failure.error);
    this.eventBus.emit(EventNames.RECOVER_CLASSIFIED, {
      taskId,
      category,
      strategy: selectStrategy(category, 1, this.engine.options),
    }, 'recover-module');

    // Use the engine's internal repair logic, but wrap the result in the new types.
    // The engine manages its own budget internally.
    const engineResult = await this.engine.repair(
      taskId,
      context,
      callLLM,
      failure.error,
      executeAgent,
    );

    // Build the RecoverResult from the engine's simpler output.
    //
    // TODO (Phase 2+): The underlying ErrorRepairEngine doesn't expose per-attempt
    // records (strategy, duration, outcome). Once the engine is refactored to emit
    // structured RepairAttempt data, the adapter can reconstruct the full history.
    // For now, record a single entry reflecting the final outcome.
    const attemptUsed = budget.getAttempts(taskId);

    // The engine's last attempted strategy (best guess)
    const lastStrategy = selectStrategy(
      category,
      Math.min(attemptUsed, 3), // clamp to [1,3] to avoid out-of-range selectStrategy
      this.engine.options,
    );

    if (engineResult.success && attemptUsed > 0) {
      // Guard: 'skip-step' should never be recorded as a successful strategy.
      // This edge case only occurs if the engine somehow succeeds on attempt 3+.
      const strategy = lastStrategy === 'skip-step'
        ? { type: 'retry-same' as const }
        : mapStrategy(lastStrategy, fallbackModels?.[0]);
      attempts.push({
        attempt: attemptUsed,
        strategy,
        outcome: 'success',
        durationMs: 0, // not tracked by the engine at per-attempt granularity
      });

      // Emit: attempt event (successful on last try)
      this.eventBus.emit(EventNames.RECOVER_ATTEMPT, {
        taskId,
        attempt: attemptUsed,
        strategy: strategy.type,
        outcome: 'success',
      }, 'recover-module');
    } else if (!engineResult.success && attemptUsed > 0) {
      // All attempts failed — record that the process was attempted
      attempts.push({
        attempt: attemptUsed,
        strategy: { type: 'bypass', reason: 'All repair strategies exhausted' },
        outcome: 'failed',
        durationMs: 0,
        error: engineResult.error || engineResult.summary || failure.error,
      });

      // Emit: budget exhausted event
      this.eventBus.emit(EventNames.RECOVER_BUDGET_EXHAUSTED, {
        taskId,
        attempts: attemptUsed,
        finalError: engineResult.error || engineResult.summary || failure.error,
      }, 'recover-module');
    }

    if (!engineResult.success) {
      finalError = engineResult.error || engineResult.summary || failure.error;
    }

    // A model switch occurred if the engine used a fallback model
    const switchedModel = fallbackModels?.[0] ?? undefined;

    // Emit: model switch event if applicable
    if (switchedModel) {
      this.eventBus.emit(EventNames.RECOVER_MODEL_SWITCH, {
        taskId,
        switchedTo: switchedModel,
      }, 'recover-module');
    }

    // Emit: final result event
    this.eventBus.emit(EventNames.RECOVER_RESULT, {
      taskId,
      success: engineResult.success,
      attempts: attemptUsed,
    }, 'recover-module');

    return {
      success: engineResult.success,
      attempts,
      finalError,
      switchedModel,
    };
  }

  classifyError(error: string): ErrorClassification {
    const category = classifyError(error);
    const repairable = isRepairable(category);

    // Determine a suggested strategy
    const suggestedStrategy = repairable
      ? mapStrategy(selectStrategy(category, 1, this.engine.options))
      : { type: 'bypass' as const, reason: 'Non-repairable error category' };

    // Generate human-readable explanation
    const explanation = repairable
      ? `Classified as ${category} — repairable (suggested: ${suggestedStrategy.type})`
      : `Classified as ${category} — not repairable`;

    return { category, repairable, suggestedStrategy, explanation };
  }
}

// ─── Convenience re-exports ────────────────────────────────────────────────

/**
 * Re-export the existing types so consumers can import everything from one module.
 * During migration, use `import type { ... } from './recover-module.js'` instead of
 * `from './error-repair.js'`.
 */
export type {
  ErrorCategory,
  RepairMode,
  RepairBudget,
  ErrorRepairOptions,
} from './error-repair.js';

export { classifyError, isRepairable, selectStrategy, needsApproval } from './error-repair.js';
