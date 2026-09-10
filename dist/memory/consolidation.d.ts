/**
 * MemoryConsolidation — Periodically compresses and prioritizes memories
 * to prevent context window bloat.
 *
 * Integration with existing stores:
 * - TrajectoryStore (trajectory-store.ts) — prunes low-score old trajectories
 * - PatternStore (pattern-extractor.ts) — compresses similar patterns
 * - FailureLessonStore (failure-lessons.ts) — summarizes old lessons
 * - SkillStore (skill-store.ts) — prunes low-quality/expired skills
 *
 * Runs in background every 30 minutes (or on demand).
 * Non-blocking: all consolidation runs asynchronously.
 *
 * Called by:
 * - LocalMemoryProvider.onSessionEnd() — end-of-session consolidation
 * - Background timer — periodic consolidation
 * - CLI: `nuvira memory consolidate` — on-demand
 */
export interface ConsolidationResult {
    /** Number of trajectories pruned */
    trajectoriesPruned: number;
    /** Number of patterns compressed/merged */
    patternsCompressed: number;
    /** Number of failure lessons summarized */
    lessonsSummarized: number;
    /** Number of skills pruned */
    skillsPruned: number;
    /** Timestamp of consolidation */
    timestamp: number;
}
export declare class MemoryConsolidation {
    private intervalId;
    private lastResult;
    /**
     * Start periodic consolidation.
     * Called by the memory manager on initialization.
     */
    start(): void;
    /**
     * Stop periodic consolidation.
     */
    stop(): void;
    /**
     * Run consolidation now (on demand).
     * Called by CLI: `nuvira memory consolidate`
     */
    consolidateNow(): Promise<ConsolidationResult>;
    /**
     * Get last consolidation result (for dashboard/CLI).
     */
    getLastResult(): ConsolidationResult | null;
    /**
     * Main consolidation logic.
     * Prunes, compresses, and prioritizes across all stores.
     */
    private consolidate;
    /**
     * Prune old/low-score trajectories.
     * Keeps the best MAX_TRAJECTORIES by score + recency.
     */
    private pruneTrajectories;
    /**
     * Compress similar patterns.
     * Merges patterns with >80% tool overlap.
     */
    private compressPatterns;
    /**
     * Summarize old failure lessons.
     * Removes lessons older than 60 days.
     */
    private summarizeLessons;
    /**
     * Prune low-quality/expired skills.
     * Uses existing decay-based quality scoring.
     */
    private pruneSkills;
}
export declare function getMemoryConsolidation(): MemoryConsolidation;
export declare function resetMemoryConsolidation(): void;
//# sourceMappingURL=consolidation.d.ts.map