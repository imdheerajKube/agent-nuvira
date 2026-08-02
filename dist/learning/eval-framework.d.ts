/**
 * Evaluation Framework — Measures whether Agent-Nuvira is actually improving.
 *
 * Unlike `benchmark.ts` (which only measures prompt-response quality), this
 * framework runs REAL end-to-end coding tasks through the full multi-agent
 * pipeline (plan → write → run → test → repair) inside an isolated temp
 * workspace, then grades the result across eight reliability metrics:
 *
 *   1. task completion rate      — did the pipeline finish without failures?
 *   2. test pass rate            — did hidden tests pass after execution?
 *   3. time-to-fix               — how long until the first green run?
 *   4. accuracy of edits         — did the final files match the reference?
 *   5. token efficiency          — tokens used vs. the task token budget
 *   6. rollback frequency        — how many file changes were reverted?
 *   7. dependency install        — was the agent able to install deps?
 *   8. recovery / new ideas      — did it try alternative approaches instead
 *                                  of just reporting "planner/runner failed"?
 *
 * Usage:
 *   buff eval run                        — Run all eval tasks against default provider
 *   buff eval run --provider groq        — Run against a specific provider
 *   buff eval run --tasks js-fizzbuzz    — Run specific tasks
 *   buff eval list                       — List available eval tasks
 *   buff eval results                    — Show previous eval runs
 *   buff eval score                      — Show the scoring rules
 *
 * Results stored in: ~/.buff/memory/evals.json
 */
import type { InferenceProvider } from '../inference/interface.js';
import { ConfigManager } from '../config/manager.js';
import { type OrchestrationResult } from '../agents/orchestrator.js';
/** Category of an evaluation task */
export type EvalCategory = 'bug-fix' | 'feature' | 'refactor' | 'test-writing' | 'dependency-setup' | 'algorithm';
/** A single end-to-end evaluation task */
export interface EvalTask {
    /** Unique task identifier */
    id: string;
    /** Human-readable title */
    title: string;
    /** Category */
    category: EvalCategory;
    /** Difficulty */
    difficulty: 'easy' | 'medium' | 'hard';
    /** The goal handed to the agent pipeline */
    goal: string;
    /** Files scaffolded into the temp workspace before the agent runs */
    setupFiles: Array<{
        path: string;
        content: string;
    }>;
    /** Hidden tests run AFTER the agent finishes (in the workspace dir) */
    hiddenTests: Array<{
        /** Test file written into the workspace */
        file: string;
        /** Command to run (cwd = workspace). Exit code 0 = pass */
        command: string;
        /** Expected exit code (default 0) */
        expectExitCode?: number;
    }>;
    /** Reference solution patterns for edit-accuracy scoring */
    referencePatterns?: Array<{
        /** File in the workspace to check */
        file: string;
        /** All of these substrings must be present */
        mustContain: string[];
        /** None of these substrings may be present */
        mustNotContain?: string[];
    }>;
    /** Token budget for token-efficiency scoring */
    tokenBudget: number;
    /** Time estimate */
    timeEstimate: 'quick' | 'medium' | 'slow';
    /** Per-task wall-clock timeout in ms (default 10 min) */
    timeoutMs?: number;
}
/** The eight metrics measured for a single task run */
export interface EvalMetrics {
    /** Task completion rate — pipeline finished without failed tasks */
    completed: boolean;
    /** Hidden tests passed */
    testPassed: boolean;
    /** Fraction of hidden tests that passed (0-1) */
    testPassRate: number;
    /** Time from run start to first green test (ms). Infinity if never green */
    timeToFixMs: number;
    /** Edit accuracy vs. reference (0-1) */
    editAccuracy: number;
    /** Token efficiency (0-1) — budget / used, capped at 1 */
    tokenEfficiency: number;
    /** Number of file changes reverted to their original content */
    rollbackCount: number;
    /** Whether the runner attempted a dependency install */
    dependencyInstallAttempted: boolean;
    /** Whether the dependency install succeeded */
    dependencyInstallSucceeded: boolean;
    /** Total repair attempts triggered by the ErrorRepairEngine */
    recoveryAttempts: number;
    /** Number of 'alternative-approach' strategies tried (new ideas) */
    alternativeApproaches: number;
    /** Task failed on first attempt but succeeded after repair */
    recovered: boolean;
    /** Total agent executions for this task */
    attempts: number;
    /** Estimated cost in USD */
    costUsd: number;
    /** Total latency in ms */
    latencyMs: number;
    /** Error message if the pipeline itself crashed */
    error?: string;
}
/** Result of running one eval task */
export interface EvalResult {
    taskId: string;
    provider: string;
    model: string;
    metrics: EvalMetrics;
    /** Composite score (0-1) from the weighted scoring rules */
    compositeScore: number;
    /** Agent's final summary */
    summary: string;
    timestamp: number;
}
/** A complete eval run across multiple tasks */
export interface EvalRun {
    id: string;
    provider: string;
    model: string;
    startedAt: number;
    endedAt: number;
    results: EvalResult[];
    summary: EvalSummary;
}
/** Summary statistics for an eval run */
export interface EvalSummary {
    totalTasks: number;
    tasksPassed: number;
    completionRate: number;
    testPassRate: number;
    avgTimeToFixMs: number;
    avgEditAccuracy: number;
    avgTokenEfficiency: number;
    totalRollbacks: number;
    dependencyInstallRate: number;
    recoveryRate: number;
    avgCompositeScore: number;
    totalCostUsd: number;
}
/**
 * Weights for the composite score. Higher = more important.
 * Weighted toward correctness (test pass) and completion, with meaningful
 * credit for speed (time-to-fix), efficiency (tokens), and — crucially —
 * recovery behavior (trying new approaches instead of giving up).
 */
