/**
 * Code Execution Tool — Sandboxed code execution.
 *
 * Hermes equivalent: code_execution_tool.py (2,087 lines)
 *
 * Provides:
 * - Execute code in sandboxed environment
 * - Support for multiple languages (JS, TS, Python, bash)
 * - Timeout and resource limits
 * - Output capture
 */
import { EventEmitter } from 'node:events';
export type ExecutionLanguage = 'javascript' | 'typescript' | 'python' | 'bash' | 'powershell';
export interface ExecutionConfig {
    language: ExecutionLanguage;
    code: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: Record<string, string>;
    cwd?: string;
}
export interface ExecutionResult {
    id: string;
    language: ExecutionLanguage;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    error?: string;
}
export declare class CodeExecutor extends EventEmitter {
    private execDir;
    private activeExecutions;
    constructor();
    private ensureDir;
    /**
     * Execute code.
     */
    execute(config: ExecutionConfig): Promise<ExecutionResult>;
    /**
     * Cancel an execution.
     */
    cancel(id: string): boolean;
    /**
     * Get the command for a language.
     */
    private getCommand;
    /**
     * Get active execution count.
     */
    getActiveCount(): number;
}
export declare function getCodeExecutor(): CodeExecutor;
export declare function resetCodeExecutor(): void;
//# sourceMappingURL=code-execution.d.ts.map