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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import inquirer from 'inquirer';

import { ProviderFactory } from '../inference/factory.js';
import { ConfigManager } from '../config/manager.js';
import type { ProviderType, InferenceOptions } from '../config/types.js';
import { showModelPicker } from '../cli/model-picker.js';
import { logger } from '../utils/logger.js';

import { ContextVault } from './context-vault.js';
import { saveCheckpoint, loadCheckpoint, checkpointIdFor } from './checkpoint-store.js';
import { Agent } from './agent.js';
import type { LLMCallFn, AgentResult, TaskStep, OnRateLimit } from './agent.js';
import { buildProjectFileTree, truncateTree, SOURCE_EXTENSIONS, IGNORE_DIRS } from './utils/file-tree.js';
import type { RunResult } from './agents/runner.js';
import { cleanupSandbox } from './agents/tester.js';
import type { McpToolEntry } from './agents/mcp-agent.js';
import { getMCPManager, resetMCPManager } from '../mcp/manager.js';
import { formatMcpToolsForPrompt } from './agents/mcp-agent.js';
import { getModuleRegistry, type ModuleRegistry } from './module-registry.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import { DefaultReportModule, type ReportModule, type ReportFormat } from './report-module.js';
import { ContextPruner } from '../learning/context-pruner.js';
import { ErrorRepairEngine } from '../learning/error-repair.js';
import type { RepairMode } from '../learning/error-repair.js';
import { estimateTokens } from '../learning/cost-tracker.js';
import { scanForInjections, formatScanReport } from '../security/scanner.js';
import { getAutoRouter, isAutoModel, isAutoProvider, type AutoRouteResult } from '../learning/auto-router.js';
import { analyzeComplexity, type ComplexityLevel } from '../learning/hybrid-router.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { recordRegistrySuccess } from '../learning/provider-fallback.js';
import { recordActionFailure, type FailureSessionState } from '../learning/failure-bookkeeping.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { refreshModelRegistry } from '../inference/model-probe.js';
import { recordRoutingDecision } from '../learning/routing-history.js';
import { createReviewFromResult } from '../team/review.js';
import { indexFiles, retrieve, recordRetrievalStats, retrievalOptionsFromConfig, estimateTokens as retrievalEstimateTokens } from '../learning/retrieval.js';

// ─── DAG Integration (optional — dashboard may not be built) ─────────────────

/**
 * Push a DAG update to the live dashboard, if the server is running.
 * Uses dynamic import so the orchestrator doesn't crash if the dashboard
 * module hasn't been built or isn't available.
 */
let dagModule: {
  pushDAGUpdate: (update: { pipelineId?: string; pipelineDescription?: string; nodes: Array<{ id: string; agentType: string; status: string; description: string }>; edges: Array<{ from: string; to: string }> }) => void;
  updateDAGNode: (nodeId: string, update: { status: string; summary?: string }) => void;
  resetDAG: () => void;
} | undefined | null = undefined;

async function ensureDAGModule(): Promise<void> {
  if (dagModule !== undefined) return; // already attempted (null = failed, object = loaded)
  try {
    dagModule = await import('../web-dashboard/server.js') as any;
  } catch {
    dagModule = null; // dashboard module not available — mark as failed
  }
}

async function tryPushDAG(update: {
  pipelineId?: string;
  pipelineDescription?: string;
  nodes: Array<{ id: string; agentType: string; status: string; description: string }>;
  edges: Array<{ from: string; to: string }>;
}): Promise<void> {
  await ensureDAGModule();
  if (dagModule) dagModule.pushDAGUpdate(update as any);
}

async function tryUpdateDAGNode(nodeId: string, update: { status: string; summary?: string }): Promise<void> {
  await ensureDAGModule();
  if (dagModule) dagModule.updateDAGNode(nodeId, update as any);
}

