/**
 * TrajectoryStore — Stores and retrieves successful agent execution trajectories.
 *
 * A trajectory captures a full agent session: the goal, the plan,
 * what files were touched, what changes were made, and the outcome.
 * This data is stored in a JSON file and indexed via the VectorStore
 * for semantic similarity search.
 *
 * When a new goal arrives, the Orchestrator queries past trajectories
 * and injects similar ones as few-shot examples into agent prompts.
 *
 * File location: ~/.buff/memory/trajectories.json
 */
import type { TaskStep } from '../agents/agent.js';
import type { OrchestrationResult } from '../agents/orchestrator.js';
import type { LLMCallFn } from '../agents/agent.js';
/** A lightweight summary of a task step, suitable for few-shot prompting */
export interface TrajectoryStep {
    id: string;
    description: string;
    agentType: string;
}
/** A stored agent execution trajectory */
export interface Trajectory {
    /** Unique identifier */
    id: string;
    /** The original user goal */
    goal: string;
    /** A concise description of the project's tech stack / domain */
    projectFingerprint: string;
    /** The execution plan (lightweight — descriptions only, no full content) */
    taskPlan: TrajectoryStep[];
    /** File paths that were read as context */
    contextFiles: string[];
    /** File changes (just paths and status, not full diffs) */
    fileChanges: Array<{
        path: string;
        status: string;
    }>;
    /** How many agent steps completed successfully */
    tasksCompleted: number;
    tasksTotal: number;
    /** Quality score (0-1) — higher = more reliable trajectory */
    score: number;
    /** When this trajectory was created */
    timestamp: number;
}
/**
 * Manages the storage and retrieval of agent execution trajectories.
 */
export declare class TrajectoryStore {
    /**
     * Save a successful orchestration result as a trajectory.
     * Also indexes it in the VectorStore for semantic search.
     *
     * @param result       The orchestration result to save
     * @param callLLM      LLM function for generating the embedding vector
     * @param taskPlan     The original task plan steps
     * @returns            The trajectory ID
     */
    save(result: OrchestrationResult, callLLM: LLMCallFn, taskPlan: TaskStep[], contextFiles: string[]): Promise<string>;
    /**
     * Retrieve a single trajectory by ID.
     */
    get(id: string): Promise<Trajectory | null>;
    /**
     * Search for trajectories similar to a goal.
     *
     * @param goal      The goal text to search by
     * @param callLLM   LLM function for generating the query embedding
     * @param k         Maximum number of results
     * @returns         Array of trajectories sorted by relevance
     */
    searchByGoal(goal: string, callLLM: LLMCallFn, k?: number): Promise<Trajectory[]>;
    /**
     * Format trajectories as few-shot examples for agent prompts.
     * Truncates plans to the first 5 steps to save token budget.
     * Returns a string that can be injected into the PlannerAgent's prompt.
     */
    formatAsFewShot(trajectories: Trajectory[]): string;
    /**
     * Get statistics about stored trajectories.
     */
    stats(): Promise<{
        total: number;
        avgScore: number;
        byProjectFingerprint: Record<string, number>;
    }>;
    /**
     * Get all stored trajectories.
     */
    getAll(): Trajectory[];
    /**
     * Clear all trajectories.
     */
    clear(): Promise<void>;
    /**
     * Build text to generate an embedding for a trajectory.
     */
    private buildEmbeddingText;
    /**
     * Remove oldest trajectories when the store exceeds MAX_TRAJECTORIES.
     */
    private pruneIfNeeded;
    /**
     * Summarize old trajectories by merging multiple low-scoring or old
     * trajectories into a single compact representation.
     *
     * Summarization replaces a group of similar old trajectories with a
     * single aggregated entry that retains the most important information
     * (goal, file patterns, common steps) while discarding individual details.
     *
     * @param retentionDays  Keep original trajectories newer than this (default: 7)
     * @param verbose        Log summarization details
     * @returns              Number of trajectories summarized/removed
     */
    summarize(retentionDays?: number, verbose?: boolean): Promise<{
        summarized: number;
        merged: number;
    }>;
    /**
     * Merge file changes from multiple trajectories into a unique set,
     * preferring 'modified' status over 'read' etc.
     */
    private mergeFileChanges;
    /**
     * Prune trajectories based on configurable retention policy.
     *
     * @param maxAgeDays       Remove trajectories older than this (default: 90)
     * @param minScore         Remove trajectories with score below this (default: 0.1)
     * @param maxTrajectories  Maximum number to keep (default: 500)
     * @param verbose          Log pruning details
     * @returns                Number of trajectories removed
     */
    pruneByPolicy(maxAgeDays?: number, minScore?: number, maxTrajectories?: number, verbose?: boolean): number;
    /**
     * Get compression statistics showing memory usage and optimization potential.
     */
    getCompressionStats(): {
        totalTrajectories: number;
        totalSizeBytes: number;
        oldTrajectories: number;
        lowScoreTrajectories: number;
        mergeableGroups: number;
        estimatedOptimization: string;
    };
}
export declare function getTrajectoryStore(): TrajectoryStore;
//# sourceMappingURL=trajectory-store.d.ts.map