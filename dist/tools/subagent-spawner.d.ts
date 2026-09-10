/**
 * Subagent Spawner — Real subagent spawning with LLM calls.
 *
 * Unlike our previous placeholder, this actually spawns child processes
 * that make their own LLM calls and return results.
 *
 * Architecture:
 * - Parent spawns child process via fork()
 * - Child has its own LLM client and tool registry
 * - Child makes its own LLM calls (no parent blocking)
 * - Child writes results to shared file/pipe
 * - Parent reads results asynchronously
 *
 * Hermes equivalent: delegate_tool.py (3931 lines) — actual agent spawning
 */
import { EventEmitter } from 'node:events';
export type SubagentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
export interface SubagentConfig {
    /** Goal for the subagent */
    goal: string;
    /** System prompt override */
    systemPrompt?: string;
    /** LLM provider to use */
    provider?: string;
    /** LLM model to use */
    model?: string;
    /** Tools available to the subagent */
    tools?: string[];
    /** Tools blocked from the subagent */
    blockedTools?: string[];
    /** Max LLM calls */
    maxLlmCalls?: number;
    /** Max tokens */
    maxTokens?: number;
    /** Timeout in ms */
    timeoutMs?: number;
    /** Working directory */
    cwd?: string;
    /** Environment variables */
    env?: Record<string, string>;
}
export interface SubagentState {
    /** Subagent ID */
    id: string;
    /** Process ID */
    pid?: number;
    /** Status */
    status: SubagentStatus;
    /** Goal */
    goal: string;
    /** Result */
    result?: string;
    /** Error */
    error?: string;
    /** LLM calls made */
    llmCalls: number;
    /** Tokens used */
    tokensUsed: number;
    /** Tool calls made */
    toolCalls: number;
    /** Start time */
    startedAt: number;
    /** End time */
    endedAt?: number;
    /** Duration in ms */
    durationMs?: number;
}
export interface SubagentResult {
    /** Subagent ID */
    id: string;
    /** Success */
    success: boolean;
    /** Result text */
    result: string;
    /** Error if failed */
    error?: string;
    /** LLM calls made */
    llmCalls: number;
    /** Tokens used */
    tokensUsed: number;
    /** Tool calls made */
    toolCalls: number;
    /** Duration in ms */
    durationMs: number;
    /** Full log */
    log: string[];
}
export declare class SubagentManager extends EventEmitter {
    private subagents;
    private processes;
    private maxConcurrent;
    private maxDepth;
    private killSwitch;
    constructor();
    /** Configure spawn limits. */
    configure(options: {
        maxConcurrent?: number;
        maxDepth?: number;
        killSwitch?: boolean;
    }): void;
    /** Check if spawning is allowed. */
    canSpawn(): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Spawn a subagent.
     */
    spawn(config: SubagentConfig): Promise<SubagentState>;
    /**
     * Get subagent state.
     */
    getState(id: string): SubagentState | null;
    /**
     * Get all subagents.
     */
    getAll(): SubagentState[];
    /**
     * Kill a subagent.
     */
    kill(id: string, reason?: string): boolean;
    /**
     * Wait for a subagent to complete.
     */
    waitForCompletion(id: string, timeoutMs?: number): Promise<SubagentResult>;
    /**
     * Get log for a subagent.
     */
    getLog(id: string): string[];
    /**
     * Read result file.
     */
    readResult(id: string): SubagentResult | null;
    private handleMessage;
    private handleExit;
    private buildResult;
    private saveState;
    private recoverState;
    private ensureDirectories;
}
export declare function getSubagentManager(): SubagentManager;
export declare function resetSubagentManager(): void;
//# sourceMappingURL=subagent-spawner.d.ts.map