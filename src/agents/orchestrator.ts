/**
 * Orchestrator — The central coordinator of the multi-agent system.
 *
 * Responsibilities:
 * 1. Accept a user goal and optionally a provider/model config
 * 2. Create a ContextVault (shared context bus)
 * 3. Build the project file tree and inject it for the Planner
 * 4. Optionally retrieve memory context from past similar trajectories
 * 5. Run the PlannerAgent to produce an execution plan
 * 6. Execute tasks sequentially, respecting dependencies
 * 7. Spawn the appropriate agent for each task
 * 8. Apply file changes to disk
 * 9. Execute runner commands and capture output
 * 10. Optionally store the trajectory in memory
 * 11. Synthesize and return the final result
 *
 * Called by the `agent-nuvira execute` CLI command.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { verifyArtifacts } from './artifact-verification.js';
import { formatCount } from '../utils/format.js';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pushDAGUpdate, updateDAGNode, resetDAG } from '../observability/dag-bridge.js';
import inquirer from 'inquirer';

import { ProviderFactory } from '../inference/factory.js';
import { ConfigManager } from '../config/manager.js';
import { capabilityReasoningEffort, isMaxCapability } from '../config/capability-mode.js';
import type { ProviderType, InferenceOptions } from '../config/types.js';
import { showModelPicker } from '../cli/model-picker.js';
import { shouldPromptWeakModel, promptWeakModelChoice, type WeakModelChoice } from '../cli/weak-model-prompt.js';
import { logger } from '../utils/logger.js';

import { ContextVault } from './context-vault.js';
import {
  saveCheckpoint,
  loadCheckpoint,
  checkpointIdFor,
  findRelatedCheckpointFor,
  reconcileTaskPlan,
  planHasPendingWork,
} from './checkpoint-store.js';
import { Agent } from './agent.js';
import type { AgentContext, LLMCallFn, AgentResult, TaskStep, OnRateLimit } from './agent.js';
import {
  buildLongFormPlan,
  isContinuationAsk,
  type LongFormPlan,
  type ProseUnit,
} from './long-form-plan.js';
import { buildCompositePlan, type CompositePlan } from './composite-plan.js';
import { runLiveFanout } from './fanout-scheduler.js';
import {
  assembleDocument,
  countWords,
  findInProgressJob,
  formatProgress,
  jobProgress,
  recordSectionOutcome,
  type LongFormJob,
} from '../learning/long-form.js';
import { artifactsPresence } from '../learning/unattended-progress.js';
import { resolveDefaultProvider } from '../learning/model-selection.js';
import { buildProjectFileTree, truncateTree, SOURCE_EXTENSIONS, IGNORE_DIRS } from './utils/file-tree.js';
import type { RunResult } from './agents/runner.js';
import { cleanupSandbox } from './agents/tester.js';
import type { McpToolEntry } from './agents/mcp-agent.js';
import { getMCPManager, resetMCPManager } from '../mcp/manager.js';
import { formatMcpToolsForPrompt } from './agents/mcp-agent.js';
import { getModuleRegistry, type ModuleRegistry } from './module-registry.js';

// Rate limits with a reset hint LONGER than this (e.g. "resets in 17h 51m" — a
// daily-quota exhaustion) are treated as EXHAUSTED: the provider is down for a
// while, so the pipeline silently auto-switches to another provider even on the
// first hit. Shorter hints (e.g. Groq/Anthropic "try again in 16.5s" TPM blips)
// are transient — a silent wait + retry is cheaper than switching.
const AUTO_SWITCH_WAIT_THRESHOLD_MS = 60_000;
// Strikes farther apart than this are NOT a "consecutive" storm — the provider
// ran healthy in between (real successes take minutes), so the counter resets.
const STORM_WINDOW_MS = 5 * 60_000;
// Cap for the "wait and retry" weak-model option: a stronger provider only
// qualifies for an honest wait if it recovers within this window (short
// rate-limit/transient cooldowns). Longer outages → 'wait' is not offered.
const MAX_WEAK_WAIT_MS = 3 * 60_000;
import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import { DefaultReportModule, type ReportModule, type ReportFormat } from './report-module.js';
import { ContextPruner } from '../learning/context-pruner.js';
import { ErrorRepairEngine } from '../learning/error-repair.js';
import type { RepairMode } from '../learning/error-repair.js';
import { estimateTokens } from '../learning/cost-tracker.js';
import { scanForInjections, formatScanReport } from '../security/scanner.js';
import { withLogCorrelation } from '../enterprise/log.js';
import { withAgentAnswerQualityGate } from './answer-quality-gate.js';
import { getMetrics } from '../enterprise/metrics.js';
import {
  getAutoRouter,
  isAgentAutoRoute,
  isAgenticTask,
  isAutoModel,
  isAutoProvider,
  isProviderOwnAuto,
  type AutoRouteResult,
  type TaskIntent,
} from '../learning/auto-router.js';
import { isAgenticCapableModel } from '../learning/model-harness.js';
import { weakRouteNotice } from '../learning/agentic-route-gate.js';
import { analyzeComplexity, type ComplexityLevel } from '../learning/hybrid-router.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { buildAutoResolveOptions } from '../learning/resolve-options.js';
import { classifyFallbackError, getProviderFallback, recordRegistrySuccess } from '../learning/provider-fallback.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import { sweepTransientFailures, sessionRevivalStore } from '../learning/provider-revival.js';
import { resolveContextBudget, resolveContextFileBudget, resolveMaxOutputTokens } from '../learning/context-budget.js';
import { clampMaxTokens, learnMaxTokensLimitFromError } from '../learning/provider-limits.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { resolveRoute } from '../inference/route-resolver.js';
import { refreshModelRegistry } from '../inference/model-probe.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { getQuotaLedger } from '../learning/quota-ledger.js';
import { withTraceCapture, beginTrace, endTrace } from '../learning/reasoning-trace.js';
import { recordWorkingState } from '../learning/working-state.js';
import { clearStepHandoff, deliverablesNamedIn, recordStepHandoff, stepKeyFor } from './step-handoff.js';
import { createResilientCallLLM, type ResilientCallOptions } from '../learning/resilient-call.js';
import { createReviewFromResult } from '../team/review.js';
import { indexFiles, retrieve, recordRetrievalStats, retrievalOptionsFromConfig, estimateTokens as retrievalEstimateTokens } from '../learning/retrieval.js';

// ─── DAG Integration (optional — dashboard may not be built) ─────────────────

/**
 * Push a DAG update to the live dashboard, if one is running.
 *
 * These helpers used to `await import('../web-dashboard/server.js')` on first
 * use, which dragged the entire 270 KB dashboard module into every CLI pipeline
 * run just to mutate in-process graph state nothing could read (no dashboard =
 * no SSE clients), and added an upward edge to the import graph. The dashboard
 * now REGISTERS its implementation with `observability/dag-bridge.ts` when it
 * loads, so these are cheap no-ops without a dashboard — same observable
 * behaviour, no web module in the agent's dependency closure.
 *
 * Deliberately still `async`: every call site awaits them, and the ordering
 * contract (the update lands before the step it describes completes) is what
 * the DAG view depends on.
 */

async function tryPushDAG(update: {
  pipelineId?: string;
  pipelineDescription?: string;
  nodes: Array<{ id: string; agentType: string; status: string; description: string }>;
  edges: Array<{ from: string; to: string }>;
}): Promise<void> {
  pushDAGUpdate(update);
}

async function tryUpdateDAGNode(nodeId: string, update: { status: string; summary?: string }): Promise<void> {
  updateDAGNode(nodeId, update);
}

