/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Single-shot mode:
 *   nuvira execute "add JWT authentication to the Express app"
 *   nuvira execute "create a CLI tool" --provider gemini --dry-run
 *   nuvira execute "add tests" --verbose --memory
 *   nuvira execute "fix bug" --memory --memory-stats
 *   nuvira execute "run tests" --sandbox
 *
 * Interactive development mode (no goal argument):
 *   nuvira execute
 *     → Model picker (if no --model flag)
 *     → Interactive loop: goal → orchestrator → results → next goal
 *     → Type /exit to quit
 */

import { createInterface } from 'node:readline';
import { resolveNuviraHome } from '../config/paths';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { Command } from 'commander';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderType } from '../config/types.js';
import type { InferenceProvider } from '../inference/interface.js';
import { resolveDefaultModel } from '../inference/default-model-resolver.js';
import { runPipelineTool, type PipelineToolResult } from '../tools/pipeline-tool.js';
import { applyActiveModel } from './model.js';
import { showModelPicker } from './model-picker.js';
import { resolveProvider } from './router.js';
import { isAutoModel } from '../learning/auto-router.js';
import { startWarmupDaemon } from '../learning/model-warmup.js';
import { parseRequestSync } from '../nlu/parser.js';
import { resolveEngine, readEngineModeConfig } from '../learning/engine-router.js';
import { runLoopExecutor } from './loop-executor.js';
import { resolveDispatch } from '../nlu/actions.js';
import { isConversationalQuestion } from '../nlu/conversation-gate.js';
import { contractFromParsed, renderContractCard } from '../nlu/contract.js';
import { maybeAutoRecall, recallCard, recallContextBlock, recallPolicy } from '../context/session-recall.js';
import { toFollowupSuggestions } from '../tools/registry.js';
import { stripToolCallArtifacts, stripReasoningLeak, ANSWER_QUALITY_FAILURE_LINE } from '../inference/tool-call-utils.js';
import { maybeRunBackgroundDuties } from './duties.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import { sweepTransientFailures, sessionRevivalStore } from '../learning/provider-revival.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { listCheckpoints } from '../agents/checkpoint-store.js';
import { logger, setSilent } from '../utils/logger.js';
import { PipelineBoard, PipelineEventStream } from './pipeline-board.js';
import {
  formatBatchReport,
  getUnattendedJob,
  jobPercent,
  UnattendedRunner,
} from '../learning/unattended-job.js';
import {
  measureUnattendedProgress,
  scheduleFromPendingWork,
} from '../learning/unattended-progress.js';
import { costSince } from '../learning/cost-tracker.js';

/**
 * Enterprise G11 — how many continuation batches one CLI run may execute.
 *
 * Deliberately far above the runner's default: the whole point of the CLI
 * autopilot is that "write a 100-page book" finishes in ONE command instead of
 * ten. The run is still bounded — by the stall cap (3 no-progress batches), the
 * consecutive-failure cap (6) and the job's 10-hour deadline — so this number
 * is a runaway guard, not the working limit.
 */
const MAX_UNATTENDED_BATCHES_CLI = 200;

/**
 * The pipeline's result, read through the SHARED wrapper's contract instead of
 * by importing the engine's own module.
 *
 * This command used to import `OrchestrationResult` straight from
 * `agents/orchestrator.ts`. That is how a bypass starts — a surface that names
 * the engine's internals is already coupled to the engine — and the architecture
 * ratchet read it exactly that way, which is why `cli/execute.ts` was the ONE
 * entry on `SURFACE_DEBT['pipeline-wrapper-bypass']`. Now the command drives the
 * pipeline through `runPipelineTool`, so the wrapper's public shape is what it
 * speaks, and the import graph agrees with the behaviour.
 */
type OrchestrationResult = NonNullable<PipelineToolResult['result']>;

// ─── Shared Options Type ────────────────────────────────────────────────────

/** Options shared between single-shot and interactive execution */
interface ExecuteOptions {
  provider?: string;
  model?: string;
  plannerModel?: string;
  gathererModel?: string;
  writerModel?: string;
  reviewerModel?: string;
  dryRun?: boolean;
  verbose?: boolean;
  memory?: boolean;
  memoryStats?: boolean;
  memoryClear?: boolean;
  contextLimit?: number;
  contextPrune?: string;
  review?: boolean;
  sandbox?: boolean;
  skipTests?: boolean;
  autoBranch?: boolean;
  maxRepairs?: number;
  repairMode?: string;
  repairFallbackModels?: string;
  autoRoute?: boolean;
  /** Save a checkpoint after every task batch (resume-able pipeline) */
  checkpoint?: boolean;
  /**
   * Resume a previous run of this ask in this directory. `true` (bare flag) =
   * auto id for goal + cwd; a string = explicit id.
   *
   * WS5 (#27) — it resumes BOTH granularities, because they are the same run: the
   * pipeline arm skips completed TASKS (`agents/checkpoint-store.ts`) and the loop
   * arm replays recorded MODEL CALLS whose input is unchanged
   * (`learning/step-checkpoint.ts`). Both resolve their id through
   * `checkpointIdFor(goal, cwd)`, so the flag cannot mean two different runs.
   */
  resume?: string | boolean;
  /**
   * WS5 (#27) — run the goal in its own git worktree of the project and report
   * the diff against the base commit. REFUSES (a failed run, never an unisolated
   * one) when the directory cannot be isolated.
   */
  worktree?: boolean;
  /** WS5 (#27) — keep the isolated worktree after the run instead of removing it. */
  keepWorktree?: boolean;
  /** List saved checkpoints and exit */
  checkpointList?: boolean;
  /**
   * Emit machine-readable NDJSON pipeline events on stdout instead of the
   * human board (one line per pipeline event + a final `result` line).
   * For CI, scripts, and external consumers like the VS Code panel.
   */
  jsonEvents?: boolean;
  /** Use tool-calling agents for writer/reviewer steps */
  toolCalling?: boolean;
  /**
   * Engine dispatch (assessment Addendum v4 Phase 1.1): 'auto' (default)
   * resolves loop-vs-pipeline from the routed provider tier via
   * resolveEngine(); 'loop' forces the single agentic loop (runToolLoop);
   * 'pipeline' forces the orchestrator (CI/publish semantics). The DEFAULT
   * stays 'pipeline' for explicit loop/pipeline and resolves to the
   * orchestrator under auto until Phase 0 eval numbers justify the flip —
   * both paths stay live (v4 risk table: "don't big-bang delete").
   */
  engine?: 'auto' | 'loop' | 'pipeline';
  /**
   * Plan-mode demotion (assessment Addendum v4 Phase 1.6): 'light' (default)
   * runs the loop/pipeline as-is; 'heavy' forces the reasoner→planner
   * front-matter (opt-in for large greenfield builds via the build tool).
   */
  planMode?: 'light' | 'heavy';
}

// ─── Session Types ──────────────────────────────────────────────────────────

/** A single goal execution entry in the session history */
export interface SessionEntry {
  goal: string;
  success: boolean;
  summary: string;
  timestamp: number;
}

/** Context passed to dev-mode commands that need it */
interface DevCommandContext {
  activeModel: string;
  activeProvider: string | undefined;
  sessionHistory: SessionEntry[];
  configManager: ConfigManager;
  lastFailedGoal?: RetryGoalData | null;
}

/** Result of handling a dev-mode slash command */
interface DevCommandResult {
  exit: boolean;
  newModel?: boolean;
  /** When set, the interactive loop should restore this session state */
  restore?: { provider: string; model: string; history: SessionEntry[] };
  /** When set, the interactive loop should retry this goal with failure context */
  fixGoal?: RetryGoalData;
}

/** Result of a single goal execution */
interface SingleGoalResult {
  success: boolean;
  /** The full orchestration result, available when execution completes */
  orchestrationResult?: OrchestrationResult;
  /**
   * R1 — the backend that actually SERVED this run: the provider and model the
   * turn was answered with, and the tool transport it travelled on
   * (`native` / `json` / `none`).
   *
   * Reported to the CALLER rather than kept inside the run, which is the whole
   * difference between "the engine knows" and "the surface records it". Before
   * this, `nuvira execute` returned only `{ success }`, so the one fact a
   * post-mortem needs — which model produced this output — existed during the
   * turn and was dropped at the boundary. Both engine arms report it: the loop
   * arm from `runLoopExecutor`, the pipeline arm from the wrapper it drives.
   */
  provider?: string;
  model?: string;
  transport?: 'native' | 'json' | 'none';
  /** Tool names the run executed, in order — the run's own report of what it did. */
  toolCalls?: string[];
  /**
   * Per-call tool outcomes, in call order, as `{ tool, ok }` — with `ok` ABSENT
   * for a call whose outcome the surface could not observe (never guessed).
   *
   * The command's `toolCalls` names alone could not say WHICH call failed (a
   * separate errored set is ambiguous once a tool runs twice), which is why
   * `tool-call-lifecycle@cli-execute` could not be proven. Both paths report it
   * now: the loop arm from the loop's own `tool`/`refusal` events, and the
   * direct-answer path from the chat engine's `onToolCall` seam.
   */
  toolOutcomes?: Array<{ tool: string; ok?: boolean }>;
  /**
   * WS5 (#27) — the isolation this run had, and the diff against its base.
   *
   * Both engine arms report it: the loop arm from `runLoopExecutor`, the
   * direct-answer arm from the shared chat engine. Absent when no isolation was
   * asked for, and the refusal text is the run's content when one could not be
   * made — the command reports that as a FAILURE, never as an answer.
   */
  worktree?: import('../tools/worktree.js').IsolationOutcome;
  /** WS5 (#27) — what this run's resume replayed, and what it saved. */
  resume?: import('../learning/step-checkpoint.js').ResumeOutcome;
  /**
   * WS1 — every finding this run recorded, in call order, with the verdict the
   * gate computed from the evidence the model supplied.
   *
   * Both arms report it: the loop arm from the loop's own `finding:recorded`
   * event, the direct-answer arm from the chat engine's `onFinding` seam. The
   * command returns the verdicts rather than leaving them where only the model
   * thread can see them — the difference between "the tool recorded it" and
   * "this surface reports it".
   */
  findings?: import('../findings/verdicts.js').WireFinding[];
  /**
   * The answer this run produced. Returned as DATA, not only printed, so a
   * caller (and the parity harness) can read the turn the surface reports
   * rather than scrape a console.
   */
  content?: string;
}

/** A suggested follow-up action after goal execution */
interface FollowUpSuggestion {
  label: string;
  description: string;
  /** The goal text to pre-fill if the user selects this suggestion */
  goal: string;
}

/** Tracks the last failed goal for retry/fix */
interface RetryGoalData {
  goal: string;
  orchestrationResult: OrchestrationResult;
}

/**
 * Map the CLI's `--checkpoint` / `--resume [id]` flags onto the orchestrator's
 * checkpoint options. Bare `--resume` (value `true`) means "resume the auto id
 * for this goal + cwd" → resumeCheckpointId undefined, resumeRequested true.
 * `--checkpoint` alone saves forward without resuming. Extracted as a pure
 * exported helper so the mapping is unit-testable without a full orchestration.
 */
