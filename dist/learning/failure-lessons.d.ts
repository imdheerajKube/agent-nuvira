/**
 * FailureLessonStore — Episodic memory of "what didn't work".
 *
 * The trajectory store only persists SUCCESSFUL runs, so the system never
 * learns from its own misses. This store captures the negative side of the
 * episodic-memory loop (assessment P1):
 *
 *   1. `recordFailure()` — persists a FAILED run: the goal, which agents
 *      failed, their error summaries, the task plan, and files touched.
 *   2. `extractLessons()` — LLM-distills the recent failures into concise
 *      reusable LESSONS ("what went wrong + how to avoid it"), deduped by
 *      title and capped, mirroring PatternStore's extraction discipline.
 *   3. `formatAsPrompt()` — injects the lessons into future Planner prompts
 *      alongside trajectory few-shots and coding patterns, so the planner
 *      avoids repeating past mistakes instead of rediscovering them.
 *
 * Persisted to ~/.nuvira/memory/failure-lessons.json (honors NUVIRA_MEMORY_DIR).
 * The store is best-effort — a corrupt/missing file must never crash a run.
 */
import type { TaskStep } from '../agents/agent.js';
import type { LLMCallFn } from '../agents/agent.js';
/** A single failed orchestration run captured for later distillation. */
export interface FailedRunRecord {
    /** Unique identifier */
    id: string;
    /** The original user goal */
    goal: string;
    /** Top-level error message (when present) */
    error?: string;
    /** Agents that failed, with their error summaries */
    failedAgents: Array<{
        agent: string;
        summary: string;
    }>;
    /** The execution plan (lightweight — descriptions only) */
    taskPlan: Array<{
        id: string;
        description: string;
        agentType: string;
    }>;
    /** File paths touched, with status */
    fileChanges: Array<{
        path: string;
        status: string;
    }>;
    /** How many steps completed vs total */
    tasksCompleted: number;
    tasksTotal: number;
    /** When the failure happened */
    timestamp: number;
}
/** A distilled lesson — a concise "what didn't work + how to avoid it". */
export interface FailureLesson {
    /** Unique identifier */
    id: string;
    /** Short descriptive title (e.g., "Long pipelines exhaust free quota") */
    title: string;
    /** Which project types this applies to (e.g., "typescript, node") */
    applicableDomains: string[];
    /** The lesson — what failed, why, and how to avoid it */
    description: string;
    /** How many failed runs this was distilled from */
    sourceCount: number;
    /** When this lesson was created */
    createdAt: number;
    /** When this lesson was last used (for decay/priority) */
    lastUsedAt: number;
    /** How many times this lesson has been injected into prompts */
    usageCount: number;
}
/**
 * Manages the capture and distillation of failed runs into reusable lessons.
 */
export declare class FailureLessonStore {
    /**
     * Record a failed orchestration run for later distillation.
     * Returns the failure id, or '' if there is nothing worth learning from
     * (no failed agents — e.g. a planner-only abort).
     *
     * @param input  The failure signal: goal, error, per-agent results, plan, files.
     * @returns      The failure record id, or '' if skipped.
     */
    recordFailure(input: {
        goal: string;
        error?: string;
        agentResults: Array<{
            agent: string;
            success: boolean;
            summary: string;
        }>;
        taskPlan: TaskStep[];
        fileChanges: string;
        tasksCompleted: number;
        tasksTotal: number;
    }): string;
    /**
     * LLM-distill the most recent failures into reusable lessons.
     * Newly distilled lessons are merged with existing ones (deduped by title,
     * keeping the newest) and capped at MAX_LESSONS.
     *
     * @param callLLM  LLM function for the extraction call
     * @returns        Number of NEW lessons added
     */
    extractLessons(callLLM: LLMCallFn): Promise<number>;
    /**
     * Format lessons as a prompt string for agent injection (mirrors
     * PatternStore.formatAsPrompt). Lessons matching the given domain tags are
     * preferred; falls back to the most recent lessons.
     */
    formatAsPrompt(domainTags?: string[]): string;
    /**
     * Mark a lesson as used (for usage/priority tracking).
     */
    markUsed(lessonId: string): void;
    /**
     * Mark multiple lessons as used in a single read/write cycle (used by
     * formatAsPrompt so prompt injection never causes N file writes).
     */
    markUsedBatch(lessonIds: string[]): void;
    /** All failed-run records (newest last). */
    getFailedRuns(): FailedRunRecord[];
    /** All distilled lessons. */
    getLessons(): FailureLesson[];
    /** Stats for the `nuvira learn status` / `learn lessons` surfaces. */
    getStats(): {
        totalFailures: number;
        totalLessons: number;
        domainsCovered: string[];
        avgFailedAgentsPerRun: number;
    };
    /** Clear all failure records and distilled lessons. */
    clear(): void;
    private buildExtractionPrompt;
    private parseLessons;
    private tryParseArray;
}
export declare function getFailureLessonStore(): FailureLessonStore;
//# sourceMappingURL=failure-lessons.d.ts.map