export declare const EVAL_SCORE_WEIGHTS: {
    /** Hidden tests pass (correctness) — 30% */
    readonly testPass: 0.3;
    /** Task completion rate — 20% */
    readonly completion: 0.2;
    /** Accuracy of edits vs. reference — 15% */
    readonly editAccuracy: 0.15;
    /** Token efficiency — 10% */
    readonly tokenEfficiency: 0.1;
    /** Speed: time-to-fix — 10% */
    readonly timeToFix: 0.1;
    /** Recovery: tried new approaches & recovered — 10% */
    readonly recovery: 0.1;
    /** Reliability: low rollback frequency — 5% */
    readonly rollbackPenalty: 0.05;
};
/** Reference "ideal" time-to-fix in ms used to normalize the speed score */
export declare const IDEAL_TIME_TO_FIX_MS = 120000;
/**
 * Score a single task's metrics into a composite 0-1 score.
 */
export declare function scoreEvalMetrics(metrics: EvalMetrics): number;
/** Create a temp workspace, scaffold setup files + hidden tests. Returns dir. */
export declare function scaffoldWorkspace(task: EvalTask): string;
/** Run a hidden test command in the workspace. Returns exit code + duration. */
export declare function runHiddenTest(workspace: string, command: string, timeoutMs?: number): {
    exitCode: number;
    durationMs: number;
    output: string;
};
/** Compute edit accuracy (0-1) by checking reference patterns in workspace files. */
export declare function computeEditAccuracy(task: EvalTask, workspace: string): number;
/** Options for runEvalSuite */
export interface RunEvalOptions {
    /** Only run tasks with these IDs */
    taskIds?: string[];
    /** Only run tasks matching this time estimate */
    timeEstimate?: 'quick' | 'medium' | 'slow';
    /** Maximum cost in USD before stopping */
    budget?: number;
    /** Progress callback */
    onProgress?: (current: number, total: number, task: EvalTask) => void;
    /** Config manager (for provider config) */
    configManager?: ConfigManager;
    /** Keep temp workspaces after the run (debugging) */
    keepWorkspaces?: boolean;
    /** Injectable goal executor — used by tests to stub the orchestrator */
    executeGoal?: (goal: string, workspace: string) => Promise<OrchestrationResult>;
}
/**
 * Run a single eval task through the full agent pipeline.
 */
export declare function runEvalTask(task: EvalTask, _provider: InferenceProvider, providerName: string, model: string, options?: RunEvalOptions): Promise<EvalResult>;
/**
 * Run the full evaluation suite against a provider/model.
 */
export declare function runEvalSuite(provider: InferenceProvider, providerName: string, model: string, options?: RunEvalOptions): Promise<EvalRun>;
/** Compute the aggregate summary from a list of eval results. */
export declare function computeEvalSummary(results: EvalResult[]): EvalSummary;
/** Format an eval run as a human-readable text report. */
export declare function formatEvalReport(run: EvalRun): string;
/** Format an eval run as JSON. */
export declare function formatEvalJSON(run: EvalRun): string;
/** Format an eval run as Markdown. */
export declare function formatEvalMarkdown(run: EvalRun): string;
/** Describe the scoring rules for the `buff eval score` command. */
export declare function formatEvalScoreRules(): string;
/** Get all available eval tasks. */
export declare function getEvalTasks(): EvalTask[];
/** Get a specific eval task by ID. */
export declare function getEvalTask(id: string): EvalTask | undefined;
/** Get all past eval runs (most recent first). */
export declare function getEvalRuns(): EvalRun[];
/** Get the most recent eval run for a provider/model. */
export declare function getLatestEvalRun(provider: string, model: string): EvalRun | null;
/** Clear all eval data. */
export declare function clearEvals(): void;
//# sourceMappingURL=eval-framework.d.ts.map