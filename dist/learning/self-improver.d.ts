/**
 * SelfImprover — The self-improvement loop that ties together scoring,
 * agent performance tracking, pattern extraction, skill compilation,
 * and model optimization.
 *
 * After each orchestration run (when `useMemory: true`), the SelfImprover:
 * 1. Scores the trajectory (how well did we do?)
 * 2. Records per-agent stats (which agents/models succeed/fail?)
 * 3. Periodically extracts patterns from high-scoring trajectories
 * 4. Periodically compiles high-scoring trajectories into executable skills
 * 5. Provides optimization recommendations (best models per agent)
 *
 * The SelfImprover is called by the Orchestrator post-execution hook.
 * Users can also interact with it via the `buff learn` and `buff skill` CLI commands.
 */
import type { OrchestrationResult } from '../agents/orchestrator.js';
import type { LLMCallFn } from '../agents/agent.js';
export declare class SelfImprover {
    private runCountSinceLastExtraction;
    private runCountSinceLastSkillCompilation;
    private runCountSinceLastFailureExtraction;
    /**
     * Process a completed orchestration run through the self-improvement loop.
     * Scores the result, tracks agent stats, records failures into episodic
     * memory, and conditionally extracts patterns, compiles skills, and
     * distills failure lessons.
     *
     * @param result       The completed orchestration result
     * @param callLLM      LLM function for pattern/lesson extraction
     * @param agentModels  The model map used for this run (for tracking model perf)
     * @param verbose      Whether to log details
     */
    processRun(result: OrchestrationResult, callLLM: LLMCallFn, agentModels?: Record<string, string>, verbose?: boolean): Promise<void>;
    /**
     * Force failure-lesson extraction from the most recent failed runs.
     *
     * @param callLLM  LLM function for lesson extraction
     * @param verbose  Whether to log details
     * @returns        Number of NEW lessons extracted
     */
    extractFailureLessons(callLLM: LLMCallFn, verbose?: boolean): Promise<number>;
    /**
     * Force pattern extraction from the best trajectories in the store.
     */
    extractPatterns(callLLM: LLMCallFn, verbose?: boolean): Promise<number>;
    /**
     * Get optimization recommendations based on collected stats.
     * Returns a recommended model map for the Orchestrator.
     */
    getOptimizedModelMap(): Record<string, string>;
    /**
     * Get a human-readable summary of the self-improvement status.
     */
    getStatus(): string;
    /**
     * Force skill compilation from the best trajectories in the store.
     */
    compileSkills(callLLM: LLMCallFn, verbose?: boolean): Promise<number>;
    /**
     * Reset extraction counter (called when user manually extracts patterns).
     */
    resetExtractionCounter(): void;
    /**
     * Reset skill compilation counter (called when user manually compiles skills).
     */
    resetSkillCompilationCounter(): void;
    /**
     * Reset failure-lesson extraction counter (called when user manually
     * extracts lessons so the auto-interval restarts).
     */
    resetFailureLessonCounter(): void;
    private averageScore;
}
export declare function getSelfImprover(): SelfImprover;
//# sourceMappingURL=self-improver.d.ts.map