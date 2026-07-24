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
import type { AgentContext, AgentResult, Artifact, FileChange, InferenceOptions, LLMCallFn, TaskStep, TaskStatus, AgentMessage } from './types.js';
import type { Agent } from './agent.js';
/** Options for building a mock context via {@link createMockContext} */
export interface MockContextOptions {
    /** The user goal / task description (default: "Test goal") */
    goal?: string;
    /** Working directory (default: process.cwd()) */
    workingDirectory?: string;
    /** Pre-populated task plan (default: empty) */
    taskPlan?: TaskStep[];
    /** Pre-populated file artifacts (default: empty) */
    artifacts?: Artifact[];
    /** Pre-populated file changes (default: empty) */
    fileChanges?: FileChange[];
    /** Pre-populated agent messages (default: empty) */
    conversations?: AgentMessage[];
    /** Additional metadata key-value pairs (default: {}) */
    metadata?: Record<string, unknown>;
    /** Whether to set up an onRateLimit callback (default: undefined — not set) */
    onRateLimit?: boolean;
}
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
export declare function createMockContext(options?: MockContextOptions): AgentContext;
/** Options for {@link createMockLLM} */
export interface MockLLMOptions {
    /**
     * If true, the mock will track all prompts received.
     * Access them via the returned array's `.prompts` property.
     * @default true
     */
    trackPrompts?: boolean;
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
export declare function createMockLLM(response?: string, options?: MockLLMOptions): LLMCallFn & {
    prompts: Array<{
        prompt: string;
        options?: InferenceOptions;
    }>;
};
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
export declare function createFailingMockLLM(error?: Error): LLMCallFn;
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
export declare function createSequentialMockLLM(responses: string[]): LLMCallFn;
/**
 * Execute an agent in a test context and return the result.
 * Automatically calls `validate()` before execution and `cleanup()` after.
 *
 * @example
 * ```ts
 * const result = await runAgentTest(new MyAgent(), context, callLLM);
 * ```
 */
export declare function runAgentTest(agent: Agent, context: AgentContext, callLLM?: LLMCallFn): Promise<AgentResult>;
/**
 * Assert that an agent result indicates success.
 * Throws a descriptive error if the result is falsy or has `success: false`.
 *
 * @example
 * ```ts
 * assertAgentSuccess(result);
 * ```
 */
export declare function assertAgentSuccess(result: AgentResult): asserts result is AgentResult & {
    success: true;
};
/**
 * Assert that an agent result indicates failure with an optional error match.
 *
 * @example
 * ```ts
 * assertAgentFailure(result, 'rate limit');
 * ```
 */
export declare function assertAgentFailure(result: AgentResult, expectedErrorSubstring?: string): asserts result is AgentResult & {
    success: false;
};
/**
 * Add a file artifact to a context for testing.
 *
 * @example
 * ```ts
 * addArtifact(ctx, 'src/index.ts', 'console.log("hello")', 'Entry point');
 * ```
 */
export declare function addArtifact(context: AgentContext, path: string, content: string, description: string): void;
/**
 * Add a task step to a context's task plan.
 *
 * @example
 * ```ts
 * addTaskStep(ctx, 'step-1', 'writer', 'Write the main file', []);
 * ```
 */
export declare function addTaskStep(context: AgentContext, id: string, agentType: string, description: string, dependsOn?: string[], status?: TaskStatus): void;
/**
 * Add a file change to a context.
 *
 * @example
 * ```ts
 * addFileChange(ctx, 'src/index.ts', 'console.log("hello")', undefined, 'created');
 * ```
 */
export declare function addFileChange(context: AgentContext, path: string, newContent: string, originalContent?: string, status?: FileChange['status']): void;
//# sourceMappingURL=testing.d.ts.map