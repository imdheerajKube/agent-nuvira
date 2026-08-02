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
import { ConfigManager } from '../config/manager.js';
import type { TaskStep } from './agent.js';
import { type ModuleRegistry } from './module-registry.js';
import type { EventBus } from '../observability/event-bus.js';
import { type ReportModule } from './report-module.js';
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
    agentResults: Array<{
        agent: string;
        success: boolean;
        summary: string;
    }>;
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
export declare class Orchestrator {
    private configManager;
    /** The module registry used for agent lookups */
    private moduleRegistry;
    /** The event bus for emitting observability events */
    private eventBus;
    /** The report module for generating structured execution reports */
    private reportModule;
    /** Optional routing decision overrides keyed by agent type */
    private routingDecisionOverrides;
    /** Execution telemetry accumulator for the current pipeline */
    private stats;
    constructor(configManager?: ConfigManager, moduleRegistry?: ModuleRegistry, eventBus?: EventBus, reportModule?: ReportModule);
    /**
     * Execute a multi-agent pipeline for the given goal.
     */
    execute(goal: string, options?: OrchestratorOptions): Promise<OrchestrationResult>;
    private createLLMProvider;
    private runAgent;
    /**
     * Create the onRateLimit callback that prompts the user.
     * Returns undefined if we're in non-interactive mode (no TTY or dry-run).
     */
    private createRateLimitHandler;
    private executeSingleTask;
    private getExecutionStrategy;
    /**
     * Create an LLM call function routed by the AutoModelRouter for a task.
     * Uses the task description for complexity analysis and resolves the best
     * provider/model per agent type.
     */
    private resolveAutoRoutingDecision;
    private createAutoRoutedLLM;
    private createAutoRoutedLLMFromDecision;
    private applyRoutingPlanAdjustments;
    /**
     * Run the ContextPruner on the vault context.
     * Only prunes when the context exceeds the configured threshold.
     * Logs details in verbose mode.
     */
    private pruneContext;
    private applyFileChanges;
    private buildResult;
}
//# sourceMappingURL=orchestrator.d.ts.map