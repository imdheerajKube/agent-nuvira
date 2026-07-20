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
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Categories of errors that the repair system can classify */
export type ErrorCategory =
  | 'llm-error'
  | 'provider-error'
  | 'process-error'
  | 'injection-blocked'
  | 'context-limit'
  | 'budget-exhausted'
  | 'unknown';

/** Repair strategies that can be applied */
export type RepairStrategy =
  | 're-prompt'
  | 'switch-model'
  | 'adjust-temperature'
  | 'retry-tool'
  | 'skip-step';

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

/** Default configuration */
const DEFAULT_OPTIONS: ErrorRepairOptions = {
  maxRepairs: 3,
  repairMode: 'auto',
  verbose: false,
  fallbackModels: [],
  repairTimeoutMs: 30_000,
};

// ─── Error Classification ───────────────────────────────────────────────────

/**
 * Classify an error string into a category.
 * Uses keyword matching against known error patterns.
 */
export function classifyError(error: string | undefined | null): ErrorCategory {
  if (!error || error.trim().length === 0) return 'unknown';

  const lower = error.toLowerCase();

  // Injection guardrail detection
  if (
    lower.includes('injection') ||
    lower.includes('guardrail') ||
    lower.includes('blocked by security') ||
    lower.includes('prompt injection')
  ) {
    return 'injection-blocked';
  }

  // Provider errors
  if (
    /5\d{2}(\D|$)/.test(lower) ||
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('server error') ||
    lower.includes('internal server error') ||
    lower.includes('service unavailable') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('gateway') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('connection refused') ||
    lower.includes('network error') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  ) {
    return 'provider-error';
  }

  // Context limit errors
  if (
    lower.includes('context length') ||
    lower.includes('max tokens') ||
    lower.includes('too many tokens') ||
    lower.includes('context window') ||
    lower.includes('token limit') ||
    lower.includes('maximum context') ||
    lower.includes('context overflow') ||
    lower.includes('prompt too long')
  ) {
    return 'context-limit';
  }

  // Process errors
  if (
    lower.includes('exit code') ||
    lower.includes('non-zero') ||
    lower.includes('command failed') ||
    lower.includes('process') ||
    lower.includes('child_process') ||
    lower.includes('spawn') ||
    lower.includes('enoent') ||
    lower.includes('eacces') ||
    lower.includes('exec')
  ) {
    return 'process-error';
  }

  // LLM output errors — note: avoid overly broad English words like 'expected'
  // which appear in common language (e.g., 'unexpected'). Use specific phrases.
  if (
    lower.includes('json') ||
    lower.includes('parse error') ||
    lower.includes('unexpected token') ||
    lower.includes('invalid json') ||
    lower.includes('malformed') ||
    lower.includes('syntax') ||
    lower.includes('unterminated') ||
    lower.includes('unexpected identifier') ||
    lower.includes('invalid response')
  ) {
    return 'llm-error';
  }

  return 'unknown';
}

/**
 * Determine if an error category is repairable.
 */
export function isRepairable(category: ErrorCategory): boolean {
  switch (category) {
    case 'llm-error':
    case 'provider-error':
    case 'context-limit':
      return true;
    case 'process-error':
      return true; // conditionally repairable
    case 'injection-blocked':
    case 'budget-exhausted':
      return false;
    case 'unknown':
      return true; // try a generic repair
  }
}

/**
 * Determine the best repair strategy for a given error category.
 */
export function selectStrategy(
  category: ErrorCategory,
  attemptNumber: number,
  options: ErrorRepairOptions,
): RepairStrategy {
  switch (category) {
    case 'llm-error':
      // First attempt: re-prompt. Subsequent: switch model or adjust temperature
      if (attemptNumber === 1) return 're-prompt';
      if (attemptNumber === 2) return options.fallbackModels && options.fallbackModels.length > 0
        ? 'switch-model'
        : 'adjust-temperature';
      return 'skip-step';

    case 'provider-error':
      // First attempt: switch model. Second: retry. Third: skip.
      if (attemptNumber === 1) return options.fallbackModels && options.fallbackModels.length > 0
        ? 'switch-model'
        : 'retry-tool';
      if (attemptNumber === 2) return 'retry-tool';
      return 'skip-step';

    case 'context-limit':
      // Context limit: re-prompt (the ContextPruner should have been called, but retry)
      return 're-prompt';

    case 'process-error':
      // Process error: retry once, then skip
      if (attemptNumber <= 2) return 'retry-tool';
      return 'skip-step';

    case 'unknown':
      // Unknown: re-prompt, then skip
      if (attemptNumber === 1) return 're-prompt';
      return 'skip-step';

    case 'injection-blocked':
    case 'budget-exhausted':
      return 'skip-step';
  }
}

