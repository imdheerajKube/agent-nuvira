/**
 * DebuggerAgent — Takes test failure output, uses the LLM to diagnose and fix
 * the issues, re-runs tests, and iterates until all tests pass or max attempts
 * are exhausted.
 *
 * This agent depends on the TesterAgent having run first and stored its results
 * in the context metadata under `testResult`.
 *
 * The debug cycle:
 * 1. Read test failure output from `context.metadata.testResult`
 * 2. Call LLM with failure output + source files → get proposed fixes
 * 3. Apply fixes to the sandbox (the TesterAgent's sandbox path is in testResult)
 * 4. Re-run tests in the sandbox
 * 5. If tests pass → done. If not, repeat up to MAX_DEBUG_ITERATIONS.
 */
import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
/**
 * DebuggerAgent — Diagnoses and fixes test failures iteratively.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-06-debug", "description": "Fix failing tests", "agentType": "debugger", "dependsOn": ["step-05-test"] }
 * ```
 */
export declare class DebuggerAgent extends Agent {
    readonly name = "Debugger";
    readonly description = "Diagnoses test failures and iteratively applies fixes";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
    /**
     * Build the debug prompt with failure output and source files.
     */
    private buildPrompt;
    /**
     * Parse the LLM response and apply the fixes to files in the sandbox.
     * Returns a list of file paths that were changed.
     */
    private applyFixes;
    /**
     * Read fixed files from the sandbox and update the context's fileChanges.
     * Handles both files already in context.fileChanges AND new files the LLM
     * may have modified that weren't in the original change set.
     */
    private syncChangesToContext;
    /**
     * Run the test command in the sandbox.
     */
    private runTest;
    /**
     * Detect the test command from package.json.
     * Returns null if no test script is found, so the caller can handle gracefully.
     */
    private detectTestCommand;
    /**
     * Truncate long output to avoid huge strings.
     */
    private truncateOutput;
}
//# sourceMappingURL=debugger.d.ts.map