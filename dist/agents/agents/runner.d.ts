/**
 * RunnerAgent — Executes shell commands in the project directory and captures output.
 *
 * This is the agent that makes agent-nuvira capable of *running* the programs
 * it creates. Without this, the system can write files but can never execute
 * them or show the user what happened.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-03-run", "description": "Run: python hello.py", "agentType": "runner", "dependsOn": ["step-02-write"] }
 * ```
 *
 * The command to run is determined by:
 * 1. The task description — if it contains a command wrapped in backticks
 *    (e.g., "Run `python hello.py`"), that command is extracted and executed.
 * 2. The "Run:" prefix — if the description starts with "Run:", the rest is
 *    treated as the command (e.g., "Run: python hello.py").
 * 3. The LLM fallback — if no explicit command is found, the LLM is asked
 *    what command to run based on the current context (files created, project type).
 *
 * Output is stored in context metadata as `runResult` and returned in the summary.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * Result of running a command, stored in context.metadata.runResult.
 */
export interface RunResult {
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
    /** Error message if execSync threw */
    error?: string;
}
/**
 * RunnerAgent — Executes shell commands and captures output.
 */
export declare class RunnerAgent extends Agent {
    readonly name = "Runner";
    readonly description = "Executes shell commands and captures output";
    /** Stored LLM call function for command suggestion fallback */
    private _callLLM?;
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Determine the command to run.
     *
     * Priority order:
     * 1. Parse from task description (backtick-wrapped command or "Run:" prefix)
     * 2. Ask the LLM what command to run based on the files that were created
     */
    private determineCommand;
    /**
     * Execute a command inside a Docker sandbox container.
     * Falls back to host execution if Docker is not available.
     */
    private executeWithDocker;
    /**
     * Check whether a command is likely to succeed before executing it.
     * Currently validates:
     * - `npm test` / `npm run test`: checks that the project's package.json has a `test` script
     */
    private isCommandAvailable;
    /**
     * Execute a command directly on the host machine.
     * Validates the command first, and falls back to LLM suggestion if the command is not available.
     */
    private executeOnHost;
    /**
     * Fallback: ask the LLM what command to run based on the project context.
     * Includes project's package.json metadata so the LLM can make an informed choice.
     */
    private askLLMForCommand;
}
//# sourceMappingURL=runner.d.ts.map