// ─── Repair Budget ──────────────────────────────────────────────────────────

/**
 * Tracks repair attempts per task and across a session.
 */
export class RepairBudget {
  /** Total repair attempts used in the current session */
  private totalUsed = 0;
  /** Repair attempts per task ID */
  private perTask = new Map<string, number>();
  /** Repair mode */
  private mode: RepairMode;
  /** Max repairs per task */
  private maxPerTask: number;
  /** Max total repairs across the session (maxPerTask * 10 as a safety net) */
  private maxTotal: number;

  constructor(maxPerTask = 3, mode: RepairMode = 'auto') {
    this.maxPerTask = maxPerTask;
    this.mode = mode;
    this.maxTotal = maxPerTask * 10;
  }

  /** Check if a task has remaining budget */
  hasBudget(taskId: string): boolean {
    if (this.mode === 'off') return false;
    const taskUsed = this.perTask.get(taskId) || 0;
    return taskUsed < this.maxPerTask && this.totalUsed < this.maxTotal;
  }

  /** Consume one repair attempt for a task */
  consume(taskId: string): void {
    const taskUsed = (this.perTask.get(taskId) || 0) + 1;
    this.perTask.set(taskId, taskUsed);
    this.totalUsed++;
  }

  /** Get the number of attempts used for a task */
  getAttempts(taskId: string): number {
    return this.perTask.get(taskId) || 0;
  }

  /** Get total attempts across the session */
  get totalAttempts(): number {
    return this.totalUsed;
  }

  /** Reset the budget (for a new session) */
  reset(): void {
    this.totalUsed = 0;
    this.perTask.clear();
  }

  /** Get budget summary for logging */
  getSummary(taskId: string): string {
    const used = this.perTask.get(taskId) || 0;
    return `${used}/${this.maxPerTask} attempts used`;
  }
}

// ─── Human-Approval Gate ────────────────────────────────────────────────────

/**
 * Determine whether human approval is needed for a given strategy.
 * Only prompts when repairMode is 'prompt'.
 */
export function needsApproval(strategy: RepairStrategy, mode: RepairMode): boolean {
  if (mode === 'off') return false;
  if (mode === 'auto') return false; // Auto mode: never requires approval
  // In 'prompt' mode, non-trivial strategies require approval
  return strategy !== 'retry-tool' && strategy !== 'adjust-temperature';
}

// ─── ErrorRepairEngine ──────────────────────────────────────────────────────

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
export class ErrorRepairEngine {
  public readonly options: ErrorRepairOptions;
  public readonly budget: RepairBudget;

