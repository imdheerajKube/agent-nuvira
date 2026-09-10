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
export type DelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface DelegationTask {
    /** Unique task ID */
    id: string;
    /** Task goal/description */
    goal: string;
    /** Task status */
    status: DelegationStatus;
    /** Assigned agent type */
    agentType?: string;
    /** Task result (when completed) */
    result?: string;
    /** Error message (when failed) */
    error?: string;
    /** Progress updates */
    progress: string[];
    /** When the task was created */
    createdAt: number;
    /** When the task started running */
    startedAt?: number;
    /** When the task completed */
    completedAt?: number;
    /** Parent task ID (for nested delegations) */
    parentId?: string;
    /** Metadata */
    metadata?: Record<string, unknown>;
}
export interface DelegationOptions {
    /** Agent type to delegate to */
    agentType?: string;
    /** Timeout in ms (default: 300000 = 5 min) */
    timeoutMs?: number;
    /** Parent task ID */
    parentId?: string;
    /** Metadata to attach */
    metadata?: Record<string, unknown>;
    /** Callback when task completes */
    onComplete?: (task: DelegationTask) => void;
    /** Callback on progress update */
    onProgress?: (task: DelegationTask, message: string) => void;
}
export interface DelegationResult {
    /** Task ID */
    taskId: string;
    /** Whether delegation was successful */
    success: boolean;
    /** Task result (if completed) */
    result?: string;
    /** Error message (if failed) */
    error?: string;
}
export declare class DelegationManager {
    private tasks;
    private handlers;
    private eventHandlers;
    /**
     * Delegate a task to a sub-agent.
     */
    delegate(goal: string, options?: DelegationOptions): Promise<DelegationResult>;
    /**
     * Get task status.
     */
    getTask(taskId: string): DelegationTask | null;
    /**
     * Get all tasks.
     */
    getAllTasks(): DelegationTask[];
    /**
     * Get tasks by status.
     */
    getTasksByStatus(status: DelegationStatus): DelegationTask[];
    /**
     * Cancel a task.
     */
    cancel(taskId: string): boolean;
    /**
     * Register a handler for a specific agent type.
     */
    registerHandler(agentType: string, handler: (goal: string, options: DelegationOptions) => Promise<string>): void;
    /**
     * Register an event handler.
     */
    onEvent(handler: (event: string, task: DelegationTask) => void): void;
    /**
     * Get live log for a task.
     */
    getLiveLog(taskId: string): string[];
    /**
     * Subscribe to live log updates.
     */
    subscribeToLog(taskId: string, callback: (message: string) => void): () => void;
    private executeTask;
    private emit;
}
export declare function getDelegationManager(): DelegationManager;
export declare function resetDelegationManager(): void;
//# sourceMappingURL=delegate-tool.d.ts.map