async function tryResetDAG(): Promise<void> {
  await ensureDAGModule();
  if (dagModule) dagModule.resetDAG();
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
   * in ~/.buff/memory/checkpoints/ and let a crash / quota kill / token expiry
   * mid-pipeline continue from the first pending step instead of restarting.
   * Default: false. Implied true when resumeCheckpointId is set.
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
function createAgent(agentType: string, registry: ModuleRegistry): Agent | null {
  try {
    return registry.getModule(agentType);
  } catch {
    return null;
  }
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
   * Latched one-shot cold-start registry probe: fired once per Orchestrator
   * instance when auto routing is active on an empty registry (see
   * maybeFireColdStartProbe). A long dev-mode session only pays for it once.
   */
  private coldStartProbeFired = false;
  /**
   * Per-pipeline failure session: the state recordActionFailure mutates when
   * a per-task LLM call fails. The registry/quota/breaker write-throughs it
   * composes are read by resolveAutoRoutingDecision BEFORE every task, so a
   * mid-pipeline 429 on the planner makes the writer skip the exhausted
   * provider predictively (parked in the quota ledger) without re-failing.
   * Session-exclusion CONSULTATION at the orchestrator resolve level is a
   * tracked Nuvira-Router follow-up (chat filters at its walk level; the
   * orchestrator has no ranked walk yet).
   */
  private readonly failureSession: FailureSessionState = {
    sessionFailedProviders: new Map(),
    sessionTransientFailedProviders: new Set(),
  };
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
    try {
      return await this.executePipeline(goal, options);
    } finally {
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
    // LOAD only when the user explicitly asked to RESUME (bare --resume or an
    // explicit id). Plain `--checkpoint` must NEVER silently resume a stale
    // checkpoint from a previous run of the same goal — that would re-enter a
    // completed plan and skip every task.
    const resumeWanted = options.resumeRequested === true || !!options.resumeCheckpointId;
    let resumed = false;
    let vault: ContextVault;
    if (resumeWanted) {
      const saved = loadCheckpoint(resumeId);
      if (saved) {
        vault = ContextVault.fromSnapshot(saved.context);
        resumed = true;
        const done = saved.context.taskPlan.filter((s) => s.status === 'completed').length;
        if (options.verbose) {
          logger.info(`   ♻️ Resumed from checkpoint '${resumeId}' — ${done}/${saved.context.taskPlan.length} steps already complete`);
        }
      } else {
        // Resume explicitly requested but no checkpoint found — warn (a
        // reworded goal silently misses the auto id) and start fresh with
        // checkpointing on, so a later crash can still be resumed.
        logger.warn(`   ⚠️ No checkpoint found for '${resumeId}' — starting a fresh pipeline (run with --checkpoint to save one)`);
        vault = new ContextVault(goal, process.cwd());
      }
    } else {
      vault = new ContextVault(goal, process.cwd());
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
    // Auto routing: when the user selected auto (`-m auto` / `buff model switch auto`
    // / `--auto-route`), the planner/memory LLM must ALSO be routed through the
    // AutoModelRouter so no call ever sends a literal 'auto' model to a real API.
    // Matches executeSingleTask's rule: an explicit --model always wins.
    const autoRoutingActive = (options.autoRouteModels === true && !options.model) ||
      isAutoModel(options.model) || isAutoProvider(options.provider);
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
    const plannerRoutingDecision = autoRoutingActive && !resumed
      ? this.resolveAutoRoutingDecision({ agentType: 'planner', description: goal }, options)
      : undefined;
    if (plannerRoutingDecision) {
      this.routingDecisionOverrides.set('planner', plannerRoutingDecision);
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
        logger.info('   No MCP server configs found (see ~/.buff/mcp/)');
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
      try {
        const { retrieveMemoryContext } = await import('../memory/memory-integration.js');
        const memoryResult = await retrieveMemoryContext(goal, defaultCallLLM, 3);
        memoryContext = memoryResult.fewShotContext;
        // Also inject coding patterns if available
        patternContext = memoryResult.patternContext || '';
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
      // Inject memory context and patterns into vault for agents
      if (memoryContext) {
        vault.setMeta('memoryContext', memoryContext);
      }
      if (patternContext) {
        vault.setMeta('patternContext', patternContext);
        memoryContext += `\n${patternContext}`;
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
      if (options.verbose) logger.highlight('\n📋 Planning...');

      // Planner with auto-repair — if planning fails, try alternative approaches
      // instead of immediately giving up with "Planning failed".
      let planResult = await this.runAgent(this.moduleRegistry.getModule('planner'), vault, defaultCallLLM, options);
      if (!planResult.success) {
        const plannerRepair = new ErrorRepairEngine({
          maxRepairs: 3,
          repairMode: 'auto',
          verbose: options.verbose,
        });
        if (options.verbose) {
          logger.info('      🔧 Planner failed — attempting auto-repair with alternative approaches');
        }
        const planner = this.moduleRegistry.getModule('planner');
        planResult = await plannerRepair.repair(
          'planner',
          vault.context,
          defaultCallLLM,
          planResult.error || planResult.summary || 'Planning failed',
          async (ctx, llm) => planner.execute(ctx, llm),
        );
        this.stats.repairAttempts += plannerRepair.budget.getAttempts('planner');
        this.stats.alternativeApproaches += plannerRepair.alternativeApproaches;
        this.stats.taskFailures += 1;
        if (planResult.success) this.stats.recoveredFailures += 1;
      }
      agentResults.push({ agent: 'Planner', success: planResult.success, summary: planResult.summary });

      if (!planResult.success) {
        return this.buildResult(false, goal, agentResults, vault, {
          error: planResult.error || 'Planning failed',
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
      // writers, reviewers — run in PARALLEL within a batch (Freebuff-style),
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
        await Promise.all(parallelGroup.map(({ task, strategy }) =>
          this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM, strategy)
        ));
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
    if (checkpointEnabled) {
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
        logger.info(`   Run \`buff team review show ${review.id}\` to view`);
        logger.info(`   Run \`buff team review approve ${review.id}\` then \`buff team review merge ${review.id}\` to apply`);
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
        };

        const { storeExecutionTrajectory } = await import('../memory/memory-integration.js');
        trajectoryId = await storeExecutionTrajectory(
          orchestrationSummary,
          defaultCallLLM,
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
            defaultCallLLM,
            options.agentModels as Record<string, string> | undefined,
            options.verbose,
          );

          if (options.verbose && trajectoryId) {
            logger.info('   Self-improvement stats saved. Run `buff learn optimize` to see recommendations.');
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

    return this.buildResult(!hasFailures, goal, agentResults, vault, {
      summary: reportText,
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
    // Guard: 'auto' is not a real provider — resolve to the configured default
    const rawProvider = options.provider || this.configManager.getAll().defaultProvider;
    const providerType = (isAutoProvider(rawProvider) ? undefined : rawProvider) ||
      this.configManager.getAll().defaultProvider as ProviderType;

    const { config } = this.configManager.getProviderConfig(providerType);
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
      // Resolve it to the provider's configured model (or 'default') so
      // planner/memory/rate-limit-switch calls never crash with "no auto model".
      const requestedModel = options.model || inferenceOptions?.model || config.model;
      const mergedOptions = {
        ...inferenceOptions,
        model: isAutoModel(requestedModel) ? (config.model || 'default') : requestedModel,
        temperature: inferenceOptions?.temperature ?? config.temperature ?? 0.7,
        maxTokens: inferenceOptions?.maxTokens ?? config.maxTokens ?? 4096,
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

  private async runAgent(
    agent: Agent,
    vault: ContextVault,
    callLLM: LLMCallFn,
    _options: OrchestratorOptions,
  ): Promise<AgentResult> {
    try {
      return await agent.execute(vault.context, callLLM);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: `${agent.name} errored`, error: msg };
    }
  }

  /**
   * Create the onRateLimit callback that prompts the user.
   * Returns undefined if we're in non-interactive mode (no TTY or dry-run).
   */
  private createRateLimitHandler(
    options: OrchestratorOptions,
    currentModel: string | undefined,
  ): OnRateLimit | undefined {
    // Don't prompt in non-interactive or dry-run mode — just use auto-retry
    if (options.dryRun || !process.stdout.isTTY) {
      return undefined;
    }

    return async (info) => {
      // ── Stop the CLI spinner before showing interactive prompts ──────
      const spl = options.spinner;
      if (spl) spl.stop();

      const waitSeconds = (info.retryAfterMs / 1000).toFixed(1);
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
          newCallLLM = this.createLLMProvider(newOptions);
        }

        restartSpinner();
        return { action: 'switch-model', callLLM: newCallLLM };
      }

      // Fallback: retry
      restartSpinner();
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
      // When the user selected Auto (`-m auto` / `buff model switch auto`) or
      // passed `--auto-route` without an explicit --model, route each task
      // independently via the AutoModelRouter so e.g. the planner gets a fast
      // cheap model while complex tasks get a stronger one. An explicit
      // `--model` always wins over auto routing.
      const autoRouting = (options.autoRouteModels === true && !options.model) ||
        isAutoModel(options.model) || isAutoProvider(options.provider);
      const effectiveAgentType = strategy.effectiveAgentType || task.agentType;
      const agentModel = options.model || options.agentModels?.[effectiveAgentType] || options.agentModels?.[task.agentType];
      const agentCallLLM = autoRouting
        ? this.createAutoRoutedLLM(
            { agentType: effectiveAgentType, description: task.description, complexity: task.complexity },
            options,
          )
        : agentModel
          ? this.createLLMProvider({ ...options, model: agentModel })
          : defaultCallLLM;

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

      const agent = createAgent(effectiveAgentType, this.moduleRegistry);
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

      // Wire up the rate-limit handler so agents can prompt the user
      vault.context.onRateLimit = this.createRateLimitHandler(options, agentModel || options.model);

      // ── Execute agent with optional auto-repair loop ────────────────
      let result: AgentResult;
      let firstFailed = false;

      if (useRepair) {
        // Try the agent — if it fails, attempt auto-repair
        const firstResult = await agent.execute(vault.context, agentCallLLM);

        if (firstResult.success) {
          result = firstResult;
        } else {
          firstFailed = true;
          if (options.verbose) {
            const repairableTypes = ['llm-error', 'provider-error', 'context-limit', 'process-error', 'unknown'];
            logger.info(`      🔧 Agent failed — attempting auto-repair (mode: ${repairMode}, max: ${maxRepairs})`);
          }

          const errorMessage = firstResult.error || firstResult.summary || 'Unknown error';
          const repairEngine = new ErrorRepairEngine({
            maxRepairs,
            repairMode,
            verbose: options.verbose,
            fallbackModels: options.repairFallbackModels,
          });

          result = await repairEngine.repair(
            task.id,
            vault.context,
            agentCallLLM,
            errorMessage,
            async (ctx, llm) => {
              return agent.execute(ctx, llm);
            },
          );

          if (options.verbose) {
            logger.info(`      🔧 ${result.success ? '✅ Repair succeeded' : '❌ Repair failed'} after ${repairEngine.budget.getAttempts(task.id)} attempt(s)`);
          }

          // Collect repair telemetry
          stats.repairAttempts += repairEngine.budget.getAttempts(task.id);
          stats.alternativeApproaches += repairEngine.alternativeApproaches;
        }
      } else {
        result = await agent.execute(vault.context, agentCallLLM);
      }

      // Track task failure/recovery telemetry
      if (!result.success) {
        stats.taskFailures += 1;
      } else if (firstFailed) {
        stats.recoveredFailures += 1;
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
      if (autoRouting && this.configManager.getAll().routing?.bandit === true) {
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

      // After debugger step: write debugger's fixes to disk immediately
      // The DebuggerAgent's syncChangesToContext() updates context.fileChanges
      // with LLM-generated fixes. If a runner step follows the debugger, those
      // fixes must be on disk before the runner executes.
      if (effectiveAgentType === 'debugger' && result.success && !options.dryRun) {
        const applied = this.applyFileChanges(vault);
        if (applied > 0 && options.verbose) {
          logger.info(`      💾 Applied ${applied} debug fix(es) to disk`);
        }
      }

      // After writer step: write files to disk immediately and sync into artifacts
      // IMPORTANT: files MUST be on disk before the RunnerAgent tries to execute them
      if (effectiveAgentType === 'writer' && result.success) {
        if (!options.dryRun) {
          const applied = this.applyFileChanges(vault);
          if (applied > 0 && options.verbose) {
            logger.info(`      💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`);
          }
        }

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
              // retrieval-stats.json so `buff retrieval stats` and the dashboard
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
    const writerLike = ['writer', 'tester', 'runner'].includes(task.agentType);

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
        if (writerLike || task.agentType === 'runner') effectiveAgentType = 'debugger';
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
  private resolveAutoRoutingDecision(
    task: { agentType: string; description: string; complexity?: string },
    options: OrchestratorOptions,
  ): AutoRouteResult {
    const routing = this.configManager.getAll().routing || {};
    // Quota-ledger parked providers sink below healthy ones — a provider whose
    // free-tier window is exhausted (or was parked by a mid-session failure) is
    // skipped predictively instead of failing reactively. Read through the
    // Model Availability Registry's UNIFIED store — same primary-store pick
    // path as chat, so exhausted providers carry their remaining time-to-wait
    // in the same sub-ms read (the ledger stays the writer, the registry the
    // read model).
    let quotaStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
    try {
      quotaStatus = getModelRegistry().getRouterQuotaStatus(this.configManager);
    } catch {
      // Best-effort — routing must never crash on ledger bookkeeping.
    }
    const decision = getAutoRouter().resolve(
      task.agentType,
      task.description,
      {
        verbose: options.verbose,
        useRuntimeStats: true,
        useBandit: routing.bandit === true,
        maxCostUsd: routing.maxCostUsd,
        minSpeed: routing.minSpeed,
        minReasoning: routing.minReasoning,
        escalationMinSamples: routing.escalationMinSamples,
        complexityHint: task.complexity as ComplexityLevel | undefined,
        quotaStatus,
        allowPaid: routing.allowPaid,
      },
      this.configManager,
    );
    // Record for the dashboard usage stats + audit trail
    recordRoutingDecision({
      source: 'orchestrator',
      agentType: task.agentType,
      task: task.description,
      complexity: decision.complexity,
      provider: decision.provider,
      model: decision.model,
      score: decision.score,
    });
    return decision;
  }

  private createAutoRoutedLLM(
    task: { agentType: string; description: string; complexity?: string },
    options: OrchestratorOptions,
  ): LLMCallFn {
    const decisionOverride = this.routingDecisionOverrides.get(task.agentType);
    const decision = decisionOverride ?? this.resolveAutoRoutingDecision(task, options);
    return this.createAutoRoutedLLMFromDecision(task, options, decision);
  }


  private createAutoRoutedLLMFromDecision(
    task: { agentType: string; description: string; complexity?: string },
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
    return async (prompt: string, inferenceOptions?: InferenceOptions) => {
      if (!validated) {
        validated = true;
        try {
          const { config } = this.configManager.getProviderConfig(decision.provider as ProviderType);
          const adapter = ProviderFactory.createProvider(decision.provider as ProviderType, config);
          workingModel = await resolveWorkingModel(adapter, decision.provider, decision.model);
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
              score: decision.score,
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
      return await base(prompt, { ...inferenceOptions, model: workingModel ?? decision.model });
    };
  }

  /**
   * One-shot background model-registry refresh for a COLD registry.
   *
   * Fired when auto routing is active and the registry has no verified
   * providers: probes listModels + spot-checks the configured providers so the
   * pipeline's later tasks route on REAL health data (the dedicated model-
   * health agent's job, started on demand instead of waiting for `buff models
   * watch`). Latched per instance — a long dev-mode session only pays once.
   * Fire-and-forget: never awaited, never blocks, never throws.
   */
  private maybeFireColdStartProbe(): void {
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
    const maxTokens = options.contextLimit || 128_000;
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
      runOutput: overrides.runOutput,
      error: overrides.error,
      trajectoryId: overrides.trajectoryId,
      reviewId: overrides.reviewId,
      stats: overrides.stats ?? this.stats,
    };
  }
}