export function checkpointOptions(
  checkpoint: boolean | undefined,
  resume: string | boolean | undefined,
): {
  checkpoint: boolean;
  resumeCheckpointId: string | undefined;
  resumeRequested: boolean;
} {
  return {
    checkpoint: checkpoint === true || !!resume,
    resumeCheckpointId: resume === true ? undefined : resume || undefined,
    resumeRequested: !!resume,
  };
}

/** A parsed action result from the post-execution prompt */
interface PostExecutionAction {
  type: 'continue' | 'switch-model' | 'history' | 'exit' | 'retry-fix' | 'followup';
  goal?: string;
}

// ─── Pure Helpers ───────────────────────────────────────────────────────────

/**
 * Parse multi-line goal input into a single goal string.
 *
 * Used by readGoal() which collects lines from readline; extracted as a
 * pure function so it can be unit-tested without mocking stdin/stdout.
 *
 * @param lines       Lines collected from user input
 * @returns           The joined goal string (blank lines collapsed)
 */
export function parseGoalLines(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n');
}

// ─── ExecuteCommand ─────────────────────────────────────────────────────────

/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export class ExecuteCommand extends BaseCommand {
  /**
   * Per-run failure session for the execute-side direct LLM calls that bypass
   * the orchestrator (generateFollowUpSuggestions). A dead provider×model
   * here is written through the FULL shared bookkeeping so the next pick skips
   * it predictively (mirror of the orchestrator's own per-task session).
   */
  private readonly failureSession: FailureSessionState = {
    sessionFailedProviders: new Map(),
    sessionTransientFailedProviders: new Set(),
  };

  create(): Command {
    const command = new Command('execute')
      .description('Run a multi-agent pipeline to accomplish a goal')
      .argument('[goal]', 'The goal to accomplish (omit for interactive development mode)')
      .option('-p, --provider <provider>', 'Inference provider for all agents')
      .option('-m, --model <model>', 'Model override for all agents')
      .option('--planner-model <model>', 'Model for the Planner agent')
      .option('--gatherer-model <model>', 'Model for the Context Gatherer agent')
      .option('--writer-model <model>', 'Model for the Writer agent')
      .option('--reviewer-model <model>', 'Model for the Reviewer agent')
      .option('--dry-run', 'Preview changes without writing to disk', false)
      .option('-v, --verbose', 'Show detailed agent output', false)
      .option('--memory', 'Enable persistent memory (learn from past sessions)', false)
      .option('--memory-stats', 'Show memory statistics and exit', false)
      .option('--memory-clear', 'Clear all stored memory trajectories', false)
      .option('--context-limit <tokens>', 'Max context tokens before pruning (default: 128000). Set higher for Gemini (1000000)', parseInt)
      .option('--context-prune <mode>', 'Pruning aggressiveness: soft | medium | aggressive (default: soft)')
      .option('--review', 'Create a review bundle capturing proposed changes (view with `nuvira team review show <id>`)', false)
      .option('--sandbox', 'Execute runner commands and tests inside a Docker sandbox', false)
      .option('--skip-tests', 'Skip tester and debugger steps (code generation only)', false)
      .option('--auto-branch', 'Enable branch automation hooks (install, commit, PR update, file watch)', false)
      .option('--max-repairs <number>', 'Max auto-repair attempts per failed task (default: 3, 0 = disabled)', parseInt)
      .option('--repair-mode <mode>', 'Repair mode: auto | prompt | off (default: auto)')
      .option('--repair-fallback-models <models>', 'Comma-separated fallback models for repair (e.g., groq/llama3,nim/mistral)')
      .option('--auto-route', 'Route each agent to the best provider/model automatically (Auto model)', false)
      .option('--tool-calling', 'Use iterative tool-calling agents for writer/reviewer (read→edit→verify loop). On by default — kept for explicit/back-compat use')
      .option('--no-tool-calling', 'Disable the tool-calling writer/reviewer — the one-shot writer must emit complete files without ever reading them')
      .option('--engine <mode>', 'Execution engine: auto | loop | pipeline (default: auto — loop for strong models, pipeline for local/weak tier)')
      .option('--plan-mode <mode>', 'Planning depth: light | heavy (default: light — heavy forces the reasoner→planner front-matter for large greenfield builds)')
      .option('--checkpoint', 'Save a resume-able checkpoint after every task batch (in ~/.nuvira/memory/checkpoints/)', false)
      // NO `false` DEFAULT here (or on the two below), and that is the point: a
      // `false` commander invented for an untyped flag is an explicit DECLINE, and
      // an explicit decline outranks the environment — which would make
      // `NUVIRA_ISOLATE=1` / `NUVIRA_RESUME=1` dead letters on `nuvira execute`,
      // the one arm the harness cannot reach through the flags. Absent stays
      // `undefined`: "the operator did not ask", so the environment can.
      .option('--resume [id]', 'Resume the last run of this goal in this directory (defaults to its auto id). Completed tasks are skipped on the pipeline engine, and recorded model calls whose input is unchanged are replayed on the loop engine')
      // WS5 (#27) — isolation. Read from the environment too (`NUVIRA_ISOLATE`),
      // which is how a surface with no command line asks for it.
      .option('--worktree', 'Run the goal in its own git worktree of the project and report the diff against the base commit. Refuses rather than running unisolated when the directory cannot be isolated (also asked for by NUVIRA_ISOLATE=1)')
      .option('--keep-worktree', 'Keep the isolated worktree after the run instead of removing it')
      .option('--checkpoint-list', 'List saved checkpoints and exit', false)
      .option('--json-events', 'Emit machine-readable NDJSON pipeline events on stdout (no human board)', false)
      .action(async (goal: string | undefined, options?: {
        provider?: string;
        model?: string;
        plannerModel?: string;
        gathererModel?: string;
        writerModel?: string;
        reviewerModel?: string;
        dryRun?: boolean;
        verbose?: boolean;
        memory?: boolean;
        memoryStats?: boolean;
        memoryClear?: boolean;
        contextLimit?: number;contextPrune?: string;
      review?: boolean;
      sandbox?: boolean;
      skipTests?: boolean;
      maxRepairs?: number;
      repairMode?: string;
      repairFallbackModels?: string;
        autoRoute?: boolean;
        checkpoint?: boolean;
        resume?: string | boolean;
        worktree?: boolean;
        keepWorktree?: boolean;
        checkpointList?: boolean;
        jsonEvents?: boolean;
        engine?: string;
        planMode?: string;
      }) => {
        // commander passes raw strings; the union narrowing happens in
        // runSingleGoal's dispatch (an unknown value degrades to 'auto' via
        // resolveEngine's config path — never throws).
        const { engine, planMode, ...rest } = options || {};
        await this.execute(goal, {
          ...rest,
          ...(engine ? { engine: engine as 'auto' | 'loop' | 'pipeline' } : {}),
          ...(planMode ? { planMode: planMode as 'light' | 'heavy' } : {}),
        });
      });

    return command;
  }

  private async execute(
    goal: string | undefined,
    options: ExecuteOptions,
  ): Promise<void> {
    // ── Handle memory management commands ─────────────────────────────────
    if (options.memoryStats) {
      await this.showMemoryStats();
      return;
    }

    if (options.memoryClear) {
      await this.clearMemory();
      return;
    }

    // ── List saved checkpoints ───────────────────────────────────────────
    if (options.checkpointList) {
      this.showCheckpointList();
      return;
    }

    // ── Apply active model from `nuvira model switch` as defaults ────────────
    const activeOpts = applyActiveModel({ provider: options.provider, model: options.model });
    let mergedProvider = activeOpts.provider;
    let mergedModel = activeOpts.model;

    // ── If no goal provided, enter interactive development mode ────────────
    if (!goal) {
      await this.runInteractiveDevMode(mergedProvider, mergedModel, options);
      return;
    }

    if (options.skipTests) {
      logger.info('   🧪 Tests skipped (--skip-tests flag set)');
    }

    // ── Single-shot execution (goal was provided on command line) ──────────
    // The run prints the orchestration report (including any suggested
    // follow-up actions). On a real terminal the session does NOT dead-end
    // there: the same "What next?" menu interactive dev mode shows appears
    // after the result, so a picked followup runs as the next goal (or the
    // user enters another goal / exits). Non-TTY (scripts/CI/pipes) keeps the
    // current run-and-exit behavior so automation is never blocked by a
    // prompt.
    let singleResult = await this.runSingleGoal(goal, mergedProvider, mergedModel, options);
    if (!process.stdin.isTTY) return;

    const sigintHandler = () => {
      console.log('\n');
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    const singleHistory: SessionEntry[] = [];
    let singleLastFailed: RetryGoalData | null = null;
    let singleGoal = goal;

    // Continuation loop — mirrors the interactive dev-mode post-execution
    // flow (menu → dispatch → next goal) so a single-shot run on a terminal
    // offers its followups as selectable next steps instead of quitting.
    while (true) {
      // The menu (follow-ups after a success, failure analysis + recovery
      // after a failure) appears after EVERY run, including the first.
      const { action: nextAction, updatedLastFailed } = await this.handlePostExecution(
        singleGoal,
        singleResult,
        singleHistory,
        singleLastFailed,
        mergedProvider,
        mergedModel,
        options,
      );
      singleLastFailed = updatedLastFailed;

      if (nextAction.type === 'exit') break;

      if (nextAction.type === 'switch-model') {
        const picked = await showModelPicker(this.configManager);
        if (picked) {
          if (picked.provider === 'auto' || isAutoModel(picked.model)) {
            mergedProvider = 'auto';
            mergedModel = 'auto';
          } else {
            if (picked.provider !== mergedProvider) {
              const resolved = resolveProvider(this.configManager, picked.provider);
              mergedProvider = resolved.type;
            }
            mergedModel = picked.model;
          }
          logger.success(`✅ Switched to ${mergedModel}\n`);
        }
      } else if (nextAction.type === 'history') {
        this.showSessionHistory(singleHistory);
      } else if (nextAction.type === 'retry-fix' && singleLastFailed) {
        logger.highlight('═'.repeat(60));
        logger.highlight('  🔧  Auto-fixing Last Failed Goal');
        logger.highlight('═'.repeat(60));
        console.log(`\n  Goal: ${singleLastFailed.goal}\n`);
        const fixResult = await this.runSingleGoal(singleLastFailed.goal, mergedProvider, mergedModel, { ...options, verbose: true });
        singleLastFailed = (await this.handlePostExecution(
          singleLastFailed.goal,
          fixResult,
          singleHistory,
          singleLastFailed,
          mergedProvider,
          mergedModel,
          options,
        )).updatedLastFailed;
      }

      // A picked followup runs immediately (auto-continue, like interactive
      // dev mode); everything else falls through to the next-goal prompt.
      let nextGoalText: string | undefined;
      if (nextAction.type === 'followup' && nextAction.goal) {
        logger.highlight('═'.repeat(60));
        logger.highlight('  💡  Executing Follow-up Goal');
        logger.highlight('═'.repeat(60));
        console.log(`\n  ${nextAction.goal}\n`);
        nextGoalText = nextAction.goal;
      }

      const nextGoal = nextGoalText ?? (await this.readGoal());
      if (!nextGoal) continue;
      if (nextGoal.startsWith('/')) {
        if (nextGoal === '/exit' || nextGoal === '/quit') break;
        continue;
      }

      singleGoal = nextGoal;
      singleResult = await this.runSingleGoal(singleGoal, mergedProvider, mergedModel, options);
      if (!singleResult.success && singleResult.orchestrationResult) {
        singleLastFailed = { goal: singleGoal, orchestrationResult: singleResult.orchestrationResult };
      } else if (singleResult.success) {
        singleLastFailed = null;
      }
    }

    process.off('SIGINT', sigintHandler);
    logger.success('\nDone. Happy coding! 🚀\n');
  }

  // ─── Interactive Development Mode ─────────────────────────────────────────

  /**
   * Interactive development mode — model picker → goal prompt → orchestrator → loop until exit.
   */
  private async runInteractiveDevMode(
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<void> {
    // ── Pick a model if not already specified ──────────────────────────────
    let activeProvider = provider;
    let activeModel = model;

    if (!activeModel) {
      logger.highlight('\n🎯  Welcome to Development Mode!');
      logger.info("   First, let's pick a model to work with.\n");

      const picked = await showModelPicker(this.configManager);
      if (!picked) {
        logger.info('\nNo model selected. Exiting development mode.\n');
        return;
      }

      if (picked.provider === 'auto' || isAutoModel(picked.model)) {
        // Auto picked — keep the auto provider so the orchestrator routes
        // per task instead of resolveProvider('auto') falling back silently.
        activeProvider = 'auto';
        activeModel = 'auto';
      } else {
        if (picked.provider !== activeProvider) {
          const resolved = resolveProvider(this.configManager, picked.provider);
          activeProvider = resolved.type;
        }
        activeModel = picked.model;
      }
    }

    // ── SIGINT handler for graceful exit ───────────────────────────────────
    const sigintHandler = () => {
      console.log('\n');
      process.exit(0);
    };
    process.on('SIGINT', sigintHandler);

    // ── Welcome banner ────────────────────────────────────────────────────
    console.log('');
    logger.highlight('═'.repeat(60));
    logger.highlight('  🚀  Development Mode');
    logger.highlight('═'.repeat(60));
    console.log(`\n  Model: ${activeModel}`);
    console.log('');
    logger.info('  Enter a goal for the AI to accomplish (or type /exit to quit).');
    logger.info('  Each goal runs the full multi-agent pipeline: Plan → Gather → Write → Review → Test.');
    console.log('');

    // ── Session tracking ──────────────────────────────────────────────────
    const sessionHistory: SessionEntry[] = [];
    let lastFailedGoal: RetryGoalData | null = null;

    // ── Interactive loop ───────────────────────────────────────────────────
    while (true) {
      const goal = await this.readGoal();
      if (!goal) continue;

      if (goal.startsWith('/')) {
        const handled = await this.handleDevCommand(goal, {
          activeModel,
          activeProvider,
          sessionHistory,
          configManager: this.configManager,
          lastFailedGoal,
        });
        if (handled.exit) break;
        if (handled.newModel) {
          const picked = await showModelPicker(this.configManager);
          if (picked) {
            if (picked.provider === 'auto' || isAutoModel(picked.model)) {
              activeProvider = 'auto';
              activeModel = 'auto';
            } else {
              if (picked.provider !== activeProvider) {
                const resolved = resolveProvider(this.configManager, picked.provider);
                activeProvider = resolved.type;
              }
              activeModel = picked.model;
            }
            logger.success(`\n✅ Switched to ${activeModel}`);
            console.log('');
          }
        }
        if (handled.restore) {
          activeProvider = handled.restore.provider;
          activeModel = handled.restore.model;
          // Add restored history into the current session
          for (const entry of handled.restore.history) {
            sessionHistory.push(entry);
          }
          logger.success(`\n✅ Restored ${handled.restore.history.length} goal(s) from session`);
          console.log('');
        }
        if (handled.fixGoal) {
          // /fix: retry the last failed goal with failure context
          logger.highlight('═'.repeat(60));
          logger.highlight('  🔧  Retrying Last Failed Goal');
          logger.highlight('═'.repeat(60));
          console.log(`\n  Goal: ${handled.fixGoal.goal}`);
          console.log(`  Applying failure context to guide the repair...`);
          console.log('');

          const fixResult = await this.runSingleGoal(
            handled.fixGoal.goal,
            activeProvider,
            activeModel,
            { ...options, verbose: true },
          );
          // Process the fix result through the shared post-execution handler
          // (same as retry-fix does) so the user sees failure analysis / follow-ups
          const fixPostExec = await this.handlePostExecution(
            handled.fixGoal.goal,
            fixResult,
            sessionHistory,
            lastFailedGoal,
            activeProvider,
            activeModel,
            options,
          );
          lastFailedGoal = fixPostExec.updatedLastFailed;
          continue;
        }
        continue;
      }

      const result = await this.runSingleGoal(goal, activeProvider, activeModel, options);

      // ── Process the result through the shared post-execution handler ──
      const { action: nextAction, updatedLastFailed } = await this.handlePostExecution(
        goal,
        result,
        sessionHistory,
        lastFailedGoal,
        activeProvider,
        activeModel,
        options,
      );
      lastFailedGoal = updatedLastFailed;

      // ── Dispatch the chosen action ────────────────────────────────────
      if (nextAction.type === 'exit') {
        break;
      } else if (nextAction.type === 'switch-model') {
        const picked = await showModelPicker(this.configManager);
        if (picked) {
          if (picked.provider === 'auto' || isAutoModel(picked.model)) {
            activeProvider = 'auto';
            activeModel = 'auto';
          } else {
            if (picked.provider !== activeProvider) {
              const resolved = resolveProvider(this.configManager, picked.provider);
              activeProvider = resolved.type;
            }
            activeModel = picked.model;
          }
          logger.success(`✅ Switched to ${activeModel}\n`);
        }
      } else if (nextAction.type === 'history') {
        this.showSessionHistory(sessionHistory);
      } else if (nextAction.type === 'retry-fix' && lastFailedGoal) {
        // Auto-fix: retry the last failed goal with failure context
        logger.highlight('═'.repeat(60));
        logger.highlight('  🔧  Auto-fixing Last Failed Goal');
        logger.highlight('═'.repeat(60));
        console.log(`\n  Goal: ${lastFailedGoal.goal}`);
        console.log(`  Applying failure context to guide the repair...`);
        console.log('');

        const fixResult = await this.runSingleGoal(
          lastFailedGoal.goal,
          activeProvider,
          activeModel,
          { ...options, verbose: true },
        );
        // Process the fix result through the post-execution handler too
        const fixPostExec = await this.handlePostExecution(
          lastFailedGoal.goal,
          fixResult,
          sessionHistory,
          lastFailedGoal,
          activeProvider,
          activeModel,
          options,
        );
        lastFailedGoal = fixPostExec.updatedLastFailed;
      } else if (nextAction.type === 'followup') {
        // Execute a follow-up suggestion immediately
        logger.highlight('═'.repeat(60));
        logger.highlight('  💡  Executing Follow-up Goal');
        logger.highlight('═'.repeat(60));
        console.log(`\n  ${nextAction.goal}\n`);

        const followupGoal = nextAction.goal!;
        const followupResult = await this.runSingleGoal(
          followupGoal,
          activeProvider,
          activeModel,
          options,
        );

        // Track in session history (skip the "What next?" prompt — the user
        // already chose the followup, so auto-continue to the main goal loop)
        sessionHistory.push({
          goal: followupGoal,
          success: followupResult.success,
          summary: followupResult.success
            ? `Follow-up completed: ${followupGoal.slice(0, 80)}`
            : `Follow-up failed: ${followupGoal.slice(0, 80)}`,
          timestamp: Date.now(),
        });

        // Update lastFailedGoal tracking
        if (!followupResult.success && followupResult.orchestrationResult) {
          lastFailedGoal = {
            goal: followupGoal,
            orchestrationResult: followupResult.orchestrationResult,
          };
        } else if (followupResult.success) {
          lastFailedGoal = null;
        }

        // Auto-continue to the main goal prompt
        // (runSingleGoal already prints the orchestration result)
        logger.success('\n💡  Follow-up complete. Enter your next goal below.\n');
      }
    }

    // Cleanup
    process.off('SIGINT', sigintHandler);
    logger.success('\nDevelopment mode ended. Happy coding! 🚀\n');
    process.exit(0);
  }

  /**
   * Display the session goal history.
   */
  private showSessionHistory(history: SessionEntry[]): void {
    if (history.length === 0) {
      logger.info('No goals have been executed yet in this session.');
      return;
    }

    logger.highlight('═'.repeat(60));
    logger.highlight('  📜  Session History');
    logger.highlight('═'.repeat(60));
    console.log('');

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const icon = entry.success ? '✅' : '❌';
      const date = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`  ${i + 1}. ${icon} [${date}] ${entry.goal.slice(0, 100)}`);
    }
    console.log('');
  }

  // ─── Goal Input ───────────────────────────────────────────────────────────

  /**
   * Prompt the user for a goal using readline (supports multi-line input).
   * Delegates to parseGoalLines() for the actual line-joining logic.
   */
  private readGoal(): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '🎯  Goal > ',
        terminal: true,
      });

      const lines: string[] = [];
      let isFirstLine = true;

      // Handle SIGINT during input
      rl.on('SIGINT', () => {
        console.log('');
        lines.push('/exit');
        rl.close();
      });

      rl.on('line', (line) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line === '') {
            rl.prompt();
            isFirstLine = true;
            return;
          }
          lines.push(line);
          if (line.startsWith('/')) {
            rl.close();
            return;
          }
          rl.setPrompt('  ...  > ');
          rl.prompt();
        } else {
          if (line === '') {
            rl.close();
          } else {
            lines.push(line);
            rl.prompt();
          }
        }
      });

      rl.on('close', () => {
        resolve(parseGoalLines(lines));
      });

      rl.prompt();
    });
  }

  // ─── Dev Commands ─────────────────────────────────────────────────────────

  /**
   * Handle slash-commands in development mode.
   */
  private async handleDevCommand(
    cmd: string,
    context?: DevCommandContext,
  ): Promise<DevCommandResult> {
    const lower = cmd.toLowerCase().trim();
    const spaceIdx = lower.indexOf(' ');
    const baseCmd = spaceIdx > 0 ? lower.slice(0, spaceIdx) : lower;
    const arg = spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : '';

    switch (baseCmd) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return { exit: true };

      case '/help': {
        const lines = [
          'Commands:',
          '  /exit, /quit           Exit development mode',
          '  /model                 Switch to a different model',
          '  /fix                   Retry the last failed goal with failure context',
          '  /suggest [query]       Show similar past goals from memory',
          '  /save <name>           Save current session for later resumption',
          '  /resume <name>         Resume a saved session',
          '  /history               Show goals executed in this session',
          '  /help                  Show this help',
          '',
          'Enter any goal to run the AI pipeline.',
          'Type on multiple lines, end with an empty line.',
        ];
        console.log('');
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        console.log('');
        return { exit: false };
      }

      case '/model':
        return { exit: false, newModel: true };

      case '/history': {
        if (context?.sessionHistory) {
          this.showSessionHistory(context.sessionHistory);
        } else {
          logger.info('No session history available.');
        }
        return { exit: false };
      }

      case '/fix': {
        if (context?.lastFailedGoal) {
          logger.highlight('═'.repeat(60));
          logger.highlight('  🔧  Retrying Last Failed Goal');
          logger.highlight('═'.repeat(60));
          console.log(`\n  Goal: ${context.lastFailedGoal.goal}`);
          console.log(`  Failure: ${context.lastFailedGoal.orchestrationResult.error || 'Unknown error'}`);
          console.log('');
          logger.info('  Retrying with failure context to guide the repair...');
          console.log('');
          return { exit: false, fixGoal: context.lastFailedGoal };
        } else {
          logger.info('No failed goal to fix. Run a goal that fails first.');
          return { exit: false };
        }
      }

      case '/suggest': {
        await this.handleSuggest(arg, context);
        return { exit: false };
      }

      case '/save': {
        await this.handleSave(arg, context);
        return { exit: false };
      }

      case '/resume': {
        const loaded = await this.handleResume(arg);
        if (loaded) {
          logger.success(`\n✅ Resumed session: ${arg}`);
          console.log(`   Provider: ${loaded.provider}`);
          console.log(`   Model: ${loaded.model}`);
          console.log(`   Goals in session: ${loaded.history?.length || 0}`);
          console.log('');
          // Return restore data so the interactive loop can update its state
          return {
            exit: false,
            restore: {
              provider: loaded.provider || '',
              model: loaded.model || '',
              history: loaded.history || [],
            },
          };
        }
        return { exit: false };
      }

      default:
        logger.warn(`Unknown command: ${baseCmd}. Type /help`);
        return { exit: false };
    }
  }

  // ─── Session Save/Resume ──────────────────────────────────────────────────

  /**
   * Save the current development session to disk.
   */
  private async handleSave(name: string, context?: DevCommandContext): Promise<void> {
    if (!name) {
      logger.error('Usage: /save <session-name>');
      return;
    }

    if (!context) {
      logger.error('No session state to save.');
      return;
    }

    const sessionsDir = join(resolveNuviraHome(), 'sessions');
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) {
      logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
      return;
    }

    const sessionData = {
      name,
      provider: context.activeProvider,
      model: context.activeModel,
      history: context.sessionHistory,
      savedAt: Date.now(),
    };

    const filePath = join(sessionsDir, `${safeName}.json`);
    writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');

    logger.success(`Session saved as "${name}"`);
    logger.info(`  Path: ${filePath}`);
    logger.info(`  Goals: ${context.sessionHistory.length}`);
    logger.info(`  Model: ${context.activeModel}`);
    console.log('');
    logger.info('Run /resume <name> to restore this session later.');
    console.log('');
  }

  /**
   * Resume a saved development session.
   */
  private async handleResume(
    name: string,
  ): Promise<{ provider?: string; model?: string; history?: SessionEntry[] } | null> {
    if (!name) {
      logger.error('Usage: /resume <session-name>');
      return null;
    }

    const sessionsDir = join(resolveNuviraHome(), 'sessions');
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeName) {
      logger.error('Invalid session name. Use only letters, numbers, hyphens, and underscores.');
      return null;
    }
    const filePath = join(sessionsDir, `${safeName}.json`);

    if (!existsSync(filePath)) {
      logger.error(`Session "${name}" not found.`);
      logger.info(`  Available sessions in: ${sessionsDir}`);

      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
        if (files.length > 0) {
          console.log('');
          logger.info('  Available sessions:');
          for (const f of files) {
            console.log(`    • ${f.replace('.json', '')}`);
          }
          console.log('');
        }
      }

      return null;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);

      const date = new Date(data.savedAt).toLocaleString();
      logger.highlight('═'.repeat(60));
      logger.highlight(`  📂  Session: ${name}`);
      logger.highlight('═'.repeat(60));
      console.log(`\n  Saved: ${date}`);
      console.log(`  Provider: ${data.provider || 'default'}`);
      console.log(`  Model: ${data.model || 'default'}`);
      if (data.history && data.history.length > 0) {
        console.log(`  Goals (${data.history.length}):`);
        for (const h of data.history) {
          const icon = h.success ? '✅' : '❌';
          console.log(`    ${icon} ${h.goal.slice(0, 100)}`);
        }
      }
      console.log('');

      return {
        provider: data.provider,
        model: data.model,
        history: data.history,
      };
    } catch (err) {
      logger.error(`Failed to load session: ${err}`);
      return null;
    }
  }

  // ─── Goal Suggestions ─────────────────────────────────────────────────────

  /**
   * Show suggestions from past trajectories (auto-completion via /suggest).
   */
  private async handleSuggest(query: string, context?: DevCommandContext): Promise<void> {
    const searchQuery = query || context?.sessionHistory?.[context.sessionHistory.length - 1]?.goal;

    if (!searchQuery) {
      logger.info('Usage: /suggest <goal description>');
      logger.info('  Shows similar past goals from memory to inspire your next task.');
      console.log('');
      logger.info('Examples:');
      logger.info('  /suggest authentication');
      logger.info('  /suggest add database');
      return;
    }

    logger.highlight('🔍  Searching memory for similar past goals...');
    console.log('');

    try {
      const store = getTrajectoryStore();
      const allTrajectories = store.getAll();

      if (allTrajectories.length === 0) {
        logger.info('No past trajectories found in memory.');
        logger.info('  Run goals with --memory enabled to build up a trajectory history.');
        return;
      }

      const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

      const scored = allTrajectories
        .map((t) => {
          const goalLower = t.goal.toLowerCase();
          const matchCount = queryWords.filter((w) => goalLower.includes(w)).length;
          return { trajectory: t, score: matchCount / Math.max(1, queryWords.length) };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (scored.length === 0) {
        logger.info(`No past goals found matching "${searchQuery}".`);
        logger.info('  Try running goals with --memory to build up a trajectory history.');
        return;
      }

      logger.success(`Found ${scored.length} similar past goal(s):`);
      console.log('');

      for (let i = 0; i < scored.length; i++) {
        const { trajectory, score } = scored[i];
        const pct = Math.round(score * 100);
        const date = new Date(trajectory.timestamp).toLocaleDateString();
        console.log(`  ${i + 1}. [${pct}% match] ${trajectory.goal.slice(0, 120)}`);
        console.log(`     📁 ${trajectory.projectFingerprint || 'N/A'}  |  ${date}  |  ${trajectory.tasksCompleted}/${trajectory.tasksTotal} tasks`);
        console.log('');
      }
    } catch (err) {
      logger.error(`Failed to search memory: ${err}`);
    }
  }

  // ─── Post-Execution Handler ───────────────────────────────────────────────

  /**
   * Shared handler for post-execution tasks:
   * 1. Track the goal in session history
   * 2. Update lastFailedGoal tracking (returns the updated value since params are passed by value)
   * 3. Generate dynamic choices (analysis + follow-ups)
   * 4. Prompt the user
   * 5. Return the parsed action + updated lastFailedGoal
   *
   * Called after EVERY goal execution (main, follow-up, retry-fix)
   * so that the interactive UX is consistent.
   */
  private async handlePostExecution(
    goal: string,
    result: SingleGoalResult,
    sessionHistory: SessionEntry[],
    currentLastFailed: RetryGoalData | null,
    activeProvider: string | undefined,
    activeModel: string | undefined,
    options: ExecuteOptions,
  ): Promise<{ action: PostExecutionAction; updatedLastFailed: RetryGoalData | null }> {
    // ── Track in session history ───────────────────────────────────────
    sessionHistory.push({
      goal,
      success: result.success,
      summary: result.success ? `Completed: ${goal.slice(0, 80)}` : `Failed: ${goal.slice(0, 80)}`,
      timestamp: Date.now(),
    });

    // ── Update lastFailedGoal tracking (returned to caller) ────────────
    let updatedLastFailed = currentLastFailed;
    if (!result.success && result.orchestrationResult) {
      updatedLastFailed = {
        goal,
        orchestrationResult: result.orchestrationResult,
      };
    } else if (result.success) {
      updatedLastFailed = null;
    }

    // ── Generate dynamic post-execution choices and prompt ─────────────
    console.log('');
    const actions = await this.generatePostExecutionActions(
      result,
      activeProvider,
      activeModel,
      options,
    );

    const answer = await inquirer.prompt<{ action: string }>([
      {
        type: 'list',
        name: 'action',
        message: 'What next?',
        prefix: '🚀',
        choices: actions,
      },
    ]);
    console.log('');

    // ── Parse the answer into a structured action ──────────────────────
    let action: PostExecutionAction;

    if (answer.action === 'exit') {
      action = { type: 'exit' };
    } else if (answer.action === 'switch-model') {
      action = { type: 'switch-model' };
    } else if (answer.action === 'history') {
      action = { type: 'history' };
    } else if (answer.action === 'retry-fix') {
      action = { type: 'retry-fix' };
    } else if (answer.action.startsWith('followup:')) {
      action = {
        type: 'followup',
        goal: answer.action.slice('followup:'.length),
      };
    } else {
      // Default: continue (enter another goal)
      action = { type: 'continue' };
    }

    return { action, updatedLastFailed };
  }

  // ─── Dynamic Post-Execution Actions ───────────────────────────────────────

  /**
   * Generate context-aware choices for the post-execution prompt.
   *
   * After a SUCCESS: shows LLM-generated follow-up suggestions
   * After a FAILURE: shows failure analysis and specific recovery options
   * Always includes: enter another goal, switch model, history, exit
   */
  private async generatePostExecutionActions(
    result: SingleGoalResult,
    activeProvider: string | undefined,
    activeModel: string | undefined,
    _options: ExecuteOptions,
  ): Promise<Array<{ name: string; value: string }>> {
    const actions: Array<{ name: string; value: string }> = [];

    if (result.success && result.orchestrationResult) {
      // ── Success: Show follow-up suggestions ─────────────────────────
      const followups = await this.generateFollowUpSuggestions(
        result.orchestrationResult,
        activeProvider,
        activeModel,
      );

      if (followups.length > 0) {
        // Show top 3 follow-up suggestions
        const shown = followups.slice(0, 3);
        for (const f of shown) {
          const label = `💡  ${f.label}`;
          actions.push({ name: label, value: `followup:${f.goal}` });
        }
        actions.push({ name: '───────────', value: 'separator' });
      }

      actions.push({ name: '💬  Enter another goal', value: 'continue' });
    } else if (result.success) {
      // P0.5 — direct-answer success (a question was answered; no pipeline
      // ran, so there are no pipeline followups to generate). Just the
      // standard next-step actions.
      actions.push({ name: '💬  Enter another goal', value: 'continue' });
    } else {
      // ── Failure: Show analysis + recovery options ───────────────────
      if (result.orchestrationResult) {
        const analysis = this.analyzeFailure(result.orchestrationResult);
        this.showFailureAnalysis(analysis);

        // Add specific recovery actions based on failure analysis
        for (const recovery of analysis.recoveryActions) {
          actions.push({ name: recovery.label, value: recovery.action });
        }

        actions.push({ name: '───────────', value: 'separator' });
      } else {
        // Orchestration threw an exception — we have no agent-level detail
        logger.highlight('═'.repeat(60));
        logger.highlight('  ❌  Execution Failed');
        logger.highlight('═'.repeat(60));
        console.log('');
        logger.error('  The pipeline threw an unexpected error before producing results.');
        console.log('');
        logger.info('  💡  Try:');
        logger.info('     • Checking your provider/model configuration');
        logger.info('     • Rephrasing the goal more simply');
        logger.info('     • Running with --verbose to see more details');
        console.log('');
      }

      actions.push({ name: '📝  Enter a new goal', value: 'continue' });
    }

    // ── Standard actions (always available) ─────────────────────────────
    actions.push({ name: '🔄  Switch provider/model', value: 'switch-model' });
    actions.push({ name: '📜  Show session history', value: 'history' });
    actions.push({ name: '🚪  Exit development mode', value: 'exit' });

    return actions;
  }

  /**
   * LLM-powered follow-up suggestion generator.
   *
   * Uses the current provider to generate contextually relevant next steps
   * based on what was just accomplished. Falls back to rule-based suggestions
   * if the LLM call fails.
   */
  private async generateFollowUpSuggestions(
    result: OrchestrationResult,
    activeProvider: string | undefined,
    activeModel: string | undefined,
  ): Promise<FollowUpSuggestion[]> {
    // ── Rule-based fallback suggestions ─────────────────────────────────
    const fallbackSuggestions = (): FollowUpSuggestion[] => {
      const goal = result.goal.toLowerCase();
      const fileChanges = (result.fileChanges || '').toLowerCase();
      const ranCommands = (result.runOutput || '').toLowerCase();
      const suggestions: FollowUpSuggestion[] = [];

      // Detect what was accomplished and suggest next steps
      if (goal.includes('test') || goal.includes('testing')) {
        suggestions.push({
          label: '🧪  Run the tests',
          description: 'Run the tests to verify everything passes',
          goal: `Run the test suite to verify everything works`,
        });
      }

      if (fileChanges.includes('.py') || fileChanges.includes('python')) {
        suggestions.push({
          label: '🐍  Add Python type hints',
          description: 'Add type annotations to the Python code',
          goal: `Add type hints to the Python files to improve code quality`,
        });
      }

      if (fileChanges.includes('.ts') || fileChanges.includes('typescript') ||
          fileChanges.includes('.js') || fileChanges.includes('javascript')) {
        suggestions.push({
          label: '📖  Add JSDoc/TSDoc comments',
          description: 'Document the code with JSDoc or TSDoc comments',
          goal: `Add documentation comments to the code`,
        });
        suggestions.push({
          label: '🧪  Add unit tests',
          description: 'Write unit tests for the new code',
          goal: `Add comprehensive unit tests for the code that was just created`,
        });
      }

      if (fileChanges.includes('route') || fileChanges.includes('api') ||
          fileChanges.includes('endpoint') || fileChanges.includes('express')) {
        suggestions.push({
          label: '🔒  Add input validation',
          description: 'Validate API inputs and add error handling',
          goal: `Add input validation and proper error handling to the API endpoints`,
        });
      }

      if (ranCommands.includes('error') || ranCommands.includes('fail')) {
        suggestions.push({
          label: '🔧  Fix the execution errors',
          description: 'Debug and fix the errors from the last run',
          goal: `Fix the errors encountered during execution: ${result.runOutput?.slice(0, 200) || ''}`,
        });
      }

      // Generic suggestion based on project type
      if (result.agentResults.some((a) => a.agent === 'runner' && a.success)) {
        suggestions.push({
          label: '🚀  Deploy the project',
          description: 'Set up deployment configuration',
          goal: `Add deployment configuration for this project`,
        });
      }

      // Limit to 3 suggestions
      return suggestions.slice(0, 3);
    };

    // ── Try LLM-powered suggestions ─────────────────────────────────────
    try {
      // ── Re-verify before re-admit ───────────────────────────────────────
      // This is the ONLY execute-side LLM call that bypasses the orchestrator,
      // and it records into `this.failureSession`. Without a sweep here the
      // marker only ever goes one way: a provider that failed transiently stays
      // excluded for the whole run even after it recovered, so the follow-up
      // generator is denied a provider that is back — while the machinery to
      // prove recovery in seconds sat unused. Best-effort: a sweep failure must
      // never stop the rule-based fallback from rendering.
      try {
        await sweepTransientFailures(sessionRevivalStore(this.failureSession), this.configManager, {
          agentType: 'execute',
        });
      } catch {
        // Best-effort — revival must never break follow-up suggestions.
      }
      const config = this.configManager.getAll();
      const type = (activeProvider ||
        config.defaultProvider || 'auto') as ProviderType;
      // The SHARED provider service (`cli/router.ts`) — the same one every other
      // command resolves through — instead of building the adapter here. It
      // handles the built-in ids, the plugin registry, the 'auto' directive and
      // the catalog providers, so this call site cannot be the one that forgets
      // one (SURFACE_DEBT['provider-factory'] used to record exactly that).
      const resolved = resolveProvider(this.configManager, type);
      const provider: InferenceProvider = resolved.provider;

      // Resolve 'default' to a real model via the provider's live catalog
      let model = activeModel || 'default';
      if (!model || model === 'default') {
        try { model = await resolveDefaultModel(provider, resolved.type, model); } catch { /* best-effort */ }
      }

      // E3b parity: the suggest_followups contract (one vocabulary
      // everywhere) — exactly 3 followups, specific to this conversation.
      const prompt = [
        'Given the following goal execution result, suggest exactly 3 follow-ups',
        'the user is likely to want next — natural next questions, deeper dives,',
        'or related directions that build on what was just accomplished;',
        'specific to this conversation, not generic.',
        '',
        '## Goal',
        result.goal,
        '',
        `## Status: ${result.success ? 'SUCCESS' : 'FAILURE'}`,
        '',
        '## Agent Results',
        ...result.agentResults.map((a) => `  ${a.agent}: ${a.success ? '✅' : '❌'} ${a.summary.slice(0, 120)}`),
        '',
        result.fileChanges && result.fileChanges !== 'No files changed.'
          ? `## File Changes\n${result.fileChanges}`
          : '',
        '',
        'Respond with ONLY a JSON array of objects, each with keys:',
        '  - "prompt": The full follow-up prompt (max 200 chars)',
        '  - "label": An optional short action label (max 40 chars)',
        '',
        'Example:',
        '[{"prompt":"Add comprehensive error handling to the API routes","label":"Add error handling"}]',
        '',
        'Return ONLY the JSON array, no other text.',
      ].filter(Boolean).join('\n');

      const response = await provider.generate(prompt, {
        model,
        temperature: 0.3,
        maxTokens: 1024,
      });

      // E3b parity: validate against the SHARED suggest_followups schema
      // (the same one the chat loop's tool uses) — one contract everywhere.
      const followups = toFollowupSuggestions(response);
      if (followups.length > 0) {
        return followups.slice(0, 3).map((f) => ({
          label: (f.label || f.prompt).replace(/^[\u{1F300}-\u{1F9FF}\s]*/u, '').trim() || f.prompt,
          description: f.label ? f.prompt.slice(0, 80) : '',
          goal: f.prompt,
        }));
      }
    } catch (err) {
      // LLM failed — feed the FULL shared bookkeeping path (Nuvira-Router
      // M0.2 Stage C): this follow-up generator is the ONLY execute-side LLM
      // call that bypasses the orchestrator, so without this a dead
      // provider×model here was never learned. recordActionFailure composes
      // session exclusion + quota park + registry write-through + timeline +
      // breaker (the old bare recordRegistryFailure only updated health
      // scores). Re-derived inside a guarded block (a throwing config read
      // must never break the rule-based fallback), and the literal 'auto'
      // provider is never written — it's a routing directive, not a real
      // provider×model.
      try {
        // Resolve the provider for failure attribution WITHOUT calling the
        // config getters when an explicit activeProvider is already known (a
        // throwing config read must never break the rule-based fallback). The
        // 'auto' directive is resolved to the concrete best-available provider.
        let fbType = activeProvider;
        if (!fbType) {
          try {
            fbType = this.configManager.getAll().defaultProvider;
            if (fbType === 'auto') {
              try {
                fbType = this.configManager.getProviderConfig().type;
              } catch {
                // Keep 'auto' — skipped below.
              }
            }
          } catch {
            try {
              fbType = this.configManager.getProviderConfig().type;
            } catch {
              fbType = 'default';
            }
          }
        }
        if (fbType && fbType !== 'auto') {
          recordActionFailure(this.failureSession, fbType, err, this.configManager, {
            model: activeModel || 'default',
            action: 'execute',
          });
        }
      } catch {
        // Telemetry must never break the fallback to rule-based suggestions.
      }
    }

    return fallbackSuggestions();
  }

  /**
   * Analyze a failed orchestration result to determine what went wrong
   * and suggest recovery actions.
   */
  private analyzeFailure(result: OrchestrationResult): {
    failedAgents: Array<{ agent: string; error: string }>;
    failureType: 'planner' | 'writer' | 'runner' | 'tester' | 'debugger' | 'reviewer' | 'other';
    recoveryActions: Array<{ label: string; action: string }>;
    advice: string;
  } {
    const failedAgents = result.agentResults
      .filter((a) => !a.success)
      .map((a) => ({ agent: a.agent, error: a.summary.slice(0, 200) }));

    const firstFailed = failedAgents[0];
    let failureType: string = 'other';
    let advice = '';
    const recoveryActions: Array<{ label: string; action: string }> = [];

    if (!firstFailed) {
      // Pipeline error (not agent-level)
      failureType = 'other';
      advice = result.error || 'Unknown error occurred';
      recoveryActions.push({
        label: '📝  Retry with a clearer goal description',
        action: 'continue',
      });
    } else {
      const agentType = firstFailed.agent.toLowerCase();
      const error = firstFailed.error.toLowerCase();

      if (agentType === 'planner') {
        failureType = 'planner';
        advice = 'The Planner agent could not create a valid execution plan. ' +
          'This often happens when the goal is too vague or the project context is unclear.';
        recoveryActions.push({
          label: '📝  Rephrase the goal more specifically',
          action: 'continue',
        });
        recoveryActions.push({
          label: '🔄  Switch to a more capable model',
          action: 'switch-model',
        });
      } else if (agentType === 'writer') {
        failureType = 'writer';
        advice = 'The Writer agent failed to generate the code. ' +
          'This could be due to context limits, model quality, or an overly complex request.';
        recoveryActions.push({
          label: '🔄  Switch to a more capable model and retry',
          action: 'switch-model',
        });
        recoveryActions.push({
          label: '📝  Simplify the goal and retry',
          action: 'continue',
        });
      } else if (agentType === 'runner') {
        failureType = 'runner';
        advice = 'The Runner agent executed a command that failed. ' +
          'This is usually a code or environment issue, not an AI issue.';
        if (error.includes('command not found') || error.includes('not found') || error.includes('no such')) {
          advice += '\n  → The command or tool was not found. Check if the required dependency is installed.';
        } else if (error.includes('syntax') || error.includes('error')) {
          advice += '\n  → The command produced an error. The generated code may have issues.';
        }
        recoveryActions.push({
          label: '🔧  Fix the issue and rerun',
          action: 'continue',
        });
        recoveryActions.push({
          label: '🔄  Try with --skip-tests to bypass the runner',
          action: 'continue',
        });
      } else if (agentType === 'tester') {
        failureType = 'tester';
        advice = 'The Tester agent ran tests that failed. ' +
          'The generated code may have bugs or the test expectations may be wrong.';
        recoveryActions.push({
          label: '🐛  Debug the failing tests',
          action: 'continue',
        });
        recoveryActions.push({
          label: '🔄  Retry with --skip-tests',
          action: 'continue',
        });
      } else if (agentType === 'debugger') {
        failureType = 'debugger';
        advice = 'The Debugger agent attempted to fix issues but failed. ' +
          'Try providing more specific guidance about what needs to be fixed.';
        recoveryActions.push({
          label: '📝  Specify the exact error and retry',
          action: 'continue',
        });
        recoveryActions.push({
          label: '🔄  Switch model for better debugging',
          action: 'switch-model',
        });
      } else if (agentType === 'reviewer' || agentType === 'context-gatherer') {
        failureType = agentType as any;
        advice = `The ${agentType} agent failed. This is unusual and may indicate` +
          ' a provider or context issue.';
        recoveryActions.push({
          label: '🔄  Retry with a different model',
          action: 'switch-model',
        });
      } else {
        failureType = 'other';
        advice = `The ${firstFailed.agent} agent failed: ${firstFailed.error.slice(0, 200)}`;
        recoveryActions.push({
          label: '📝  Retry with a clearer goal',
          action: 'continue',
        });
      }

      // Add retry with failure context option for most failure types
      if (failureType !== 'planner' && failureType !== 'runner') {
        recoveryActions.push({
          label: `🔧  Auto-fix: Retry "${result.goal.slice(0, 40)}${result.goal.length > 40 ? '...' : ''}"`,
          action: 'retry-fix',
        });
      }
    }

    return {
      failedAgents,
      failureType: failureType as any,
      recoveryActions,
      advice,
    };
  }

  /**
   * Display a concise failure analysis to the user.
   */
  private showFailureAnalysis(analysis: {
    failedAgents: Array<{ agent: string; error: string }>;
    failureType: string;
    advice: string;
    recoveryActions: Array<{ label: string; action: string }>;
  }): void {
    logger.highlight('═'.repeat(60));
    logger.highlight('  ❌  Failure Analysis');
    logger.highlight('═'.repeat(60));

    console.log('');
    for (const fa of analysis.failedAgents) {
      const icon =
        fa.agent.toLowerCase() === 'planner' ? '📋' :
        fa.agent.toLowerCase() === 'writer' ? '✏️' :
        fa.agent.toLowerCase() === 'runner' ? '▶️' :
        fa.agent.toLowerCase() === 'tester' ? '🧪' :
        fa.agent.toLowerCase() === 'debugger' ? '🐛' :
        fa.agent.toLowerCase() === 'reviewer' ? '👁️' :
        fa.agent.toLowerCase() === 'context-gatherer' ? '📂' : '⚠️';

      console.log(`  ${icon}  ${fa.agent} failed:`);
      const wrapped = fa.error.length > 120 ? fa.error.slice(0, 120) + '...' : fa.error;
      console.log(`     ${wrapped}`);
      console.log('');
    }

    logger.info(`💡  ${analysis.advice}`);
    console.log('');
  }

  // ─── Single Goal Execution ────────────────────────────────────────────────

  /**
   * Run the orchestrator for a single goal and display results.
   * Returns the outcome so the caller can record it in session history.
   */
  /**
   * P0.5 — conversation-vs-pipeline gate: a genuine QUESTION is ANSWERED
   * directly (same chat engine as the dashboard), never run through the
   * multi-agent pipeline. The observed failure this kills: "why is the test
   * failing?" in execute mode spawned a python program to "answer" it.
   */
  private async answerConversationDirectly(
    goal: string,
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<SingleGoalResult> {
    try {
      // Lazy import breaks the static execute↔chat cycle (chat.ts imports
      // printOrchestrationResult from execute.ts); the chat engine IS the
      // direct-answer path (tool loop + ask_user + followups).
      const { ChatCommand } = await import('./chat.js');
      // The direct-answer path IS a chat turn, so it reports a chat turn's tool
      // lifecycle: each executed call and its outcome, from the shared engine's
      // own onToolCall seam. Without this the command could answer by running
      // tools ("list the working directory…") and report no tool work at all —
      // the gap `tool-call-lifecycle@cli-execute` recorded.
      const toolCalls: string[] = [];
      const toolOutcomes: Array<{ tool: string; ok?: boolean }> = [];
      // WS1 — the findings this answer recorded, from the same engine seam as
      // the tool lifecycle above.
      const findings: import('../findings/verdicts.js').WireFinding[] = [];
      const answer = await new ChatCommand().answerOnce(goal, {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        onToolCall: (phase, info) => {
          if (phase !== 'called') return;
          toolCalls.push(info.tool);
          toolOutcomes.push({ tool: info.tool, ...(typeof info.ok === 'boolean' ? { ok: info.ok } : {}) });
        },
        onFinding: (finding) => {
          findings.push(finding);
        },
        // WS2 (#24) — this turn is the EXECUTE command's, even though it runs
        // through the shared chat engine. Without this the session debug log of
        // a `nuvira execute` run was labelled `cli-chat`, which is exactly the
        // kind of misattribution a bug report cannot afford.
        debugSurface: 'cli-execute',
        // WS5 (#27) — the command's own flags, on the arm that answers directly.
        // The loop arm is handed the same three by `runLoopEngineGoal`, so one
        // `nuvira execute --worktree` isolates the run on EITHER engine.
        worktree: options.worktree,
        keepWorktree: options.keepWorktree,
        resume: options.resume,
      });
      // Parity with the dashboard/gateway: never print a raw suggest_followups
      // payload (or the empty fence it leaves behind) as if it were the answer,
      // and never print the model's own reasoning as one either.
      const content = displayTextOrLine(answer.content ?? '');
      // HONESTY (WS6 #28): a turn whose generation FAILED is not a success, and
      // this arm used to say it was. Found by the fault-injection row, which drives
      // all five surfaces through a declared provider fault and compared what they
      // claimed: the loop arm below computes `success = !result.generationFailed`,
      // while this arm returned `success: true` unconditionally — so `nuvira
      // execute` reported success for the SAME backend failure that `nuvira chat`
      // reported as failed, publishing the provider's own error prose as the
      // answer. An empty generation is the one outcome a caller must be able to
      // tell apart from a real answer, and `--json-events` consumers were being
      // told the opposite.
      const generationFailed = answer.generationFailed === true;
      if (options.jsonEvents) {
        process.stdout.write(JSON.stringify({
          type: 'result',
          success: !generationFailed,
          goal,
          summary: content,
          tasksCompleted: generationFailed ? 0 : 1,
          tasksTotal: 1,
          agentResults: [],
          fileChanges: '',
          runOutput: '',
          // The loop arm puts the failure text here too; the machine-readable
          // stream must not need a second field to tell why nothing was answered.
          error: generationFailed ? content : '',
          engine: 'direct',
          ts: Date.now(),
        }) + '\n');
      } else if (content) {
        console.log('\n' + content + '\n');
        // The same visible failure signal the loop arm prints, so a person running
        // `nuvira execute` is told the run produced no answer rather than left to
        // read the provider's apology as one.
        if (generationFailed) logger.error(content);
      }
      // R1 — hand the caller the backend that produced this answer. The chat
      // engine has always known it; this command used to drop it here.
      return {
        success: !generationFailed,
        ...(typeof answer.content === 'string' ? { content: answer.content } : {}),
        ...(answer.provider ? { provider: answer.provider } : {}),
        ...(answer.model ? { model: answer.model } : {}),
        ...(answer.transport ? { transport: answer.transport } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(toolOutcomes.length > 0 ? { toolOutcomes } : {}),
        ...(findings.length > 0 ? { findings } : {}),
        // WS5 — the isolation and resume this turn had, back to the caller.
        ...(answer.worktree ? { worktree: answer.worktree } : {}),
        ...(answer.resume ? { resume: answer.resume } : {}),
      };
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      return { success: false };
    }
  }

  /**
   * Run the goal through the LOOP engine (assessment Addendum v4 Phase 1.1):
   * one agentic turn over runToolLoop with ambient project context + tiered
   * tool exposure. Prints the loop's answer (and the tool-call trail unless
   * --json-events), and returns the same SingleGoalResult shape as the
   * pipeline path so session history / followups keep working unchanged.
   */
  private async runLoopEngineGoal(
    goal: string,
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<SingleGoalResult> {
    // The background warmup/exploration daemon also runs for the LOOP engine
    // (Models-page audit). The loop path never calls the orchestrator's
    // cold-start hook, so on a loop-engine-only day not even the probe ran and
    // the verified pool the router reads could only decay. Idempotent + unref'd:
    // safe to start on every goal.
    try {
      startWarmupDaemon(this.configManager);
    } catch {
      // Best-effort — warmup must never break the run.
    }
    try {
      const result = await runLoopExecutor(goal, this.configManager, {
        provider,
        model,
        // WS5 (#27) — the command's own flags. `--resume` means the SAME run
        // here as it does on the pipeline arm: the last run of this ask in this
        // directory (both ids come from `checkpointIdFor`), so one flag resumes
        // the plan on one engine and the recorded model calls on the other.
        ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
        ...(options.keepWorktree === undefined ? {} : { keepWorktree: options.keepWorktree }),
        ...(options.resume === undefined ? {} : { resume: options.resume }),
        quiet: !!options.jsonEvents,
        // G18 — `-v` echoes each tool's result (first line) under its call, so a
        // live run shows what came BACK, not only what was attempted. Without
        // it, "the gate applied the edit autonomously" and "the model passed
        // confirm:true" were indistinguishable from the console.
        verbose: options.verbose,
      });
      // The loop engine's answer is rendered by THIS command while the gateway
      // and dashboard console both sanitize it before showing it. Without this
      // the execute CLI printed a `**suggest_followups**` caption plus its raw
      // JSON payload (observed live from `nuvira execute`) — and, in the same
      // session, the model's own reasoning as the answer ("The user wants a
      // project plan… I should use the `plan_todo` tool…"). The loop engine now
      // REJECTS a reasoning reply at generation time, so this is the last line
      // of defence; a suppressed reply is never reported as a success.
      const content = displayTextOrLine(result.content ?? '');
      const suppressed = suppressReasoningLeak(result.content ?? '');
      const success = !result.generationFailed && !suppressed;
      if (options.jsonEvents) {
        process.stdout.write(JSON.stringify({
          type: 'result',
          success,
          goal,
          summary: content,
          tasksCompleted: success ? 1 : 0,
          tasksTotal: 1,
          agentResults: [],
          fileChanges: '',
          runOutput: '',
          error: success ? '' : content,
          engine: 'loop',
          engineExplanation: result.engineExplanation,
          // R1 — the same attribution the human path now returns, on the
          // machine-readable stream: which provider/model served the run, and
          // which tool transport carried it.
          provider: result.provider,
          model: result.model,
          transport: result.transport,
          toolCalls: result.toolCalls,
          toolOutcomes: result.toolOutcomes,
          erroredTools: result.erroredTools,
          // G18 — the evidence pointer: a machine consumer can follow up with
          // `nuvira trace show <id>` (or `/api/traces/<id>`) instead of taking
          // the summary on faith.
          traceId: result.traceId,
          refusals: result.refusals,
          gateDecisions: result.gateDecisions,
          durationMs: result.durationMs,
          ts: Date.now(),
        }) + '\n');
      } else {
        console.log('');
        if (content) console.log(content + '\n');
        if (!success) {
          logger.error(content || 'The loop engine could not complete this goal.');
        }
        // G18 — where this run's evidence lives. Printed under `-v` only, so the
        // default output stays the answer.
        if (options.verbose && result.traceId) {
          logger.info(
            `   🔍 Trace: ${result.traceId} — \`nuvira trace show ${result.traceId}\` (tool calls, gate decisions, refusals)`,
          );
        }
      }
      // R1 — the run's own attribution, back to the caller. `success` alone was
      // the whole result before this: a reader could not say which model
      // produced the output they were reading.
      return {
        success,
        ...(result.content ? { content: result.content } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
        ...(result.transport ? { transport: result.transport } : {}),
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        ...(result.toolOutcomes && result.toolOutcomes.length > 0
          ? { toolOutcomes: result.toolOutcomes }
          : {}),
        ...(result.findings && result.findings.length > 0 ? { findings: result.findings } : {}),
        // WS5 — the isolation and resume this run had, back to the caller.
        ...(result.worktree ? { worktree: result.worktree } : {}),
        ...(result.resume ? { resume: result.resume } : {}),
      };
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      return { success: false };
    }
  }

  private async runSingleGoal(
    goal: string,
    provider: string | undefined,
    model: string | undefined,
    options: ExecuteOptions,
  ): Promise<SingleGoalResult> {
    // P0.5 — conversation-vs-pipeline gate: a genuine question is answered
    // directly (no orchestrator, no python program). Runs BEFORE the option
    // echo, contract card and board so a question never looks like a pipeline.
    if (isConversationalQuestion(goal)) {
      return await this.answerConversationDirectly(goal, provider, model, options);
    }

    // ── Engine dispatch (assessment Addendum v4 Phase 1.1 + Phase 2) ───────
    // 'auto' (default): the engine router resolves loop-vs-pipeline from the
    // routed provider tier — strong models → the single agentic loop
    // (runToolLoop), local/weak tier → the orchestrator pipeline (the
    // weak-model advantage kept honestly). 'pipeline' forces the orchestrator
    // (CI/publish semantics, dry-run/rollback audit); 'loop' forces the loop.
    // planMode 'heavy' (Phase 1.6) demotes this dispatch to the orchestrator:
    // the reasoner→planner front-matter is reserved for large greenfield
    // builds invoked explicitly.
    {
      const planMode = options.planMode ?? 'light';
      if (planMode === 'heavy') {
        if (!options.jsonEvents) {
          logger.info('   🧭 Plan mode: heavy — orchestrator pipeline (reasoner→planner front-matter)');
        }
        // Fall through to the pipeline path (orchestrator) below.
      } else {
        const configMode = readEngineModeConfig(this.configManager);
        // CLI flag wins over config; config only refines 'auto'.
        const effective: 'auto' | 'loop' | 'pipeline' = options.engine
          ? (options.engine as 'auto' | 'loop' | 'pipeline')
          : configMode === 'pipeline' ? 'pipeline' : configMode === 'loop' ? 'loop' : 'auto';
        const decision = resolveEngine({
          provider,
          model,
          configManager: { getAll: () => ({ routing: { engineMode: effective } }) },
          // G13b — the GOAL is an input to the engine decision. "Write a 12 page
          // story at /path/Mahagatha.md" and "tell me a story" route
          // differently: the first asks for an artifact, so the pipeline that
          // plans units and assembles the document runs it, and the second is a
          // chat answer. Omitted before this input existed, which is exactly why
          // the artifact ask was answered in prose and written nowhere.
          goal,
        });
        if (decision.engine === 'loop') {
          if (!options.jsonEvents) {
            logger.info(`   🧭 Engine: loop — ${decision.explanation}`);
          }
          return await this.runLoopEngineGoal(goal, provider, model, options);
        }
        if (!options.jsonEvents && effective === 'auto') {
          logger.info(`   🧭 Engine: pipeline — ${decision.explanation}`);
        }
      }
    }
    if (!options.jsonEvents && (options.verbose || options.dryRun || options.review || options.sandbox)) {
      logger.info(`Goal: ${goal}`);
      if (options.dryRun) logger.info('Mode: Dry run (files will not be modified)');
      if (options.review) logger.info('Mode: Review (changes captured as review bundle)');
      if (options.sandbox) logger.info('Mode: Sandbox (commands run in Docker containers)');
      if (options.provider) logger.info(`Provider: ${options.provider} (from --provider flag)`);
      else if (provider) logger.info(`Provider: ${provider}`);
      if (options.model) logger.info(`Model: ${options.model} (from --model flag)`);
      else if (model) logger.info(`Model: ${model}`);
      if (options.memory) logger.info('Memory: Enabled');
      console.log('');
    }

    const agentModels: Record<string, string> = {};
    if (options.plannerModel) agentModels['planner'] = options.plannerModel;
    if (options.gathererModel) agentModels['context-gatherer'] = options.gathererModel;
    if (options.writerModel) agentModels['writer'] = options.writerModel;
    if (options.reviewerModel) agentModels['reviewer'] = options.reviewerModel;

    // Session 20: resolve the REQUEST CONTRACT BEFORE the board starts so the
    // 🧠 understand-card is visible before execution (cross-command parity with
    // chat's pipeline runs — same shared choke point). Suppressed under
    // --json-events so stdout stays a pure NDJSON stream.
    const parsedGoal = parseRequestSync(goal);
    const dispatch = resolveDispatch(parsedGoal);
    const contract = contractFromParsed(goal, parsedGoal);
    if (!options.jsonEvents) {
      console.log('\n' + renderContractCard(contract, {
        // The card's resumability claim must match reality: only true when
        // checkpointing is actually enabled for this run (--checkpoint / --resume).
        resumable: checkpointOptions(options.checkpoint, options.resume).checkpoint,
      }) + '\n');
    }

    // Live pipeline board — every step, parallel lane, and agent "thinking"
    // update shown in real time (falls back to plain lines when not a TTY).
    // Also implements the spinner interface so rate-limit prompts pause it.
    // With --json-events, swap in the machine-readable NDJSON event stream so
    // external consumers (CI, scripts, the VS Code panel) get the same events.
    const board = options.jsonEvents ? new PipelineEventStream() : new PipelineBoard();
    board.start(goal);

    try {
      // Machine-readable mode: keep stdout a pure NDJSON stream. The event-bus
      // LoggerConsumer and incidental warn/info calls would otherwise interleave
      // human lines ("⚡ Pipeline started", inspection echoes, auto-routing
      // warnings) into the JSON stream — silence the logger for the duration and
      // let the NDJSON events carry all the detail. Set inside the try so the
      // finally below ALWAYS restores it, even on an early throw.
      if (options.jsonEvents) setSilent(true);

      // D2: agent-driven background duties — one-line health + models status
      // at session start (throttled; silent in jsonEvents so stdout stays
      // NDJSON). Best-effort — never breaks execution.
      await maybeRunBackgroundDuties(this.configManager, {
        silent: !!options.jsonEvents,
      }).catch(() => { /* best-effort */ });

      // D1: agent-driven auto-recall — continue/resume goals recall the
      // project's prior work into the planner context (cross-command parity
      // with chat). Best-effort — never breaks execution. In --json-events
      // mode the card is suppressed so stdout stays pure NDJSON.
      let recallContext: string | undefined;
      // Ambient recall (see recallPolicy): a goal no longer has to be phrased as
      // a continuation to learn what this project already did.
      const recallPolicyDecision = recallPolicy({ mode: dispatch.mode });
      if (recallPolicyDecision.recall) {
        try {
          const recall = await maybeAutoRecall(process.cwd(), this.configManager.getWorkspaceStore());
          if (recall) {
            if (recallPolicyDecision.announce && !options.jsonEvents) console.log(recallCard(recall));
            recallContext = recallContextBlock(recall);
          }
        } catch { /* recall must never break execution */ }
      }

      // The options THIS command owns. Provider/model are deliberately ABSENT:
      // they ride on the wrapper's own options, where 'auto' is resolved once,
      // the same way for every caller (the gateway included).
      const execOptions = {
        taskIntentHint: dispatch.taskIntentHint,
        recallContext,
        acceptanceCriteria: contract.acceptanceCriteria,
        agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
        dryRun: options.dryRun,
        verbose: options.verbose,
        useDockerSandbox: options.sandbox,
        skipTests: options.skipTests,
        useMemory: options.memory,
        reviewMode: options.review,
        contextLimit: options.contextLimit,
        contextPruneMode: options.contextPrune as 'soft' | 'medium' | 'aggressive' | undefined,
        maxRepairs: options.maxRepairs,
        repairMode: options.repairMode as 'auto' | 'prompt' | 'off' | undefined,
        repairFallbackModels: options.repairFallbackModels?.split(',').map((m: string) => m.trim()).filter(Boolean),
        autoRouteModels: options.autoRoute || undefined,
        // Resolved explicitly (default true): the orchestrator's own default is
        // tool-calling ON (audit W3), and passing the boolean keeps `--no-tool-calling`
        // authoritative over it from the CLI.
        useToolCalling: options.toolCalling !== false,
        ...checkpointOptions(options.checkpoint, options.resume),
        spinner: board,
      };
      // The SHARED turn entry. One place owns the pipeline's provider
      // resolution, understand-card, recall wiring and checkpoint default, so
      // this command, the gateway and the model's build/resume tools cannot
      // drift apart — which is what SURFACE_DEBT['pipeline-wrapper-bypass'] was
      // recording while this command built its own Orchestrator.
      const pipeline = await runPipelineTool(goal, this.configManager, {
        provider,
        model,
        // The board is OURS: the wrapper must not mount a second one behind it.
        board: false,
        // …and the 🧠 card is ours too — ours states the real resumability, which
        // the wrapper cannot know.
        announce: false,
        taskIntentHint: dispatch.taskIntentHint,
        recallContext,
        execOptions,
      });
      const result = pipeline.result;
      if (!result) {
        // The wrapper never throws, so a run that could not even resolve a
        // working provider arrives here as a null result with the reason in
        // `error` — reported as the failure it is rather than swallowed.
        board.finish(false);
        if (options.jsonEvents) {
          process.stdout.write(JSON.stringify({
            type: 'result',
            success: false,
            error: pipeline.error ?? pipeline.summary,
            ts: Date.now(),
          }) + '\n');
        } else {
          logger.error(pipeline.error ?? pipeline.summary);
        }
        return { success: false };
      }

      // ── G11: finish the job, do NOT ask for a "continue" ──────────────────
      // A 100-page book is ~39 units; the ledger already made that possible, but
      // it used to end every batch by asking the user to reply. The ask itself
      // is the authorization, so the remaining batches run HERE, in this same
      // command, until the deliverable is complete or something real stops it.
      //
      // Skipped in --json-events mode (a machine consumer gets one result
      // event) and in dry-run (nothing is executed, so nothing can progress).
      if (!options.jsonEvents && !options.dryRun) {
        const pending = result.pendingWork;
        if (pending) {
          const surface = { platform: 'cli', channelId: process.cwd() };
          const scheduled = scheduleFromPendingWork(pending, surface);
          if (scheduled) {
            console.log(
              `\n🤖 Unfinished work detected — ${pending.reason}. Continuing automatically; no reply needed.`,
            );
            const runner = new UnattendedRunner({
              maxBatchesPerDrain: MAX_UNATTENDED_BATCHES_CLI,
              owns: (job) => job.surface.platform === 'cli' && job.surface.channelId === process.cwd(),
              notify: (_job, line) => {
                console.log(`\n${line}`);
              },
              runBatch: async (batchJob) => {
                // G27: time the batch and measure what it COST from the ledger's
                // timestamps. A fresh orchestrator per batch runs through this
                // loop too, so a session counter would report zero for every
                // batch after the first.
                const startedAt = Date.now();
                // A FRESH wrapper run per batch: each batch is its own run, and
                // reusing anything from the previous one would carry its
                // counters and trace id into the next.
                const batch = await runPipelineTool(batchJob.continuationPrompt, this.configManager, {
                  provider,
                  model,
                  board: false,
                  announce: false,
                  taskIntentHint: dispatch.taskIntentHint,
                  recallContext,
                  execOptions: { ...execOptions, spinner: undefined },
                });
                const batchResult = batch.result;
                if (!batchResult) {
                  // Nothing ran at all, so there is no progress to measure and
                  // the failure counts against the runner's own caps.
                  return {
                    ...measureUnattendedProgress(batchJob),
                    error: batch.error ?? batch.summary ?? 'batch failed',
                  };
                }
                const economy = costSince(startedAt);
                const envelope = {
                  durationMs: Date.now() - startedAt,
                  costUsd: economy.costUsd,
                  tokens: economy.tokens,
                };
                const measured = measureUnattendedProgress(batchJob);
                // "The batch ran" is not "the work moved". A failed batch that
                // ALSO produced no measurable progress is a failure (it counts
                // toward the failure cap); a failed batch that still wrote
                // chapters is just a partial success, and the ledger decides.
                const moved = (measured.progress ?? 0) > batchJob.progress;
                if (!batchResult.success && !measured.finished && !moved) {
                  return {
                    ...measured,
                    ...envelope,
                    error: batchResult.error || batchResult.summary || 'batch failed',
                  };
                }
                // Refresh with the newest snapshot: the composite's expected
                // artifacts can only be known once its phases have been planned.
                scheduleFromPendingWork(batchResult.pendingWork, surface);
                return { ...measured, ...envelope };
              },
            });
            await runner.drain();
            this.reportUnattendedOutcome(scheduled.id);
          }
        }
      }

      board.finish(result.success);
      if (options.jsonEvents) {
        // Machine-readable terminal event: the full orchestration result.
        process.stdout.write(JSON.stringify({
          type: 'result',
          success: result.success,
          goal: result.goal,
          summary: displayTextOrLine(result.summary),
          tasksCompleted: result.tasksCompleted,
          tasksTotal: result.tasksTotal,
          // Each agent line goes through the same sanitizer: a `--json-events`
          // consumer must not receive a leaked reasoning trace as an agent's
          // summary either.
          agentResults: result.agentResults.map((ar) => ({
            ...ar,
            summary: displayTextOrLine(ar.summary),
          })),
          fileChanges: result.fileChanges,
          runOutput: result.runOutput,
          error: result.error,
          engine: 'pipeline',
          trajectoryId: result.trajectoryId,
          reviewId: result.reviewId,
          // R1 — the run's attribution, so a machine consumer reading the
          // NDJSON stream can tell WHICH backend produced this output without
          // joining against a trace. `transport` is deliberately absent for
          // this arm: a multi-agent pipeline resolves a model per agent, and
          // the wrapper does not track a single tool transport for the run.
          provider: pipeline.provider,
          model: pipeline.model,
          ts: Date.now(),
        }) + '\n');
      } else {
        console.log('');
        printOrchestrationResult(result);
      }
      return {
        success: result.success,
        orchestrationResult: result,
        content: result.summary,
        ...(pipeline.provider ? { provider: pipeline.provider } : {}),
        ...(pipeline.model ? { model: pipeline.model } : {}),
      };
    } catch (err) {
      board.finish(false);
      if (options.jsonEvents) {
        process.stdout.write(JSON.stringify({
          type: 'result',
          success: false,
          error: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        }) + '\n');
      } else {
        logger.error(String(err));
      }
      return { success: false };
    } finally {
      if (options.jsonEvents) setSilent(false);
    }
  }

  // ─── Unattended Completion ─────────────────────────────────────────────

  /**
   * Report where an unattended run actually ended up.
   *
   * Four distinct outcomes, and the wording never blurs them: DONE (the
   * deliverable exists), BLOCKED (a decision only the user can make — the one
   * case where asking is correct), FAILED (a real error, reported with its
   * reason), and STILL RUNNING out of budget (resumable, because the ledger
   * holds the progress). Reporting the last one as "failed" was the original
   * session's core dishonesty: it had done real work on disk and called it a
   * failure six times.
   */
  private reportUnattendedOutcome(jobId: string): void {
    const job = getUnattendedJob(jobId);
    if (!job) return;
    const batches = `${job.batches} batch${job.batches === 1 ? '' : 'es'}`;
    switch (job.status) {
      case 'done':
        logger.success(
          `\n✅ Finished unattended — ${job.progressLine ?? 'deliverable complete'} (${batches}).`,
        );
        break;
      case 'blocked':
        console.log(`\n❓ ${job.pendingQuestion ?? job.stopReason ?? 'I need your input to continue.'}`);
        break;
      case 'failed':
        logger.warn(`\n⚠️  Stopped before finishing — ${job.stopReason ?? 'unknown reason'} (${batches}).`);
        break;
      default:
        logger.info(
          `\n⏳ Not finished yet — ${job.progressLine ?? ''} (${jobPercent(job)}%). ` +
            'Progress is saved; run the same command again to resume from where it stopped.',
        );
    }

    // G27: the run's cost and latency, per batch — a long unattended job must
    // account for itself instead of leaving the bill to be reconstructed from
    // the cost ledger by hand afterwards.
    const report = formatBatchReport(job);
    if (report) console.log(report);
  }

  // ─── Checkpoint Listing ────────────────────────────────────────────────

  /**
   * Show saved checkpoints (goal, completion, age) and how to resume them.
   */
  private showCheckpointList(): void {
    const checkpoints = listCheckpoints();

    if (checkpoints.length === 0) {
      logger.highlight('📒 Checkpoints');
      console.log('');
      logger.info('  No checkpoints found.');
      logger.info('  Run a goal with --checkpoint to save a resume-able pipeline:');
      logger.info('    nuvira execute "my goal" --checkpoint');
      console.log('');
      return;
    }

    logger.highlight('📒 Checkpoints (resume with `nuvira execute "<goal>" --resume <id>`)');
    console.log('');
    for (const cp of checkpoints) {
      const date = new Date(cp.savedAt).toLocaleString();
      const pct = cp.tasksTotal > 0 ? Math.round((cp.tasksCompleted / cp.tasksTotal) * 100) : 0;
      console.log(`  • ${cp.id}`);
      console.log(`      Goal: ${cp.goal.slice(0, 90)}`);
      console.log(`      Progress: ${cp.tasksCompleted}/${cp.tasksTotal} steps (${pct}%) · Saved: ${date}`);
      console.log('');
    }
    console.log('');
  }

  // ─── Memory Management ─────────────────────────────────────────────────

  private async showMemoryStats(): Promise<void> {
    try {
      const { getMemoryStats } = await import('../memory/memory-integration.js');
      const stats = await getMemoryStats();

      logger.highlight(`${'═'.repeat(60)}`);
      logger.highlight(`  🧠  Memory Statistics`);
      logger.highlight(`${'═'.repeat(60)}`);

      console.log(`\n  Total trajectories: ${stats.total}`);
      console.log(`  Average quality score: ${stats.avgScore}`);

      if (Object.keys(stats.byProjectFingerprint).length > 0) {
        console.log(`\n  By project type:`);
        for (const [fp, count] of Object.entries(stats.byProjectFingerprint)) {
          console.log(`    ${fp}: ${count}`);
        }
      }

      console.log('');
      logger.highlight(`${'═'.repeat(60)}`);
      console.log('');
    } catch (err) {
      logger.error(`Failed to read memory stats: ${err}`);
    }
  }

  private async clearMemory(): Promise<void> {
    try {
      const { clearMemory } = await import('../memory/memory-integration.js');
      await clearMemory();
      logger.success('Memory cleared successfully');
    } catch (err) {
      logger.error(`Failed to clear memory: ${err}`);
    }
  }
}

// ─── Answer rendering ───────────────────────────────────────────────────────

/**
 * Text fit to show a human: tool-call artifacts stripped, and a leading
 * reasoning trace salvaged away (empty when the trace was the whole reply).
 *
 * ONE definition for every execute render path — the loop engine, the direct
 * answer, the pipeline report and each agent line — so the human output and the
 * `--json-events` payload can never disagree about what was shown (the parity
 * gap that let a raw `**suggest_followups**` payload reach `nuvira execute`
 * while the gateway and dashboard stripped it).
 */
function displayText(text: string): string {
  return stripReasoningLeak(stripToolCallArtifacts(text ?? '')).trim();
}

/**
 * `displayText`, plus an honest line when nothing deliverable remained — for the
 * surfaces that must always render something (the pipeline summary and its
 * per-agent lines). Empty input stays empty: an absent summary is not a
 * suppressed one.
 */
function displayTextOrLine(text: string): string {
  if (!(text ?? '').trim()) return '';
  return displayText(text) || ANSWER_QUALITY_FAILURE_LINE;
}

/** Did this reply have to be suppressed as a reasoning trace (nothing usable)? */
function suppressReasoningLeak(text: string): boolean {
  const raw = (text ?? '').trim();
  return raw !== '' && displayText(raw) === '';
}

// ─── Pretty Printer ─────────────────────────────────────────────────────────

/**
 * Pretty-print the orchestration result to the console.
 */
export function printOrchestrationResult(result: OrchestrationResult): void {
  const statusIcon = result.success ? '✅' : '❌';
  logger.highlight(`${'═'.repeat(60)}`);
  logger.highlight(`  ${statusIcon}  Execution Result`);
  logger.highlight(`${'═'.repeat(60)}`);

  console.log(`\n  Goal: ${result.goal}`);
  console.log(`\n  ${displayTextOrLine(result.summary)}`);
  console.log(`  Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);

  if (result.trajectoryId) {
    console.log(`  Memory: Stored as ${result.trajectoryId}`);
  }

  if (result.agentResults.length > 0) {
    console.log(`\n  Agents:`);
    for (const ar of result.agentResults) {
      const icon = ar.success ? '✅' : '❌';
      const agentSummary = displayTextOrLine(ar.summary);
      const truncatedSummary = agentSummary.length > 120
        ? agentSummary.slice(0, 120) + '...'
        : agentSummary;
      console.log(`    ${icon} ${ar.agent}: ${truncatedSummary}`);
    }
  }

  if (result.fileChanges && result.fileChanges !== 'No files changed.') {
    console.log(`\n  File Changes:`);
    for (const line of result.fileChanges.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  if (result.runOutput) {
    console.log(`\n  Command Output:`);
    for (const line of result.runOutput.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  if (result.error) {
    console.log(`\n  Error: ${result.error}`);
  }

  console.log('');
  logger.highlight(`${'═'.repeat(60)}`);
  console.log('');
}
