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
 * | `alternative-approach` | Persistent failures across strategies | Ask the LLM for a fundamentally different strategy, then re-execute |
 * | `shrink-scope` | WEAK-MODEL path (escalation is a no-op) | Re-ask for the SMALLEST single unit, so a model that cannot hold the whole task still moves the work forward |
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
  /**
   * The PROVIDER's account has no money/credits left (HTTP 402). Distinct from
   * `budget-exhausted` (OUR token/step allowance): retrying, re-prompting or
   * shrinking the ask cannot conjure funds, so this is never repairable on the
   * same pair. Switching PROVIDER is the real remedy — a different host may
   * serve the same model — but that decision belongs to the failover walk, not
   * to the repair ladder.
   */
  | 'credit-exhausted'
  /**
   * A PIN that strict mode refuses to honour (`Model 'X' is not available on
   * 'Y', and strict model mode forbids substituting another model`).
   *
   * DEFINITIVE for this run: only the user can change the pin or unset
   * NUVIRA_STRICT_MODEL. No rung of the repair ladder may substitute a model the
   * user explicitly forbade, so every attempt is waste. Measured: this sentence —
   * NOT the raw provider error — is what reached the repair loop, so the planner
   * burned its entire budget on it even after the underlying 402 was itself
   * classified correctly.
   */
  | 'pin-unavailable'
  | 'unknown';

