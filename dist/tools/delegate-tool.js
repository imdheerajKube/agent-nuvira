/**
 * Delegate Tool — Async task delegation to sub-agents.
 *
 * Allows the main agent to delegate tasks to background sub-agents
 * and monitor their progress. Supports:
 * - Fire-and-forget delegation
 * - Async completion with delivery
 * - Progress monitoring
 * - Live log streaming
 *
 * Hermes equivalent: delegate_tool.py + delegation_live_log.py + async_delegation.py + managed_tool_gateway.py
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
// ─── Delegation Manager ───────────────────────────────────────────────────
export class DelegationManager {
    tasks = new Map();
    handlers = new Map();
    eventHandlers = [];
    // ─── Task Management ─────────────────────────────────────────────────
    /**
     * Delegate a task to a sub-agent.
     */
    async delegate(goal, options = {}) {
        const taskId = randomUUID();
        const task = {
            id: taskId,
            goal,
            status: 'pending',
            agentType: options.agentType,
            progress: [],
            createdAt: Date.now(),
            parentId: options.parentId,
            metadata: options.metadata,
        };
        this.tasks.set(taskId, task);
        this.emit('created', task);
        // Start execution asynchronously
        this.executeTask(taskId, options).catch((err) => {
            logger.error(`Delegation: Task '${taskId}' execution error: ${err}`);
        });
        return {
            taskId,
            success: true,
        };
    }
    /**
     * Get task status.
     */
    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }
    /**
     * Get all tasks.
     */
    getAllTasks() {
        return [...this.tasks.values()];
    }
    /**
     * Get tasks by status.
     */
    getTasksByStatus(status) {
        return [...this.tasks.values()].filter((t) => t.status === status);
    }
    /**
     * Cancel a task.
     */
    cancel(taskId) {
        const task = this.tasks.get(taskId);
        if (!task)
            return false;
        if (task.status === 'completed' || task.status === 'failed') {
            return false;
        }
        task.status = 'cancelled';
        task.completedAt = Date.now();
        this.emit('cancelled', task);
        return true;
    }
    // ─── Handler Registration ────────────────────────────────────────────
    /**
     * Register a handler for a specific agent type.
     */
    registerHandler(agentType, handler) {
        this.handlers.set(agentType, handler);
    }
    /**
     * Register an event handler.
     */
    onEvent(handler) {
        this.eventHandlers.push(handler);
    }
    // ─── Live Log ────────────────────────────────────────────────────────
    /**
     * Get live log for a task.
     */
    getLiveLog(taskId) {
        const task = this.tasks.get(taskId);
        return task?.progress || [];
    }
    /**
     * Subscribe to live log updates.
     */
    subscribeToLog(taskId, callback) {
        const task = this.tasks.get(taskId);
        if (!task)
            return () => { };
        const handler = (event, t) => {
            if (t.id === taskId && event === 'progress') {
                const lastMessage = t.progress[t.progress.length - 1];
                if (lastMessage)
                    callback(lastMessage);
            }
        };
        this.eventHandlers.push(handler);
        return () => {
            const idx = this.eventHandlers.indexOf(handler);
            if (idx !== -1)
                this.eventHandlers.splice(idx, 1);
        };
    }
    // ─── Internal ────────────────────────────────────────────────────────
    async executeTask(taskId, options) {
        const task = this.tasks.get(taskId);
        if (!task)
            return;
        task.status = 'running';
        task.startedAt = Date.now();
        this.emit('started', task);
        try {
            // Find handler
            const agentType = task.agentType || 'default';
            const handler = this.handlers.get(agentType);
            if (!handler) {
                throw new Error(`No handler registered for agent type '${agentType}'`);
            }
            // Execute with timeout
            const timeoutMs = options.timeoutMs || 300_000;
            const result = await Promise.race([
                handler(task.goal, {
                    ...options,
                    onProgress: (_task, message) => {
                        task.progress.push(message);
                        this.emit('progress', task);
                        options.onProgress?.(task, message);
                    },
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)), timeoutMs)),
            ]);
            task.status = 'completed';
            task.result = result;
            task.completedAt = Date.now();
            this.emit('completed', task);
            options.onComplete?.(task);
        }
        catch (err) {
            task.status = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            task.completedAt = Date.now();
            this.emit('failed', task);
        }
    }
    emit(event, task) {
        for (const handler of this.eventHandlers) {
            try {
                handler(event, task);
            }
            catch {
                // Ignore handler errors
            }
        }
    }
}
// ─── Singleton ────────────────────────────────────────────────────────────
let _instance = null;
export function getDelegationManager() {
    if (!_instance) {
        _instance = new DelegationManager();
    }
    return _instance;
}
export function resetDelegationManager() {
    _instance = null;
}
//# sourceMappingURL=delegate-tool.js.map