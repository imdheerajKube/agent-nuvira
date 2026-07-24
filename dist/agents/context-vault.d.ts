/**
 * ContextVault — The shared in-memory context bus for inter-agent communication.
 *
 * All agents read from and write to this vault. The orchestrator creates one
 * per execution session and passes references to every agent.
 *
 * This is deliberately a simple class wrapping a plain object so that
 * it can be serialized/deserialized in Phase 2 (persistent memory).
 */
import type { AgentContext, TaskStep, Artifact, FileChange } from './agent.js';
/**
 * Shared, mutable context bus for a single orchestration session.
 */
export declare class ContextVault {
    /** The underlying shared context */
    readonly context: AgentContext;
    constructor(goal: string, workingDirectory: string);
    /** Replace the full task plan */
    setTaskPlan(steps: TaskStep[]): void;
    /** Update status for a single task step */
    updateTaskStatus(taskId: string, status: TaskStep['status'], result?: string): void;
    /** Get pending tasks whose dependencies are all completed */
    getRunnableTasks(): TaskStep[];
    /** Check if all tasks are completed or failed */
    get isComplete(): boolean;
    /** Check if any task has failed */
    get hasFailedTasks(): boolean;
    /** Add one or more file artifacts */
    addArtifacts(artifacts: Artifact[]): void;
    /** Get all artifacts (optionally filtered by path match) */
    getArtifacts(pathPattern?: string): Artifact[];
    /** Log an agent-to-agent message */
    addMessage(from: string, to: string, content: string): void;
    /** Get conversation history formatted for LLM context */
    getConversationLog(): string;
    /** Record a file change */
    addFileChange(change: FileChange): void;
    /** Get all file changes */
    getFileChanges(): FileChange[];
    /** Get a formatted diff summary for display */
    getDiffSummary(): string;
    /** Store a metadata value */
    setMeta(key: string, value: unknown): void;
    /** Retrieve a metadata value */
    getMeta<T = unknown>(key: string): T | undefined;
    /** Get a serialisable snapshot (handy for logging / Phase 2 persistence) */
    snapshot(): AgentContext;
}
//# sourceMappingURL=context-vault.d.ts.map