/** Repair strategies that can be applied */
export type RepairStrategy =
  | 're-prompt'
  | 'switch-model'
  | 'adjust-temperature'
  | 'retry-tool'
  | 'alternative-approach'
  | 'shrink-scope'
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
  /** Check if the current LLM provider is available (not rate-limited).
   *  When false, retry-tool and alternative-approach strategies are skipped
   *  because they would hit the same rate-limited provider. */
  isLLMAvailable?: () => boolean;
  /**
   * WEAK-MODEL CLOSE-THE-LOOP mode. Set by the orchestrator when model
   * escalation is a NO-OP — every stronger candidate is unavailable/blocked, so
   * the task can only ever run on the weak model in use.
   *
   * Re-prompting such a model repeats the same failure; the fix is to ask it
   * for LESS. This switches the ladder to a bounded, non-repeating sequence
   * (see `selectStrategy`) whose second step shrinks the ask to a single unit,
   * so the run makes progress instead of dead-ending. Off by default — a
   * healthy pipeline keeps the ordinary per-category ladder unchanged.
   */
  weakModel?: boolean;
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

  // Credit/payment exhaustion — checked BEFORE the generic provider/server
  // patterns. Measured: an OpenRouter 402
  // (`{"error":{"message":"Insufficient credits...","code":402,...}}`) matched
  // NO branch and fell through to `unknown`, which `isRepairable` treats as
  // repairable — so a Planner burned its whole repair budget ("Repair budget exhausted
  // after 2 attempt(s)") on a failure that could never succeed. The message
  // ALSO contains `max_tokens`, which is why the credit check must come first:
  // a later `context-limit` match would classify an unfunded account as a
  // too-long-prompt and try to shrink the ask.
  if (
    /insufficient credits?/.test(lower) ||
    /purchase (more )?credits?/.test(lower) ||
    /credit balance/.test(lower) ||
    /out of credits/.test(lower) ||
    /"?code"?\s*:\s*402/.test(lower)
  ) {
    return 'credit-exhausted';
  }

  // A strict-mode pin refusal — DEFINITIVE, and deliberately matched on OUR OWN
  // wording (the sentence `route-resolver.ts` emits), so it cannot accidentally
  // swallow a provider's "service not available" (which is a retryable 503 and
  // must stay `provider-error`).
  if (lower.includes('strict model mode') || lower.includes('forbids substituting')) {
    return 'pin-unavailable';
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
    // No strategy in the ladder changes an unfunded account: re-prompting the
    // same pair, shrinking the ask or switching model within the provider all
    // hit the same 402. Only a different PROVIDER can serve it — a decision the
    // failover walk owns. Spending repair attempts here is pure waste, and it
    // hides the real cause behind "repair budget exhausted".
    case 'credit-exhausted':
    // Only the user can change a pin or lift strict mode; the ladder must not
    // substitute a model they forbade, so it has nothing to offer.
    case 'pin-unavailable':
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
  // ── WEAK-MODEL CLOSE-THE-LOOP LADDER ────────────────────────────────────
  // When ONLY a weak model is available, the per-category ladder below is a
  // trap: its 2nd/3rd steps (switch-model / alternative-approach) assume a
  // stronger model exists to switch TO, and re-prompting the same weak model
  // repeats the identical failure. So the ladder is replaced by a bounded,
  // predictable sequence whose every step is a DIFFERENT kind of attempt:
  //   1. `re-prompt`     — cheap, honest first move: give it the failure once;
  //   2. `shrink-scope`  — ask for the SMALLEST single unit. This is the step
  //      that turns a stuck loop around: a model that cannot hold the whole
  //      task can still produce one correct file, which is real progress;
  //   3. `skip-step`     — end honestly (the durable hand-off records what is
  //      still missing, so the next run continues instead of re-deriving).
  if (options.weakModel) {
    if (attemptNumber === 1) return 're-prompt';
    if (attemptNumber === 2) return 'shrink-scope';
    return 'skip-step';
  }

  switch (category) {
    case 'llm-error':
      // First attempt: re-prompt. Second: switch model or adjust temperature.
      // Third: ask for a completely different approach. Fourth: skip.
      if (attemptNumber === 1) return 're-prompt';
      if (attemptNumber === 2) return options.fallbackModels && options.fallbackModels.length > 0
        ? 'switch-model'
        : 'adjust-temperature';
      if (attemptNumber === 3) return 'alternative-approach';
      return 'skip-step';

    case 'provider-error':
      // First attempt: switch model. Second: retry. Third: alternative approach. Fourth: skip.
      if (attemptNumber === 1) return options.fallbackModels && options.fallbackModels.length > 0
        ? 'switch-model'
        : 'retry-tool';
      if (attemptNumber === 2) return 'retry-tool';
      if (attemptNumber === 3) return 'alternative-approach';
      return 'skip-step';

    case 'context-limit':
      // Context limit: re-prompt (the ContextPruner should have been called, but retry),
      // then try an alternative approach before skipping.
      if (attemptNumber === 1) return 're-prompt';
      if (attemptNumber === 2) return 'alternative-approach';
      return 'skip-step';

    case 'process-error':
      // Process/command error: the previous execution FAILED — re-running the
      // same agent blind (old retry-tool behavior) just repeats the identical
      // failure until the budget dies (observed: 4 identical `wrangler pages
      // deploy` runs on a project that needed `pages project create` first).
      // The ladder must ADAPT: re-prompt with the failure output first (so the
      // agent picks a different command/approach), then a fundamentally
      // different approach, then escalate the model, then skip.
      if (attemptNumber === 1) return 're-prompt';
      if (attemptNumber === 2) return 'alternative-approach';
      if (attemptNumber === 3) return options.fallbackModels && options.fallbackModels.length > 0
        ? 'switch-model'
        : 'alternative-approach';
      return 'skip-step';

    case 'unknown':
      // Unknown: re-prompt, then alternative approach, then skip
      if (attemptNumber === 1) return 're-prompt';
      if (attemptNumber === 2) return 'alternative-approach';
      return 'skip-step';

    case 'injection-blocked':
    case 'budget-exhausted':
    // No rung of the ladder can fund an account, and `isRepairable` already
    // refuses it — this case exists so the switch stays exhaustive and the
    // strategy is stated positively rather than defaulting.
    case 'credit-exhausted':
    case 'pin-unavailable':
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
  /** Number of 'alternative-approach' strategies executed (telemetry) */
  public alternativeApproaches = 0;

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
            // Wire failure lessons into repair: when re-prompting, inject known
            // failure patterns so the model avoids repeating past mistakes.
            const failureLessonContext = context.metadata?.failureLessonContext as string | undefined;
            const lessonSuffix = failureLessonContext
              ? `\n\n## Known Failure Patterns (from past runs)\nAvoid these specific issues:${failureLessonContext}`
              : '';
            context = {
              ...context,
              goal: context.goal + errorSuffix + lessonSuffix,
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
            // LLM AVAILABILITY GUARD: when the provider is rate-limited or
            // exhausted, retrying with the same callLLM just repeats the
            // failure until the budget dies. Skip to the next strategy.
            if (this.options.isLLMAvailable && !this.options.isLLMAvailable()) {
              if (this.options.verbose) {
                logger.info(`   ⏭️ Repair attempt ${attemptNumber}: skipping retry-tool (LLM provider unavailable)`);
              }
              this.budget.consume(taskId);
              continue;
            }
            if (this.options.verbose) {
              logger.info(`   🔄 Repair attempt ${attemptNumber}: retrying with failure context`);
            }
            // Retry WITH the failure context appended — a blind identical
            // re-run would otherwise repeat the same mistake (e.g. a runner
            // task re-extracting the same failing command from its unchanged
            // description). The error suffix is how the runner detects a
            // repair attempt and re-selects its command.
            context = {
              ...context,
              goal: context.goal + [
                '',
                `[REPAIR ATTEMPT ${attemptNumber}]`, // marker consumed by agents (e.g. RunnerAgent)
                `The previous attempt failed with:`,
                originalError.slice(0, 2000),
                'Do not repeat the same failing approach — change your next action based on this error.',
              ].join('\n'),
            };
            result = await executeFn(context, callLLM);
            break;
          }

          case 'alternative-approach': {
            // LLM AVAILABILITY GUARD: alternative-approach sends a prompt to
            // the LLM asking for a different strategy, then executes it. If the
            // LLM is rate-limited, both steps fail. Skip to skip-step.
            if (this.options.isLLMAvailable && !this.options.isLLMAvailable()) {
              if (this.options.verbose) {
                logger.info(`   ⏭️ Repair attempt ${attemptNumber}: skipping alternative-approach (LLM provider unavailable)`);
              }
              this.budget.consume(taskId);
              continue;
            }
            this.alternativeApproaches += 1;
            if (this.options.verbose) {
              logger.info(`   💡 Repair attempt ${attemptNumber}: asking the LLM for a fundamentally different approach`);
            }
            // Ask the LLM to propose a completely different strategy to accomplish
            // the goal instead of repeating the same failing approach.
            let suggestion = '';
            try {
              const prompt = [
                'The current approach has failed repeatedly. Propose a COMPLETELY DIFFERENT',
                'strategy to accomplish the goal below. Think about alternative libraries,',
                'different algorithms, a different file structure, or a different sequence of',
                'steps. Do NOT repeat the approach that already failed.',
                '',
                `GOAL: ${context.goal}`,
                '',
                `RECENT FAILURE: ${originalError.slice(0, 500)}`,
                '',
                'Return ONLY a concise, actionable new approach (2-4 bullet points).',
              ].join('\n');
              suggestion = (await callLLM(prompt, { temperature: 0.8, maxTokens: 400 })).trim();
            } catch {
              suggestion = '';
            }

            const altContext = suggestion
              ? {
                  ...context,
                  goal: `${context.goal}\n\n[ALTERNATIVE APPROACH REQUIRED]\nThe previous attempts failed with: ${originalError.slice(0, 500)}\n\nTry this fundamentally different approach instead:\n${suggestion}`,
                }
              : {
                  ...context,
                  goal: `${context.goal}\n\n[ALTERNATIVE APPROACH REQUIRED]\nThe previous attempts failed with: ${originalError.slice(0, 500)}\n\nDo not repeat the previous approach. Think of a completely different way to accomplish the goal and execute it.`,
                };
            result = await executeFn(altContext, callLLM);
            break;
          }

          case 'shrink-scope': {
            // WEAK-MODEL CLOSE-THE-LOOP: the model cannot hold the whole task,
            // so ask for the smallest single unit instead of repeating the full
            // ask. `context.metadata.expectedFiles` (set by the orchestrator
            // from the task's declared artifacts) names the FIRST file to
            // produce, so the narrowed ask is concrete rather than a vague
            // "do less" — and never invents a file the task did not declare.
            if (this.options.verbose) {
              logger.info(`   ✂️ Repair attempt ${attemptNumber}: reducing scope to the smallest single unit`);
            }
            context = { ...context, goal: shrinkScopeGoal(context) };
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

/**
 * Build the NARROWED goal for a `shrink-scope` attempt (weak-model path).
 *
 * The whole point is to make the ask fit the model: one unit, explicitly, with
 * permission to stop. It names the FIRST declared artifact when the caller
 * supplied one and otherwise says "one file (or one function)" — it never
 * invents a filename, and it never asks for a summary instead of the work.
 */
export function shrinkScopeGoal(context: AgentContext): string {
  const declared = (context.metadata?.expectedFiles as unknown) as string[] | undefined;
  const first = Array.isArray(declared)
    ? declared.find((f) => typeof f === 'string' && f.trim().length > 0)
    : undefined;
  return [
    context.goal,
    '',
    '[SCOPE REDUCTION — WEAK MODEL]',
    'This task is larger than the model in use can hold reliably, so deliver only the',
    'SMALLEST single unit you can complete CORRECTLY, then stop:',
    first ? `  • produce exactly this file: ${first}` : '  • one file (or one function) only',
    'Write it to disk, then stop. Do NOT attempt the remaining files or steps — a later',
    'step continues from here. One correct unit is worth more than partial work on many.',
  ].join('\n');
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
