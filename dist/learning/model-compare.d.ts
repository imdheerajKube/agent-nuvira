/**
 * ModelCompare — A/B comparison engine that connects benchmark results
 * to model routing recommendations.
 *
 * Provides:
 * - Side-by-side benchmark comparison for two models
 * - Automatic best-model recommendation per agent type
 * - Integration with the ModelRouter and AgentStats
 * - Human-readable comparison reports
 */
import type { BenchmarkRun, BenchmarkSummary } from './benchmark.js';
/** A comparison result between two models */
export interface ModelComparisonResult {
    /** Model A details */
    modelA: {
        provider: string;
        model: string;
        summary: BenchmarkSummary;
    };
    /** Model B details */
    modelB: {
        provider: string;
        model: string;
        summary: BenchmarkSummary;
    };
    /** Per-metric winners */
    winners: {
        passRate: 'A' | 'B' | 'tie';
        quality: 'A' | 'B' | 'tie';
        latency: 'A' | 'B' | 'tie';
        cost: 'A' | 'B' | 'tie';
    };
    /** Overall winner */
    overallWinner: 'A' | 'B' | 'tie';
    /** Recommendation string */
    recommendation: string;
}
/** Recommendation for how to route agent types based on benchmark data */
export interface BenchmarkDrivenRecommendation {
    /** Agent type */
    agentType: string;
    /** Currently recommended model */
    currentModel: string;
    /** Better model found via benchmark */
    betterModel: string | null;
    /** Quality improvement expected (null if no improvement) */
    qualityImprovement: number | null;
    /** Confidence level */
    confidence: 'high' | 'medium' | 'low';
}
/**
 * Compare two benchmark runs and determine the winner.
 */
export declare function compareModelRuns(runA: BenchmarkRun, runB: BenchmarkRun): ModelComparisonResult;
/**
 * Compare two benchmark runs and auto-update the ModelRouter / AgentStats
 * recommendations based on the results.
 */
export declare function compareAndRecommend(runA: BenchmarkRun, runB: BenchmarkRun, verbose?: boolean): Promise<{
    comparison: ModelComparisonResult;
    updatedRoutes: string[];
}>;
/**
 * Find the best model for a specific agent type by comparing all
 * available benchmark runs.
 */
export declare function findBestModelForAgent(agentType: string): BenchmarkDrivenRecommendation;
/**
 * Format a model comparison as a human-readable report.
 */
export declare function formatComparisonResult(result: ModelComparisonResult): string;
/**
 * Format benchmark-driven routing recommendations.
 */
export declare function formatBenchmarkRecommendations(recommendations: BenchmarkDrivenRecommendation[]): string;
//# sourceMappingURL=model-compare.d.ts.map