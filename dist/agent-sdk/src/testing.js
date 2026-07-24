/**
 * @agent-nuvira/sdk/testing — Testing utilities for building and testing custom agents.
 *
 * Provides:
 * - {@link createMockContext} — Build a fully typed {@link AgentContext} for tests
 * - {@link createMockLLM} — Create a mock LLM function that returns controlled responses
 * - {@link runAgentTest} — Convenience wrapper for executing an agent in a test
 * - {@link assertAgentSuccess} / {@link assertAgentFailure} — Result assertions
 *
 * ## Example
 *
 * ```ts
 * import { describe, it, expect } from 'vitest';
 * import { MyAgent } from './my-agent.js';
 * import {
 *   createMockContext,
 *   createMockLLM,
 *   runAgentTest,
 *   assertAgentSuccess,
 * } from '@agent-nuvira/sdk/testing';
 *
 * describe('MyAgent', () => {
 *   it('should process files correctly', async () => {
 *     const context = createMockContext({
 *       goal: 'Format all TypeScript files',
 *       artifacts: [{ path: 'src/index.ts', content: 'const x=1', description: 'Source file' }],
 *     });
 *     const callLLM = createMockLLM('Formatted code content');
 *
 *     const result = await runAgentTest(new MyAgent(), context, callLLM);
 *
 *     assertAgentSuccess(result);
 *     expect(result.summary).toContain('Formatted');
 *     expect(context.fileChanges).toHaveLength(1);
 *   });
 * });
 * ```
 *
 * @module @agent-nuvira/sdk/testing
 */
/**
 * Create a fully typed mock {@link AgentContext} for testing agents.
 *
 * @example
 * ```ts
 * const ctx = createMockContext({
 *   goal: 'Add error handling to server.ts',
 *   artifacts: [{ path: 'server.ts', content: '...', description: 'Main server' }],
 * });
 * ```
 */
export function createMockContext(options = {}) {
    return {
        goal: options.goal || 'Test goal',
        workingDirectory: options.workingDirectory || process.cwd(),
        taskPlan: options.taskPlan || [],
        artifacts: options.artifacts || [],
        fileChanges: options.fileChanges || [],
        conversations: options.conversations || [],
        metadata: options.metadata || {},
        onRateLimit: options.onRateLimit
            ? async () => ({ action: 'retry' })
            : undefined,
    };
}
/**
 * Create a mock LLM function that returns a fixed response.
 * Useful for testing agent logic without making real API calls.
 *
 * Also provides a `prompts` array on the returned function that records all
 * prompts sent to it (when `trackPrompts` is enabled).
 *
 * @example
 * ```ts
 * const callLLM = createMockLLM('Some LLM response');
 * const result = await callLLM('Some prompt');
 * // result === 'Some LLM response'
 * // callLLM.prompts[0] === { prompt: 'Some prompt', options: undefined }
 * ```
 */
export function createMockLLM(response = '', options = {}) {
    const trackPrompts = options.trackPrompts !== false;
    const prompts = [];
    const fn = async (prompt, opts) => {
        if (trackPrompts) {
            prompts.push({ prompt, options: opts });
        }
        return response;
    };
    fn.prompts = prompts;
    return fn;
}
/**
 * Create a mock LLM function that throws an error.
 * Useful for testing error handling in agents.
 *
 * @example
 * ```ts
 * const callLLM = createFailingMockLLM(new Error('API rate limit'));
 * await expect(agent.execute(ctx, callLLM)).resolves.toMatchObject({ success: false });
 * ```
 */
export function createFailingMockLLM(error = new Error('Mock LLM error')) {
    return async () => {
        throw error;
    };
}
/**
 * Create a mock LLM function that returns different responses in sequence.
 * Useful for testing agents that need multiple LLM calls.
 *
 * @example
 * ```ts
 * const callLLM = createSequentialMockLLM(['First response', 'Second response']);
 * const r1 = await callLLM('prompt 1'); // 'First response'
 * const r2 = await callLLM('prompt 2'); // 'Second response'
 * ```
 */
export function createSequentialMockLLM(responses) {
    let index = 0;
    return async () => {
        if (index >= responses.length) {
            throw new Error(`Sequential mock exhausted: no more responses (called ${index + 1} times)`);
        }
        return responses[index++];
    };
}
// ─── Test Runner ────────────────────────────────────────────────────────────
/**
 * Execute an agent in a test context and return the result.
 * Automatically calls `validate()` before execution and `cleanup()` after.
 *
 * @example
 * ```ts
 * const result = await runAgentTest(new MyAgent(), context, callLLM);
 * ```
 */
export async function runAgentTest(agent, context, callLLM = createMockLLM()) {
    // Validate
    const validationResult = agent.validate(context);
    if (validationResult !== true) {
        return {
            success: false,
            summary: 'Validation failed',
            error: validationResult,
        };
    }
    // Execute
    let result;
    try {
        result = await agent.execute(context, callLLM);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { success: false, summary: 'Agent threw an error', error: msg };
    }
    finally {
        // Cleanup (runs even if execute throws)
        try {
            agent.cleanup();
        }
        catch {
            // Best-effort cleanup
        }
    }
    return result;
}
// ─── Assertion Helpers ───────────────────────────────────────────────────────
/**
 * Assert that an agent result indicates success.
 * Throws a descriptive error if the result is falsy or has `success: false`.
 *
 * @example
 * ```ts
 * assertAgentSuccess(result);
 * ```
 */
export function assertAgentSuccess(result) {
    if (!result) {
        throw new Error('Expected agent result, but got ' + String(result));
    }
    if (!result.success) {
        const summary = result.summary || '(no summary)';
        const error = result.error ? `\n  Error: ${result.error}` : '';
        throw new Error(`Agent failed unexpectedly: ${summary}${error}`);
    }
}
/**
 * Assert that an agent result indicates failure with an optional error match.
 *
 * @example
 * ```ts
 * assertAgentFailure(result, 'rate limit');
 * ```
 */
export function assertAgentFailure(result, expectedErrorSubstring) {
    if (!result) {
        throw new Error('Expected agent result, but got ' + String(result));
    }
    if (result.success) {
        throw new Error(`Agent succeeded unexpectedly: ${result.summary}`);
    }
    if (expectedErrorSubstring && result.error) {
        if (!result.error.toLowerCase().includes(expectedErrorSubstring.toLowerCase())) {
            throw new Error(`Expected error to contain "${expectedErrorSubstring}", but got: ${result.error}`);
        }
    }
}
// ─── Context Helpers ────────────────────────────────────────────────────────
/**
 * Add a file artifact to a context for testing.
 *
 * @example
 * ```ts
 * addArtifact(ctx, 'src/index.ts', 'console.log("hello")', 'Entry point');
 * ```
 */
export function addArtifact(context, path, content, description) {
    context.artifacts.push({ path, content, description });
}
/**
 * Add a task step to a context's task plan.
 *
 * @example
 * ```ts
 * addTaskStep(ctx, 'step-1', 'writer', 'Write the main file', []);
 * ```
 */
export function addTaskStep(context, id, agentType, description, dependsOn = [], status = 'pending') {
    context.taskPlan.push({ id, description, agentType, dependsOn, status });
}
/**
 * Add a file change to a context.
 *
 * @example
 * ```ts
 * addFileChange(ctx, 'src/index.ts', 'console.log("hello")', undefined, 'created');
 * ```
 */
export function addFileChange(context, path, newContent, originalContent, status = 'modified') {
    context.fileChanges.push({ path, originalContent, newContent, status });
}
//# sourceMappingURL=testing.js.map