/**
 * TesterAgent — Creates a sandboxed test environment, copies the project,
 * installs dependencies, runs tests, and reports pass/fail results.
 *
 * The sandbox is created in a temp directory to avoid modifying the original project.
 * Tests are run via `npm test` (or a custom command), and full stdout/stderr + exit
 * code are captured and returned.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * Result of running tests in the sandbox.
 */
export interface TestResult {
    /** Whether all tests passed */
    success: boolean;
    /** Full test output (stdout + stderr) */
    output: string;
    /** Test exit code */
    exitCode: number;
    /** Path to the sandbox directory */
    sandboxPath: string;
    /** How many tests passed (parsed from output) */
    passed?: number;
    /** How many tests failed (parsed from output) */
    failed?: number;
    /** How many tests total (parsed from output) */
    total?: number;
}
/**
 * TesterAgent — Sandboxed test runner.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-05-test", "description": "Run tests to verify the changes", "agentType": "tester", "dependsOn": ["step-04-write"] }
 * ```
 */
export declare class TesterAgent extends Agent {
    readonly name = "Tester";
    readonly description = "Runs tests in a sandboxed environment";
    /**
     * Execute tests in a sandboxed copy of the project.
     *
     * Steps:
     * 1. Create a temp directory
     * 2. Copy project files (excluding node_modules, .git, etc.)
     * 3. Run `npm install` in the sandbox
     * 4. Run `npm test` in the sandbox
     * 5. Parse and return the results
     */
    execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Execute tests inside a Docker sandbox container.
     * Falls back to filesystem sandbox if Docker is not available.
     */
    private executeWithDocker;
    /**
     * Detect the test command from package.json scripts.
     * Returns null if no test script is found, so the caller can skip tests gracefully
     * instead of running a failing `npm test` command.
     */
    private detectTestCommand;
    /**
     * Copy project files to the sandbox directory, excluding large/generated dirs.
     */
    private copyProject;
    /**
     * Get sorted directory entries to ensure deterministic copy order.
     */
    private getDirectoryEntries;
    /**
     * Apply the file changes from the execution context to the sandbox.
     */
    private applyChangesToSandbox;
    /**
     * Run npm install in the sandbox.
     */
    private runInstall;
    /**
     * Run the test command and capture output.
     */
    private runTests;
    /**
     * Parse test output to extract pass/fail/total counts.
     * Supports common test runners: vitest, jest, mocha, etc.
     */
    private parseTestOutput;
    /**
     * Truncate long output to avoid huge result strings.
     */
    private truncateOutput;
}
/**
 * Clean up a specific sandbox directory.
 */
export declare function cleanupSandbox(sandboxPath: string): void;
//# sourceMappingURL=tester.d.ts.map