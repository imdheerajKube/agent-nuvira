/**
 * Benchmark — Standardized model benchmarking system for coding tasks.
 *
 * Runs a suite of coding tasks against configured providers/models and
 * measures: success rate, output quality, latency, and cost.
 *
 * Usage:
 *   buff benchmark                          — Run all tasks against default provider
 *   buff benchmark --provider groq          — Run against a specific provider
 *   buff benchmark --model llama-3.3-70b    — Run against a specific model
 *   buff benchmark --tasks quick            — Run only quick tasks
 *   buff benchmark --budget 0.50            — Stop if costs exceed $0.50
 *   buff benchmark list                     — List available benchmark tasks
 *   buff benchmark results                  — Show previous benchmark results
 *
 * Results stored in: ~/.buff/memory/benchmarks.json
 */
import type { InferenceProvider } from '../inference/interface.js';
/** Difficulty level of a benchmark task */
export type TaskDifficulty = 'easy' | 'medium' | 'hard' | 'expert';
/** Category tags for benchmark tasks */
export type TaskTag = 'code-generation' | 'refactoring' | 'debugging' | 'explanation' | 'testing' | 'documentation' | 'security' | 'optimization' | 'translation' | 'comprehension';
/** A single benchmark task */
export interface BenchmarkTask {
    /** Unique task identifier */
    id: string;
    /** Human-readable title */
    title: string;
    /** Category tag */
    tag: TaskTag;
    /** Difficulty level */
    difficulty: TaskDifficulty;
    /** The prompt to send to the model */
    prompt: string;
    /** Expected output patterns (optional — for automated scoring) */
    expectedPatterns?: string[];
    /** Expected output anti-patterns (things that shouldn't appear) */
    antiPatterns?: string[];
    /** Maximum expected tokens for a good answer */
    maxExpectedTokens: number;
    /** Time estimate: 'quick' (< 30s), 'medium' (< 2min), 'slow' (> 2min) */
    timeEstimate: 'quick' | 'medium' | 'slow';
    /** Expected output language (for syntax checking) */
    outputLanguage?: 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'bash' | 'text';
}
/** The result of a single benchmark task run */
export interface BenchmarkResult {
    /** Task ID */
    taskId: string;
    /** Provider name */
    provider: string;
    /** Model name */
    model: string;
    /** The model's output */
    output: string;
    /** Whether the output was successfully generated */
    success: boolean;
    /** Latency in milliseconds */
    latencyMs: number;
    /** Estimated input tokens */
    inputTokens: number;
    /** Estimated output tokens */
    outputTokens: number;
    /** Estimated cost in USD */
    costUsd: number;
    /** Quality score (0-1, heuristic-based) */
    qualityScore: number;
    /** Error message if failed */
    error?: string;
    /** Timestamp */
    timestamp: number;
}
/** A complete benchmark run across multiple tasks */
export interface BenchmarkRun {
    /** Unique run ID */
    id: string;
    /** Provider used */
    provider: string;
    /** Model used */
    model: string;
    /** When the run started */
    startedAt: number;
    /** When the run ended */
    endedAt: number;
    /** Task results */
    results: BenchmarkResult[];
    /** Summary statistics */
    summary: BenchmarkSummary;
}
/** Summary statistics for a benchmark run */
export interface BenchmarkSummary {
    /** Total tasks */
    totalTasks: number;
    /** Tasks that succeeded */
    tasksPassed: number;
    /** Tasks that failed */
    tasksFailed: number;
    /** Average quality score (0-1) */
    avgQualityScore: number;
    /** Median latency in ms */
    medianLatencyMs: number;
    /** Total cost in USD */
    totalCostUsd: number;
    /** Total tokens consumed */
    totalTokens: number;
}
/**
 * Generate a quality score for a model's output based on heuristics.
 * Scores range from 0 (poor) to 1 (excellent).
 */
export declare function scoreQuality(output: string, task: BenchmarkTask): number;
/**
 * Run the benchmark suite against a provider/model.
 */
export declare function runBenchmark(provider: InferenceProvider, providerName: string, model: string, options?: {
    /** Only run tasks with these IDs */
    taskIds?: string[];
    /** Only run tasks matching this time estimate */
    timeEstimate?: 'quick' | 'medium' | 'slow';
    /** Maximum cost in USD before stopping */
    budget?: number;
    /** Callback for progress updates */
    onProgress?: (current: number, total: number, task: BenchmarkTask) => void;
}): Promise<BenchmarkRun>;
/**
 * Format a benchmark run as a human-readable report.
 */
export declare function formatBenchmarkReport(run: BenchmarkRun): string;
/**
 * Format a benchmark run as JSON (for machine consumption).
 */
export declare function formatBenchmarkJSON(run: BenchmarkRun): string;
/**
 * Format a benchmark run as Markdown (for documentation).
 */
export declare function formatBenchmarkMarkdown(run: BenchmarkRun): string;
/**
 * Get all available benchmark tasks.
 */
export declare function getBenchmarkTasks(): BenchmarkTask[];
/**
 * Get a specific benchmark task by ID.
 */
export declare function getBenchmarkTask(id: string): BenchmarkTask | undefined;
/**
 * Get all past benchmark runs.
 */
export declare function getBenchmarkRuns(): BenchmarkRun[];
/**
 * Get the most recent benchmark run for a specific provider/model.
 */
export declare function getLatestBenchmarkRun(provider: string, model: string): BenchmarkRun | null;
/**
 * Compare two benchmark runs side by side.
 */
export declare function compareBenchmarks(runA: BenchmarkRun, runB: BenchmarkRun): string;
/**
 * Clear all benchmark data.
 */
export declare function clearBenchmarks(): void;
//# sourceMappingURL=benchmark.d.ts.map