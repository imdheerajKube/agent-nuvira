/**
 * PatternExtractor — Extracts reusable coding patterns from high-scoring
 * execution trajectories and stores them for future prompting.
 *
 * A "pattern" is a concise description of how a particular type of task
 * was successfully completed: which files were involved, what steps were
 * taken, what conventions were followed.
 *
 * These patterns are injected alongside trajectory few-shot examples
 * when the PlannerAgent decomposes a new goal.
 *
 * Patterns are stored in ~/.buff/memory/patterns.json
 */
import type { LLMCallFn } from '../agents/agent.js';
import type { Trajectory } from '../memory/trajectory-store.js';
/** A reusable coding pattern extracted from successful trajectories */
export interface CodingPattern {
    /** Unique identifier */
    id: string;
    /** Short descriptive title (e.g., "Adding CLI commands") */
    title: string;
    /** Which project types this applies to (e.g., "typescript, node") */
    applicableDomains: string[];
    /** The pattern description — steps, conventions, file structure */
    description: string;
    /** File paths commonly involved (pattern-based, not absolute) */
    commonFiles: string[];
    /** Agent types commonly used */
    commonAgentSequence: string[];
    /** How many trajectories this was distilled from */
    sourceCount: number;
    /** Average score of source trajectories */
    avgSourceScore: number;
    /** When this pattern was created */
    createdAt: number;
    /** When this pattern was last used (for decay scoring) */
    lastUsedAt: number;
    /** How many times this pattern has been used */
    usageCount: number;
}
/**
 * Manages storage and retrieval of reusable coding patterns.
 * Patterns are extracted from high-scoring trajectories via LLM.
 */
export declare class PatternStore {
    private patterns;
    constructor();
    /**
     * Get all stored patterns, optionally filtered by minimum quality score.
     */
    getAll(minQualityScore?: number): CodingPattern[];
    /**
     * Get patterns relevant to a specific project domain.
     */
    getByDomain(domainTags: string[]): CodingPattern[];
    /**
     * Format patterns as a prompt string for agent injection.
     */
    formatAsPrompt(domainTags?: string[]): string;
    /**
     * Extract patterns from high-scoring trajectories using the LLM.
     * Newly extracted patterns are merged with existing ones (keeping the best).
     */
    extractFromTrajectories(trajectories: Trajectory[], callLLM: LLMCallFn): Promise<number>;
    /**
     * Mark a pattern as used (for decay tracking).
     */
    markUsed(patternId: string): void;
    /**
     * Compute a decay score for a pattern based on age and usage.
     * Returns a score from 0 (expired) to 1 (fresh).
     */
    computeDecayScore(pattern: CodingPattern): number;
    /**
     * Garbage collect low-quality patterns.
     * Returns the number of patterns removed.
     */
    garbageCollect(verbose?: boolean): number;
    /**
     * Get decay quality statistics for all patterns.
     */
    getQualityReport(): Array<{
        id: string;
        title: string;
        decayScore: number;
        usageCount: number;
        ageDays: number;
    }>;
    /**
     * Clear all patterns.
     */
    clear(): void;
    private load;
    private save;
    private buildExtractionPrompt;
    private parsePatterns;
}
export declare function getPatternStore(): PatternStore;
//# sourceMappingURL=pattern-extractor.d.ts.map