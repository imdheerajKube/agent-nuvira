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
import { ErrorRepairEngine, classifyError, isRepairable, selectStrategy } from './error-repair.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
// ─── Adapter: ErrorRepairEngine → RecoverModule ────────────────────────────
/**
 * Map an existing string-union RepairStrategy to the new discriminated union.
 */
function mapStrategy(oldStrategy, fallbackModel) {
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
export class ErrorRepairRecoverModule {
    /** The underlying engine (exposed for direct access in migration) */
    engine;
    /** The repair budget (shared reference) */
    budget;
    /** The event bus for emitting observability events */
    eventBus;
    constructor(options = {}, eventBus) {
        this.engine = new ErrorRepairEngine(options);
        this.budget = this.engine.budget;
        this.eventBus = eventBus ?? getEventBus();
    }
    /**
     * Reset the repair budget (e.g., for a new pipeline).
     */
    reset() {
        this.engine.reset();
    }
    // ─── RecoverModule implementation ──────────────────────────────────────
    async repair(params) {
        const { taskId, failure, context, callLLM, executeAgent, budget, fallbackModels } = params;
        const attempts = [];
        let finalError;
        // Emit: error classified event
        const category = classifyError(failure.error);
        this.eventBus.emit(EventNames.RECOVER_CLASSIFIED, {
            taskId,
            category,
            strategy: selectStrategy(category, 1, this.engine.options),
        }, 'recover-module');
        // Use the engine's internal repair logic, but wrap the result in the new types.
        // The engine manages its own budget internally.
        const engineResult = await this.engine.repair(taskId, context, callLLM, failure.error, executeAgent);
        // Build the RecoverResult from the engine's simpler output.
        //
        // TODO (Phase 2+): The underlying ErrorRepairEngine doesn't expose per-attempt
        // records (strategy, duration, outcome). Once the engine is refactored to emit
        // structured RepairAttempt data, the adapter can reconstruct the full history.
        // For now, record a single entry reflecting the final outcome.
        const attemptUsed = budget.getAttempts(taskId);
        // The engine's last attempted strategy (best guess)
        const lastStrategy = selectStrategy(category, Math.min(attemptUsed, 3), // clamp to [1,3] to avoid out-of-range selectStrategy
        this.engine.options);
        if (engineResult.success && attemptUsed > 0) {
            // Guard: 'skip-step' should never be recorded as a successful strategy.
            // This edge case only occurs if the engine somehow succeeds on attempt 3+.
            const strategy = lastStrategy === 'skip-step'
                ? { type: 'retry-same' }
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
        }
        else if (!engineResult.success && attemptUsed > 0) {
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
    classifyError(error) {
        const category = classifyError(error);
        const repairable = isRepairable(category);
        // Determine a suggested strategy
        const suggestedStrategy = repairable
            ? mapStrategy(selectStrategy(category, 1, this.engine.options))
            : { type: 'bypass', reason: 'Non-repairable error category' };
        // Generate human-readable explanation
        const explanation = repairable
            ? `Classified as ${category} — repairable (suggested: ${suggestedStrategy.type})`
            : `Classified as ${category} — not repairable`;
        return { category, repairable, suggestedStrategy, explanation };
    }
}
export { classifyError, isRepairable, selectStrategy, needsApproval } from './error-repair.js';
//# sourceMappingURL=recover-module.js.map