  constructor(options: Partial<ErrorRepairOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.budget = new RepairBudget(this.options.maxRepairs, this.options.repairMode);
  }

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
  async repair(
    taskId: string,
    context: AgentContext,
    callLLM: LLMCallFn,
    originalError: string,
    executeFn: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult>,
  ): Promise<AgentResult> {
    const category = classifyError(originalError);

    if (this.options.verbose) {
      logger.info(`   🔧 Error classified as: ${category}`);
    }

    // Check if repairable
    if (!isRepairable(category)) {
      if (this.options.verbose) {
        logger.info(`   ❌ Error is not repairable (${category})`);
      }
      return {
        success: false,
        summary: `Non-repairable error (${category})`,
        error: originalError,
      };
    }

    // Repair loop
    while (this.budget.hasBudget(taskId)) {
      const attemptNumber = this.budget.getAttempts(taskId) + 1;
      const strategy = selectStrategy(category, attemptNumber, this.options);

      if (strategy === 'skip-step') {
        if (this.options.verbose) {
          logger.info(`   ⏭️  All repair strategies exhausted for ${taskId}`);
        }
        return {
          success: false,
          summary: `Repair budget exhausted after ${attemptNumber - 1} attempt(s)`,
          error: originalError,
        };
      }

      // Check human-approval gate
      if (needsApproval(strategy, this.options.repairMode)) {
        if (this.options.verbose) {
          logger.info(`   🛑 Human approval required for strategy: ${strategy}`);
        }
        // In 'prompt' mode, fall back to skip-step if we can't get user input here
        return {
          success: false,
          summary: `Human approval needed for '${strategy}' strategy in prompt mode`,
          error: originalError,
        };
      }

      // Consume budget and apply strategy
      this.budget.consume(taskId);

      const startTime = Date.now();
      let result: AgentResult;

      try {
        switch (strategy) {
          case 're-prompt': {
            if (this.options.verbose) {
              logger.info(`   🔄 Repair attempt ${attemptNumber}: re-prompting with error context`);
            }
            // Append error context to the goal so the next invocation knows what went wrong
            const errorSuffix = `\n\n[REPAIR ATTEMPT ${attemptNumber}]\nThe previous attempt failed with:\n${originalError}\n\nPlease learn from this error and provide a correct answer.`;
            context = {
              ...context,
              goal: context.goal + errorSuffix,
            };
            result = await executeFn(context, callLLM);
            break;
          }

          case 'switch-model': {
            const fallbackModel = this.options.fallbackModels?.[0];
            if (this.options.verbose && fallbackModel) {
              logger.info(`   🔄 Repair attempt ${attemptNumber}: switching model to ${fallbackModel}`);
            }
            if (fallbackModel) {
              // Create a new LLM call function with the fallback model
              const fallbackLLM: LLMCallFn = async (prompt, opts) => {
                return callLLM(prompt, { ...opts, model: fallbackModel });
              };
              result = await executeFn(context, fallbackLLM);
            } else {
              // No fallback model configured — retry with original
              result = await executeFn(context, callLLM);
            }
            break;
          }

          case 'adjust-temperature': {
            if (this.options.verbose) {
              logger.info(`   🔄 Repair attempt ${attemptNumber}: adjusting temperature to 0.2`);
            }
            const lowTempLLM: LLMCallFn = async (prompt, opts) => {
              return callLLM(prompt, { ...opts, temperature: 0.2 });
            };
            result = await executeFn(context, lowTempLLM);
            break;
          }

          case 'retry-tool': {
            if (this.options.verbose) {
              logger.info(`   🔄 Repair attempt ${attemptNumber}: retrying`);
            }
            result = await executeFn(context, callLLM);
            break;
          }

          default:
            result = { success: false, summary: `Unknown strategy: ${strategy}`, error: originalError };
        }

        const durationMs = Date.now() - startTime;

        if (result.success) {
          if (this.options.verbose) {
            logger.success(`   ✅ Repair attempt ${attemptNumber} succeeded (${strategy}) in ${durationMs}ms`);
          }
          return result;
        }

        if (this.options.verbose) {
          logger.info(`   ❌ Repair attempt ${attemptNumber} failed (${strategy}) — ${result.summary}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.options.verbose) {
          logger.info(`   ❌ Repair attempt ${attemptNumber} threw: ${msg}`);
        }
      }
    }

    // Budget exhausted
    return {
      success: false,
      summary: `Repair budget exhausted (${this.budget.getAttempts(taskId)} attempts)`,
      error: originalError,
    };
  }

  /** Reset the repair budget (e.g., for a new pipeline) */
  reset(): void {
    this.budget.reset();
  }
}

// ─── Format Helpers ─────────────────────────────────────────────────────────

/**
 * Format a repair result for display in verbose mode.
 */
export function formatRepairSummary(
  taskId: string,
  category: ErrorCategory,
  finalResult: AgentResult,
  budget: RepairBudget,
): string {
  const icon = finalResult.success ? '✅' : '❌';
  const attempts = budget.getAttempts(taskId);
  return `${icon} [${taskId}] ${category} → ${finalResult.summary} (${attempts} repair attempt(s))`;
}