async function tryResetDAG(): Promise<void> {
  resetDAG();
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for an orchestration session */
export interface OrchestratorOptions {
  /** Inference provider type (default: from configManager) */
  provider?: string;
  /** Model override (default: from provider config) */
  model?: string;
  /** Whether to write files to disk (false = dry-run) */
  dryRun?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Agent-specific model overrides */
  agentModels?: Partial<Record<string, string>>;
  /** Enable persistent memory (trajectory storage and retrieval) */
  useMemory?: boolean;
  /** Auto-create a review bundle instead of applying changes directly */
  reviewMode?: boolean;
  /** Auto-route each agent to its recommended model from the ModelRouter */
  autoRouteModels?: boolean;
  /**
   * Use tool-calling agents for writer and reviewer steps.
   * When true, the orchestrator routes 'writer' tasks to 'writer-tc' and
   * 'reviewer' tasks to 'reviewer-tc' — iterative read→edit→verify loops
   * instead of one-shot LLM calls.
   *
   * Defaults to `DEFAULT_USE_TOOL_CALLING` (true). Absent means "use the
   * default" — pass an explicit `false` to force the one-shot writer, which
   * is what the eval framework does for its non-tool-calling arm so the arms
   * stay distinguishable.
   */
  useToolCalling?: boolean;
  /**
   * Opt-in to the interactive rate-limit prompt (wait / switch / skip / abort).
   * Default: false — rate limits are handled fully automatically (silent wait
   * for transient hints, silent auto-switch to another provider when the
   * current one is exhausted). Also settable via `routing.askOnRateLimit` in
   * .nuviraconfig.json.
   */
  askOnRateLimit?: boolean;
  /**
   * C3: NLU task-intent hint (router TaskIntent vocabulary) from the parsed
   * goal. Seeded into the planner routing decision's taskProfile.intent so the
   * orchestrator's strategy switch + the router's task-type see the SAME
   * vocabulary every action command derives from the shared NLU parser.
   * Safety flags (requiresVerification / escalationTarget) stay text-derived.
   */
  taskIntentHint?: TaskIntent;
  /**
   * D1: agent-driven recall context (continue/resume goals). Recalled project
   * state (sessions/facts/checkpoint) is prepended to the planner's memory
   * block so the planner sees prior work before planning.
   */
  recallContext?: string;
  /**
   * Session 20 — RequestContract acceptance criteria for this goal. Seeded
   * into vault metadata so the verification pass (the reviewer follow-up)
   * checks the changes against the contract, not just the loose goal
   * (Decision 3: spec→verify). Optional — the pipeline verifies normally
   * when absent.
   */
  acceptanceCriteria?: string[];
  /**
   * Enable automatic MCP server discovery and tool injection.
   * Set to false to skip MCP auto-connect for a specific pipeline.
   * Default: true
   */
  enableMcp?: boolean;
  /** Pre-built task plan to use instead of calling the PlannerAgent (for workflow templates) */
  prefillPlan?: TaskStep[];
  /**
   * Maximum context tokens before the ContextPruner triggers pruning.
   * Default: 128000 (suitable for Llama-3, Groq, OpenRouter).
   * Set higher for Gemini (1000000) or lower for smaller models.
   */
  contextLimit?: number;
  /**
   * Context pruning aggressiveness.
   * - 'soft' (default): keeps last 10 conversation messages
   * - 'medium': keeps last 5
   * - 'aggressive': keeps last 2
   */
  contextPruneMode?: 'soft' | 'medium' | 'aggressive';
  /**
   * Run runner commands and tests inside a Docker sandbox container.
   * Requires Docker to be installed and running.
   */
  /**
   * Maximum number of auto-repair attempts per task when an agent fails.
   * Default: 3. Set to 0 to disable auto-repair.
   */
  maxRepairs?: number;
  /**
   * Auto error-repair mode.
   * - 'auto' (default): automatically repair repairable errors without asking
   * - 'prompt': ask for user approval before applying repair strategies
   * - 'off': disable auto-repair entirely
   */
  repairMode?: 'auto' | 'prompt' | 'off';
  /**
   * Fallback models to try when switching during error-repair.
   * Example: ['groq/llama-3.3-70b', 'gemini/gemini-2.0-flash']
   */
  repairFallbackModels?: string[];
  useDockerSandbox?: boolean;
  /**
   * When true, skip all tester and debugger tasks in the pipeline.
   * Useful when you only want to generate code without running tests.
   */
  skipTests?: boolean;
  /**
   * Optional spinner reference from the CLI caller.
   * When set, the orchestrator stops the spinner before showing interactive
   * rate-limit prompts and restarts it after the user responds.
   */
  spinner?: {
    stop(): void;
    start(text?: string): void;
  };
  /**
   * Save a checkpoint after every task batch so the pipeline can be resumed
   * later with `--resume` (or a fresh run of the same goal). Checkpoints live
   * in ~/.nuvira/memory/checkpoints/ and let a crash / quota kill / token expiry
   * mid-pipeline continue from the first pending step instead of restarting.
   * Default: false for the PER-BATCH saves (implied true when
   * resumeCheckpointId is set).
   *
   * Independent of this flag, a run that ends with WORK UNFINISHED — a failed
   * step, or a step that reported success whose declared deliverable is not on
   * disk — always persists its ledger once. That is not a preference: it is the
   * record of what still needs doing, and the run after it is the one that has
   * to read it. Without this the live NVDA-addon failure left nothing behind for
   * attempt #2 to inherit, which is why attempts #2 through #19 re-planned the
   * same plan from zero.
   */
  checkpoint?: boolean;
  /**
   * Resume a previously saved pipeline from a checkpoint id (or the auto id
   * for goal + cwd). Completed steps are skipped; execution continues from the
   * first pending step with its dependencies satisfied.
   */
  resumeCheckpointId?: string;
  /**
   * True when the user explicitly asked to RESUME (bare `--resume` with no id
   * included). Lets the orchestrator warn when no checkpoint matches the auto
   * id (e.g. a reworded goal) instead of silently starting a fresh pipeline.
   */
  resumeRequested?: boolean;
  /**
   * Enable resilient auto-routing: every LLM call auto-routes on ANY failure
   * (not just rate-limit), tries ALL ranked candidates (no 3-candidate cap),
   * and tracks failures across the session AND across pipelines (persisted to
   * disk). Default: true when auto-routing is active.
   */
  resilientRouting?: boolean;
}

/** The final result of an orchestration session */
export interface OrchestrationResult {
  /** Overall success */
  success: boolean;
  /** The original user goal */
  goal: string;
  /** Summary of what was accomplished */
  summary: string;
  /** Number of tasks completed vs total */
  tasksCompleted: number;
  tasksTotal: number;
  /** Detailed results from each agent */
  agentResults: Array<{ agent: string; success: boolean; summary: string }>;
  /** File change summary */
  fileChanges: string;
  /**
   * Enterprise G3 — the PATHS the pipeline changed (excluding deletions), used
   * to feed the working-state ledger so the next run knows what this one
   * touched. `fileChanges` stays the human-readable diff summary.
   */
  changedFiles?: string[];
  /** Runner output (from executed commands) */
  runOutput?: string;
  /** Error message if failed */
  error?: string;
  /** Memory trajectory ID if stored */
  trajectoryId?: string;
  /** Review bundle ID if review mode was enabled */
  reviewId?: string;
  /** Execution telemetry — attempts, repair activity, dependency installs */
  stats?: ExecutionStats;
  /** The execution plan (lightweight — descriptions only); used by the
   *  self-improvement loop to capture failed runs into episodic memory. */
  taskPlan?: TaskStep[];
  /**
   * Enterprise G11 — work this run did NOT finish but that must KEEP GOING
   * without the user typing "continue".
   *
   * The orchestrator decides WHAT still needs doing (it has the ledger); the
   * calling surface decides who to report to and owns the tick that drives it.
   * That split is what lets the same unfinished book be continued by the CLI,
   * the dashboard or a messaging gateway without the orchestrator knowing which
   * it is.
   */
  pendingWork?: PendingWork;
}

/**
 * Include `pendingWork` only when there is genuinely something left to do.
 *
 * Extracted so the rule lives in one place: every surface treats a handed-over
 * job as work to schedule, so handing over a COMPLETE deliverable would make it
 * rebuild the thing the user already has.
 */
function buildPendingWork(pending: PendingWork | undefined): { pendingWork?: PendingWork } {
  if (!pending) return {};
  if (pending.percent >= 100) return {};
  return { pendingWork: pending };
}

/**
 * Unfinished work that the calling surface must keep scheduling.
 *
 * Present only when a run ended with a deliverable that is genuinely
 * incomplete — the honest alternative to the old "Reply *continue*" cadence,
 * which made a 100-page book take ten human turns.
 */
export interface PendingWork {
  kind: 'long-form' | 'phased';
  /** The ORIGINAL ask, so a batch hours later still restates real intent. */
  goal: string;
  /** Absolute project root. */
  projectPath: string;
  /** What drives the next batch ("continue" resumes the ledger). */
  continuationPrompt: string;
  /** Files that must all exist for the deliverable to count as finished. */
  expectedArtifacts?: string[];
  /** Measured progress, e.g. "chapter 12/39 · 9,800/35,000 words". */
  progressLine: string;
  /** Measured percentage complete. */
  percent: number;
  /** Why it is not finished, in one line. */
  reason: string;
}

/**
 * The plan for authored work, in one shape.
 *
 * Both planning modes feed the same execution path, so the orchestrator does
 * not need to branch on "is this a book or an interactive book" anywhere below
 * the planning step — it just gets steps to run and a ledger to measure.
 */
interface AuthoredPlan {
  steps: TaskStep[];
  /** Measured progress line, e.g. "Chapter 3/39 · 2,700/35,000 words". */
  progressLine: string;
  /** True when the work RESUMED existing content rather than starting fresh. */
  resumed: boolean;
  kind: 'long-form' | 'phased';
  /** One-line description for logs and the agent-results board. */
  label: string;
  /** Files the whole deliverable promises (composite plans only). */
  expectedArtifacts?: string[];
  job: LongFormJob;
  /** The phase plan, when this is a hybrid deliverable. */
  composite?: CompositePlan;
}

/**
 * Telemetry about how the pipeline executed — used by the evaluation
 * framework to measure reliability, recovery behavior, and token efficiency.
 */
export interface ExecutionStats {
  /** Total LLM calls made across all agents */
  llmCalls: number;
  /** Estimated input tokens */
  inputTokens: number;
  /** Estimated output tokens */
  outputTokens: number;
  /** Total repair attempts triggered by the ErrorRepairEngine */
  repairAttempts: number;
  /** Count of 'alternative-approach' repair strategies executed */
  alternativeApproaches: number;
  /** Tasks that failed on first attempt but succeeded after repair */
  recoveredFailures: number;
  /** Total task failures (before repair) */
  taskFailures: number;
  /** Whether the runner auto-installed dependencies */
  dependencyInstallAttempted: boolean;
  /** Whether the dependency install succeeded */
  dependencyInstallSucceeded: boolean;
  /** Number of file changes that were rolled back (reverted to original) */
  rollbackCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Valid per-subtask complexity labels (mirrors ComplexityLevel). */
const VALID_COMPLEXITY = new Set<string>(['trivial', 'simple', 'moderate', 'complex', 'critical']);

// ─── Agent Registry Bridge ───────────────────────────────────────────────────

/**
 * Create an agent instance by looking it up in the ModuleRegistry.
 * Replaces the old hardcoded switch statement.
 */
/** Normalize path separators for deliverable comparison (Windows vs POSIX). */
function normalizeSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

function createAgent(agentType: string, registry: ModuleRegistry): Agent | null {
  try {
    return registry.getModule(agentType);
  } catch {
    return null;
  }
}

/**
 * Default for the iterative tool-calling writer/reviewer (audit W3).
 *
 * The one-shot writer receives the plan + gathered context and must emit the
 * COMPLETE content of every file in a single response — it cannot read the
 * file it is editing, so it rewrites code it has never seen, and a single
 * malformed code fence loses the whole task. `writer-tc`/`reviewer-tc` run a
 * prompt-based read→edit→verify loop instead, which is provider-agnostic (no
 * native function calling required) and is the single largest capability gap
 * between this harness and a fully agentic harness, weak models most of all.
 *
 * It is therefore ON by default; `--no-tool-calling` (CLI) or
 * `useToolCalling: false` (API) restores the one-shot writer.
 */
export const DEFAULT_USE_TOOL_CALLING = true;

/**
 * Resolve the tool-calling writer/reviewer setting from options.
 * Exported so the default is testable without booting an orchestrator.
 */
export function resolveUseToolCalling(options: Pick<OrchestratorOptions, 'useToolCalling'>): boolean {
  return options.useToolCalling ?? DEFAULT_USE_TOOL_CALLING;
}

/**
 * A5 — the trace-capture context for a pipeline HOUSEKEEPING call (the planner,
 * memory retrieval, trajectory summarization, self-improvement), or `null` when
 * the call must NOT be wrapped again.
 *
 * WHY THIS EXISTS. Those calls all run through `defaultCallLLM`, and each used to
 * be wrapped at its use site with no provider/model:
 *  - in AUTO mode `defaultCallLLM` is already traced by `createAutoRoutedLLM`, so
 *    the second wrap logged every housekeeping call TWICE — once routed, once
 *    `unknown/unknown` (the duplicate the planner already guarded against);
 *  - on the EXPLICIT (pinned) path it is raw and must be wrapped — and NAMED, or
 *    the step recorded `unknown/unknown` even though `options.provider/model`
 *    were known, leaving the trace unable to say which model ran.
 * `null` means "already traced — reuse it". The explicit context carries the
 * audit route when one is known; `resolveAuditRoute` is best-effort and leaves
 * its own `unknown` marker when nothing is known, exactly as before.
 */
export function housekeepingTraceContext(
  autoRoutingActive: boolean,
  base: { traceId: string; agentType: string; description: string },
  audit?: { provider?: string; model?: string },
): { traceId: string; agentType: string; description: string; provider?: string; model?: string } | null {
  if (autoRoutingActive) return null;
  const context: { traceId: string; agentType: string; description: string; provider?: string; model?: string } = { ...base };
  if (audit?.provider) context.provider = audit.provider;
  if (audit?.model) context.model = audit.model;
  return context;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

interface RoutingExecutionStrategy {
  effectiveAgentType: string;
  followUpAgentType?: string;
  runSerially: boolean;
  useRepair: boolean;
  maxRepairs: number;
  verificationPass: boolean;
}

export class Orchestrator {
  private configManager: ConfigManager;
  /** The module registry used for agent lookups */
  private moduleRegistry: ModuleRegistry;
  /** The event bus for emitting observability events */
  private eventBus: EventBus;
  /** The report module for generating structured execution reports */
  private reportModule: ReportModule;
  /** Optional routing decision overrides keyed by agent type */
  private routingDecisionOverrides = new Map<string, AutoRouteResult>();
  /**
   * The ROUTED complexity per task (keyed by task id), recorded when the
   * auto-routed LLM is created. The router may escalate complexity itself at
   * resolve time (escalationApplied) — so the FAILED call may have actually
   * run at a higher tier than the raw task.complexity label. Repair escalation
   * must climb from the ROUTED tier, or it can land back on the same tier that
   * just failed (only re-rolling provider/model, not reasoning capacity).
   */
  private routedComplexities = new Map<string, string>();
  /**
   * The provider×model each task was actually ROUTED to (by task id),
   * recorded when the auto-routed LLM is created. The repair path compares
   * this against the ESCALATED decision to detect a no-op escalation (the
   * "stronger model" resolves to the SAME provider×model — only a weak
   * model is available) and degrade to lenient file-change parsing instead
   * of re-prompting the same weak model until the repair budget dies.
   */
  private routedProviderModelByTask = new Map<string, { provider: string; model: string }>();
  /**
   * The provider×model each task's ESCALATED repair resolved to (by task
   * id), recorded by createEscalatedLLM. Compared against the routed baseline
   * in isNoOpEscalation so a repair that lands back on the same weak model is
   * detected without re-resolving the decision (which has side effects).
   */
  private escalatedProviderModelByTask = new Map<string, { provider: string; model: string }>();
  /**
   * The user's weak-model decision for THIS pipeline, latched after the first
   * prompt (routing.promptOnWeakModel) so a multi-task pipeline asks ONCE,
   * not once per task. null = not asked yet; 'continue'/'wait'/'abort' = the
   * user's choice. Silent mode never prompts — this stays null and the
   * pipeline always takes the weak-model path.
   */
  private weakModelChoice: WeakModelChoice | null = null;
  /**
   * Latched one-shot cold-start registry probe: fired once per Orchestrator
   * instance when auto routing is active on an empty registry (see
   * maybeFireColdStartProbe). A long dev-mode session only pays for it once.
   */
  private coldStartProbeFired = false;
  /**
   * P0 reasoning trace: the id of the trace for the CURRENT pipeline (set in
   * execute(), ended in its finally). All LLM calls made while this is set are
   * recorded as steps so `nuvira trace replay <id>` and the dashboard can show
   * exactly which agent × model × prompt produced each result.
   */
  private activeTraceId: string | null = null;

  /**
   * Per-pipeline failure session: the state recordActionFailure mutates when
   * a per-task LLM call fails, and resolveAutoRoutingDecision CONSULTS it
   * before every task (M0.3) — a provider that failed earlier in this pipeline
   * (auth = rest of pipeline, rate-limit/transient = cooldown) never wins a
   * subsequent task; the decision sinks to the best-ranked non-excluded
   * provider. The registry/quota/breaker write-throughs it composes are also
   * read by the router before every task (parked providers sink below healthy
   * ones), so both mechanisms agree.
   */
  private readonly failureSession: FailureSessionState = {
    sessionFailedProviders: new Map(),
    sessionTransientFailedProviders: new Set(),
  };
  /**
   * Re-verify transiently-failed providers and re-admit the ones that recovered.
   *
   * The pipeline allocated `failureSession.sessionTransientFailedProviders` and
   * never read it, so the documented round-trip — "fail → cool down → prove
   * recovery with a 1-token spot-check → route again" — only ever went ONE way
   * here. A provider that recovered mid-run stayed excluded for the rest of the
   * pipeline, which is how a transient 503 ended up degrading a whole run.
   *
   * Called once per task batch (and at pipeline entry), so recovery is discovered
   * between tasks rather than by failing again. Cheap when nothing is pending:
   * the sweep returns immediately on an empty transient set, and a still-active
   * exclusion is skipped without a network call.
   */
  private async sweepTransientProviders(agentType = 'orchestrator'): Promise<string[]> {
    try {
      const result = await sweepTransientFailures(
        sessionRevivalStore(this.failureSession),
        this.configManager,
        { agentType },
      );
      return result.revived;
    } catch {
      // Best-effort — revival must never break the pipeline.
      return [];
    }
  }

  /** Execution telemetry accumulator for the current pipeline */
  private stats: ExecutionStats = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    repairAttempts: 0,
    alternativeApproaches: 0,
    recoveredFailures: 0,
    taskFailures: 0,
    dependencyInstallAttempted: false,
    dependencyInstallSucceeded: false,
    rollbackCount: 0,
  };

  constructor(configManager?: ConfigManager, moduleRegistry?: ModuleRegistry, eventBus?: EventBus, reportModule?: ReportModule) {
    this.configManager = configManager ?? new ConfigManager();
    this.moduleRegistry = moduleRegistry ?? getModuleRegistry();
    this.eventBus = eventBus ?? getEventBus();
    this.reportModule = reportModule ?? new DefaultReportModule(this.eventBus);
  }

  /**
   * Execute a multi-agent pipeline for the given goal.
   *
   * Wraps the pipeline in a try/finally so MCP server connections are torn down
   * on EVERY exit path. Early returns (e.g. planner failure) previously skipped
   * the cleanup at the end of the method, leaking the spawned MCP subprocesses
   * and keeping the CLI process alive long after the pipeline finished.
   */
  async execute(goal: string, options: OrchestratorOptions = {}): Promise<OrchestrationResult> {
    // K1: one pipeline run = one runId on every log line emitted below.
    return withLogCorrelation({ runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` }, () =>
      this.executeCorrelated(goal, options),
    );
  }

  /** The actual pipeline body — wrapped by execute() with a K1 runId. */
  private async executeCorrelated(goal: string, options: OrchestratorOptions = {}): Promise<OrchestrationResult> {
    // Re-admit any provider that recovered since the LAST run before the planner
    // routes: the transient marker is session-scoped, but the registry block it
    // pairs with persists, so a provider proven healthy in a prior run must not
    // stay hidden from this one.
    await this.sweepTransientProviders('planner');

    // P0 reasoning trace: begin the per-pipeline trace so every planner,
    // memory, and task LLM call lands in ~/.nuvira/memory/reasoning-traces.json
    // (best-effort — a trace failure must never break the pipeline).
    // Audit honesty: record the provider×model that will ACTUALLY serve the
    // calls. `options.provider` is undefined whenever the user did not pin one
    // (`nuvira run "…"` with no --provider), and the trace then labelled every
    // step `provider: unknown` — including the writer steps of a live 5-page
    // story run. A trace nobody can attribute is not an audit trail.
    const auditRoute = this.resolveAuditRoute(options);
    this.activeTraceId = beginTrace({
      goal,
      source: 'orchestrator',
      provider: auditRoute.provider,
      model: auditRoute.model,
    });
    let result: OrchestrationResult | undefined;
    try {
      result = await this.executePipeline(goal, options);
      // Phase A2: workspace continuity — record this run in the project
      // registry so the current project's last goal / outcome / session are
      // persisted for `nuvira doctor` and the D1 auto-recall. Best-effort — a
      // workspace write must never break the result delivery.
      try {
        this.configManager.getWorkspaceStore().recordRun({
          cwd: process.cwd(),
          goal,
          summary: result.summary,
          success: result.success,
        });
      } catch {
        // Best-effort — never break the pipeline over a workspace write.
      }
      return result;
    } finally {
      try {
        endTrace(this.activeTraceId, result?.success);
      } catch {
        // Best-effort — never break the result delivery over telemetry.
      }
      // Enterprise G3 — record what this run DID for the next one: the files it
      // changed, whether a verification agent (tester/runner/verifier) ran, and
      // the goal itself (scanned for a regression signal). Best-effort.
      try {
        const changed = result?.changedFiles ?? [];
        const verificationRan = (result?.agentResults ?? []).some(
          (r) => r.success && /test|runner|verif|audit/i.test(r.agent),
        );
        const verifiedAll = result?.success === true && verificationRan;
        recordWorkingState(process.cwd(), {
          filesTouched: changed,
          toolsUsed: ['pipeline'],
          verified: verifiedAll,
          // Per-file mode: this path verifies the RUN as a whole (a test/runner
          // agent ran and the pipeline succeeded), so it either covered every
          // file it changed or none of them. Stated as paths so the ledger's debt
          // is a list of files on both entry points, not a bare count here and a
          // list there.
          verifiedPaths: verifiedAll ? changed : [],
          unverifiedPaths: verifiedAll ? [] : changed,
          unverifiedEdit: changed.length > 0 && !verifiedAll,
          userMessage: goal,
        });
      } catch {
        // Best-effort — a ledger write must never break result delivery.
      }
      this.activeTraceId = null;
      // K2: persist runtime metrics (memory hits/misses, rule/LLM latency)
      // at the end of every pipeline run so nuvira doctor / the dashboard see
      // them in a fresh process.
      try {
        getMetrics().save();
      } catch {
        // Best-effort — a metrics write must never break result delivery.
      }
      try {
        resetMCPManager();
      } catch {
        // Best-effort cleanup — never break the result delivery.
      }
    }
  }

  /** Internal pipeline implementation (see execute()). */
  private async executePipeline(goal: string, options: OrchestratorOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now();
    // ── Checkpoint resume: rehydrate a saved vault instead of starting fresh ──
    // Assessment item #6 (continuity): if a previous run saved a checkpoint for
    // this goal, `--resume` continues from the first pending step — completed
    // steps are never re-run, and the resumed provider/model can differ.
    const checkpointId = checkpointIdFor(goal, process.cwd());
    const resumeId = options.resumeCheckpointId || checkpointId;
    // SAVE checkpoints whenever the user opted in (--checkpoint, or implied by
    // any --resume so a resumed run keeps checkpointing forward — including
    // direct API callers that only set resumeRequested).
    const checkpointEnabled =
      options.checkpoint === true ||
      !!options.resumeCheckpointId ||
      options.resumeRequested === true;
    // ── The work ledger is LOADED AND RECONCILED ON EVERY RUN ────────────────
    // v1.62.4 loaded it only on an explicit `--resume`, and that gate was
    // justified by a real hazard: silently re-entering a COMPLETED plan would
    // skip every task. The hazard is real, but the gate treated the checkpoint's
    // own `completed` flags as proof — and the live NVDA-addon checkpoint said
    // `5/5 completed` while three of those steps had produced nothing, so the
    // one run that should have resumed was the one run forbidden from it. The
    // same plan was then re-planned 18 times.
    //
    // The fix is to make the flags verifiable rather than to keep ignoring them:
    // `reconcileTaskPlan` demotes a "completed" step whose DECLARED files are not
    // on disk, and only then is the checkpoint consulted without being asked.
    //
    //   * explicit --resume        → load whatever is there, reconciled.
    //   * same goal, no --resume   → load the auto-id checkpoint, reconciled;
    //                                continue only if work is genuinely left.
    //   * REWORDED goal            → the auto-id misses (it hashes goal + cwd),
    //                                so fall back to the newest checkpoint for
    //                                this PROJECT. This is what makes "do that
    //                                addon thing again" resume instead of
    //                                re-planning from zero.
    //   * everything verified done → start fresh (the old guard, now earned).
    const resumeWanted = options.resumeRequested === true || !!options.resumeCheckpointId;
    let resumed = false;
    let vault: ContextVault;
    {
      let saved = loadCheckpoint(resumeId);
      let source: 'goal' | 'project' = 'goal';
      if (!saved && !resumeWanted) {
        // A reworded ask hashes to a different id — look for the same ask
        // recorded differently. The goal test is required: taking the newest
        // checkpoint in the directory would hand this run the plan of an
        // unrelated run that merely shared a folder.
        try {
          saved = findRelatedCheckpointFor(process.cwd(), goal, { excludeId: resumeId });
          if (saved) source = 'project';
        } catch {
          saved = null;
        }
      }

      if (!saved) {
        if (resumeWanted) {
          // Resume explicitly requested but no checkpoint found — warn (a
          // reworded goal silently misses the auto id) and start fresh with
          // checkpointing on, so a later crash can still be resumed.
          logger.warn(`   ⚠️ No checkpoint found for '${resumeId}' — starting a fresh pipeline (run with --checkpoint to save one)`);
        }
        vault = new ContextVault(goal, process.cwd());
      } else {
        const firstStep = saved.context.taskPlan.length;
        const { context: reconciledContext, demoted } = reconcileTaskPlan(saved.context, process.cwd());
        const workLeft = demoted.length > 0 || planHasPendingWork(reconciledContext);
        // An explicit resume always continues. An automatic one continues only
        // when reconciliation found real work — a plan that verifies as finished
        // must not be re-entered (that is the hazard the old gate guarded).
        if (resumeWanted || workLeft) {
          vault = ContextVault.fromSnapshot(reconciledContext);
          resumed = true;
          const done = reconciledContext.taskPlan.filter((s) => s.status === 'completed').length;
          if (demoted.length > 0) {
            // Named, never silent: the checkpoint claimed these were done and
            // the filesystem disagrees. That gap IS the bug being fixed.
            logger.warn(
              `   ♻️ Re-opened ${demoted.length} of ${firstStep} step(s) from checkpoint '${saved.id}' — "completed" but the deliverable is not on disk:`,
            );
            for (const d of demoted) logger.warn(`      ⛔ ${d.id}: ${d.reason}`);
          }
          if (options.verbose || demoted.length > 0) {
            logger.info(
              `   ♻️ ${source === 'project' ? 'Continuing this project\'s' : 'Resumed from'} checkpoint '${saved.id}' — ${done}/${reconciledContext.taskPlan.length} steps verified complete`,
            );
          }
        } else {
          // Every declared artifact is on disk — the plan is genuinely finished,
          // so a fresh run starts fresh rather than skipping work it should do.
          if (options.verbose) {
            logger.info(`   ℹ️ Checkpoint '${saved.id}' verifies as complete — starting a fresh plan`);
          }
          vault = new ContextVault(goal, process.cwd());
        }
      }
    }
    // ── Transparency channel ─────────────────────────────────────────────
    // Agents call context.onAgentUpdate() (via Agent.report()) to stream
    // user-readable "thinking" updates. Forward every update to the event bus
    // so the CLI pipeline board and web dashboard can display them live.
    vault.context.onAgentUpdate = (update) => {
      try {
        this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
          agentType: update.agentType,
          stage: update.stage,
          message: update.message,
          taskId: update.taskId,
        }, 'orchestrator');
      } catch {
        // Transparency is best-effort — never break the pipeline.
      }
    };
    // Session 20: seed the RequestContract acceptance criteria into vault
    // metadata so every agent (especially the reviewer verification pass)
    // reads them via context.metadata.acceptanceCriteria. Best-effort.
    if (options.acceptanceCriteria?.length) {
      vault.setMeta('acceptanceCriteria', options.acceptanceCriteria);
    }
    // Reset execution telemetry for this pipeline (shared accumulator used by
    // createLLMProvider, executeSingleTask, and buildResult).
    this.stats = {
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      repairAttempts: 0,
      alternativeApproaches: 0,
      recoveredFailures: 0,
      taskFailures: 0,
      dependencyInstallAttempted: false,
      dependencyInstallSucceeded: false,
      rollbackCount: 0,
    };
    // Auto routing: when the user selected auto (`-m auto` / `nuvira model switch auto`
    // / `--auto-route`), the planner/memory LLM must ALSO be routed through the
    // AutoModelRouter so no call ever sends a literal 'auto' model to a real API.
    // Matches executeSingleTask's rule: an explicit --model always wins.
    const autoRoutingActive = (options.autoRouteModels === true && !options.model) ||
      isAgentAutoRoute(options.provider, options.model);
    // Cold-start learning: when auto routing is active but the registry has ZERO
    // verified providers (fresh install / stale store), fire ONE background probe
    // pass so later tasks in this pipeline — and the next session — route on
    // real health data instead of credential-guessing. Fire-and-forget, latched
    // per instance, never blocks the first planner call. Skipped on RESUME: the
    // checkpointed plan already carries its routing context, so the probe would
    // only burn tokens re-verifying providers a completed run already used.
    if (autoRoutingActive && !resumed) {
      this.maybeFireColdStartProbe();
    }
    // On RESUME the restored vault already carries the routingContext from the
    // original run — recomputing it here would overwrite the checkpointed
    // metadata (and the planner isn't re-run anyway, so the override is moot).
    // No contextHintTokens for the planner: its real payload (file tree, MCP
    // tools, memory) isn't known at resolve time — the tree is built AFTER this
    // call — and a goal-only hint would equal the router's default
    // estimateTokens(description), a no-op. Per-task decisions DO pass the
    // workspace payload estimate (see executeSingleTask), which is where the
    // signal differentiates.
    const plannerRoutingDecision = autoRoutingActive && !resumed
      ? this.resolveAutoRoutingDecision({ agentType: 'planner', description: goal }, options)
      : undefined;
    if (plannerRoutingDecision) {
      // Session 46 — weak-model pre-flight gate: when auto routing lands on a
      // LOCAL model with a low learned score (no verified cloud provider was
      // available at decision time), warn BEFORE the pipeline burns minutes on
      // a model that is likely to fail complex tasks. Observed failure: a 4B
      // local model ran the whole pipeline, the writer silently skipped the
      // real work, and the reviewer blocked the unchanged code 3× — 12m51s
      // wasted. Warning only — the user keeps control and can switch
      // provider/model.
      this.maybeWarnWeakLocalModel(plannerRoutingDecision);
      this.routingDecisionOverrides.set('planner', plannerRoutingDecision);
      // Record the planner's ROUTED provider×model so isNoOpEscalation can
      // compare the escalated decision against it. The planner has NO taskId
      // (the task-keyed map misses it), so without this the no-op guard read
      // an undefined baseline and treated EVERY planner escalation as a no-op
      // — silently killing the planner repair loop under auto routing since
      // the guard landed (observed: deterministic test failure + dead
      // assessment-P0 escalation path).
      this.routedProviderModelByTask.set('planner', {
        provider: plannerRoutingDecision.provider,
        model: plannerRoutingDecision.model,
      });
      vault.setMeta('routingContext', {
        taskProfile: plannerRoutingDecision.taskProfile,
        explanation: plannerRoutingDecision.explanation,
        escalationApplied: plannerRoutingDecision.escalationApplied,
        complexity: plannerRoutingDecision.complexity,
        provider: plannerRoutingDecision.provider,
        model: plannerRoutingDecision.model,
      });
    }
    const defaultCallLLM = autoRoutingActive
      ? this.createAutoRoutedLLM({ agentType: 'planner', description: goal }, options)
      : this.createLLMProvider(options);
    // P0 reasoning trace: the planner + memory + trajectory + self-improver
    // calls share `defaultCallLLM`, so they are wrapped at ONE use-site helper
    // (never at creation) — a task fallback re-uses defaultCallLLM, and wrapping
    // it at creation would record every task call twice (planner and task).
    //
    // A5 — THE HOUSEKEEPING STEPS WERE NOT NAMED, AND IN AUTO MODE WERE LOGGED
    // TWICE. Two facts, one helper:
    //  - When auto-routing is active `defaultCallLLM` is ALREADY traced by
    //    `createAutoRoutedLLM`, so wrapping it again logged each housekeeping
    //    call twice (once 'unknown/unknown', once routed). The planner guarded
    //    against this; memory/trajectory/self-improver did not.
    //  - On the explicit (pinned) path the wrapper carried NO provider/model, so
    //    the step recorded `unknown/unknown` even though the pair was known.
    // Reuse the already-traced LLM when auto-routing, and attribute the step to
    // the audit route otherwise. `resolveAuditRoute` is best-effort and leaves
    // its own 'unknown' marker when nothing is known, exactly as before.
    const housekeepingCallLLM = (agentType: string, description: string): LLMCallFn => {
      const context = housekeepingTraceContext(
        autoRoutingActive,
        { traceId: this.activeTraceId ?? '', agentType, description },
        this.resolveAuditRoute(options),
      );
      return context ? withTraceCapture(defaultCallLLM, context) : defaultCallLLM;
    };
    const plannerCallLLM = housekeepingCallLLM('planner', goal);
    // On resume, seed the report with the steps already finished in the original
    // run (completed/failed) so the final agent breakdown is complete — these
    // steps are never re-executed, but they still count toward the summary.
    const agentResults: OrchestrationResult['agentResults'] = resumed
      ? vault.context.taskPlan
        .filter((s) => s.status === 'completed' || s.status === 'failed')
        .map((s) => ({
          agent: s.agentType,
          success: s.status === 'completed',
          summary: s.result || (s.status === 'completed' ? 'Completed (previous run)' : 'Failed (previous run)'),
        }))
      : [];
    const contextFiles: string[] = [];

    // ── Emit: pipeline started event ───────────────────────────────────
    this.eventBus.emit(EventNames.ORCHESTRATOR_PIPELINE_STARTED, {
      goal,
      provider: options.provider,
      model: options.model,
    }, 'orchestrator');

    // ── 2b. Build project file tree and inject for Planner ────────────────
    if (options.verbose) logger.highlight('\n📂 Scanning project structure...');
    try {
      const fullTree = await buildProjectFileTree(process.cwd());
      // Truncate to 100 lines max to avoid blowing token limits
      const treeForPlanner = truncateTree(fullTree, 100);
      vault.setMeta('projectFileTree', treeForPlanner);
      if (options.verbose) {
        const fileCount = fullTree.split('\n').filter((l) => l.includes('📄')).length;
        logger.info(`   Found ${fileCount} source files in project`);
      }
    } catch (err) {
      logger.debug(`File tree build failed (non-critical): ${err}`);
      vault.setMeta('projectFileTree', '');
    }

    // ── 2b2. Pre-flight project inspection (always-on, deterministic) ─────
    // Look before you leap: detect the project type, existing tests, and git
    // state BEFORE planning so the planner reuses what already exists instead
    // of reworking it, and the user sees a readable summary instead of a
    // black hole. Fast, no LLM calls — pure filesystem + git inspection.
    this.runProjectInspection(vault, options);

    // ── 2c. Auto-connect MCP servers and inject tool descriptions ────────
    const enableMcp = options.enableMcp !== false; // default true
    if (enableMcp && options.verbose) logger.highlight('\n🔌 Discovering MCP servers...');
    if (enableMcp) try {
      const mcpManager = getMCPManager();
      const configs = mcpManager.discoverConfigs();

      if (configs.length > 0) {
        if (options.verbose) {
          logger.info(`   Found ${configs.length} MCP server config(s)`);
        }

        const connected = await mcpManager.connectAll();

        if (connected.length > 0) {
          const allTools = mcpManager.getAllTools();
          const toolEntries: McpToolEntry[] = allTools.map((t) => ({
            server: t.server,
            tool: {
              name: t.tool.name,
              description: t.tool.description,
              inputSchema: t.tool.inputSchema,
            },
          }));

          // Store both the raw tool entries (for programmatic access)
          vault.setMeta('mcpTools', toolEntries);
          // And a formatted string (for LLM prompt injection)
          const formattedTools = formatMcpToolsForPrompt(toolEntries);
          vault.setMeta('mcpToolsFormatted', formattedTools);
          this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
            agentType: 'orchestrator',
            stage: 'mcp',
            message: `Connected to ${connected.length} MCP server(s) with ${allTools.length} tool(s)`, 
          }, 'orchestrator');

          if (options.verbose) {
            logger.info(`   Connected to ${connected.length} MCP server(s) with ${allTools.length} tool(s)`);
          }
        } else if (options.verbose) {
          logger.info('   No MCP servers could be connected');
        }
      } else if (options.verbose) {
        logger.info('   No MCP server configs found (see ~/.nuvira/mcp/)');
      }
    } catch (err) {
      logger.debug(`MCP auto-connect failed (non-critical): ${err}`);
    } else if (options.verbose) {
      logger.info('   MCP disabled (enableMcp: false)');
    }

    // ── 3. Memory Retrieval ──────────────────────────────────────────────
    let memoryContext = '';

    if (options.useMemory) {
      if (options.verbose) logger.highlight('\n🔍 Searching memory for similar past tasks...');
      let patternContext = '';
      let failureLessonContext = '';
      let factContext = '';
      try {
        // Phase B2: route memory recall through the MemoryManager so the
        // active provider (local today, Mem0 later) builds the persistent-
        // memory block. Identical recall underneath (retrieveMemoryContext),
        // plus the is_trivial_prompt gate — a one-word goal returns empty
        // without touching the stores.
        const { getMemoryManager } = await import('../memory/manager.js');
        const memoryResult = await getMemoryManager().buildMemoryBlock(
          goal,
          housekeepingCallLLM('memory', `Memory retrieval for: ${goal.slice(0, 80)}`),
        );
        // The manager composes the FULL persistent-memory block (provider's
        // static system block framing the per-field recall). Consume it
        // directly — the old re-composition here was redundant work.
        memoryContext = memoryResult.block;
        // Keep the individual contexts for vault meta (dashboard/audit view).
        patternContext = memoryResult.patternContext || '';
        failureLessonContext = memoryResult.failureLessonContext || '';
        factContext = memoryResult.factContext || '';
        this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
          agentType: 'orchestrator',
          stage: 'memory',
          message: memoryResult.trajectories.length > 0
            ? `Found ${memoryResult.trajectories.length} similar past task(s) in memory`
            : 'No similar past tasks found in memory',
        }, 'orchestrator');
        if (options.verbose) {
          if (memoryResult.trajectories.length > 0) {
            logger.info(`   Found ${memoryResult.trajectories.length} similar past trajectories`);
          } else {
            logger.info('   No similar past tasks found in memory');
          }
          if (failureLessonContext) {
            logger.info('   🛡️ Injected failure lessons — planner will avoid past mistakes');
          }
          // Transparency: surface which vector backend served the cross-session
          // semantic search (faiss-native / faiss-ivf / json) so users can see
          // the FAISS-style backend is active for trajectory memory.
          try {
            const { getVectorStore } = await import('../memory/vector-store.js');
            logger.info(`   🧠 Cross-session memory backend: ${await getVectorStore().backendName()}`);
          } catch {
            // Best-effort — backend name is diagnostics-only.
          }
        }
      } catch (err) {
        logger.debug(`Memory retrieval failed: ${err}`);
      }
      // Inject memory context, patterns, and failure lessons into vault for
      // agents. The composed block already contains every non-empty part, so
      // there is no re-composition here.
      // D1: agent-driven recall context (continue/resume) — prepended so the
      // planner sees the recalled project state before the memory block.
      if (options.recallContext) {
        memoryContext = options.recallContext + (memoryContext ? `\n\n${memoryContext}` : '');
      }

      if (memoryContext) {
        vault.setMeta('memoryContext', memoryContext);
      }
      if (patternContext) {
        vault.setMeta('patternContext', patternContext);
      }
      if (failureLessonContext) {
        vault.setMeta('failureLessonContext', failureLessonContext);
      }
      if (factContext) {
        vault.setMeta('factContext', factContext);
      }
    }

    // ── 2d. Log MCP tools availability ───────────────────────────────────
    const mcpToolCount = (vault.getMeta<McpToolEntry[]>('mcpTools') || []).length;
    if (mcpToolCount > 0 && options.verbose) {
      logger.info(`   ${mcpToolCount} MCP tool(s) available via ${(vault.getMeta<any>('mcpToolsFormatted') || '').includes('Server:') ? 'connected servers' : 'discovered configs'}`);
    }

    // ── 3b. Auto-route models ─────────────────────────────────────────────
    // `--auto-route` / autoRouteModels enables per-task AutoModelRouter
    // routing in executeSingleTask (no static map needed).

    // ── 3c. Skill discovery (MODEL-DRIVEN) ──────────────────────────────────
    // This step used to KEYWORD-MATCH one skill to the goal (findMatch +
    // findHubSkillMatch, then the isSkillActivated evidence filter) and inject
    // its methodology. That shipped a hand-written stopword/generic-word/host
    // list that kept getting a case wrong ("blood test report" → the software
    // test-strategy skill; "Windows and Linux" → wsl-setup). Word matching
    // cannot decide what a goal MEANS, so it is gone from the pipeline too:
    // the planner is a MODEL, so it is handed the CATALOG and picks the skill
    // (by name) that fits, and the writer can load one in full with
    // skill_view(name). The disabled gate still applies at catalog build time.
    // Best-effort — a skill-store failure must never break planning.
    try {
      const { buildConfiguredSkillHint } = await import('../tools/loop-skill-hint.js');
      // `skill-view` tail: the pipeline's load path is the writer's skill_view,
      // not the loop's skill tool.
      const skillCatalog = await buildConfiguredSkillHint(this.configManager, { loadHint: 'skill-view' });
      if (skillCatalog) {
        vault.setMeta('skillCatalog', skillCatalog);
        this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
          agentType: 'orchestrator',
          stage: 'skill',
          message: '🧠 Handing the planner the skill catalog — the model picks which skill (if any) a step needs',
        }, 'orchestrator');
      }
    } catch {
      // Best-effort — skill discovery must never break the pipeline.
    }

    // ── 4. Planner (or pre-built plan from workflow template) ────────────
    // When resuming from a checkpoint the plan is already in the vault — skip
    // the planner entirely (no re-plan, no re-gather) and continue execution.
    if (resumed && vault.context.taskPlan.length > 0) {
      if (options.verbose) {
        logger.highlight('\n♻️  Resuming existing plan from checkpoint...');
        for (const step of vault.context.taskPlan) {
          const icon = step.status === 'completed' ? '✅' : step.status === 'failed' ? '❌' : '⏳';
          logger.info(`      ${icon} [${step.agentType}] ${step.description}`);
        }
      }
    } else if (options.prefillPlan && options.prefillPlan.length > 0) {
      for (const step of options.prefillPlan) {
        vault.context.taskPlan.push({ ...step });
      }
      agentResults.push({ agent: 'Planner', success: true, summary: `Using pre-built '${options.prefillPlan.length}-step' workflow plan` });
      if (options.verbose) {
        logger.highlight('\n📋 Using workflow template plan...');
        logger.info(`   Using ${options.prefillPlan.length} pre-defined steps`);
        for (const step of options.prefillPlan) {
          logger.info(`      [${step.agentType}] ${step.description}`);
        }
      }
    } else {
      // ── AUTHORED DELIVERABLES plan themselves — BEFORE the design layers ──
      // The planner's output for "write a 100-page story" was a Python script
      // that would write the story: ZERO prose steps, and the failing run died
      // before even that script existed. Two conclusions follow, and both are
      // why this is computed FIRST rather than after planning:
      //   1. the unit plan IS the plan for an authored ask — the code planner
      //      has no vocabulary for "39 chapters", so its output is replaced;
      //   2. a planner failure must not sink a story. The live session's six
      //      failures were all JSON/planning-layer deaths; a book does not need
      //      the planner to exist, so it is no longer a dependency of one.
      //
      // G14 — it also runs before the REASONER now, because whether this run is
      // CONTINUING work that is already in flight decides whether the design
      // layers run at all (see below).
      const priorAuthoredJob = this.findInFlightAuthoredJob(vault);
      let longFormPlan: AuthoredPlan | null = null;
      try {
        longFormPlan = this.planAuthored(vault, goal, options);
      } catch (err) {
        // Best-effort — a long-form planning failure must never break the run.
        logger.debug(`long-form planning failure: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── G14: a CONTINUATION batch does not re-decide the design ──────────
      // Continuing an in-flight authored job re-derives the unit/phase plan from
      // the ledger and REPLACES whatever the reasoner and planner produce — the
      // deliverable class is in the ledger, the structure is a deterministic
      // function of it, and nothing about the design is still open. Running them
      // anyway costs two LLM round trips per batch and, worse, adds a failure
      // surface the plan does not need: live evidence from the unattended web-book
      // run shows the planner failing with `provider-error` on EVERY batch from
      // batch 4 onward and burning its entire repair budget before the real work
      // started. Both layers are now skipped, and the skip is REPORTED rather
      // than hidden — "no planner was needed" is a fact about the run.
      //
      // Scoped deliberately to CONTINUATIONS. A first, fresh authored ask still
      // runs both: that is the one run where the class is being established, and
      // it is a single batch, not one per batch.
      const continuingAuthored = !!(longFormPlan && priorAuthoredJob);

      // ── 3d. Reasoner (technical decisions before planning) ─────────────
      // The reasoner makes high-level technical decisions (language, framework,
      // platform, architecture) BEFORE the planner creates steps. This replaces
      // generic "create a game" with specific "Create a Python+tkinter game,
      // single file, package with pyinstaller" — the planner then creates
      // precise steps based on these decisions.
      if (continuingAuthored) {
        agentResults.push({
          agent: 'Reasoner',
          success: true,
          summary: 'Skipped — continuing in-flight authored work (the deliverable class is already decided)',
        });
        if (options.verbose) {
          logger.info('   ⏭️  Continuing in-flight authored work — reasoner skipped');
        }
      } else {
        try {
          if (options.verbose) logger.highlight('\n🧠 Reasoning...');
          const reasoner = this.moduleRegistry.getModule('reasoner');
          const reasonerResult = await this.runAgent(reasoner, vault, plannerCallLLM, options);
          agentResults.push({ agent: 'Reasoner', success: reasonerResult.success, summary: reasonerResult.summary });
          if (options.verbose && reasonerResult.success) {
            const decision = vault.getMeta<import('./agents/reasoner.js').TechnicalDecision>('technicalDecision');
            if (decision) {
              logger.info(`   🧠 ${decision.language}+${decision.framework} → ${decision.platform} → ${decision.deliverable}`);
              if (decision.reasoning) logger.info(`   🧠 ${decision.reasoning}`);
            }
          }
          // Best-effort — reasoning failure must never block planning
        } catch (err) {
          logger.debug(`Reasoner failed (non-critical): ${err}`);
        }
      }

      if (options.verbose && !continuingAuthored) logger.highlight('\n📋 Planning...');

      // Planner with auto-repair — if planning fails, try alternative approaches
      // instead of immediately giving up with "Planning failed".
      // (Skipped on a continuation; the synthesized result is a RECORD of that,
      // not a claim that planning succeeded — see the summary text.)
      let planResult: AgentResult = continuingAuthored
        ? {
            success: true,
            summary: 'Skipped — continuing in-flight authored work (the unit plan is the plan)',
          }
        : await this.runAgent(this.moduleRegistry.getModule('planner'), vault, plannerCallLLM, options);
      if (!planResult.success) {
        // MODEL ESCALATION on planner failure (assessment P0: "deliver the
        // goal, complete the task in iterations"). A planner failure is almost
        // always the routed model being too weak to produce a faithful plan
        // (garbage JSON, or regurgitating the few-shot example). Re-route the
        // repair attempts through the Auto router at the NEXT complexity level
        // so it picks a STRONGER model — re-prompting the same weak model (the
        // old behavior) just repeats the same failure until the budget dies.
        // Non-auto paths keep the same provider/model but honor explicit
        // repairFallbackModels for the switch-model strategy.
        const escalatedPlannerLLM = autoRoutingActive
          ? this.createEscalatedPlannerLLM(goal, options)
          : undefined;
        // NO-OP ESCALATION GUARD (planner): when the "escalated" planner LLM
        // resolves to the SAME provider×model as the one that just failed (every
        // stronger candidate is rate-limited or unavailable), escalation would
        // just re-prompt the same model until the repair budget dies. Detect
        // this and skip the repair entirely — the planner failure is real and
        // not recoverable with the same or weaker model.
        const plannerEscalationIsNoOp = autoRoutingActive
          && escalatedPlannerLLM
          && this.isNoOpEscalation('planner', this.escalatedProviderModelByTask.get('planner'));
        if (plannerEscalationIsNoOp) {
          if (options.verbose) {
            logger.warn('      ⚠️ No stronger model available for planner repair (escalation is a no-op) — skipping repair loop');
          }
          // Don't enter the repair loop at all — waste 0 tokens.
        } else {
          const plannerRepair = new ErrorRepairEngine({
            maxRepairs: 3,
            repairMode: 'auto',
            verbose: options.verbose,
            fallbackModels: options.repairFallbackModels,
            // LLM AVAILABILITY GUARD: check if the escalated planner's provider
            // is rate-limited before retrying. Prevents retry-tool and
            // alternative-approach from hitting the same 429 until the budget dies.
            isLLMAvailable: autoRoutingActive ? () => {
              const escalated = this.escalatedProviderModelByTask.get('planner');
              if (!escalated) return true; // no escalation info — assume available
              const expiresAt = this.failureSession.sessionFailedProviders.get(escalated.provider);
              return !expiresAt || expiresAt <= Date.now();
            } : undefined,
          });
          if (options.verbose) {
            logger.info('      🔧 Planner failed — attempting auto-repair with a stronger model');
          }
          const planner = this.moduleRegistry.getModule('planner');
          planResult = await plannerRepair.repair(
            'planner',
            vault.context,
            escalatedPlannerLLM ?? plannerCallLLM,
            planResult.error || planResult.summary || 'Planning failed',
            async (ctx, llm) => planner.execute(ctx, llm),
          );
          this.stats.repairAttempts += plannerRepair.budget.getAttempts('planner');
          this.stats.alternativeApproaches += plannerRepair.alternativeApproaches;
        }
        this.stats.taskFailures += 1;
        if (planResult.success) this.stats.recoveredFailures += 1;
      }
      agentResults.push({ agent: 'Planner', success: planResult.success, summary: planResult.summary });

      if (longFormPlan) {
        // The unit/phase plan IS the plan. Adopt it whether or not the code
        // planner succeeded — and REPLACE a code plan when it did, because the
        // planner CANNOT express this deliverable correctly (it asks for a
        // script that would write the story instead of writing the story).
        vault.context.taskPlan = longFormPlan.steps;
        agentResults.push({
          agent: longFormPlan.kind === 'phased' ? 'CompositePlanner' : 'LongFormPlanner',
          success: true,
          summary: `${longFormPlan.steps.length} step(s) planned${longFormPlan.resumed ? ' (resumed)' : ''} — ${longFormPlan.label}`,
        });
        logger.info(`   ${longFormPlan.kind === 'phased' ? '🛠️' : '📖'} ${longFormPlan.kind === 'phased' ? 'Composite plan' : 'Long-form plan'}: ${longFormPlan.label}`);
        if (!planResult.success) {
          logger.warn('   ⚠️ Planner failed — continuing with the content plan (no planner needed for an authored deliverable)');
        }
      } else if (!planResult.success) {
        const errMsg = planResult.error || 'Planning failed';
        // Provide actionable guidance based on the error type.
        let hint = '';
        if (/413|too large|token.*limit|TPM/i.test(errMsg)) {
          hint = ' The prompt is too large for this model. Try: (1) add API keys for larger models (openai, anthropic), (2) reduce the project scope.';
        } else if (/429|rate.?limit/i.test(errMsg)) {
          hint = ' All available providers are rate-limited. Wait a few minutes or add more provider API keys.';
        } else if (/no valid task steps|plan.*empty/i.test(errMsg)) {
          hint = ' The model could not produce a valid plan. Try rephrasing the goal more specifically.';
        }
        return this.buildResult(false, goal, agentResults, vault, {
          error: errMsg + hint,
        });
      }

      if (vault.context.taskPlan.length === 0) {
        return this.buildResult(false, goal, agentResults, vault, {
          error: 'Planner did not produce a valid task plan',
        });
      }

      const routingContext = vault.getMeta<{ taskProfile?: { requiresVerification?: boolean; notes?: string[] } }>('routingContext');
      this.applyRoutingPlanAdjustments(vault, routingContext);

      if (options.verbose) {
        logger.info(`   Created ${vault.context.taskPlan.length} task steps`);
        for (const step of vault.context.taskPlan) {
          logger.info(`      [${step.agentType}] ${step.description}`);
        }
      }

      // Prune context after the Planner produces the plan
      this.pruneContext(vault, options);
    }

    // ── 4b. Label every step with a per-subtask complexity bucket ──────
    // Assessment item #1: subtasks carry a complexity label so Auto routing
    // is subtask-local, not goal-global. Trust the planner's label when valid;
    // otherwise derive deterministically from the step description so every
    // step is ALWAYS labeled.
    for (const step of vault.context.taskPlan) {
      if (!step.complexity || !VALID_COMPLEXITY.has(step.complexity)) {
        step.complexity = analyzeComplexity(step.description);
      }
    }

    // ── 4b. Push initial DAG state to dashboard ─────────────────────────
    if (vault.context.taskPlan.length > 0) {
      await tryResetDAG();
      const nodes = vault.context.taskPlan.map((step) => ({
        id: step.id,
        agentType: step.agentType,
        status: 'pending' as const,
        description: step.description,
        complexity: step.complexity,
      }));
      const edges: Array<{ from: string; to: string }> = [];
      for (const step of vault.context.taskPlan) {
        for (const dep of step.dependsOn) {
          edges.push({ from: dep, to: step.id });
        }
      }
      await tryPushDAG({
        pipelineId: goal,
        pipelineDescription: goal.slice(0, 80),
        nodes,
        edges,
      });

      // ── Emit: plan ready (the CLI board renders the task list from this) ──
      const rootCount = nodes.filter((n) => !edges.some((e) => e.to === n.id)).length;
      this.eventBus.emit(EventNames.ORCHESTRATOR_PLAN_READY, {
        pipelineId: goal,
        nodes: nodes.map(({ id, agentType, description, complexity }) => ({ id, agentType, description, complexity })),
        edges,
        parallelCount: rootCount,
      }, 'orchestrator');
      this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
        agentType: 'orchestrator',
        stage: 'planned',
        message: `${nodes.length} step(s) planned${rootCount > 1 ? ` — ${rootCount} can start in parallel` : ''}`,
      }, 'orchestrator');
    }

    // ── 5. Execute tasks ─────────────────────────────────────────────────
    if (options.verbose) logger.highlight('\n⚡ Executing tasks...');

    // Update spinner to show we've moved past planning into execution
    if (options.spinner && vault.context.taskPlan.length > 0) {
      const total = vault.context.taskPlan.length;
      options.spinner.start(`⚡ Executing ${total} task${total !== 1 ? 's' : ''}...`);
    }

    for (let iteration = 0; iteration < 50; iteration++) {
      if (vault.isComplete) break;

      const runnableTasks = vault.getRunnableTasks();
      const routingContext = vault.getMeta<{ taskProfile?: { intent?: string; requiresVerification?: boolean } }>('routingContext');
      const taskStrategies = runnableTasks.map((task) => ({
        task,
        strategy: this.getExecutionStrategy(task, routingContext),
      }));

      // Prune context before executing the next batch of tasks
      this.pruneContext(vault, options);

      // Set Docker sandbox flag so RunnerAgent and TesterAgent know to use containers
      if (options.useDockerSandbox) {
        vault.setMeta('useDockerSandbox', true);
      }
      if (runnableTasks.length === 0 && !vault.isComplete) {
        const stuck = vault.context.taskPlan.filter((s) => s.status === 'pending');
        for (const s of stuck) {
          const failedDep = vault.context.taskPlan.find(
            (d) => s.dependsOn.includes(d.id) && d.status === 'failed',
          );
          const reason = failedDep
            ? `Dependency failed: ${failedDep.id} (${failedDep.description.slice(0, 60)})`
            : 'Deadlocked: dependencies could not be satisfied';
          vault.updateTaskStatus(s.id, 'failed', reason);
        }
        break;
      }

      // Runner and sandbox agents need exclusive access (no parallel).
      // Conservative parallelism (recommended): independent tasks — gatherers,
      // writers, reviewers — run in PARALLEL within a batch,
      // while tester/debugger/runner (and any strategy-marked serial step) run
      // one at a time because they share files, commands, ports, and sandboxes.
      const exclusiveAgentTypes = ['tester', 'debugger', 'runner'];
      const parallelGroup: Array<{ task: TaskStep; strategy: RoutingExecutionStrategy }> = [];
      const serialGroup: Array<{ task: TaskStep; strategy: RoutingExecutionStrategy }> = [];
      for (const { task, strategy } of taskStrategies) {
        if (strategy.runSerially || exclusiveAgentTypes.includes(task.agentType)) {
          serialGroup.push({ task, strategy });
        } else {
          parallelGroup.push({ task, strategy });
        }
      }

      // ── Re-verify before re-admit, once per BATCH ────────────────────────
      // A provider that failed transiently earlier in this pipeline is only
      // re-admitted once a spot-check proves it is back. Re-checking per batch
      // (not per task) bounds the cost: a batch is already the fan-out unit, and
      // the sweep no-ops when no exclusion has expired.
      await this.sweepTransientProviders();

      // Mark every runnable task as running up front so the live board shows
      // the whole batch (and its parallel lanes) at once.
      for (const { task } of taskStrategies) {
        vault.updateTaskStatus(task.id, 'running');
      }

      if (parallelGroup.length > 0) {
        if (parallelGroup.length > 1) {
          if (options.verbose) {
            logger.info(`\n   ⚡ Running ${parallelGroup.length} independent tasks in parallel...`);
          }
          this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
            agentType: 'orchestrator',
            stage: 'parallel',
            message: `Running ${parallelGroup.length} independent tasks in parallel`, 
          }, 'orchestrator');
        }
        // G3 — LIVE fan-out. The old `Promise.all` over a fixed batch left a
        // task that a just-finished sibling UNBLOCKED sitting idle until every
        // other sibling settled. `runLiveFanout` re-polls the runnable set as
        // each task settles and promotes newly unblocked, non-exclusive work
        // into the same batch while a lane is free. Default concurrency = the
        // initial group size, so the first wave is unchanged.
        const parallelStrategyById = new Map(parallelGroup.map(({ task, strategy }) => [task.id, strategy]));
        const isExclusiveTask = (task: TaskStep): boolean =>
          exclusiveAgentTypes.includes(task.agentType) ||
          this.getExecutionStrategy(task, routingContext).runSerially;
        const fanout = await runLiveFanout<TaskStep>({
          initial: parallelGroup.map(({ task }) => task),
          poll: () => vault.getRunnableTasks(),
          isExclusive: isExclusiveTask,
          run: (task) =>
            this.executeSingleTask(
              task,
              vault,
              options,
              agentResults,
              contextFiles,
              defaultCallLLM,
              parallelStrategyById.get(task.id) ?? this.getExecutionStrategy(task, routingContext),
            ),
          // A promoted task missed the up-front "mark running" sweep above, so
          // the live board would show it pending until it finished. Mark it as
          // it is admitted (idempotent for the initial wave).
          onAdmit: (task) => vault.updateTaskStatus(task.id, 'running'),
        });
        if (fanout.promoted.length > 0) {
          if (options.verbose) {
            logger.info(
              `   ⚡ ${fanout.promoted.length} newly unblocked task(s) promoted into the same batch`,
            );
          }
          this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
            agentType: 'orchestrator',
            stage: 'parallel',
            message: `Filled freed lane(s) with ${fanout.promoted.length} newly unblocked task(s)`,
          }, 'orchestrator');
        }
      }

      for (const { task, strategy } of serialGroup) {
        await this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM, strategy);
      }

      // ── Checkpoint after every task batch ──────────────────────────────
      // Persist the vault (per-step statuses, artifacts, file changes) so a
      // crash / quota kill / token expiry mid-pipeline can `--resume` from
      // here instead of restarting the whole plan (assessment item #6).
      // Guarded by !vault.isComplete: in-progress states are saved per batch,
      // and the terminal state is persisted once by the final save below —
      // no redundant double-write on the completing iteration.
      if (checkpointEnabled && !vault.isComplete) {
        try {
          const cid = saveCheckpoint(vault.context, resumeId);
          if (cid && options.verbose) {
            const done = vault.context.taskPlan.filter((s) => s.status === 'completed').length;
            logger.debug(`   💾 Checkpoint saved (${cid}): ${done}/${vault.context.taskPlan.length} steps complete`);
          }
        } catch {
          // Best-effort — checkpointing must never break the pipeline
        }
      }
    }

    // ── 5b. Final checkpoint (pipeline completing) ────────────────────────
    // Save once more after the loop so the newest on-disk checkpoint reflects
    // the COMPLETED state (including the final batch). Without this, the last
    // saved checkpoint would show the final step still 'pending', and a
    // --resume after a successful run would re-execute it.
    //
    // ALSO saved when the run ends with work UNFINISHED, whether or not the user
    // opted into checkpoints. A failed step, or a "completed" step whose declared
    // deliverable is not on disk (see `reconcileTaskPlan`), means the ledger is
    // the only thing standing between this run and the next one re-deriving the
    // whole plan — which is exactly what happened 18 times on the live NVDA
    // add-on ask. Bounded on purpose: a run that finished cleanly and opted out
    // writes nothing, so the store does not grow on every invocation.
    let persistLedger = checkpointEnabled;
    if (!persistLedger) {
      try {
        const { demoted } = reconcileTaskPlan(vault.context, process.cwd());
        persistLedger = vault.hasFailedTasks || demoted.length > 0;
        if (persistLedger && options.verbose) {
          logger.info(
            `   💾 Work is unfinished (${vault.hasFailedTasks ? 'a step failed' : `${demoted.length} step(s) missing their deliverable`}) — saving the ledger for the next run`,
          );
        }
      } catch {
        // Best-effort — the ledger must never break result delivery.
      }
    }
    if (persistLedger) {
      try {
        const cid = saveCheckpoint(vault.context, resumeId);
        if (cid && options.verbose) {
          const done = vault.context.taskPlan.filter((s) => s.status === 'completed').length;
          logger.debug(`   💾 Final checkpoint saved (${cid}): ${done}/${vault.context.taskPlan.length} steps complete`);
        }
      } catch {
        // Best-effort — checkpointing must never break the pipeline
      }
    }

    // ── 6. Clean up sandbox if any ────────────────────────────────────────
    const sandboxPath = vault.getMeta<string>('sandboxPath');
    if (sandboxPath) {
      try {
        cleanupSandbox(sandboxPath);
      } catch {
        // Best-effort cleanup
      }
    }

    // ── 6b. Review mode — create a review bundle instead of applying changes
    let reviewId: string | undefined;
    if (options.reviewMode && vault.context.fileChanges.filter(c => c.newContent || c.status === 'deleted').length > 0) {
      const fileChanges = vault.context.fileChanges.map((c) => ({
        path: c.path,
        originalContent: c.originalContent,
        newContent: c.newContent,
        status: c.status,
      }));

      // Build a summary from agent results
      const summaryLines = agentResults.map((r) => `${r.success ? '✅' : '❌'} ${r.agent}: ${r.summary.slice(0, 120)}`);
      summaryLines.push('');
      summaryLines.push(vault.getDiffSummary());
      const fullSummary = summaryLines.join('\n');

      const review = createReviewFromResult(goal, fileChanges, fullSummary, {
        provider: options.provider,
        model: options.model,
        author: process.env.USER || 'agent-nuvira',
      });

      reviewId = review.id;

      if (options.verbose) {
        logger.highlight(`\n📋 Created review bundle: ${review.id}`);
        logger.info(`   Run \`nuvira team review show ${review.id}\` to view`);
        logger.info(`   Run \`nuvira team review approve ${review.id}\` then \`nuvira team review merge ${review.id}\` to apply`);
      }
    }

    // ── 6c. Apply file changes ────────────────────────────────────────────
    if (!options.reviewMode && !options.dryRun) {
      const applied = this.applyFileChanges(vault);
      if (applied > 0) {
        this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
          agentType: 'orchestrator',
          stage: 'applied',
          message: `Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`, 
        }, 'orchestrator');
        if (options.verbose) {
          logger.success(`\n   💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`);
        }
      }
    } else if (options.verbose && options.reviewMode) {
      logger.info('   📋 Review mode — changes saved as review bundle instead of written to disk');
    }

    // ── 6d. Collect runner output for display ────────────────────────────
    let runOutput: string | undefined;
    const runResult = vault.getMeta<RunResult>('runResult');
    if (runResult) {
      const lines: string[] = [];
      lines.push(`$ ${runResult.command}`);
      lines.push(`Exit code: ${runResult.exitCode} | Duration: ${runResult.duration}ms`);
      if (runResult.stdout) {
        lines.push('');
        lines.push(runResult.stdout.slice(0, 2000)); // Limit displayed output
        if (runResult.stdout.length > 2000) {
          lines.push('... (output truncated)');
        }
      }
      if (runResult.stderr && runResult.exitCode !== 0) {
        lines.push('');
        lines.push('stderr:');
        lines.push(runResult.stderr.slice(0, 1000));
      }
      runOutput = lines.join('\n');

      // Capture dependency-install telemetry from the runner
      this.stats.dependencyInstallAttempted = this.stats.dependencyInstallAttempted || runResult.dependencyInstallAttempted === true;
      this.stats.dependencyInstallSucceeded = this.stats.dependencyInstallSucceeded || runResult.dependencyInstallSucceeded === true;
    }

    // ── 7. Store trajectory in memory + self-improvement loop ───────────
    let trajectoryId = '';
    if (options.useMemory) {
      try {
        const orchestrationSummary = {
          success: !vault.hasFailedTasks,
          goal,
          summary: '',
          tasksCompleted: vault.context.taskPlan.filter((s) => s.status === 'completed').length,
          tasksTotal: vault.context.taskPlan.length,
          agentResults,
          fileChanges: vault.getDiffSummary(),
          taskPlan: vault.context.taskPlan,
        };

        const { storeExecutionTrajectory } = await import('../memory/memory-integration.js');
        trajectoryId = await storeExecutionTrajectory(
          orchestrationSummary,
          housekeepingCallLLM('memory', `Trajectory summarization for: ${goal.slice(0, 80)}`),
          vault.context.taskPlan,
          contextFiles,
          options.verbose,
        );

        // Self-improvement
        try {
          const { getSelfImprover } = await import('../learning/self-improver.js');
          const improver = getSelfImprover();
          await improver.processRun(
            { ...orchestrationSummary, trajectoryId },
            housekeepingCallLLM('self-improver', `Pattern/failure-lesson extraction for: ${goal.slice(0, 80)}`),
            options.agentModels as Record<string, string> | undefined,
            options.verbose,
          );

          if (options.verbose && trajectoryId) {
            logger.info('   Self-improvement stats saved. Run `nuvira learn optimize` to see recommendations.');
          }
        } catch (err) {
          logger.debug(`Self-improvement loop failed: ${err}`);
        }
      } catch (err) {
        logger.debug(`Trajectory storage failed: ${err}`);
      }
    }

    // ── 8. Synthesize result ─────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const completed = vault.context.taskPlan.filter((s) => s.status === 'completed').length;
    const total = vault.context.taskPlan.length;
    const hasFailures = vault.hasFailedTasks;

    // Count rollbacks: file changes that were reverted to their original content
    this.stats.rollbackCount = vault.context.fileChanges.filter(
      (c) => c.status === 'modified' && c.newContent !== undefined && c.newContent === c.originalContent,
    ).length;

    // ── Emit: pipeline completed event ────────────────────────────────
    this.eventBus.emit(EventNames.ORCHESTRATOR_PIPELINE_COMPLETED, {
      goal,
      success: !hasFailures,
      tasksCompleted: completed,
      tasksTotal: total,
      durationMs: Date.now() - startTime,
    }, 'orchestrator');

    // ── Learning loop: create skills from successful complex tasks ────
    // After a successful pipeline, check if the task was complex enough to
    // warrant creating a reusable skill. This is the Hermes pattern: skills
    // self-improve during use, and complex tasks produce new skills.
    if (!hasFailures && completed >= 3) {
      this.postPipelineLearning(goal, vault, options).catch(() => {
        // Best-effort — learning must never break the pipeline result
      });
    }

    // ── Generate structured report via ReportModule ──────────────────
    const report = await this.reportModule.generate({
      goal,
      agentResults,
      fileChanges: vault.context.fileChanges.map((c) => ({
        path: c.path,
        status: c.status,
      })),
      hasFailures,
      durationMs: Date.now() - startTime,
      runOutput,
      error: undefined,
      trajectoryId,
      reviewId,
    });

    // Format as text for the result summary
    const reportText = this.reportModule.format(report, 'text');

    // ── Long-form work: state what EXISTS, not just whether the batch ran ──
    // A 100-page book cannot finish in one run, so "success" for the batch is
    // NOT "the deliverable is done". This appends the honest progress line
    // (units written, words on disk, how to continue) that the original six
    // failing runs never produced.
    const longFormSummary = this.longFormProgressNote(vault);

    return this.buildResult(!hasFailures, goal, agentResults, vault, {
      summary: longFormSummary ? `${reportText}\n\n${longFormSummary}` : reportText,
      tasksCompleted: completed,
      tasksTotal: total,
      trajectoryId,
      reviewId,
      runOutput,
      stats: this.stats,
    });
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Session 46 — weak-model pre-flight warning (extracted for testability).
   *
   * When auto routing resolves to a LOCAL model with a low learned score
   * (score < 0.5), no verified cloud provider was available at decision
   * time. Warn BEFORE the pipeline burns minutes on a model that is likely
   * to fail complex tasks. Warning only — the user keeps control.
   */
  private maybeWarnWeakLocalModel(decision: AutoRouteResult): void {
    // B2 — CAPABILITY-based, not locality-based. Prefer the router's own verdict
    // (A1) when present; else fall back to the shared predicate on the served
    // pair. The legacy local+low-score case is kept so a weak LOCAL model is
    // still surfaced even when the router had no task profile to judge against.
    const capable =
      typeof decision.agenticCapable === 'boolean'
        ? decision.agenticCapable
        : isAgenticCapableModel(decision.model, decision.provider);
    const agentic =
      decision.taskProfile && decision.complexity
        ? isAgenticTask(decision.complexity, decision.taskProfile)
        : false;
    const weakForAgenticAsk = agentic && !capable;
    const weakLocalLegacy =
      decision.provider === 'local' && typeof decision.score === 'number' && decision.score < 0.5;
    if (!weakForAgenticAsk && !weakLocalLegacy) return;

    // One shared wording (A4/B2) so chat, the orchestrator and the dashboard
    // cannot describe the same situation three different ways.
    const notice =
      weakRouteNotice(decision, agentic) ??
      `⚠️  Auto-routing found only a weak LOCAL model (${decision.model}, score ${decision.score.toFixed(2)}/1.0) — no verified cloud model is available.`;
    logger.warn(
      `   ${notice} ` +
        `Complex tasks may run slowly or fail. Add a real API key (nuvira provider set) or run with an explicit --model for reliable results.`,
    );
    this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: 'orchestrator',
      stage: 'routing',
      message: `⚠️ Only a weak model (${decision.model}) is available — this pipeline may be slow or fail. Add a real API key for better results.`,
    }, 'orchestrator');
  }

  /**
   * Post-pipeline learning: create skills from successful complex tasks.
   *
   * After a successful pipeline with 3+ completed steps, extract the
   * execution pattern as a reusable skill. This is the Hermes pattern:
   * skills self-improve during use, and complex tasks produce new skills.
   *
   * The skill is created asynchronously (fire-and-forget) so it never
   * blocks the pipeline result delivery.
   */
  private async postPipelineLearning(
    goal: string,
    vault: ContextVault,
    options: OrchestratorOptions,
  ): Promise<void> {
    try {
      const { getSkillStore } = await import('../learning/skill-store.js');
      const skillStore = getSkillStore();

      // Check if a skill already matches this goal (don't duplicate)
      const existing = skillStore.findMatch(goal);
      if (existing) return;

      // Extract the execution pattern from the completed plan
      const completedSteps = vault.context.taskPlan
        .filter((s) => s.status === 'completed')
        .map((s) => ({
          agentType: s.agentType,
          description: s.description,
          complexity: s.complexity,
        }));

      if (completedSteps.length < 3) return; // Not complex enough

      // Create a skill from the execution pattern
      const skillName = goal
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);

      // Only create if the name is meaningful
      if (skillName.length < 5) return;

      const skill: import('../learning/skill-types.js').Skill = {
        id: `skill-learned-${skillName}`,
        name: skillName,
        description: `Learned from successful execution: ${goal}`,
        version: '1.0.0',
        goalPattern: goal.toLowerCase().slice(0, 100),
        steps: completedSteps.map((s) => ({
          agentType: s.agentType,
          description: s.description,
          dependsOn: [],
        })),
        parameters: [],
        tags: ['learned', 'auto-generated'],
        sourceTrajectoryIds: [],
        createdAt: Date.now(),
        usageCount: 0,
        qualityScore: 1.0,
        lastUsedAt: Date.now(),
      };

      skillStore.save(skill);

      if (options.verbose) {
        logger.info(`   🧠 Learned new skill '${skillName}' from successful pipeline`);
      }

      this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
        agentType: 'orchestrator',
        stage: 'learning',
        message: `🧠 Learned new skill '${skillName}' from successful execution`,
      }, 'orchestrator');
    } catch {
      // Best-effort — learning must never break the pipeline
    }
  }

  /**
   * Pre-flight project inspection — deterministic, always-on, no LLM calls.
   *
   * Scans the working directory for the project type (manifest files), counts
   * source + test files, and reads the git state. The readable digest is:
   * - Stored in the vault as `projectInspection` so the Planner builds a plan
   *   that REUSES the existing codebase (no rework) and keeps backward
   *   integrity (existing tests are taken into account).
   * - Emitted on the event bus so the CLI board / dashboard can show the
   *   user what was found before planning starts.
   */
  private runProjectInspection(vault: ContextVault, options: OrchestratorOptions): void {
    const cwd = vault.context.workingDirectory;
    const lines: string[] = [];

    try {
      // 1. Manifest / framework detection
      const manifests: Array<[string, string]> = [
        ['package.json', 'Node.js'],
        ['requirements.txt', 'Python'],
        ['pyproject.toml', 'Python (pyproject)'],
        ['go.mod', 'Go'],
        ['Cargo.toml', 'Rust'],
        ['pom.xml', 'Java (Maven)'],
        ['build.gradle', 'Java (Gradle)'],
        ['Gemfile', 'Ruby'],
        ['composer.json', 'PHP'],
        ['pubspec.yaml', 'Dart/Flutter'],
        ['Dockerfile', 'Docker'],
      ];
      const found = manifests.filter(([f]) => existsSync(join(cwd, f)));
      if (found.length > 0) {
        lines.push(`Project type: ${found.map(([, label]) => label).join(', ')}`);
      } else {
        lines.push('Project type: not detected (no recognized manifest)');
      }

      // Extra package.json details (name, test/build scripts)
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        const extra: string[] = [];
        if (pkg.name) extra.push(`name: ${pkg.name}`);
        if (pkg.scripts?.test) extra.push('test script present');
        if (pkg.scripts?.build) extra.push('build script present');
        if (extra.length > 0) lines.push(`package.json — ${extra.join(' · ')}`);
      } catch {
        // Not a package.json project — fine.
      }

      // 2. Source + test file counts and top-level source directories
      const { sourceCount, testCount, topDirs } = this.countSourceFiles(cwd);
      lines.push(
        `${sourceCount} source file(s)` +
        (testCount > 0 ? ` · ${testCount} test file(s) found` : ' · no test files found'),
      );
      if (topDirs.length > 0) {
        lines.push(`Main directories: ${topDirs.slice(0, 5).join(', ')}`);
      }

      // 3. Git state (branch + uncommitted changes)
      const git = this.gitState(cwd);
      if (git) {
        lines.push(
          git.dirty > 0
            ? `Git: branch '${git.branch}' with ${git.dirty} uncommitted change(s)`
            : `Git: branch '${git.branch}' — clean working tree`,
        );
      }

      // 4. Backward-integrity note — existing tests act as the safety net
      if (testCount > 0) {
        lines.push('Backward-integrity: existing test suite detected — changes will be verified against it');
      }
    } catch (err) {
      logger.debug(`Project inspection failed (non-critical): ${err}`);
      lines.push('Inspection: could not fully inspect the project (non-critical)');
    }

    vault.setMeta('projectInspection', lines.join('\n'));
    this.eventBus.emit(EventNames.ORCHESTRATOR_INSPECTION, { lines }, 'orchestrator');
    if (options.verbose) {
      logger.highlight('\n🔍 Pre-flight project inspection:');
      for (const line of lines) logger.info(`   ${line}`);
    }
  }

  /** Count source/test files and top-level source directories (no LLM). */
  private countSourceFiles(cwd: string): { sourceCount: number; testCount: number; topDirs: string[] } {
    let sourceCount = 0;
    let testCount = 0;
    const dirCounts = new Map<string, number>();
    // Files under any of these directories are treated as test files even when
    // their filename doesn't carry a .test/.spec marker (e.g. tests/auth.ts).
    const TEST_DIR = /^(test|tests|__tests__|spec|specs)$/i;

    const walk = (dir: string, depth: number, inTestDir: boolean) => {
      if (depth > 6) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p, depth + 1, inTestDir || TEST_DIR.test(entry.name));
        } else if (entry.isFile()) {
          const ext = entry.name.slice(entry.name.lastIndexOf('.'));
          if (!SOURCE_EXTENSIONS.has(ext)) continue;
          sourceCount++;
          const base = entry.name.slice(0, entry.name.lastIndexOf('.'));
          if (
            inTestDir ||
            /\.(test|spec)([._-]|$)/i.test(entry.name) ||
            /^(test|tests|__tests__)$/i.test(base)
          ) {
            testCount++;
          }
          const rel = relative(cwd, p);
          const top = rel.split(/[\\/]/)[0];
          if (top && top !== entry.name && top !== '.') {
            dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
          }
        }
      }
    };

    walk(cwd, 0, false);
    const topDirs = [...dirCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} (${count})`);
    return { sourceCount, testCount, topDirs };
  }

  /** Read the git branch and uncommitted-change count. Returns null if not a repo. */
  private gitState(cwd: string): { branch: string; dirty: number } | null {
    try {
      const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (branch.status !== 0) return null;
      const status = spawnSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      });
      const dirty = (status.stdout || '').split('\n').filter((l) => l.trim().length > 0).length;
      return { branch: branch.stdout.trim() || 'unknown', dirty };
    } catch {
      return null;
    }
  }

  private createLLMProvider(options: OrchestratorOptions): LLMCallFn {
    // Guard: 'auto' is not a real provider — getProviderConfig resolves the
    // 'auto' routing directive to the best AVAILABLE provider at runtime, so
    // the adapter factory never sees a literal 'auto'.
    const rawProvider = options.provider || this.configManager.getAll().defaultProvider;
    const { type: providerType, config } = this.configManager.getProviderConfig(rawProvider);
    const provider = ProviderFactory.createProvider(providerType, config);

    return async (prompt: string, inferenceOptions?: InferenceOptions) => {
      // Runtime injection guardrail
      const injectionFindings = scanForInjections(prompt);
      if (injectionFindings.length > 0) {
        const report = formatScanReport({
          passed: false,
          findings: injectionFindings,
          summary: 'Prompt injection detected — call blocked',
        });
        throw new Error(`Injection guardrail blocked LLM call:\n${report}`);
      }

        // Guard: 'auto' is not a real model — never send it to a provider API.
      // Resolve it to the provider's configured model (or best available) so
      // planner/memory/rate-limit-switch calls never crash with "no auto model".
      let requestedModel = options.model || inferenceOptions?.model || config.model;
      // 'auto' is a DIRECTIVE, not a model id: resolve it to the provider's
      // configured model BEFORE validating, so the validator is never asked to
      // repair a sentinel and the 'auto is not available on X' warning is not
      // printed for a value the user never chose as a model.
      //
      // A8 EXCEPTION: a CONCRETE provider pinned with `-m auto` means that
      // provider's own auto (an OmniRoute combo), so the sentinel is NOT ours
      // to resolve — it must reach the provider as-is.
      if (isAutoModel(requestedModel) && !isProviderOwnAuto(rawProvider, requestedModel)) {
        requestedModel = config.model || undefined;
      }
      // ALWAYS validate the pair — the model against THIS provider instance,
      // which is the one that will serve the call.
      //
      // This used to run only when the model was empty or the literal 'default',
      // which skipped the validator in exactly the case it was written for: a
      // real, non-empty model id that does not belong to this provider (issue
      // #10). A stale or foreign pin then went straight to the API and 404'd —
      // `Groq API error (404): The model 'gemini-3.1-flash-lite' does not exist`
      // — with the repair machinery sitting right there, unused.
      //
      // resolveRoute also owns the reporting: a substitution is printed and
      // recorded rather than made silently, and NUVIRA_STRICT_MODEL=1 refuses to
      // substitute at all (issue #11).
      const route = await resolveRoute({
        providerType,
        provider,
        model: requestedModel,
        source: 'orchestrator',
        verifyOnDemand: isMaxCapability(this.configManager),
      });
      const servedModel = route.model;
      const mergedOptions = {
        ...inferenceOptions,
        model: servedModel,
        // `max` asks the routed model to reason harder; the adapter applies it
        // only for a model verified to accept the parameter (default-deny).
        reasoningEffort: capabilityReasoningEffort(this.configManager),
        temperature: inferenceOptions?.temperature ?? config.temperature ?? 0.7,
        // Output cap: explicit option → configured value → the model's real
        // capability. The old flat `4096` held a 200K+ model to a small-model
        // ceiling, so the better the model, the more of it the constant wasted.
        //
        // Then clamped by anything the provider has TAUGHT us (G15): a model
        // with a large context window and a tiny output cap (the live story run
        // hit a 512-token cap on a big-window model) rejects the window-derived
        // number with a 400 every single call, and a hard-coded caller constant
        // like the prose path's 8192 cannot be allowed to do that silently.
        maxTokens: clampMaxTokens(
          inferenceOptions?.maxTokens ??
            config.maxTokens ??
            resolveMaxOutputTokens({ provider: providerType, model: servedModel }),
          providerType,
          servedModel,
        ),
      };
      // The strongest signal the provider×model is NOT usable: a real call
      // failed. Feed the SHARED registry telemetry path (the same one chat
      // and the fallback commands use) so the NEXT call in this pipeline —
      // and every future session — routes around it predictively instead of
      // failing into it again. This is the SINGLE record point for the whole
      // orchestrator: both the auto-routed path (its base() routes through
      // here) and the non-auto path (`execute --provider X`, planner/writer/
      // memory calls) land here. Best-effort — never mask the error.
      let output: string;
      try {
        output = await provider.generate(prompt, mergedOptions);
      } catch (err) {
        // A provider that NAMES its output limit has told us what to do, and
        // retrying at that number is strictly better than failing the step
        // (G15 — the live story run burned 6 batches of prose units this way).
        // One retry, only when the named limit is actually below what we sent.
        const namedLimit = learnMaxTokensLimitFromError(err, providerType, servedModel);
        if (namedLimit !== null && mergedOptions.maxTokens !== undefined && mergedOptions.maxTokens > namedLimit) {
          logger.warn(
            `${providerType}/${servedModel} caps output at ${namedLimit} tokens (we sent ` +
              `${mergedOptions.maxTokens}) — clamping and retrying once`,
          );
          try {
            output = await provider.generate(prompt, { ...mergedOptions, maxTokens: namedLimit });
            recordRegistrySuccess(providerType, mergedOptions.model, 'execute');
            this.stats.llmCalls += 1;
            this.stats.inputTokens += estimateTokens(prompt);
            this.stats.outputTokens += estimateTokens(output);
            return output;
          } catch (retryErr) {
            // The cap was not the (only) problem — surface the ORIGINAL error
            // with the retry attached, so the audit reads the first cause.
            recordActionFailure(this.failureSession, providerType, retryErr, this.configManager, {
              model: mergedOptions.model,
              action: 'execute',
            });
            throw retryErr;
          }
        }
        // FULL shared bookkeeping (Nuvira-Router M0.2 Stage C): the previous
        // bare recordRegistryFailure only updated health scores — a mid-pipeline
        // 429 now also parks the provider in the quota ledger (so the NEXT task
        // in this pipeline skips it predictively), records the quota-timeline
        // failover event, feeds the circuit breaker, and applies the
        // model-not-found → definitive-unavailable rule. Same classification.
        recordActionFailure(this.failureSession, providerType, err, this.configManager, {
          model: mergedOptions.model,
          action: 'execute',
        });
        throw err;
      }
      // Success attribution: this pipeline call just PROVED the provider ×
      // model works — the per-action "learned from real usage" panel gains an
      // 'execute' verified row (the mirror of the failure write above). Both
      // the auto-routed path (its base routes through here) and the non-auto
      // path land here, so this is the SINGLE success record point. Best-effort.
      recordRegistrySuccess(providerType, mergedOptions.model, 'execute');
      this.stats.llmCalls += 1;
      this.stats.inputTokens += estimateTokens(prompt);
      this.stats.outputTokens += estimateTokens(output);
      return output;
    };
  }

  /**
   * CHANGE-002: Create a fast/cheap LLM for file finding.
   * Use a small, fast model (like Gemini Flash) for file selection instead
   * of the main (expensive) model.
   *
   * The file finder only needs to:
   * 1. Read the file tree
   * 2. Match files to the task description
   * 3. Return file paths
   *
   * This doesn't require a powerful model — a fast model with good instruction
   * following is sufficient. A finetuned small model is well suited to this
   * exact purpose.
   *
   * Returns a cheap LLM call function, or null if no fast model is available.
   */
  private createFileFinderLLM(options: OrchestratorOptions): LLMCallFn | null {
    // Try to find a fast/cheap model for file finding.
    // Priority: explicit gathererModel option > auto-router's cheapest > null (use main model)
    const gathererModel = options.agentModels?.['context-gatherer'];
    if (gathererModel) {
      // User explicitly configured a model for context gathering — use it
      const [provider, model] = gathererModel.includes('/')
        ? gathererModel.split('/', 2)
        : [options.provider || 'auto', gathererModel];
      try {
        return this.createLLMProvider({ ...options, provider, model });
      } catch {
        // Best-effort — fall through to auto selection
      }
    }

    // Try auto-router to find the cheapest fast model for file finding
    if (isAutoModel(options.model) || isAutoProvider(options.provider) || options.autoRouteModels) {
      try {
        const autoRouter = getAutoRouter();
        const decision = autoRouter.resolve(
          'context-gatherer',
          'file finding',
          {
            ...buildAutoResolveOptions(this.configManager, {
              verbose: options.verbose,
            }),
            // Prefer cheap, fast models for file finding
            preferenceMode: 'cost-first',
          },
          this.configManager,
        );
        if (decision.provider && decision.model) {
          return this.createLLMProvider({
            ...options,
            provider: decision.provider,
            model: decision.model,
          });
        }
      } catch {
        // Best-effort — fall through to null (use main model)
      }
    }

    // No fast model available — return null so context-gatherer uses main model
    return null;
  }

  private async runAgent(
    agent: Agent,
    vault: ContextVault,
    callLLM: LLMCallFn,
    _options: OrchestratorOptions,
  ): Promise<AgentResult> {
    try {
      // Same answer-quality gate as the task path (see the wiring above): the
      // reasoner and planner are executed HERE with their own LLM function, so
      // without this their summaries would be the only agent output still able
      // to carry a leaked reasoning trace into the report.
      const gated = withAgentAnswerQualityGate(callLLM, { agent: agent.name, taskId: 'single' });
      return await withLogCorrelation({ taskId: 'single' }, () => agent.execute(vault.context, gated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: `${agent.name} errored`, error: msg };
    }
  }

  /**
   * Create the onRateLimit callback.
   *
   * Rate-limit recovery is FULLY AUTOMATIC by default (decision #26): the
   * pipeline silently waits out transient hits (short reset hints) and silently
   * auto-switches to another provider when the current one is exhausted or
   * rate-limiting repeatedly — the user is never interrupted, and the build
   * continues on whichever provider is healthy. The interactive prompt
   * (wait / switch / skip / abort) is opt-in via `routing.askOnRateLimit: true`
   * in .nuviraconfig.json and only ever appears on a real TTY.
   *
   * Returns undefined only for dry-run (no LLM calls happen anyway), so even
   * non-interactive runs (CI, pipes) get silent auto-switch instead of grinding
   * the same exhausted provider.
   */
  private createRateLimitHandler(
    options: OrchestratorOptions,
    currentModel: string | undefined,
    boundProvider?: string,
  ): OnRateLimit | undefined {
    // Dry-run: no LLM calls occur, so no rate-limit handler is needed.
    if (options.dryRun) {
      return undefined;
    }

    // The interactive prompt is opt-in (routing.askOnRateLimit) and only
    // reachable on a real TTY. Non-interactive runs (CI, pipes) get the same
    // handler in SILENT mode — auto-switch + auto-wait, never a prompt.
    const interactive = process.stdout.isTTY === true;
    const askUser =
      interactive &&
      (options.askOnRateLimit ??
        this.configManager.getAll().routing?.askOnRateLimit === true);

    // Rate-limit STORM guard: a fresh handler is created per task, so this
    // counter tracks CONSECUTIVE rate-limits WITHIN one task execution. After
    // the second one, grinding the same provider's "wait and retry" is futile
    // (the agent's callLLM is bound to that provider mid-task) — auto-switch
    // to the router's next-ranked provider instead of prompting again.
    //
    // "Consecutive" is honest: (a) the counter resets to 0 after a successful
    // auto-switch (the new provider starts a fresh streak — one transient hit
    // on a provider that just succeeded 10x is NOT a storm), and (b) strikes
    // farther apart than STORM_WINDOW_MS (a long healthy run between them) are
    // treated as a fresh incident, not a continuation.
    let consecutiveRateLimits = 0;
    let lastRateLimitAt = 0;
    // Providers already auto-switched-to this task. Guards against ping-pong
    // between two providers that are BOTH in quota-storms (e.g. gemini 503 +
    // groq TPM): their short hint-aware parks (~16s) can lapse mid-task, making
    // each the fresh winner again right after we switched away from it.
    const triedProviders = new Set<string>();
    const pinnedProvider =
      options.provider && options.provider !== 'auto' ? options.provider : undefined;
    // Seed with the provider the agent is bound to in BOTH modes: pinned mode
    // from options, auto mode from the caller (captured when the task's callLLM
    // was routed). Without the auto-mode seed, a fresh decision that still
    // picks the just-rate-limited provider (park lag) would "switch" to the
    // very provider we're on — a wasted switch that immediately re-rate-limits.
    // Note: this makes the exclusion per-task — the guard never auto-returns to
    // the originally-bound provider even if it fully recovers mid-task (the
    // ping-pong trade-off; a fresh task re-routes normally).
    if (pinnedProvider) triedProviders.add(pinnedProvider);
    if (boundProvider) triedProviders.add(boundProvider);

    return async (info) => {
      // ── Stop the CLI spinner before any wait / prompt ────────────────
      const spl = options.spinner;
      if (spl) spl.stop();
      // Honest "consecutive": a long healthy run between strikes resets the
      // streak (Date.now is cheap; only consulted on the rare rate-limit path).
      const now = Date.now();
      if (lastRateLimitAt === 0 || now - lastRateLimitAt > STORM_WINDOW_MS) {
        consecutiveRateLimits = 0;
      }
      consecutiveRateLimits++;
      lastRateLimitAt = now;

      // ── Auto-switch: storm (2+ in a row) OR exhaustion (long reset) ──
      // A short reset hint (e.g. "try again in 16.5s") is TRANSIENT — waiting
      // is cheaper than switching. A LONG hint (e.g. "resets in 17h 51m" — a
      // daily-quota exhaustion) or repeated hits means the provider is down for
      // a while: silently switch to the router's next healthy provider.
      const exhausted = info.retryAfterMs > AUTO_SWITCH_WAIT_THRESHOLD_MS;
      if (consecutiveRateLimits >= 2 || exhausted) {
        try {
          const task = { agentType: info.agentName.toLowerCase(), description: 'auto-failover' };
          const decision = this.resolveAutoRoutingDecision(task, options);
          // Auto mode trusts the fresh decision's winner: the hint-aware park
          // (decision #23) has usually already moved it OFF the rate-limited
          // provider, so the winner IS the best healthy pick — excluding it
          // would skip ranked[0] for a worse ranked[1] provider. Pinned mode
          // seeds triedProviders so the bound provider is never re-selected.
          const target = decision.ranked?.find(
            (c) => !c.inCooldown && !triedProviders.has(c.provider),
          );
          if (target) {
            logger.warn(
              `\u26A0\uFE0F  ${info.agentName} ${exhausted ? 'exhausted' : `rate-limited ${consecutiveRateLimits}x in a row`} — auto-switching to ${target.provider}…`,
            );
            this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
              agentType: info.agentName.toLowerCase(),
              stage: 'routing',
              message: `⚠️ ${info.agentName} ${exhausted ? 'exhausted' : `rate-limited ${consecutiveRateLimits}x`} — auto-switched to ${target.provider}`,
            }, 'orchestrator');
            // Surface the auto-switch on the dashboard Failover Timeline
            // (quota-events.jsonl, same store the CLI's `model quota` last-20
            // and the audit chain read). Best-effort — the timeline must never
            // break routing.
            getQuotaLedger().recordEvent(
              'failover',
              target.provider,
              exhausted
                ? `auto-switch (${info.agentName.toLowerCase()} exhausted: reset hint > ${AUTO_SWITCH_WAIT_THRESHOLD_MS / 1000}s)`
                : `auto-switch (${info.agentName.toLowerCase()} rate-limited ${consecutiveRateLimits}x)`,
            );
            const callLLM = this.createAutoRoutedLLMFromDecision(task, options, {
              ...decision,
              provider: target.provider,
              // ScoredProvider carries no model — and the spread must NOT leak
              // the winner's model to the new provider (groq would get gemini's
              // model ID → 404). 'default' is the codebase's "no pin" sentinel:
              // resolveWorkingModel treats it as explicit=undefined and resolves
              // the target provider's best VERIFIED model.
              model: 'default',
            });
            // Remember this provider for the rest of the task — if IT then
            // rate-limits too, we move on instead of coming back to it.
            triedProviders.add(target.provider);
            // The new provider starts a FRESH streak: one transient hit on it
            // after a long successful run must NOT trigger another switch.
            consecutiveRateLimits = 0;
            lastRateLimitAt = 0;
            if (spl) spl.start();
            return { action: 'switch-model', callLLM };
          }
        } catch {
          // Best-effort — fall through to wait/prompt below.
        }
      }

      const waitSeconds = (info.retryAfterMs / 1000).toFixed(1);

      // ── Interactive prompt (opt-in: routing.askOnRateLimit) ──────────
      if (askUser) {
        const modelStr = info.modelName
          ? `Model: ${info.modelName}`
          : currentModel
            ? `Model: ${currentModel}`
            : '';

        console.log('');
        logger.warn(`\u26A0\uFE0F  Rate limit hit for ${info.agentName}`);
        logger.info(`   ${modelStr}`);
        logger.info(`   Please wait ${waitSeconds}s before next request`);
        console.log('');

        const { action } = await inquirer.prompt<{ action: string }>([
          {
            type: 'list',
            name: 'action',
            message: `What would you like to do?`,
            prefix: '\u{1F504}',
            choices: [
              { name: `\u23F3  Wait ${waitSeconds}s and retry`, value: 'retry' },
              { name: '\u{1F500}  Switch to a different model', value: 'switch-model' },
              { name: '\u23ED  Skip this step', value: 'skip' },
              { name: '\u274C  Abort the pipeline', value: 'abort' },
            ],
          },
        ]);

        console.log('');

        // Helper to restart the spinner before returning
        const restartSpinner = () => {
          if (spl) spl.start();
        };

        if (action === 'retry') {
          logger.info(`Waiting ${waitSeconds}s as requested...`);
          restartSpinner();
          return { action: 'retry' };
        }

        if (action === 'skip') {
          logger.info('Skipping this step.');
          restartSpinner();
          return { action: 'skip' };
        }

        if (action === 'abort') {
          logger.error('Pipeline aborted by user.');
          // Don't restart spinner — pipeline is ending
          return { action: 'abort' };
        }

        if (action === 'switch-model') {
          // Show the categorized model picker so the user can choose visually
          const picked = await showModelPicker(this.configManager);

          if (!picked) {
            logger.info('Model selection cancelled — retrying with current model.');
            restartSpinner();
            return { action: 'retry' };
          }

          console.log('');
          logger.info(`Switching to model: ${picked.model} (provider: ${picked.provider})`);

          let newCallLLM: LLMCallFn;
          if (picked.provider === 'auto' || isAutoModel(picked.model)) {
            // Auto picked — route through the AutoModelRouter for this agent
            // instead of handing the literal 'auto' provider/model to a real API.
            newCallLLM = this.createAutoRoutedLLM(
              { agentType: info.agentName || 'chat', description: 'Rate-limit retry' },
              options,
            );
          } else {
            // Create a new LLM provider with the switched model
            const newOptions = {
              ...options,
              provider: picked.provider,
              model: picked.model,
            };
            newCallLLM = withTraceCapture(this.createLLMProvider(newOptions), {
              traceId: this.activeTraceId ?? '',
              agentType: info.agentName || 'chat',
              description: 'Rate-limit retry',
              provider: picked.provider,
              model: picked.model,
            });
          }

          restartSpinner();
          return { action: 'switch-model', callLLM: newCallLLM };
        }

        // Fallback: retry
        restartSpinner();
        return { action: 'retry' };
      }

      // ── Default (fully automatic): silent wait + retry ──────────────
      logger.warn(
        `\u26A0\uFE0F  ${info.agentName} rate-limited — waiting ${waitSeconds}s and auto-retrying…`,
      );
      if (spl) spl.start();
      return { action: 'retry' };
    };
  }

  private async executeSingleTask(
    task: TaskStep,
    vault: ContextVault,
    options: OrchestratorOptions,
    agentResults: OrchestrationResult['agentResults'],
    contextFiles: string[],
    defaultCallLLM: LLMCallFn,
    executionStrategy?: RoutingExecutionStrategy,
    stats: ExecutionStats = this.stats,
  ): Promise<void> {
    const routingContext = vault.getMeta<{ taskProfile?: { intent?: string; requiresVerification?: boolean } }>('routingContext');
    const strategy = executionStrategy ?? this.getExecutionStrategy(task, routingContext);
    // Per-subtask complexity label (set by the plan-labeling pass in execute();
    // this fallback covers direct executeSingleTask calls in tests).
    if (!task.complexity || !VALID_COMPLEXITY.has(task.complexity)) {
      task.complexity = analyzeComplexity(task.description);
    }
    task.routingHints = {
      effectiveAgentType: strategy.effectiveAgentType,
      followUpAgentType: strategy.followUpAgentType,
      runSerially: strategy.runSerially,
      useRepair: strategy.useRepair,
      maxRepairs: strategy.maxRepairs,
      verificationPass: strategy.verificationPass,
    };
    const maxRepairs = strategy.maxRepairs || options.maxRepairs || 3;
    const repairMode = (options.repairMode ?? 'auto') as RepairMode;

    // If repairs are enabled, set up the error-repair engine. Runner/tester/debugger
    // have their own retry logic, but the repair engine adds the crucial
    // 'alternative-approach' strategy — so a failing runner/tester tries a
    // fundamentally different approach instead of immediately declaring failure.
    const useRepair = strategy.useRepair || (maxRepairs > 0 && repairMode !== 'off');

    vault.updateTaskStatus(task.id, 'running');
    // Let agents know which task step they are working on. Needed for parallel
    // batches: writer/runner look up "the running task" in the shared plan, so
    // a per-task marker disambiguates when several run concurrently.
    vault.setMeta('currentTaskId', task.id);
    // Long-form unit? Hand the writer its unit brief (title, path, word target,
    // and the previous unit's tail for continuity). Cleared for every other
    // step so a code task can never inherit a prose contract — or vice versa.
    const proseEntry = this.proseUnits.get(task.id);
    vault.setMeta('proseUnit', proseEntry ? proseEntry.unit : undefined);
    await tryUpdateDAGNode(task.id, { status: 'running' });
    this.eventBus.emit(EventNames.ORCHESTRATOR_TASK_STARTED, {
      taskId: task.id,
      agentType: task.agentType,
      description: task.description,
    }, 'orchestrator');

    // Update spinner text to show which task is currently executing
    if (options.spinner) {
      const agentIcon = this.moduleRegistry.getIcon(task.agentType);
      const shortDesc = task.description.slice(0, 60);
      options.spinner.start(`${agentIcon} ${shortDesc}${task.description.length > 60 ? '...' : ''}`);
    }

    if (options.verbose) {
      logger.info(`\n   ▶️  ${task.agentType}: ${task.description.slice(0, 80)}${task.description.length > 80 ? '...' : ''}`);
    }

    try {
      // ── Auto routing: use the right model for the right task ───────────
      // When the user selected Auto (`-m auto` / `nuvira model switch auto`) or
      // passed `--auto-route` without an explicit --model, route each task
      // independently via the AutoModelRouter so e.g. the planner gets a fast
      // cheap model while complex tasks get a stronger one. An explicit
      // `--model` always wins over auto routing.
      const autoRouting = (options.autoRouteModels === true && !options.model) ||
        isAgentAutoRoute(options.provider, options.model);
      const effectiveAgentType = strategy.effectiveAgentType || task.agentType;
      const agentModel = options.model || options.agentModels?.[effectiveAgentType] || options.agentModels?.[task.agentType];
      let taskBoundProvider: string | undefined;
      const useResilient = autoRouting && (options.resilientRouting !== false);
      // The provider×model that will actually serve this step's calls (see
      // `resolveAuditRoute`). Resolved ONCE per step so the trace records a
      // real attribution even when the user pinned nothing.
      const stepAuditRoute = this.resolveAuditRoute(options, agentModel);
      const routedAgentCallLLM = autoRouting
        ? (useResilient
            ? this.createResilientAutoRoutedLLM(
                {
                  agentType: effectiveAgentType,
                  description: task.description,
                  complexity: task.complexity,
                  taskId: task.id,
                  contextHintTokens: this.estimateTaskPayloadTokens(vault, task.description, contextFiles),
                },
                options,
              )
            : this.createAutoRoutedLLM(
                {
                  agentType: effectiveAgentType,
                  description: task.description,
                  complexity: task.complexity,
                  taskId: task.id,
                  contextHintTokens: this.estimateTaskPayloadTokens(vault, task.description, contextFiles),
                },
                options,
                (provider) => {
                  taskBoundProvider = provider;
                },
              ))
        : withTraceCapture(
            agentModel
              ? this.createLLMProvider({ ...options, model: agentModel })
              : defaultCallLLM,
            {
              traceId: this.activeTraceId ?? '',
              agentType: effectiveAgentType,
              taskId: task.id,
              description: task.description,
              provider: stepAuditRoute.provider,
              model: stepAuditRoute.model,
            },
          );

      // ── AGENT ANSWER-QUALITY GATE ──────────────────────────────────────
      // The agents do NOT go through the loop engine, so the generation-time
      // quality gate that protects chat/`execute` never saw them: each agent is
      // handed this function and calls the provider directly. A traced reply
      // (the model narrating the conversation or reciting its instructions)
      // therefore became the task's SUMMARY — rendered as
      // `• ✅ Reasoner: The user wants a project plan … I should use the
      // \`plan_todo\` tool…`. Wrapping here (rather than inside each agent)
      // covers every agent type and every path that hands the agent this
      // function — the first pass, the repair engine, the reviewer-fix
      // strategy — while leaving the orchestrator's housekeeping calls (file
      // finding, memory) alone. One corrective retry, then the render sites'
      // salvage/suppress takes over.
      const agentCallLLM = withAgentAnswerQualityGate(routedAgentCallLLM, {
        agent: effectiveAgentType,
        taskId: task.id,
      });

      // Skip tester and debugger tasks in skip-tests mode
      if (options.skipTests && (task.agentType === 'tester' || task.agentType === 'debugger')) {
        vault.updateTaskStatus(task.id, 'completed', 'Skipped (--skip-tests)');
        agentResults.push({
          agent: task.agentType,
          success: true,
          summary: 'Skipped (--skip-tests)',
        });
        if (options.verbose) {
          logger.info(`      ⏭️  Skipped ${task.agentType} (--skip-tests)`);
        }
        return;
      }

      // Skip runner tasks in dry-run mode (no commands executed)
      if (task.agentType === 'runner' && options.dryRun) {
        vault.updateTaskStatus(task.id, 'completed', 'Skipped (dry-run mode)');
        agentResults.push({
          agent: 'runner',
          success: true,
          summary: 'Skipped (dry-run mode — no commands executed)',
        });
        if (options.verbose) {
          logger.info('      ⏭️  Skipped (dry-run — no commands executed)');
        }
        return;
      }

      // Tool-calling agent routing: when useToolCalling is enabled, route
      // 'writer' and 'reviewer' tasks to their tool-calling variants.
      // This gives the LLM iterative read→edit→verify capability instead
      // of a single-shot LLM call.
      let actualAgentType = effectiveAgentType;
      if (resolveUseToolCalling(options)) {
        // A long-form PROSE unit must NOT go to the tool-calling writer: that
        // agent speaks a read→propose_change→edit protocol for code, and would
        // try to emit file changes from tool calls instead of writing prose.
        // The one-shot WriterAgent owns the author path (G7/G8).
        const isProseUnit = this.proseUnits.has(task.id);
        // Same for a step that CREATES a file in a project that does not exist
        // yet (a composite plan's scaffold/experience/services steps). The
        // tool-calling writer's value is the read→edit→verify loop, and there is
        // nothing to read on a greenfield. Live evidence: it returned ZERO file
        // changes for the site scaffold and the pipeline died on step 1 of 8 —
        // the whole composite deliverable unreachable for a reason that had
        // nothing to do with the plan.
        const isCreationStep = this.creationSteps.has(task.id);
        if (effectiveAgentType === 'writer' && !isProseUnit && !isCreationStep) {
          actualAgentType = 'writer-tc';
        } else if (effectiveAgentType === 'reviewer') {
          actualAgentType = 'reviewer-tc';
        }
      }

      const agent = createAgent(actualAgentType, this.moduleRegistry);
      if (!agent) {
        vault.updateTaskStatus(task.id, 'failed', `Unknown agent type: ${effectiveAgentType}`);
        agentResults.push({
          agent: effectiveAgentType,
          success: false,
          summary: `Unknown agent type: ${effectiveAgentType}`,
        });
        return;
      }

      // Tag this agent instance with its task step so its "thinking" updates
      // attach to the correct board line (fresh instance per task → no races).
      agent.currentTaskId = task.id;

      // CHANGE-002: Create a fast/cheap file finder LLM for context-gatherer.
      // A finetuned small model is well suited to file finding — fast,
      // cheap, and accurate for this narrow task. When available, inject it
      // into the context-gatherer's metadata so it uses the fast model instead
      // of the main (expensive) model for file selection.
      if (effectiveAgentType === 'context-gatherer') {
        try {
          const fileFinderLLM = this.createFileFinderLLM(options);
          if (fileFinderLLM) {
            vault.setMeta('fileFinderCallLLM', fileFinderLLM);
          }
        } catch {
          // Best-effort — file finder must never break the pipeline
        }
      }

      // Wire up the rate-limit handler so agents can prompt the user. Pass the
      // task's bound provider (auto mode) so the storm guard never auto-switches
      // to the very provider the agent is on (park lag: the fresh decision can
      // re-pick the just-rate-limited provider before the registry park lands).
      vault.context.onRateLimit = this.createRateLimitHandler(
        options,
        agentModel || options.model,
        taskBoundProvider,
      );

      // ── Execute agent with optional auto-repair loop ────────────────
      let result: AgentResult;
      let firstFailed = false;

      if (useRepair) {
        // Try the agent — if it fails, attempt auto-repair. K1: taskId rides
        // on every log line from this agent's execution.
        const firstResult = await withLogCorrelation({ taskId: task.id }, () =>
          agent.execute(vault.context, agentCallLLM),
        );

        if (firstResult.success) {
          result = firstResult;
        } else {
          firstFailed = true;
          if (options.verbose) {
            const repairableTypes = ['llm-error', 'provider-error', 'context-limit', 'process-error', 'unknown'];
            logger.info(`      🔧 Agent failed — attempting auto-repair (mode: ${repairMode}, max: ${maxRepairs})`);
          }

          // The repair engine re-prompts with this as the failure context.
          // For command-executing agents (runner/tester/debugger) prefer the
          // rich `details` block (it embeds the exact command + exit code +
          // captured stdout/stderr) so the repair actually SEES the failure
          // output instead of a one-line summary — a runner repair without
          // the command output just re-runs the same command blind. For
          // other agents, `error` is the more diagnostic field (details is
          // often the raw LLM response).
          const executesCommands = ['runner', 'tester', 'debugger'].includes(task.agentType);
          const errorMessage = (
            executesCommands && firstResult.details && firstResult.details.trim().length > 0
              ? firstResult.details
              : firstResult.error || firstResult.summary || 'Unknown error'
          ).slice(0, 4000);
          // MODEL ESCALATION on task failure (assessment P0, same principle as
          // the planner repair): when auto routing is active, hand the repair
          // engine a re-routed LLM at the NEXT complexity level so it picks a
          // STRONGER model than the one that just failed. Re-prompting the
          // same weak model repeats the same failure until the budget dies —
          // the exact failure mode seen when a weak writer kept failing.
          // Non-auto paths keep the explicit model but honor
          // repairFallbackModels for the switch-model strategy.
          //
          // NO-OP ESCALATION GUARD: when the "stronger model" resolves to the
          // SAME provider×model as the one that just failed (every stronger
          // candidate is unavailable/blocked — e.g. only a weak local model is
          // configured), escalation is a lie that just re-runs the same weak
          // model until the budget dies (observed: writer format failures
          // spinning 3×1-2 min on the same local model). Degrade instead:
          //   - the writer gets LENIENT file-change parsing (recovers plain
          //     ```lang code blocks the model actually emitted, so a format-
          //     shy model's real work is saved instead of failing);
          //   - the repair budget for this task is capped at 1 so we fail
          //     fast and surface the model's output instead of looping.
          let escalatedTaskLLM = autoRouting
            ? this.createEscalatedLLM(effectiveAgentType, task.description, options, task.complexity, task.id)
            : undefined;
          let noOpEscalation = this.isNoOpEscalation(
            task.id,
            autoRouting ? this.escalatedProviderModelByTask.get(task.id!) : undefined,
          );
          if (noOpEscalation && autoRouting) {
            if (options.verbose) {
              logger.warn(
                `      ⚠️ No stronger model available (escalation resolves to the same model) — enabling lenient parsing / bounded repair for ${effectiveAgentType}`,
              );
            }
            // The writer's parseFileChangesLenient fallback is gated on this
            // flag, so plain code blocks are only recovered when NO stronger
            // model exists to escalate to (never for a healthy pipeline).
            try {
              vault.context.metadata.lenientFileParsing = true;
              // Name the task's DECLARED artifacts so a `shrink-scope` repair
              // can ask for the FIRST one concretely ("produce exactly this
              // file") instead of a vague "do less". Absent → the narrowed ask
              // stays generic and never invents a filename.
              if (task.expectedFiles?.length) {
                vault.context.metadata.expectedFiles = task.expectedFiles;
              }
            } catch {
              // Best-effort — metadata must never break repair.
            }

            // ── USER DECISION (opt-in: routing.promptOnWeakModel) ───────
            // The default stays SILENT: continue on the weak model. When the
            // user opts in, ask ONCE per pipeline (latched) so a multi-task
            // pipeline never re-prompts. Non-interactive (piped/CI) stdin
            // falls through to the silent weak-model path — never blocks.
            if (this.weakModelChoice === null && shouldPromptWeakModel(this.configManager.getAll()) && process.stdin.isTTY) {
              const escalated = this.escalatedProviderModelByTask.get(task.id!);
              const weakLabel = `${escalated?.provider ?? 'unknown'}/${escalated?.model ?? 'unknown'}`;
              // 'wait' is only honest when a stronger candidate is actually
              // in a SHORT cooldown (circuit breaker / rate-limit exclusion)
              // — otherwise it would just sit forever. Check the circuit
              // breaker + session exclusions for any non-weak provider that
              // will recover within a few minutes.
              const waitMs = this.weakModelWaitAvailableMs(task.id);
              // ── Pause the live board BEFORE the interactive prompt ──────
              // The live pipeline board is an ink TUI whose useInput holds
              // stdin in RAW MODE with its own keypress listener. An inquirer
              // prompt fired while the board is mounted RENDERS but every
              // keystroke goes to the board — the user sees the choices yet
              // cannot select one, and the session appears to die (single-shot
              // then exits on the weak-model outcome). Mirrors the rate-limit
              // prompt's spl.stop() before / spl.start() after.
              const spl = options.spinner;
              if (spl) spl.stop();
              try {
                this.weakModelChoice = await promptWeakModelChoice(weakLabel, { waitAvailable: waitMs !== null });
              } catch {
                this.weakModelChoice = 'continue'; // prompt failure → silent path
              }

              // ── 'wait': sleep out the short cooldown, then RE-ROUTE ─────
              // A stronger provider that is in cooldown may be back once the
              // exclusion expires. Re-create the escalated LLM fresh (the
              // router re-ranks; the recovered provider is now eligible) and
              // re-check the no-op — if a stronger model is back, the normal
              // repair budget applies instead of the capped weak path.
              if (this.weakModelChoice === 'wait' && waitMs !== null) {
                logger.warn(`      ⏳ Waiting ${Math.ceil(waitMs / 1000)}s for a stronger model to recover…`);
                await new Promise((r) => setTimeout(r, Math.min(waitMs, MAX_WEAK_WAIT_MS)));
                escalatedTaskLLM = autoRouting
                  ? this.createEscalatedLLM(effectiveAgentType, task.description, options, task.complexity, task.id)
                  : escalatedTaskLLM;
                noOpEscalation = this.isNoOpEscalation(
                  task.id,
                  autoRouting ? this.escalatedProviderModelByTask.get(task.id!) : undefined,
                );
                if (!noOpEscalation) {
                  // A stronger model is back — drop the lenient flag (not
                  // needed anymore) and use the normal repair budget.
                  try {
                    delete vault.context.metadata.lenientFileParsing;
                  } catch {
                    // Best-effort.
                  }
                }
              }
              // Resume the live board unless the user aborted (pipeline is
              // ending — nothing left to watch). 'continue' and 'wait' both
              // proceed into repair, so the TUI comes back.
              if (this.weakModelChoice !== 'abort' && spl) spl.start();
            }
          }
          // No-op escalation → a bounded WEAK-MODEL CLOSE-THE-LOOP ladder.
          //
          // This used to cap the budget at 1 because attempt 2 was the SAME
          // weak model re-running the SAME failure — pure wasted minutes. It is
          // now 2, because `weakModel: true` changes what attempt 2 IS: a
          // `shrink-scope` ask for the smallest single unit (see
          // error-repair.ts). That is the step that turns a stuck loop around:
          // re-prompt with the failure, then ask for LESS and move the work
          // forward, then stop honestly at 3. Healthy pipelines keep the
          // configured budget and the ordinary per-category ladder.
          //
          // 'abort' skips repair entirely: the user chose to fix the provider
          // config, so re-running the weak model is wasted work. The task is
          // marked failed with an actionable message; the pipeline stops.
          const userAborted = this.weakModelChoice === 'abort';
          const weakModelOnly = noOpEscalation && autoRouting;
          const effectiveMaxRepairs = weakModelOnly ? 2 : maxRepairs;
          const repairEngine = new ErrorRepairEngine({
            maxRepairs: effectiveMaxRepairs,
            repairMode,
            verbose: options.verbose,
            // Only the weak/no-op-escalation path takes the bounded ladder.
            weakModel: weakModelOnly,
            fallbackModels: options.repairFallbackModels,
            // LLM AVAILABILITY GUARD: check if the escalated task's provider
            // is rate-limited before retrying. Prevents retry-tool and
            // alternative-approach from hitting the same 429 until the budget dies.
            isLLMAvailable: autoRouting ? () => {
              const escalated = this.escalatedProviderModelByTask.get(task.id!);
              if (!escalated) return true;
              const expiresAt = this.failureSession.sessionFailedProviders.get(escalated.provider);
              return !expiresAt || expiresAt <= Date.now();
            } : undefined,
          });

          // Session 46 — REVIEWER-BLOCKED → WRITER FIX PASS: when the failure
          // is a REVIEW VERDICT (not an LLM/provider error), repair must apply
          // the reviewer's feedback via the WRITER and then re-verify with the
          // reviewer. Re-running the reviewer alone on the same code repeats
          // the same verdict until the budget dies — the exact failure mode
          // seen when a weak writer silently skipped a task's real work and
          // the reviewer correctly blocked the unchanged code three times.
          const isReviewVerdictFailure =
            effectiveAgentType === 'reviewer' &&
            typeof firstResult.error === 'string' &&
            firstResult.error.includes('Critical issues found');
          const repairExecuteFn: (ctx: AgentContext, llm: LLMCallFn) => Promise<AgentResult> =
            isReviewVerdictFailure
              ? async (ctx, llm) => {
                  const writer = createAgent('writer', this.moduleRegistry);
                  const reviewer = createAgent('reviewer', this.moduleRegistry);
                  if (!writer || !reviewer) return firstResult;
                  // Latest review output — each fix cycle re-reviews, so the
                  // feedback evolves toward the still-open issues.
                  const latestReview = [...ctx.conversations]
                    .reverse()
                    .find((c) => c.from === 'Reviewer' && c.to === 'Orchestrator');
                  const feedback = String(
                    latestReview?.content || firstResult.details || 'Fix the issues the reviewer found.',
                  );
                  // The writer targets the ORIGINAL writer task descriptions
                  // (the plan's writer steps), not the reviewer step that is
                  // currently marked running in the shared plan.
                  const writerTasks = ctx.taskPlan
                    .filter((s) => s.agentType === 'writer')
                    .map((s) => `- ${s.description}`)
                    .join('\n');
                  const fixGoal = [
                    ctx.goal,
                    '',
                    '[REVIEW FEEDBACK — FIX THESE ISSUES]',
                    writerTasks ? `Original implementation task(s):\n${writerTasks}` : '',
                    feedback.slice(0, 6000),
                  ]
                    .filter((l) => l !== '')
                    .join('\n');
                  this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
                    agentType: 'writer',
                    stage: 'fixing',
                    message: 'Applying reviewer feedback to fix the reported issues…',
                    taskId: task.id,
                  }, 'orchestrator');
                  const fixContext: AgentContext = { ...ctx, goal: fixGoal };
                  const writeResult = await withLogCorrelation({ taskId: task.id }, () =>
                    writer.execute(fixContext, llm),
                  );
                  if (!writeResult.success) return writeResult;
                  // Verify the fix — the reviewer verdict is the gate.
                  return withLogCorrelation({ taskId: task.id }, () =>
                    reviewer.execute(fixContext, llm),
                  );
                }
              : async (ctx, llm) =>
                  withLogCorrelation({ taskId: task.id }, () => agent.execute(ctx, llm));

          if (userAborted) {
            // The user chose to fix the provider config — skip the weak-model
            // repair entirely and surface an actionable failure.
            result = {
              success: false,
              summary: 'Aborted by user — only a weak model is available',
              error:
                'Aborted by user: only a weak model is available for this task. ' +
                'Add a provider API key or wait for a stronger model, then re-run.',
            };
            if (options.verbose) {
              logger.warn(`      ⛔ Task aborted by user (weak model only) — fix provider config and re-run.`);
            }
          } else {
            result = await repairEngine.repair(
              task.id,
              vault.context,
              escalatedTaskLLM ?? agentCallLLM,
              errorMessage,
              repairExecuteFn,
            );
          }

          if (options.verbose && !userAborted) {
            logger.info(`      🔧 ${result.success ? '✅ Repair succeeded' : '❌ Repair failed'} after ${repairEngine.budget.getAttempts(task.id)} attempt(s)`);
          }

          // Collect repair telemetry
          stats.repairAttempts += repairEngine.budget.getAttempts(task.id);
          stats.alternativeApproaches += repairEngine.alternativeApproaches;
        }
      } else {
        result = await withLogCorrelation({ taskId: task.id }, () =>
          agent.execute(vault.context, agentCallLLM),
        );
      }

      // Track task failure/recovery telemetry
      if (!result.success) {
        stats.taskFailures += 1;
      } else if (firstFailed) {
        stats.recoveredFailures += 1;
      }

      // ── The step's OWN writes reach disk BEFORE anything judges them ───────
      // Ordering, and the reason it is load-bearing: the deliverable check just
      // below asks whether the declared artifacts EXIST on disk. A writer's
      // output only reaches disk in `applyFileChanges`, which used to run at the
      // END of this block — after the check. So the check asked about a file the
      // pipeline had not written yet, every creating writer step was reported as
      // "step claimed success but the artifact is not there", and because the
      // later apply is gated on `result.success` (now false) the write was then
      // SKIPPED as well: the step failed itself AND lost its work. Both real
      // long-form E2E tests caught it as "only unit 1 exists on disk".
      if (result.success && !options.dryRun && (effectiveAgentType === 'writer' || effectiveAgentType === 'debugger')) {
        const applied = this.applyFileChanges(vault);
        if (applied > 0 && options.verbose) {
          logger.info(
            `      💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk` +
              (effectiveAgentType === 'debugger' ? ' (debug fix)' : ''),
          );
        }
      }

      // Deliverable verification: a step that declares files must produce them
      // ON DISK. Two holes in the v1.62.4 version of this guard let the live
      // NVDA-addon failure through, and both are closed here.
      //
      //  1. It accepted the agent's own REPORT of what it wrote. That run's
      //     `fileChanges` claimed .../kuttaaddon/installTasks.py was `created`
      //     and the file did not exist — but the claim satisfied the check, so
      //     the disk test never ran. A claim is not an artifact: only the
      //     filesystem counts now, and a path that was reported as written while
      //     being absent is named explicitly, because that discrepancy IS the
      //     bug rather than a side note.
      //  2. It only ran for `writer` steps. The step that fabricated the empty
      //     package was a `runner` (`zip -r kuttaaddon.nvda-addon …`), so the one
      //     step whose whole job was to produce the deliverable was structurally
      //     exempt from the check. Any step may declare expectedFiles, so any
      //     step is verified.
      //
      // The test is also no longer existence-only: an empty file is not a
      // deliverable, and a zip holding zero entries is not a package (see
      // artifact-verification.ts for how an empty archive is detected). Checked
      // BEFORE the result is recorded so agentResults, the task status and the
      // checkpoint all reflect the corrected outcome.
      if (result.success && task.expectedFiles && task.expectedFiles.length > 0) {
        const root = vault.context.workingDirectory || process.cwd();
        const check = verifyArtifacts(task.expectedFiles, root);
        if (!check.ok) {
          const reported = new Set(
            vault.context.fileChanges
              .filter((c) => c.status === 'created' || c.status === 'modified')
              .map((c) => normalizeSlash(c.path)),
          );
          const claimedButAbsent = check.missing.filter((f) => reported.has(normalizeSlash(f)));
          const msg = [
            `Deliverable mismatch — step claimed success but the artifact is not there: ${check.reason}`,
            claimedButAbsent.length
              ? `(reported as written but absent from disk: ${claimedButAbsent.join(', ')})`
              : '',
          ]
            .filter(Boolean)
            .join(' ');
          logger.warn(`      ⚠️ ${msg}`);
          result = {
            success: false,
            summary: msg,
            error: msg,
          };
        }
      }

      // ── DURABLE HAND-OFF: this step's outcome survives the run ─────────────
      // A failed step writes down what it must produce and what is already on
      // disk; a succeeded step CLEARS its own entry. That pairing is the whole
      // mechanism — the live NVDA-addon run had no such record, so the next
      // attempt inherited nothing and re-derived the same plan (18 times), and
      // a step that finally succeeded would have stayed on the outstanding list
      // forever without the clear.
      //
      // Keyed on the step's DECLARED artifacts when it has them, so the same
      // deliverable asked for in different words maps to one hand-off. Root is
      // the vault's own working directory — the same root the deliverable check
      // above used, so the two can never disagree about where "on disk" means.
      try {
        const handoffRoot = vault.context.workingDirectory || process.cwd();
        const declared = (task.expectedFiles ?? []).filter((f) => f && f.trim());
        const runGoal = vault.context.goal;
        if (result.success) {
          if (declared.length > 0) clearStepHandoff(handoffRoot, stepKeyFor({ declared }));
        } else {
          const named = declared.length > 0 ? declared : deliverablesNamedIn(`${runGoal} ${task.description}`);
          recordStepHandoff({
            projectPath: handoffRoot,
            goal: runGoal,
            stepDescription: task.description,
            declared: named,
            route: effectiveAgentType,
            kind: result.error && /refus|denied|outside the workspace/i.test(result.error) ? 'refused' : 'failed',
            reason: result.error || result.summary,
          });
        }
      } catch {
        // Best-effort — the hand-off ledger must never break the pipeline.
      }

      vault.updateTaskStatus(task.id, result.success ? 'completed' : 'failed', result.summary);
      await tryUpdateDAGNode(task.id, {
        status: result.success ? 'completed' : 'failed',
        summary: result.summary,
      });
      this.eventBus.emit(EventNames.ORCHESTRATOR_TASK_COMPLETED, {
        taskId: task.id,
        agentType: effectiveAgentType,
        success: result.success,
        summary: result.summary,
      }, 'orchestrator');
      agentResults.push({ agent: effectiveAgentType, success: result.success, summary: result.summary });

      // Feed the real-world outcome back into the learning bandit so the router
      // improves from actual results. Only when bandit learning is ENABLED —
      // otherwise the getLastProvider() lookup could reward/penalize a stale
      // provider noted by an earlier bandit-enabled run in this process.
      // ISSUE-002: enabled by default (opt-out via routing.bandit = false).
      if (autoRouting && this.configManager.getAll().routing?.bandit !== false) {
        try {
          getAutoRouter().recordOutcome(
            task.agentType,
            task.description,
            result.success ? 'success' : 'failure',
            this.configManager,
            undefined,
            task.complexity as ComplexityLevel | undefined,
          );
        } catch {
          // Learning is best-effort — never break the pipeline on a bandit error
        }
      }

      if (result.success && strategy.followUpAgentType && strategy.followUpAgentType !== effectiveAgentType) {
        const followUpAgent = createAgent(strategy.followUpAgentType, this.moduleRegistry);
        if (followUpAgent) {
          const followUpResult = await followUpAgent.execute(vault.context, agentCallLLM);
          agentResults.push({
            agent: strategy.followUpAgentType,
            success: followUpResult.success,
            summary: followUpResult.summary,
          });
          if (options.verbose) {
            logger.info(`      🔎 Follow-up ${strategy.followUpAgentType}: ${followUpResult.summary}`);
          }
        }
      }

      // Track sandbox path for cleanup
      if (result.success && effectiveAgentType === 'tester') {
        const testResult = vault.getMeta<any>('testResult');
        if (testResult?.sandboxPath) {
          vault.setMeta('sandboxPath', testResult.sandboxPath);
        }
      }

      // ── Writer artifacts sync (writer/debugger writes were applied ABOVE,
      // before the deliverable check, so a runner following this step still
      // finds them on disk) ─────────────────────────────────────────────────
      if (effectiveAgentType === 'writer' && result.success) {
        const newArtifacts = vault.context.fileChanges
          .filter((c) => c.status === 'created' || c.status === 'modified')
          .filter((c) => c.newContent)
          .map((c) => ({
            path: c.path,
            content: c.newContent!,
            description: `${c.status} by WriterAgent (${task.description.slice(0, 60)})`,
          }));

        for (const artifact of newArtifacts) {
          const existing = vault.context.artifacts.findIndex((a) => a.path === artifact.path);
          if (existing >= 0) {
            vault.context.artifacts[existing] = artifact;
          } else {
            vault.context.artifacts.push(artifact);
          }
        }
      }

      // ── Long-form unit finished: measure it, record it, assemble when done ──
      // "The writer step succeeded" is not the same as "the unit exists", so
      // the outcome is measured from the FILE that landed on disk. The ledger
      // turns that into progress the next turn can resume from.
      const prose = this.proseUnits.get(task.id);
      if (prose) {
        const job = this.longFormJobs.get(prose.jobKey);
        // The unit brief carries the absolute path of its own file.
        const abs = prose.unit.absolutePath;
        let words = 0;
        try {
          if (existsSync(abs)) words = countWords(readFileSync(abs, 'utf-8'));
        } catch {
          words = 0;
        }
        const ok = result.success && words > 0;
        if (job) {
          recordSectionOutcome(job, prose.unit.index, {
            ok,
            words,
            error: ok ? undefined : result.error || `unit produced ${words} words`,
          });
          this.longFormJobs.set(prose.jobKey, job);
          vault.setMeta('longFormJobKey', prose.jobKey);
          // Keep the hand-off honest: the surface schedules the NEXT batch from
          // this snapshot, so it must reflect the units just written.
          const prior = this.pendingWork;
          this.pendingWork = this.pendingWorkFor(job, prior?.kind ?? 'long-form', prior?.expectedArtifacts);
          if (options.verbose) {
            logger.info(`      📖 ${prose.unit.title}: ${words} words recorded`);
          }
          if (ok) {
            const assembled = assembleDocument(job);
            if (assembled) {
              logger.success(
                `   📖 Document assembled: ${assembled.path} — ${formatCount(assembled.words)} words (~${assembled.pages} pages, ${assembled.files} units)`,
              );
            }
          }
        }
      }

      // After runner step: refresh artifacts with any files created during execution
      if (effectiveAgentType === 'runner' && result.success) {
        const runResult = vault.getMeta<any>('runResult');
        if (runResult?.stdout) {
          vault.setMeta('runOutput', runResult.stdout);
        }
      }

      // Track context file paths for memory storage
      if (effectiveAgentType === 'context-gatherer' && result.success) {
        for (const artifact of vault.context.artifacts) {
          if (!contextFiles.includes(artifact.path)) {
            contextFiles.push(artifact.path);
          }
        }
      }

      // ── Vector retrieval hook (post-gather) ───────────────────────────
      // Once the gatherer has collected the relevant files, index them into
      // the repo vector store (idempotent) and retrieve the top-k chunks for
      // the goal. This gives the writer a SEMANTIC file ranking (relevance
      // over size) and records token-savings transparency for the dashboard.
      // Best-effort: any retrieval failure falls through silently — the
      // pipeline must never break on an embedding/indexing error.
      if (effectiveAgentType === 'context-gatherer' && result.success && contextFiles.length > 0) {
        try {
          const retrievalOpts = retrievalOptionsFromConfig(this.configManager);
          if (retrievalOpts.enabled) {
            const { files, chunks } = await indexFiles(contextFiles, retrievalOpts);
            if (chunks > 0) {
              const hits = await retrieve(vault.context.goal, retrievalOpts);
              if (hits.length > 0) {
                vault.setMeta('retrievalRanking', hits.map((h) => ({
                  filePath: h.chunk.filePath,
                  similarity: h.similarity,
                })));
              }
              // Token-savings transparency (Step 5): record the retrieval into
              // retrieval-stats.json so `nuvira retrieval stats` and the dashboard
              // Retrieval card reflect pipeline retrieval too (not just chat).
              try {
                const originalTokens = contextFiles.reduce((sum, f) => {
                  try { return sum + retrievalEstimateTokens(readFileSync(f, 'utf-8')); } catch { return sum; }
                }, 0);
                const reducedTokens = hits.reduce((sum, h) => sum + h.chunk.tokenCount, 0);
                recordRetrievalStats({
                  used: hits.length > 0,
                  originalTokens,
                  reducedTokens,
                  savedTokens: Math.max(0, originalTokens - reducedTokens),
                  pctReduced: originalTokens > 0 ? Math.round((1 - reducedTokens / originalTokens) * 1000) / 10 : 0,
                  chunksRetrieved: hits.length,
                  failover: false,
                  hits: hits.map((h) => ({ filePath: h.chunk.filePath, similarity: h.similarity })),
                  timestamp: Date.now(),
                });
              } catch {
                // Best-effort — stats must never break the pipeline.
              }
              if (options.verbose) {
                logger.info(`🧠 Indexed ${files} file(s) into ${chunks} retrieval chunk(s)`);
              }
            }
          }
        } catch (err) {
          logger.debug(`Vector retrieval hook skipped: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Prune context after each agent step to keep the context bus within limits
      this.pruneContext(vault, options);

      if (options.verbose) {
        const icon = result.success ? '✅' : '⚠️';
        logger.info(`      ${icon} ${result.summary}`);
        // If it's a runner, show the output inline
        if (effectiveAgentType === 'runner' && result.success && result.details) {
          const outputLines = result.details.split('\n').filter((l) => l.startsWith('stdout:') || l.startsWith('Command:'));
          for (const line of outputLines) {
            logger.info(`      ${line}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vault.updateTaskStatus(task.id, 'failed', msg);
      await tryUpdateDAGNode(task.id, { status: 'failed', summary: msg });
      agentResults.push({ agent: task.agentType, success: false, summary: `Error: ${msg}` });
    }
  }

  private getExecutionStrategy(
    task: { agentType: string; description: string },
    routingContext: { taskProfile?: { intent?: string; requiresVerification?: boolean } } | undefined,
  ): RoutingExecutionStrategy {
    const intent = routingContext?.taskProfile?.intent;
    const requiresVerification = routingContext?.taskProfile?.requiresVerification === true;
    // Only the WRITER (file-producing agent) is remapped by intent. Runner and
    // tester EXECUTE things — commands and tests — and must never be silently
    // replaced by a code-writing debugger, a reviewer, or the security agent:
    // the debugger requires `testResult` metadata that only a real tester run
    // produces (a runner→debugger swap observed live: a "Run `wrangler pages
    // project create`" step was remapped to the debugger, which refused with
    // "No test results found" and never executed the command). Intent shapes
    // WHICH code agent writes; execution agents stay as planned.
    const writerLike = ['writer'].includes(task.agentType);

    let effectiveAgentType = task.agentType;
    let followUpAgentType: string | undefined;
    let runSerially = false;
    let useRepair = false;
    let maxRepairs = 3;
    let verificationPass = false;

    switch (intent) {
      case 'security':
        if (writerLike) effectiveAgentType = 'security';
        runSerially = true;
        useRepair = true;
        maxRepairs = 4;
        break;
      case 'debugging':
        if (writerLike) effectiveAgentType = 'debugger';
        runSerially = true;
        useRepair = true;
        maxRepairs = 5;
        break;
      case 'verification':
        if (writerLike) effectiveAgentType = 'reviewer';
        runSerially = true;
        useRepair = true;
        maxRepairs = 4;
        verificationPass = true;
        followUpAgentType = 'reviewer';
        break;
      case 'architecture':
        runSerially = true;
        break;
      default:
        break;
    }

    // H2 — delegate steps: the DelegateAgent fans out sub-agent specs in
    // PARALLEL and aggregates partial failures itself, so the step runs in the
    // parallel batch like other independent tasks, and the ErrorRepairEngine
    // is NOT layered on top (re-running a delegate step would re-fan-out every
    // sub-agent; its own aggregation is the repair signal).
    if (task.agentType === 'delegate') {
      runSerially = false;
      useRepair = false;
      effectiveAgentType = 'delegate';
    }

    if (requiresVerification && !followUpAgentType && task.agentType !== 'reviewer') {
      followUpAgentType = 'reviewer';
      verificationPass = true;
    }

    return {
      effectiveAgentType,
      followUpAgentType,
      runSerially,
      useRepair,
      maxRepairs,
      verificationPass,
    };
  }

  /**
   * Create an LLM call function routed by the AutoModelRouter for a task.
   * Uses the task description for complexity analysis and resolves the best
   * provider/model per agent type.
   */
  /**
   * M2.5: estimate the REAL prompt payload for a task — goal + task
   * description + the workspace context files the agent will receive (sized by
   * stat, the same chars→tokens heuristic as estimateTokens, without reading
   * file contents). Passed as contextHintTokens so the context-fit signal
   * differentiates per-task in multi-agent pipelines the way it does for chat's
   * growing conversation history. Best-effort: any stat failure contributes 0
   * (the router still falls back to the task-description estimate).
   */
  private estimateTaskPayloadTokens(vault: ContextVault, taskDescription: string, contextFiles: string[]): number {
    // goal/description are pure string ops (can't throw); only statSync can —
    // each file is guarded individually, so no outer guard needed.
    let tokens = estimateTokens(vault.context.goal) + estimateTokens(taskDescription);
    for (const file of contextFiles) {
      try {
        tokens += statSync(file).size / 4.5;
      } catch {
        // Best-effort — a missing/unreadable file contributes nothing
      }
    }
    return Math.ceil(tokens);
  }

  private resolveAutoRoutingDecision(
    task: { agentType: string; description: string; complexity?: string; contextHintTokens?: number },
    options: OrchestratorOptions,
  ): AutoRouteResult {
    // ISSUE-003: ONE resolve-options assembly for every action point. The
    // shared helper supplies the full chat/orchestrator feature set (bandit
    // learning ON by default, quota-ledger status via the registry's unified
    // read path, runtime stats, cost/speed/reasoning floors, paid-model gate,
    // context preflight); the orchestrator layers its per-task complexity hint
    // on top.
    const decision = getAutoRouter().resolve(
      task.agentType,
      task.description,
      {
        ...buildAutoResolveOptions(this.configManager, {
          verbose: options.verbose,
          contextHintTokens: task.contextHintTokens,
        }),
        complexityHint: task.complexity as ComplexityLevel | undefined,
        ...(options.taskIntentHint ? { taskIntentHint: options.taskIntentHint } : {}),
      },
      this.configManager,
    );
    // ── Session-exclusion consultation (Nuvira-Router M0.3) ──────────────
    // A provider that failed EARLIER in this pipeline (auth = rest of the
    // pipeline, rate-limit/transient = short cooldown) is excluded from the
    // resolve-time winner, exactly like chat's walk skips session-failed
    // providers. Without this, the registry/quota write-throughs from Stage C
    // are learned but a task whose router pick IS the dead provider would
    // still fail into it once per task before the walk learns again. Sink the
    // decision to the best-ranked NON-excluded provider.
    const exclusionNow = Date.now();
    const isActiveExclusion = (p: string): boolean => {
      const expiresAt = this.failureSession.sessionFailedProviders.get(p);
      return expiresAt !== undefined && expiresAt > exclusionNow;
    };
    let effective = decision;
    if (isActiveExclusion(decision.provider)) {
      const next = decision.ranked.find((r) => !isActiveExclusion(r.provider));
      if (next) {
        const keptRanked = decision.ranked.filter((r) => !isActiveExclusion(r.provider));
        effective = {
          ...decision,
          provider: next.provider,
          model: getAutoRouter().resolveModel(next.provider, task.agentType, this.configManager),
          score: next.score,
          ranked: keptRanked,
          // Keep the fallback chain consistent with the sunk pick — never walk
          // back into the excluded provider via repair/escalation/switch.
          fallbackChain: decision.fallbackChain.filter((c) => !isActiveExclusion(c.provider)),
          explanation: `${decision.explanation} — ${decision.provider} excluded this pipeline (failed earlier); sank to ${next.provider}.`,
        };
        if (options.verbose) {
          logger.warn(`      ⚠️ ${decision.provider} excluded this pipeline (failed earlier) — routing ${task.agentType} to ${next.provider}`);
        }
      } else if (options.verbose) {
        // Winner + every ranked provider excluded — no sink possible. The pick
        // falls through to the excluded winner and will fail once (graceful
        // degradation, matching chat's exhausted-candidates behavior).
        logger.warn(`      ⚠️ ${decision.provider} excluded this pipeline (failed earlier) and no non-excluded ranked provider remains — trying it once`);
      }
    }
    // Record for the dashboard usage stats + audit trail (the EFFECTIVE pick)
    recordRoutingDecision({
      source: 'orchestrator',
      agentType: task.agentType,
      task: task.description,
      complexity: effective.complexity,
      provider: effective.provider,
      model: effective.model,
      score: effective.score,
    });
    return effective;
  }

  private createAutoRoutedLLM(
    task: { agentType: string; description: string; complexity?: string; contextHintTokens?: number; taskId?: string },
    options: OrchestratorOptions,
    onRouted?: (provider: string) => void,
  ): LLMCallFn {
    const decisionOverride = this.routingDecisionOverrides.get(task.agentType);
    const decision = decisionOverride ?? this.resolveAutoRoutingDecision(task, options);
    // Let the caller learn which provider this callLLM is bound to (used to
    // seed the rate-limit storm guard's tried-providers set in auto mode).
    onRouted?.(decision.provider);
    // Remember the ROUTED complexity for this task — the tier the LLM actually
    // runs at (the router may have escalated it). Repair escalation climbs
    // from this, never from the raw label. Keyed by task id; the planner
    // (no task id) is covered by the routingDecisionOverrides latch instead.
    if (task.taskId && decision.complexity) {
      this.routedComplexities.set(task.taskId, decision.complexity);
    }
    // Remember the ROUTED provider×model so the repair path can detect a
    // no-op escalation (escalation landing back on the same model).
    if (task.taskId) {
      this.routedProviderModelByTask.set(task.taskId, { provider: decision.provider, model: decision.model });
    }
    return this.createAutoRoutedLLMFromDecision(task, options, decision);
  }

  /**
   * Detect a NO-OP model escalation for a task: the "stronger model" the
   * repair engine would escalate to resolves to the SAME provider×model as
   * the one that just failed. This happens when every stronger candidate is
   * unavailable/blocked (e.g. only a weak local model is configured) —
   * re-prompting "a stronger model" then just repeats the identical failure
   * until the repair budget dies. The caller degrades instead: lenient
   * parsing for the writer, a clear warning, and a bounded repair budget.
   *
   * Returns true when escalation would be a no-op (or the routed baseline is
   * unknown — treat as no-op to stay safe), false when a genuinely different
   * provider×model exists for escalation.
   */
  private isNoOpEscalation(taskId: string | undefined, escalated?: { provider: string; model: string }): boolean {
    if (!taskId || !escalated) return true;
    const routed = this.routedProviderModelByTask.get(taskId);
    if (!routed) return true;
    return routed.provider === escalated.provider && routed.model === escalated.model;
  }

  /**
   * Whether a stronger candidate is in a SHORT cooldown that will recover
   * soon — the only honest basis for offering "wait and retry". Checks the
   * session exclusions (rate-limit / transient cooldowns) and the shared
   * circuit breaker for any provider other than the weak one with a recovery
   * time within MAX_WEAK_WAIT_MS. Returns the wait ms (or null when no
   * stronger candidate is coming back soon — 'wait' is then not offered).
   */
  private weakModelWaitAvailableMs(taskId: string | undefined): number | null {
    if (!taskId) return null;
    const weak = this.routedProviderModelByTask.get(taskId);
    const now = Date.now();
    let best: number | null = null;

    // 1. Session exclusions (auth = MAX_SAFE, rate-limit/transient = short).
    for (const [provider, expiresAt] of this.failureSession.sessionFailedProviders) {
      if (weak && provider === weak.provider) continue;
      const remaining = expiresAt - now;
      if (remaining > 0 && remaining <= MAX_WEAK_WAIT_MS) {
        best = best === null ? remaining : Math.min(best, remaining);
      }
    }

    // 2. Shared circuit breaker cooldowns (opened after repeated failures).
    try {
      const statuses = getProviderFallback(this.configManager).getCircuitBreakerStatus();
      for (const s of statuses) {
        if (weak && s.provider === weak.provider) continue;
        if (s.cooldownRemaining > 0 && s.cooldownRemaining <= MAX_WEAK_WAIT_MS) {
          best = best === null ? s.cooldownRemaining : Math.min(best, s.cooldownRemaining);
        }
      }
    } catch {
      // Best-effort — circuit breaker must never break the prompt.
    }

    return best;
  }

  /**
   * Build an ESCALATED planner LLM for repair attempts (assessment P0).
   *
   * The Auto router picks the cheapest ADEQUATE model per task. When that
   * model fails to plan (garbage JSON, example regurgitation), re-resolving at
   * the NEXT complexity level forces the router to rank reasoning capacity
   * higher — the repair then runs on a genuinely stronger model instead of
   * re-prompting the same weak one that already failed. Uses a fresh decision
   * (not the latched planner override) so the escalation actually applies.
   */
  private createEscalatedPlannerLLM(goal: string, options: OrchestratorOptions): LLMCallFn {
    const plannerDecision = this.routingDecisionOverrides.get('planner');
    return this.createEscalatedLLM('planner', goal, options, plannerDecision?.complexity as string | undefined);
  }

  /**
   * Re-route a task's repair at the NEXT complexity level so the Auto router
   * picks a STRONGER model than the one that just failed (assessment P0).
   *
   * Used by BOTH the planner repair path and the per-task agent repair path
   * (writer/debugger/security/tester...): re-prompting the same weak model
   * that already failed just repeats the failure until the repair budget
   * dies. The escalation carries the stronger decision's routing snapshot
   * into the reasoning trace so repairs are fully auditable.
   */
  /**
   * Resolve the escalated (next-complexity) routing decision for a task.
   * Extracted so the repair path can inspect the decision ONCE (detect a
   * no-op escalation) and then build the escalated LLM from it — avoiding a
   * double resolveAutoRoutingDecision (which has side effects: routing
   * history + audit write-through).
   */
  private resolveEscalatedDecision(
    agentType: string,
    description: string,
    options: OrchestratorOptions,
    baseComplexity?: string,
    taskId?: string,
    allowedProviders?: string[],
  ): AutoRouteResult {
    // Prefer the ROUTED complexity (the tier that actually failed — the router
    // may have escalated the raw label) so the escalation is guaranteed to be
    // strictly above the failing tier. Fall back to the raw label / undefined
    // (undefined → 'critical', the top of the ladder) for the planner path.
    const effectiveBase = (taskId && this.routedComplexities.get(taskId)) || baseComplexity;
    const COMPLEXITY_LADDER = ['trivial', 'simple', 'moderate', 'complex', 'critical'] as const;
    const currentIdx = COMPLEXITY_LADDER.indexOf(effectiveBase as any);
    const escalatedComplexity =
      currentIdx >= 0 && currentIdx < COMPLEXITY_LADDER.length - 1
        ? COMPLEXITY_LADDER[currentIdx + 1]
        : 'critical';
    const escalatedTask = {
      agentType,
      description,
      complexity: escalatedComplexity,
      taskId,
      // Mark repair steps in the reasoning trace so the dashboard can show
      // exactly which calls were model-escalated repairs (v1.60.4).
      escalated: true,
    };
    // When the user explicitly selected a provider, constrain escalation to
    // that provider only — never silently re-route to a different provider.
    if (allowedProviders?.length) {
      const constrained = { ...options, allowedProviders };
      return this.resolveAutoRoutingDecision(escalatedTask, constrained);
    }
    return this.resolveAutoRoutingDecision(escalatedTask, options);
  }

  private createEscalatedLLM(
    agentType: string,
    description: string,
    options: OrchestratorOptions,
    baseComplexity?: string,
    taskId?: string,
  ): LLMCallFn {
    const escalatedTask = {
      agentType,
      description,
      complexity: taskId
        ? ((this.routedComplexities.get(taskId) || baseComplexity) &&
            this.escalateComplexity(this.routedComplexities.get(taskId) || baseComplexity))
        : this.escalateComplexity(baseComplexity),
      taskId,
      escalated: true,
    };
    // DECISION #MANUAL-MODEL-SANCTITY: When the user explicitly selected a
    // provider/model (not auto), escalation must NOT re-route to a different
    // provider. The user's choice is sacred — only try stronger models within
    // the SAME provider. Re-routing to a different provider on escalation
    // violates the user's explicit intent and causes confusing behavior
    // (e.g. user picks openrouter/stealth-ox-alpha, escalation silently
    // switches to groq/default which 404s).
    const userExplicitlySelected = !isAutoModel(options.model) && !isAutoProvider(options.provider) && !!options.provider;
    const escalationAllowedProviders = userExplicitlySelected && options.provider
      ? [options.provider]
      : undefined; // undefined = auto-router decides freely
    const decision = this.resolveEscalatedDecision(agentType, description, options, baseComplexity, taskId, escalationAllowedProviders);
    if (options.verbose) {
      logger.info(`      🚀 Escalating ${agentType} repair to a stronger model (${escalatedTask.complexity}): ${decision.provider}/${decision.model}`);
    }
    // Record the escalated provider×model so the repair path can detect a
    // no-op escalation (escalation landing back on the same weak model)
    // without re-resolving the decision. Keyed by task id; the planner (no
    // task id) records under its agent type so its guard can compare against
    // the routed baseline recorded at planning time.
    const escalationKey = taskId ?? (agentType === 'planner' ? 'planner' : undefined);
    if (escalationKey) {
      this.escalatedProviderModelByTask.set(escalationKey, { provider: decision.provider, model: decision.model });
    }
    return this.createAutoRoutedLLMFromDecision(escalatedTask, options, decision);
  }

  /** Next rung on the complexity ladder (critical is the top). */
  private escalateComplexity(base: string | undefined): string {
    const COMPLEXITY_LADDER = ['trivial', 'simple', 'moderate', 'complex', 'critical'] as const;
    const currentIdx = COMPLEXITY_LADDER.indexOf(base as any);
    return currentIdx >= 0 && currentIdx < COMPLEXITY_LADDER.length - 1
      ? COMPLEXITY_LADDER[currentIdx + 1]
      : 'critical';
  }


  private createAutoRoutedLLMFromDecision(
    task: { agentType: string; description: string; complexity?: string; contextHintTokens?: number; taskId?: string; escalated?: boolean },
    options: OrchestratorOptions,
    decision: AutoRouteResult,
  ): LLMCallFn {
    if (options.verbose) {
      logger.info(`      🤖 Auto: ${decision.explanation}`);
    }
    // Surface the routing decision to the user ("how it's taking decisions"):
    // which provider/model was chosen for this agent and why.
    this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
      agentType: task.agentType,
      stage: 'routing',
      message: decision.explanation || `Routed to ${decision.provider}/${decision.model}`,
    }, 'orchestrator');
    // Model health: the router resolves each provider's PINNED config model,
    // which can be stale (deprecated gemini-2.0-flash-exp → 404) or a
    // placeholder (nim 'new-nim-model'). Don't bake the unvalidated model into
    // the provider options — validate against the provider's live model list on
    // the first call and repair to a verified-working model. 'auto' is never
    // sent to a real API: the base LLM's model guard resolves the fallback.
    const base = this.createLLMProvider({
      ...options,
      provider: decision.provider,
      model: undefined,
    });
    let workingModel: string | undefined;
    let validated = false;
    // Failover targets: the router's OTHER ranked providers, best-first, only
    // when this decision was AUTO-routed (ranked non-empty). A pinned provider
    // (e.g. --provider groq) has an empty ranked list and is never overridden.
    // Providers already in circuit-breaker cooldown are skipped by the router's
    // scoring, so re-checking here is cheap and defensive.
    const failoverCandidates =
      decision.ranked && decision.ranked.length > 1
        ? decision.ranked
            .filter((c) => c.provider !== decision.provider && !c.inCooldown)
            .slice(0, 3)
        : [];

    // P0 reasoning trace: the auto-routed LLM carries its routing snapshot, so
    // every call records which provider×model the router picked AND the
    // verified model actually used. taskId (when present) links steps to the
    // dashboard DAG node. withTraceCapture is best-effort and never changes
    // the call behavior (errors still propagate to fallback/repair handling).
    return withTraceCapture(
      async (prompt: string, inferenceOptions?: InferenceOptions) => {
        // Runs a provider×model through the SAME guarded path as `base`
        // (injection scan, 'auto'-model guard, shared failure telemetry). The
        // winner uses the validated working model; failover candidates let the
        // adapter resolve its own best verified model (undefined).
        const callWithProvider = (provider: string, model: string | undefined): Promise<string> => {
          const llm =
            provider === decision.provider
              ? base
              : this.createLLMProvider({ ...options, provider, model: undefined });
          return llm(prompt, { ...inferenceOptions, model }) as Promise<string>;
        };
        if (!validated) {
          validated = true;
          try {
            const { config } = this.configManager.getProviderConfig(decision.provider as ProviderType);
            const adapter = ProviderFactory.createProvider(decision.provider as ProviderType, config);
            // resolveRoute, not resolveWorkingModel: identical repair policy, but
            // the pair is validated against the adapter that will serve the call
            // and a substitution is printed + recorded instead of silent.
            const route = await resolveRoute({
              providerType: decision.provider,
              provider: adapter,
              model: decision.model,
              source: 'orchestrator',
              agentType: task.agentType,
              task: task.description,
              verifyOnDemand: isMaxCapability(this.configManager),
            });
            workingModel = route.model;
          } catch {
            workingModel = decision.model;
          }
          // Keep the dashboard audit trail accurate: resolveAutoRoutingDecision()
          // recorded the original (possibly broken) model, but the actual call
          // uses the repaired working model. Re-record with the verified model.
          if (workingModel !== decision.model) {
            try {
              recordRoutingDecision({
                source: 'orchestrator',
                agentType: task.agentType,
                task: task.description,
                complexity: decision.complexity,
                provider: decision.provider,
                model: workingModel ?? decision.model,
                // B2-a — this block runs only when the model was REPAIRED
                // (`workingModel !== decision.model`), so `decision.score`
                // describes the model that was replaced. The repaired model was
                // substituted, never ranked: record it with no score rather than
                // with a number that belongs to a different model.
              });
            } catch {
              // Audit is best-effort — never break the LLM call over telemetry
            }
          }
        }
        // A failed call is recorded exactly ONCE, inside createLLMProvider (base
        // routes through it): the same shared telemetry path chat and the
        // fallback commands use, so the NEXT task in this pipeline — and every
        // future session — routes around the dead provider×model predictively.
        // Recording here instead of above avoids a double-write AND keeps
        // guardrail blocks (injection scan, thrown BEFORE the generate call)
        // out of the registry — those aren't provider failures.
        //
        // Cross-provider failover ("the reviewer hit a rate limit — why didn't
        // it take another model?"): a RETRYABLE failure on the auto-picked
        // winner (503 high-demand / 429 / network) walks to the router's next
        // ranked cloud candidate instead of exhausting the repair budget on
        // one provider. Auth failures never fail over (broken key ≠ other
        // providers broken) and a user-PINNED provider (ranked empty) is
        // honored as-is.
        try {
          return await callWithProvider(decision.provider, workingModel ?? decision.model);
        } catch (err) {
          const kind = classifyFallbackError(err);
          if (kind === 'auth' || failoverCandidates.length === 0) throw err;
          // Winner is transiently down — try the next-ranked candidates.
          for (const candidate of failoverCandidates) {
            try {
              logger.warn(
                `   ⚠️  ${decision.provider} (${kind}) — failing over to ${candidate.provider} for ${task.agentType}`,
              );
              this.eventBus.emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
                agentType: task.agentType,
                stage: 'routing',
                message: `⚠️ ${decision.provider} ${kind} — failing over to ${candidate.provider}`,
              }, 'orchestrator');
              return await callWithProvider(candidate.provider, undefined);
            } catch (err2) {
              // Recorded by createLLMProvider's shared telemetry. An auth
              // failure on ONE candidate (e.g. groq's key rotated) must NOT
              // abort the walk — other providers have their own keys. Only
              // rethrow the winner's error once every candidate is exhausted.
            }
          }
          throw err;
        }
      },
      {
        traceId: this.activeTraceId ?? '',
        agentType: task.agentType,
        taskId: task.taskId,
        description: task.description,
        escalated: task.escalated,
        routing: {
          provider: decision.provider,
          model: decision.model,
          score: decision.score,
          complexity: decision.complexity,
          explanation: decision.explanation,
        },
      },
    );
  }

  /**
   * Create a RESILIENT auto-routed callLLM that auto-routes on ANY failure.
   *
   * Unlike createAutoRoutedLLM (which binds to ONE provider and only failovers
   * on rate-limit), this proxy:
   * 1. Routes to the auto-router's best candidate initially
   * 2. On ANY failure (not just rate-limit), re-routes to the next candidate
   * 3. Tries ALL ranked candidates (no 3-candidate cap)
   * 4. Tracks failures across the entire session AND persists to disk
   * 5. Tools/sub-agents use it transparently
   *
   * Use this when you want maximum resilience — the caller never sees errors
   * unless ALL providers are exhausted.
   */
  private createResilientAutoRoutedLLM(
    task: { agentType: string; description: string; complexity?: string; taskId?: string; contextHintTokens?: number },
    options: OrchestratorOptions,
  ): LLMCallFn {
    return createResilientCallLLM(this.configManager, {
      task: {
        agentType: task.agentType,
        description: task.description,
        complexity: task.complexity,
        taskId: task.taskId,
        contextHintTokens: task.contextHintTokens,
      },
      verbose: options.verbose,
      crossPipelineMemory: true,
    });
  }

  /**
   * One-shot background model-registry refresh for a COLD registry.
   *
   * Fired when auto routing is active and the registry has no verified
   * providers: probes listModels + spot-checks the configured providers so the
   * pipeline's later tasks route on REAL health data (the dedicated model-
   * health agent's job, started on demand instead of waiting for `nuvira models
   * watch`). Latched per instance — a long dev-mode session only pays once.
   * Fire-and-forget: never awaited, never blocks, never throws.
   */
  private maybeFireColdStartProbe(): void {
    // ── The warmup daemon is NOT cold-start-only (Models-page audit) ───────
    // It used to start ONLY from the cold branch below, so from the first
    // verified model onward nothing ever warmed or verified anything again: the
    // routing pool froze at whatever the cold probe found, and then the
    // registry's own 7-day staleness rule began retiring models nothing
    // re-verified (observed: 12 verified models against 496 unverified, four of
    // the 12 within 24h of going stale).
    //
    // Starting it on every run is safe because it is unref'd (it can never hold
    // the process open) and its per-cycle budget is bounded. That unref is what
    // makes this possible — without it, starting the daemon on a normal run
    // would hang every CLI command forever.
    this.maybeStartWarmupDaemon();

    if (this.coldStartProbeFired) return;
    try {
      const registry = getModelRegistry();
      if (registry.getUsableProviders().length > 0) return; // not cold
      this.coldStartProbeFired = true;
      void refreshModelRegistry(this.configManager, { spotCheck: true }).then((result) => {
        logger.info(
          `   🌱 Cold-start registry probe: ${result.providersProbed.length} provider(s), ${result.verified} verified, ${result.unavailable} unavailable`,
        );
      }).catch(() => {
        // Best-effort — a failed probe must never break the pipeline.
      });
    } catch {
      // Best-effort.
    }
  }

  /** Whether this instance already started the background warmup daemon. */
  private warmupDaemonStarted = false;

  /** Start the background model warmup/exploration daemon exactly once. */
  private maybeStartWarmupDaemon(): void {
    if (this.warmupDaemonStarted) return;
    this.warmupDaemonStarted = true;
    try {
      const { startWarmupDaemon } = require('../learning/model-warmup.js');
      startWarmupDaemon(this.configManager);
    } catch {
      // Best-effort — warmup must never break routing
    }
  }

  private applyRoutingPlanAdjustments(
    vault: ContextVault,
    routingContext: { taskProfile?: { requiresVerification?: boolean; notes?: string[] } } | undefined,
  ): void {
    if (!routingContext?.taskProfile?.requiresVerification) {
      return;
    }

    const existingReviewer = vault.context.taskPlan.some((step) => step.agentType === 'reviewer');
    if (existingReviewer) {
      return;
    }

    const reviewerStep: TaskStep = {
      id: `step-${vault.context.taskPlan.length + 1}-review`,
      description: routingContext.taskProfile.notes?.[0]
        ? `Review and validate the work: ${routingContext.taskProfile.notes[0]}`
        : 'Review the changes and validate the result',
      agentType: 'reviewer',
      dependsOn: vault.context.taskPlan.map((step) => step.id),
      status: 'pending',
    };

    vault.context.taskPlan.push(reviewerStep);
  }

  /**
   * Run the ContextPruner on the vault context.
   * Only prunes when the context exceeds the configured threshold.
   * Logs details in verbose mode.
   */
  private pruneContext(vault: ContextVault, options: OrchestratorOptions): void {
    // Budget from the SERVED model's real window when it is known (the registry
    // records each provider's advertised `context_length`), falling back to the
    // historical 128K default when it is not — so nothing regresses for a model
    // we cannot discover, while a large-window model stops being pruned as if it
    // had 128K. An explicit `contextLimit` still wins outright.
    //
    // NOTE: this uses the pipeline's configured provider/model. In auto mode the
    // CONCRETE model is chosen per task, so a per-task budget would be more
    // precise still — that requires threading the routed decision into pruning.
    const maxTokens = resolveContextBudget({
      provider: options.provider,
      model: options.model,
      override: options.contextLimit,
    }).budget;
    // T2 — model-window-aware FILE-context budget for the writer/edit agents,
    // derived from the same window the pruner uses. Unknown windows resolve to
    // the historical caps (10 files / 16K chars), so nothing regresses; a known
    // large window lets the writer read more of the project instead of a fixed
    // keyhole. Best-effort — budget metadata must never break a run.
    try {
      const fileBudget = resolveContextFileBudget({
        provider: options.provider,
        model: options.model,
        override: options.contextLimit,
      });
      vault.setMeta('contextFileBudgetChars', fileBudget.maxChars);
      vault.setMeta('contextFileBudgetFiles', fileBudget.maxFiles);
    } catch {
      // Best-effort.
    }
    const pruner = new ContextPruner({
      maxTokens,
      conversationMode: options.contextPruneMode || 'soft',
    });

    const result = pruner.prune(vault.context);

    if (result.pruned) {
      vault.setMeta('lastPruneResult', result);

      if (options.verbose) {
        const formatted = pruner.formatPruneResult(result);
        if (formatted) {
          logger.info(`\n${formatted}`);
        }
      }
    }
  }

  private applyFileChanges(vault: ContextVault): number {
    let count = 0;
    for (const change of vault.context.fileChanges) {
      if (change.status === 'deleted') continue;
      if (!change.newContent) continue;

      const absolutePath = isAbsolute(change.path)
        ? change.path
        : resolve(process.cwd(), change.path);

      const dir = dirname(absolutePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(absolutePath, change.newContent, 'utf-8');
      count++;
    }
    return count;
  }

  /** Long-form jobs in flight this run, keyed by job key. */
  private longFormJobs = new Map<string, LongFormJob>();

  /**
   * Enterprise G11 — the work this run leaves unfinished, handed to the calling
   * surface so it can keep going without a "continue" turn.
   */
  private pendingWork?: PendingWork;

  /**
   * The config's effective provider/model, resolved once per run.
   *
   * Only used for ATTRIBUTION (traces, events, review bundles). When the user
   * pinned a provider or a model those win; otherwise the running default is
   * looked up, so a trace says `gemini · gemini-2.0-flash` instead of
   * `unknown · unknown`. A live 5-page story run recorded every step as
   * unknown — the audit trail could not say which model wrote the book.
   */
  private defaultRoute: { provider?: string; model?: string } | null = null;

  private resolveAuditRoute(
    options: Pick<OrchestratorOptions, 'provider' | 'model'>,
    agentModel?: string,
  ): { provider?: string; model?: string } {
    const model = agentModel || options.model;
    if (options.provider && model) return { provider: options.provider, model };

    if (!this.defaultRoute) {
      let provider: string | undefined;
      let configuredModel: string | undefined;
      try {
        provider = resolveDefaultProvider(this.configManager);
        configuredModel = this.configManager.getProviderConfig(provider as ProviderType).config?.model;
      } catch {
        // Best-effort attribution — an unresolvable default stays undefined
        // and the trace falls back to its own 'unknown' marker.
      }
      this.defaultRoute = { provider, model: configuredModel };
    }

    return { provider: options.provider ?? this.defaultRoute.provider, model: model ?? this.defaultRoute.model };
  }

  /** The prose unit + owning job for each long-form task id. */
  private proseUnits = new Map<string, { unit: ProseUnit; jobKey: string }>();

  /** Steps that create files from scratch, keyed by task id (one-shot writer). */
  private creationSteps = new Set<string>();

  /**
   * Plan an authored ask as bounded prose units.
   *
   * Returns null for every non-authored goal, so the ordinary code path is
   * untouched. For an authored goal whose units are already all written, the
   * finished document is assembled and no work is planned — a "continue" turn
   * after completion must not restart the book.
   */
  private planAuthored(
    vault: ContextVault,
    goal: string,
    options: OrchestratorOptions,
  ): AuthoredPlan | null {
    const workingDir = vault.context.workingDirectory || process.cwd();
    const forceResume = isContinuationAsk(goal);

    // ── Hybrid asks get PHASES, not units ──────────────────────────────────
    // "a web-based interactive book with voice" is authored content AND an
    // application. Planning it as either alone loses half the ask, so it is
    // planned as ordered phases (shape → content → experience → services →
    // verify) with a deterministic verification step at the end.
    let composite: CompositePlan | null = null;
    try {
      composite = buildCompositePlan({ goal, workingDir });
    } catch (err) {
      logger.debug(`composite planning skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (composite) {
      const presence = artifactsPresence(workingDir, composite.expectedArtifacts);
      const progress = jobProgress(composite.job);
      // Everything already on disk? Then there is nothing to plan. (A re-run of
      // a finished ask must never rebuild the shell over finished chapters.)
      if (progress.complete && presence.present === presence.total) {
        const assembled = assembleDocument(composite.job);
        if (assembled) {
          logger.success(`   🛠️ Deliverable already complete — assembled ${assembled.path}`);
        }
        return null;
      }
      this.longFormJobs.set(composite.job.key, composite.job);
      for (const [stepId, unit] of composite.proseUnits) {
        this.proseUnits.set(stepId, { unit, jobKey: composite.job.key });
      }
      // Greenfield creation steps go to the one-shot writer (see the exception
      // in `runAgent`): a read→edit loop has nothing to read in a directory that
      // does not exist yet.
      for (const id of composite.creationStepIds) this.creationSteps.add(id);
      vault.setMeta('longFormJobKey', composite.job.key);
      vault.setMeta('compositeArtifacts', composite.expectedArtifacts);
      const plan: AuthoredPlan = {
        steps: composite.steps,
        progressLine: composite.progressLine,
        resumed: forceResume,
        kind: 'phased',
        label: `${composite.deliverableSummary} — ${composite.progressLine}`,
        expectedArtifacts: composite.expectedArtifacts,
        job: composite.job,
        composite,
      };
      this.pendingWork = this.pendingWorkFor(composite.job, 'phased', composite.expectedArtifacts);
      if (options.verbose) {
        logger.info(`   🛠️ ${composite.substrates.join(' + ')} → ${composite.phases.map((p) => p.title).join(' → ')}`);
      }
      return plan;
    }

    // ── Everything else: the single-substrate unit plan (G8) ───────────────
    // A bare "continue" carries no class or magnitude — the ledger does, so it
    // resumes the project's in-flight job instead of starting a second book
    // from the default filename.
    const plan = buildLongFormPlan({ goal, workingDir, forceResume });
    if (!plan) return null;

    if (plan.steps.length === 0) {
      const assembled = assembleDocument(plan.job);
      if (assembled) {
        logger.success(
          `   📖 Nothing left to write — assembled ${assembled.path} (${formatCount(assembled.words)} words, ~${assembled.pages} pages)`,
        );
      }
      return null;
    }

    this.longFormJobs.set(plan.job.key, plan.job);
    for (const [stepId, unit] of plan.units) {
      this.proseUnits.set(stepId, { unit, jobKey: plan.job.key });
    }
    vault.setMeta('longFormJobKey', plan.job.key);
    const authored: AuthoredPlan = {
      steps: plan.steps,
      progressLine: plan.progressLine,
      resumed: plan.resumed,
      kind: 'long-form',
      label: plan.progressLine,
      job: plan.job,
    };
    this.pendingWork = this.pendingWorkFor(plan.job, 'long-form');
    if (options.verbose && plan.resumed) {
      logger.info(`   📖 Resuming long-form work — ${plan.progressLine}`);
    }
    return authored;
  }

  /**
   * The in-flight authored job for this project, if any (G14).
   *
   * The signal is the LEDGER, not the wording of the ask. A composite
   * continuation re-sends the ORIGINAL goal — its phases are re-derived against
   * the ledger — so `isContinuationAsk('continue')` would miss it entirely. An
   * in-flight job for this project IS the continuation, whichever surface
   * scheduled it.
   */
  private findInFlightAuthoredJob(vault: ContextVault): LongFormJob | null {
    try {
      const workingDir = vault.context.workingDirectory || process.cwd();
      return findInProgressJob(workingDir);
    } catch {
      return null;
    }
  }

  /**
   * Describe what is still outstanding, so the calling SURFACE can keep it
   * going without the user typing "continue".
   *
   * Measured from the ledger, never from the run's own success flag: a batch
   * that succeeded is 4 chapters of a 39-chapter book, and reporting that as
   * "done" is the overclaim this whole workstream exists to remove.
   */
  private pendingWorkFor(
    job: LongFormJob,
    kind: 'long-form' | 'phased',
    expectedArtifacts?: string[],
  ): PendingWork {
    const progress = jobProgress(job);
    const presence = artifactsPresence(job.projectPath, expectedArtifacts);
    const unitsLeft = progress.total - progress.done;
    const filesLeft = presence.total - presence.present;
    const complete = progress.complete && filesLeft === 0;
    return {
      kind,
      goal: job.goal,
      projectPath: job.projectPath,
      // A composite deliverable is re-planned from the ORIGINAL ask (its phases
      // are re-derived against the ledger); a plain book resumes on "continue".
      continuationPrompt: kind === 'phased' ? job.goal : 'continue',
      ...(expectedArtifacts ? { expectedArtifacts } : {}),
      progressLine: formatProgress(job),
      percent: complete ? 100 : progress.percent,
      reason: complete
        ? 'the content is complete but the deliverable has not been assembled yet'
        : unitsLeft > 0
          ? `${unitsLeft} of ${progress.total} content units remaining`
          : `${filesLeft} deliverable file(s) remaining`,
    };
  }

  /**
   * The honest progress line for the pipeline summary.
   *
   * Reported even when the batch SUCCEEDED, because for a 39-unit book a
   * successful batch is 4 chapters — presenting that as "done" (or as a bare
   * "success") is the kind of overclaim this hardening exists to remove.
   *
   * It no longer asks the user to reply: the work is scheduled to continue on
   * its own (the surface reads `result.pendingWork`), so demanding a "continue"
   * would be asking for permission the ask already granted.
   */
  private longFormProgressNote(vault: ContextVault): string {
    const key = vault.getMeta<string>('longFormJobKey');
    if (!key) return '';
    const job = this.longFormJobs.get(key);
    if (!job) return '';
    const pending = this.pendingWork;
    const progress = jobProgress(job);
    if (progress.complete) {
      const presence = artifactsPresence(job.projectPath, pending?.expectedArtifacts);
      if (presence.total > 0 && presence.present < presence.total) {
        return (
          `✅ All ${progress.total} content units written — ${formatCount(progress.words)} words. ` +
          `Still to produce: ${presence.missing.join(', ')}. Continuing automatically.`
        );
      }
      return `✅ All ${progress.total} units written — ${formatCount(progress.words)} words (~${progress.pagesTarget} pages).`;
    }
    return (
      `${formatProgress(job)} — continuing automatically; ` +
      `${progress.total - progress.done} unit(s) left, no reply needed.`
    );
  }

  private buildResult(
    success: boolean,
    goal: string,
    agentResults: OrchestrationResult['agentResults'],
    vault: ContextVault,
    overrides: Partial<OrchestrationResult> = {},
  ): OrchestrationResult {
    const completed = overrides.tasksCompleted ?? agentResults.filter((r) => r.success).length;
    const total = overrides.tasksTotal ?? agentResults.length;
    return {
      success,
      goal,
      summary: overrides.summary || `Execution completed with status: ${success ? 'success' : 'failure'}`,
      tasksCompleted: completed,
      tasksTotal: total,
      agentResults,
      fileChanges: vault.getDiffSummary(),
      // Enterprise G3 — the changed paths for the working-state ledger.
      changedFiles:
        overrides.changedFiles ??
        vault.context.fileChanges.filter((c) => c.status !== 'deleted').map((c) => c.path),
      runOutput: overrides.runOutput,
      error: overrides.error,
      trajectoryId: overrides.trajectoryId,
      reviewId: overrides.reviewId,
      stats: overrides.stats ?? this.stats,
      // Enterprise G11 — unfinished work, so the surface can continue it
      // unattended instead of asking the user to say "continue".
      //
      // Present only while work REMAINS, which is the whole contract: a surface
      // schedules whatever it is handed, so reporting 100%-complete work as
      // pending would make the runner re-run a finished deliverable. `percent`
      // is 100 exactly when the content is complete AND every promised artifact
      // exists (see `pendingWorkFor`), so that is the test.
      ...(buildPendingWork(overrides.pendingWork ?? this.pendingWork)),
    };
  }
}
