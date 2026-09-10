/**
 * BackgroundSync — Daemon thread manager for memory operations.
 *
 * Runs memory extraction and sync operations in background threads
 * to keep per-turn latency at zero. Uses a queue-based architecture
 * with configurable concurrency.
 *
 * Features:
 * - Zero-cost per-turn memory operations
 * - Configurable concurrency limits
 * - Graceful shutdown with drain timeout
 * - Error handling and retry logic
 * - Metrics and monitoring
 */
import { EventEmitter } from 'events';
type SyncTaskType = 'extract' | 'sync' | 'prefetch' | 'cleanup';
interface SyncTask {
    id: string;
    type: SyncTaskType;
    data: any;
    priority: number;
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    error?: string;
    retries: number;
    maxRetries: number;
}
interface SyncMetrics {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    pendingTasks: number;
    runningTasks: number;
    averageDuration: number;
    totalDuration: number;
}
interface BackgroundSyncConfig {
    maxConcurrent: number;
    maxQueueSize: number;
    drainTimeoutMs: number;
    retryDelayMs: number;
    maxRetries: number;
}
export declare class BackgroundSyncManager extends EventEmitter {
    private queue;
    private running;
    private completed;
    private config;
    private isProcessing;
    private isShutdown;
    private taskCounter;
    private metrics;
    constructor(config?: Partial<BackgroundSyncConfig>);
    /**
     * Enqueue a task for background execution.
     */
    enqueue(params: {
        type: SyncTaskType;
        data: any;
        priority?: number;
    }): string;
    /**
     * Process the queue.
     */
    private processQueue;
    /**
     * Process a single task.
     */
    private processTask;
    /**
     * Execute a task (override in subclass or provide handler).
     */
    private executeTask;
    /**
     * Get task status.
     */
    getStatus(id: string): SyncTask | null;
    /**
     * Get metrics.
     */
    getMetrics(): SyncMetrics;
    /**
     * Get queue length.
     */
    getQueueLength(): number;
    /**
     * Get running count.
     */
    getRunningCount(): number;
    /**
     * Cancel a task.
     */
    cancel(id: string): boolean;
    /**
     * Drain the queue (wait for all tasks to complete).
     */
    drain(timeoutMs?: number): Promise<void>;
    /**
     * Shutdown gracefully.
     */
    shutdown(): Promise<void>;
}
export declare function getBackgroundSyncManager(): BackgroundSyncManager;
export {};
//# sourceMappingURL=background-sync.d.ts.map