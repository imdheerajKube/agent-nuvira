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

import type {
  AgentContext,
  AgentResult,
  Artifact,
  FileChange,
  InferenceOptions,
  LLMCallFn,
  TaskStep,
  TaskStatus,
  AgentMessage,
} from './types.js';
import type { Agent } from './agent.js';

// ─── Mock Context Builder ───────────────────────────────────────────────────

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
export function createMockContext(options: MockContextOptions = {}): AgentContext {
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

// ─── Mock LLM Factory ───────────────────────────────────────────────────────

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
export function createMockLLM(
  response: string = '',
  options: MockLLMOptions = {},
): LLMCallFn & { prompts: Array<{ prompt: string; options?: InferenceOptions }> } {
  const trackPrompts = options.trackPrompts !== false;
  const prompts: Array<{ prompt: string; options?: InferenceOptions }> = [];

  const fn = async (prompt: string, opts?: InferenceOptions): Promise<string> => {
    if (trackPrompts) {
      prompts.push({ prompt, options: opts });
    }
    return response;
  };

  fn.prompts = prompts;
  return fn as typeof fn & { prompts: typeof prompts };
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
export function createFailingMockLLM(error: Error = new Error('Mock LLM error')): LLMCallFn {
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
export function createSequentialMockLLM(responses: string[]): LLMCallFn {
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
export async function runAgentTest(
  agent: Agent,
  context: AgentContext,
  callLLM: LLMCallFn = createMockLLM(),
): Promise<AgentResult> {
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
  let result: AgentResult;
  try {
    result = await agent.execute(context, callLLM);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = { success: false, summary: 'Agent threw an error', error: msg };
  } finally {
    // Cleanup (runs even if execute throws)
    try {
      agent.cleanup();
    } catch {
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
export function assertAgentSuccess(result: AgentResult): asserts result is AgentResult & { success: true } {
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
export function assertAgentFailure(
  result: AgentResult,
  expectedErrorSubstring?: string,
): asserts result is AgentResult & { success: false } {
  if (!result) {
    throw new Error('Expected agent result, but got ' + String(result));
  }
  if (result.success) {
    throw new Error(`Agent succeeded unexpectedly: ${result.summary}`);
  }
  if (expectedErrorSubstring && result.error) {
    if (!result.error.toLowerCase().includes(expectedErrorSubstring.toLowerCase())) {
      throw new Error(
        `Expected error to contain "${expectedErrorSubstring}", but got: ${result.error}`,
      );
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
export function addArtifact(
  context: AgentContext,
  path: string,
  content: string,
  description: string,
): void {
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
export function addTaskStep(
  context: AgentContext,
  id: string,
  agentType: string,
  description: string,
  dependsOn: string[] = [],
  status: TaskStatus = 'pending',
): void {
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
export function addFileChange(
  context: AgentContext,
  path: string,
  newContent: string,
  originalContent?: string,
  status: FileChange['status'] = 'modified',
): void {
  context.fileChanges.push({ path, originalContent, newContent, status });
}
