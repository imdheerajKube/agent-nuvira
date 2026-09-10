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
// ─── Background Sync Manager ────────────────────────────────────────────────
export class BackgroundSyncManager extends EventEmitter {
    queue = [];
    running = new Map();
    completed = [];
    config;
    isProcessing = false;
    isShutdown = false;
    taskCounter = 0;
    // Metrics
    metrics = {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        pendingTasks: 0,
        runningTasks: 0,
        averageDuration: 0,
        totalDuration: 0,
    };
    constructor(config) {
        super();
        this.config = {
            maxConcurrent: config?.maxConcurrent ?? 3,
            maxQueueSize: config?.maxQueueSize ?? 100,
            drainTimeoutMs: config?.drainTimeoutMs ?? 5000,
            retryDelayMs: config?.retryDelayMs ?? 1000,
            maxRetries: config?.maxRetries ?? 3,
        };
    }
    /**
     * Enqueue a task for background execution.
     */
    enqueue(params) {
        if (this.isShutdown) {
            throw new Error('BackgroundSyncManager is shut down');
        }
        if (this.queue.length >= this.config.maxQueueSize) {
            throw new Error('Queue is full');
        }
        const id = `sync_${Date.now()}_${++this.taskCounter}`;
        const task = {
            id,
            type: params.type,
            data: params.data,
            priority: params.priority ?? 0,
            createdAt: Date.now(),
            status: 'pending',
            retries: 0,
            maxRetries: this.config.maxRetries,
        };
        this.queue.push(task);
        this.metrics.totalTasks++;
        this.metrics.pendingTasks++;
        // Sort by priority (higher = more urgent)
        this.queue.sort((a, b) => b.priority - a.priority);
        // Start processing if not already
        this.processQueue();
        return id;
    }
    /**
     * Process the queue.
     */
    async processQueue() {
        if (this.isProcessing || this.isShutdown) {
            return;
        }
        this.isProcessing = true;
        while (this.queue.length > 0 && this.running.size < this.config.maxConcurrent) {
            const task = this.queue.shift();
            if (!task)
                break;
            this.metrics.pendingTasks--;
            this.running.set(task.id, task);
            this.metrics.runningTasks++;
            // Process task in background (non-blocking)
            this.processTask(task).catch((err) => {
                console.error(`BackgroundSync: Task ${task.id} failed:`, err);
            });
        }
        this.isProcessing = false;
    }
    /**
     * Process a single task.
     */
    async processTask(task) {
        task.status = 'running';
        task.startedAt = Date.now();
        try {
            await this.executeTask(task);
            task.status = 'completed';
            task.completedAt = Date.now();
            const duration = task.completedAt - task.startedAt;
            this.metrics.completedTasks++;
            this.metrics.totalDuration += duration;
            this.metrics.averageDuration =
                this.metrics.totalDuration / this.metrics.completedTasks;
            this.emit('task:completed', { id: task.id, type: task.type, duration });
        }
        catch (err) {
            task.error = err.message;
            if (task.retries < task.maxRetries) {
                // Retry after delay
                task.retries++;
                task.status = 'pending';
                this.running.delete(task.id);
                this.metrics.runningTasks--;
                setTimeout(() => {
                    this.queue.unshift(task); // Add to front for retry
                    this.metrics.pendingTasks++;
                    this.processQueue();
                }, this.config.retryDelayMs);
                return;
            }
            task.status = 'failed';
            task.completedAt = Date.now();
            this.metrics.failedTasks++;
            this.emit('task:failed', { id: task.id, type: task.type, error: err.message });
        }
        finally {
            this.running.delete(task.id);
            this.metrics.runningTasks--;
            // Move to completed list (keep last 100)
            this.completed.push(task);
            if (this.completed.length > 100) {
                this.completed = this.completed.slice(-100);
            }
            // Process more tasks
            this.processQueue();
        }
    }
    /**
     * Execute a task (override in subclass or provide handler).
     */
    async executeTask(task) {
        // Emit event for external handlers
        return new Promise((resolve, reject) => {
            this.emit('task:execute', task, resolve, reject);
        });
    }
    /**
     * Get task status.
     */
    getStatus(id) {
        return (this.running.get(id) ||
            this.queue.find((t) => t.id === id) ||
            this.completed.find((t) => t.id === id) ||
            null);
    }
    /**
     * Get metrics.
     */
    getMetrics() {
        return { ...this.metrics };
    }
    /**
     * Get queue length.
     */
    getQueueLength() {
        return this.queue.length;
    }
    /**
     * Get running count.
     */
    getRunningCount() {
        return this.running.size;
    }
    /**
     * Cancel a task.
     */
    cancel(id) {
        // Check queue
        const queueIndex = this.queue.findIndex((t) => t.id === id);
        if (queueIndex >= 0) {
            const task = this.queue.splice(queueIndex, 1)[0];
            task.status = 'cancelled';
            this.metrics.pendingTasks--;
            this.emit('task:cancelled', { id: task.id, type: task.type });
            return true;
        }
        // Check running
        const runningTask = this.running.get(id);
        if (runningTask) {
            runningTask.status = 'cancelled';
            this.emit('task:cancelled', { id: runningTask.id, type: runningTask.type });
            return true;
        }
        return false;
    }
    /**
     * Drain the queue (wait for all tasks to complete).
     */
    async drain(timeoutMs) {
        const timeout = timeoutMs ?? this.config.drainTimeoutMs;
        const startTime = Date.now();
        while ((this.queue.length > 0 || this.running.size > 0) &&
            Date.now() - startTime < timeout) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // Force cancel remaining tasks
        if (this.queue.length > 0 || this.running.size > 0) {
            for (const task of this.queue) {
                task.status = 'cancelled';
            }
            this.queue = [];
            for (const [id, task] of this.running) {
                task.status = 'cancelled';
            }
            this.running.clear();
        }
    }
    /**
     * Shutdown gracefully.
     */
    async shutdown() {
        this.isShutdown = true;
        await this.drain();
        this.removeAllListeners();
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getBackgroundSyncManager() {
    if (!_instance)
        _instance = new BackgroundSyncManager();
    return _instance;
}
//# sourceMappingURL=background-sync.js.map