/**
 * ExecuteModule — Executes shell commands and captures output.
 * Phase 8 of the architecture migration: extract from RunnerAgent into
 * a pluggable module with EventBus integration.
 *
 * Determines the command to run from the task description, validates it,
 * executes on the host or in a Docker sandbox, and returns structured output.
 *
 * @see ARCHITECTURE.md §3.8 — Execute Module specification
 */
import type { EventBus } from '../observability/event-bus.js';
/** Result of a single command execution */
export interface ExecuteResult {
    /** Whether the command exited with code 0 */
    success: boolean;
    /** The exact command that was executed */
    command: string;
    /** Process exit code */
    exitCode: number;
    /** Standard output */
    stdout: string;
    /** Standard error */
    stderr: string;
    /** Duration in milliseconds */
    duration: number;
    /** Error message if execution threw */
    error?: string;
}
/** Parameters for the ExecuteModule.execute() method */
export interface ExecuteParams {
    /** The command to run (can be extracted from task description) */
    command?: string;
    /** The user goal / task description (used to infer command if not provided) */
    goal: string;
    /** Working directory for the command */
    workingDirectory: string;
    /** Optional timeout in milliseconds (default: 120000) */
    timeoutMs?: number;
    /** Optional list of file changes for context */
    fileChanges?: Array<{
        path: string;
        status: string;
    }>;
    /** Optional list of artifacts for context */
    artifactPaths?: string[];
}
/**
 * ExecuteModule — Execute shell commands and capture output.
 *
 * @example
 * ```typescript
 * const module = new DefaultExecuteModule();
 * const result = await module.execute({
 *   command: 'npm test',
 *   goal: 'Run tests',
 *   workingDirectory: '/project',
 * });
 * console.log(`Exit code: ${result.exitCode}`);
 * ```
 */
export interface ExecuteModule {
    /**
     * Execute a shell command and capture output.
     */
    execute(params: ExecuteParams): Promise<ExecuteResult>;
}
/**
 * DefaultExecuteModule — Built-in execute module implementation.
 *
 * Determines the command to run (from params or by inferring from the goal),
 * validates it against the project environment, executes via execSync,
 * and returns structured output with stdout, stderr, exit code, and duration.
 */
export declare class DefaultExecuteModule implements ExecuteModule {
    /** The event bus for emitting observability events */
    private eventBus;
    constructor(eventBus?: EventBus);
    /**
     * Execute a shell command and capture output.
     */
    execute(params: ExecuteParams): Promise<ExecuteResult>;
    /**
     * Infer the command to run from the goal and context.
     * Priority: backtick-wrapped command > "Run:" prefix > npm test > LLM-style prompt.
     */
    private inferCommand;
    /**
     * Validate whether a command is likely to succeed.
     * Checks npm test commands against package.json.
     */
    private validateCommand;
}
//# sourceMappingURL=execute-module.d.ts.map