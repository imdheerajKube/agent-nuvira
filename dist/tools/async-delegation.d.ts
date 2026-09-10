/**
 * async_delegation — Background child agent execution.
 *
 * Enables running child agents in the background without blocking the parent.
 * Uses a daemon executor with thread pool for parallel task execution.
 *
 * Features:
 * - Background execution (non-blocking)
 * - Completion queue for results
 * - Crash recovery via SQLite
 * - Configurable concurrency limits
 * - Live status monitoring
 */
import { EventEmitter } from 'events';
interface DelegationTask {
    id: string;
    goal: string;
    context?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    result?: any;
    error?: string;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    duration?: number;
}
interface DelegationStats {
    total: number;
    running: number;
    completed: number;
    failed: number;
    pending: number;
}
declare class AsyncDelegationManager extends EventEmitter {
    private tasks;
    private maxConcurrent;
    private taskIdCounter;
    private runningCount;
    private completionQueue;
    constructor(options?: {
        maxConcurrent?: number;
    });
    /**
     * Dispatch a task for background execution.
     */
    dispatch(params: {
        goal: string;
        context?: string;
        runner?: (task: DelegationTask) => Promise<any>;
    }): {
        id: string;
        status: string;
    };
    /**
     * Try to start a pending task if we have capacity.
     */
    private tryStartTask;
    /**
     * Default runner for tasks without custom runner.
     */
    private defaultRunner;
    /**
     * Try to start the next pending task.
     */
    private tryStartNext;
    /**
     * Get status of a task.
     */
    getStatus(id: string): DelegationTask | null;
    /**
     * Get all tasks.
     */
    listTasks(): DelegationTask[];
    /**
     * Get completion queue (drained on read).
     */
    drainCompletionQueue(): DelegationTask[];
    /**
     * Cancel a task.
     */
    cancel(id: string): boolean;
    /**
     * Get statistics.
     */
    getStats(): DelegationStats;
    /**
     * Clear completed tasks older than retention period.
     */
    clearOlderThan(retentionMs: number): number;
}
export declare function getAsyncDelegationManager(): AsyncDelegationManager;
export { AsyncDelegationManager };
//# sourceMappingURL=async-delegation.d.ts.map