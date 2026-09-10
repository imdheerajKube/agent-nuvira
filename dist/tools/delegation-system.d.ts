/**
 * Delegation System — Full subagent architecture.
 *
 * Hermes equivalent: delegate_tool.py (3931 lines) + delegation_live_log.py (424 lines)
 *                     + async_delegation.py (1515 lines) + managed_tool_gateway.py (452 lines)
 *
 * Features:
 * - Spawns child AI agent instances with isolated context
 * - Inherits parent toolsets with child-only blocked tools stripped
 * - Fresh conversation per child (no parent history)
 * - Own task_id (own terminal session, file ops cache)
 * - Live log streaming to parent/user
 * - Background (async) delegation with completion events
 * - Batch (parallel) delegation mode
 * - Managed tool gateway for vendor passthroughs
 */
import { EventEmitter } from 'node:events';
export type DelegationMode = 'sync' | 'async' | 'batch';
export type DelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type LogEntryType = 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'lifecycle' | 'error';
export interface DelegationTask {
    id: string;
    delegationId: string;
    goal: string;
    status: DelegationStatus;
    mode: DelegationMode;
    agentType: string;
    context: DelegationContext;
    result?: string;
    error?: string;
    progress: string[];
    createdAt: number;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    retryCount: number;
    maxRetries: number;
}
export interface DelegationContext {
    parentTaskId?: string;
    toolsets: string[];
    blockedTools: string[];
    systemPrompt?: string;
    metadata: Record<string, unknown>;
}
export interface DelegationResult {
    taskId: string;
    delegationId: string;
    success: boolean;
    result?: string;
    error?: string;
    durationMs: number;
    toolCalls: number;
    summary: string;
}
export interface LogEntry {
    taskId: string;
    type: LogEntryType;
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
export interface ManagedToolConfig {
    name: string;
    endpoint: string;
    apiKey?: string;
    timeout?: number;
    retries?: number;
}
/** Configuration for delegation behavior. */
export interface DelegationConfig {
    /** Maximum concurrent child agents (default: 3). */
    maxConcurrentChildren: number;
    /** Maximum spawn depth — 1 means parent->child only (default: 1). */
    maxSpawnDepth: number;
    /** Stall timeout — if a child produces no output for this long, it's marked stalled (default: 120s). */
    stallTimeoutMs: number;
    /** Global kill switch — when true, no new children can be spawned. */
    killSwitch: boolean;
    /** Inherit parent toolsets to children (default: true). */
    inheritToolsets: boolean;
    /** Inherit MCP toolsets to children (default: true). */
    inheritMcpToolsets: boolean;
}
export declare class DelegationManager extends EventEmitter {
    private tasks;
    private delegations;
    private completionQueue;
    private logStreams;
    private config;
    private activeChildren;
    private stallTimers;
    constructor();
    /** Update delegation configuration. */
    configure(config: Partial<DelegationConfig>): void;
    /** Get current configuration. */
    getConfig(): DelegationConfig;
    /** Toggle the global kill switch. */
    toggleKillSwitch(enabled: boolean): void;
    /** Check if a task can be spawned (respects kill switch, depth, concurrency). */
    canSpawn(parentTaskId?: string): {
        allowed: boolean;
        reason?: string;
    };
    /** Calculate spawn depth for a task. */
    private getSpawnDepth;
    /** Interrupt a running subagent gracefully. */
    interrupt(taskId: string): boolean;
    /** Check if a task has been interrupted. */
    isInterrupted(taskId: string): boolean;
    private startStallMonitor;
    /** Get the number of active children. */
    getActiveChildCount(): number;
    /** Get spawn tree for a task (shows parent-child chain). */
    getSpawnTree(taskId: string): Array<{
        id: string;
        goal: string;
        depth: number;
    }>;
    /**
     * Delegate a task to a subagent.
     */
    delegate(goal: string, options?: {
        mode?: DelegationMode;
        agentType?: string;
        parentTaskId?: string;
        toolsets?: string[];
        blockedTools?: string[];
        systemPrompt?: string;
        metadata?: Record<string, unknown>;
        timeout?: number;
        maxRetries?: number;
    }): Promise<DelegationTask>;
    /**
     * Delegate a batch of tasks in parallel.
     */
    delegateBatch(goals: string[], options?: {
        agentType?: string;
        maxConcurrency?: number;
        timeout?: number;
    }): Promise<DelegationTask[]>;
    /**
     * Get task status.
     */
    getTask(taskId: string): DelegationTask | null;
    /**
     * Get all tasks for a delegation.
     */
    getDelegationTasks(delegationId: string): DelegationTask[];
    /**
     * Cancel a task.
     */
    cancel(taskId: string): boolean;
    /**
     * Wait for a task to complete.
     */
    waitForCompletion(taskId: string, timeoutMs?: number): Promise<DelegationResult>;
    /**
     * Get live log for a task.
     */
    getLiveLog(taskId: string): LogEntry[];
    /**
     * Subscribe to live log updates.
     */
    subscribeToLog(taskId: string, callback: (entry: LogEntry) => void): () => void;
    /**
     * Tail log for a task (returns async iterator).
     */
    tailLog(taskId: string): AsyncGenerator<LogEntry>;
    /**
     * Get pending completions.
     */
    getPendingCompletions(): DelegationResult[];
    /**
     * Acknowledge a completion.
     */
    acknowledgeCompletion(taskId: string): boolean;
    /**
     * Drain completion queue (get all and clear).
     */
    drainCompletions(): DelegationResult[];
    private managedTools;
    /**
     * Register a managed tool.
     */
    registerManagedTool(config: ManagedToolConfig): void;
    /**
     * Call a managed tool.
     */
    callManagedTool(toolName: string, args: Record<string, unknown>): Promise<{
        success: boolean;
        result?: unknown;
        error?: string;
    }>;
    /**
     * List managed tools.
     */
    listManagedTools(): ManagedToolConfig[];
    private executeTask;
    private buildSystemPrompt;
    private buildResult;
    private logEntry;
    private createLiveLog;
    private ensureDirectories;
    private loadPendingTasks;
    private saveCompletionQueue;
    private recoverCompletionQueue;
}
export declare function getDelegationManager(): DelegationManager;
export declare function resetDelegationManager(): void;
//# sourceMappingURL=delegation-system.d.ts.map