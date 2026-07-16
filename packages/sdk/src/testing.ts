/**
 * @agent-nuvira/sdk/testing — Testing utilities for building and testing custom agents.
 *
 * Provides:
 * - `MockLLM` — A callable that returns canned responses for predictable testing
 * - `createTestContext` — Creates a minimal AgentContext for unit tests
 * - `createMockCallLLM` — Creates an LLMCallFn that returns predefined responses
 * - `assertAgentResult` — Asserts common patterns on AgentResult
 *
 * ## Usage
 *
 * ```ts
 * import { describe, it, expect } from 'vitest';
 * import { createTestContext, createMockCallLLM, assertAgentResult } from '@agent-nuvira/sdk/testing';
 * import { MyAgent } from '../src/my-agent.js';
 *
 * describe('MyAgent', () => {
 *   it('should return success', async () => {
 *     const agent = new MyAgent();
 *     const context = createTestContext('Write a poem');
 *     const callLLM = createMockCallLLM('Some response');
 *
 *     const result = await agent.execute(context, callLLM);
 *     assertAgentResult(result);
 *     expect(result.summary).toContain('success');
 *   });
 * });
 * ```
 */

import type { AgentContext, AgentResult, LLMCallFn, FileChange, InferenceOptions } from './agent.js';

// ─── Mock LLM ───────────────────────────────────────────────────────────────

/**
 * Configuration for a mock LLM call function.
 */
export interface MockLLMConfig {
  /** The response to return for all calls */
  defaultResponse?: string;
  /** Map of prompt substrings to specific responses (matched in order) */
  promptMappings?: Array<{ match: string; response: string }>;
  /** If true, records all prompts received for later inspection */
  recordPrompts?: boolean;
  /** Simulate a delay before returning (ms) */
  delayMs?: number;
  /** If set, reject with this error instead of returning a response */
  rejectWith?: string;
}

/**
 * A mock LLM call function for testing agents.
 *
 * @example
 * ```ts
 * const llm = new MockLLM({ defaultResponse: 'Hello, world!' });
 * const result = await llm('Write something');
 * console.log(result); // 'Hello, world!'
 * console.log(llm.prompts); // ['Write something']
 * ```
 */
export class MockLLM {
  /** All prompts received (only if recordPrompts is enabled) */
  readonly prompts: string[] = [];
  private config: MockLLMConfig;

  constructor(config: MockLLMConfig = {}) {
    this.config = {
      defaultResponse: '',
      ...config,
    };
  }

  /**
   * Call the mock LLM. Returns a promise that resolves to the configured response.
   */
  async call(prompt: string, _options?: InferenceOptions): Promise<string> {
    if (this.config.recordPrompts) {
      this.prompts.push(prompt);
    }

    if (this.config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    if (this.config.rejectWith) {
      throw new Error(this.config.rejectWith);
    }

    // Check prompt mappings in order
    if (this.config.promptMappings) {
      for (const mapping of this.config.promptMappings) {
        if (prompt.toLowerCase().includes(mapping.match.toLowerCase())) {
          return mapping.response;
        }
      }
    }

    return this.config.defaultResponse ?? '';
  }

  /**
   * Clear the recorded prompts.
   */
  clear(): void {
    this.prompts.length = 0;
  }

  /**
   * Get the number of times call() was invoked.
   */
  get callCount(): number {
    return this.prompts.length;
  }

  /**
   * Reset the mock (clears prompts and resets config).
   */
  reset(config?: MockLLMConfig): void {
    this.prompts.length = 0;
    if (config) {
      this.config = { defaultResponse: '', ...config };
    }
  }
}

// ─── Context Utilities ──────────────────────────────────────────────────────

/**
 * Create a minimal AgentContext for unit testing agents.
 *
 * @param goal - The user goal (default: 'Test goal')
 * @param workingDirectory - Working directory (default: process.cwd())
 * @returns A minimal AgentContext
 *
 * @example
 * ```ts
 * const ctx = createTestContext('Refactor the auth module');
 * ctx.artifacts.push({ path: 'auth.ts', content: '...', description: 'Auth file' });
 * ```
 */
export function createTestContext(
  goal: string = 'Test goal',
  workingDirectory: string = process.cwd(),
): AgentContext {
  return {
    goal,
    workingDirectory,
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  };
}

/**
 * Create an LLMCallFn that returns predefined responses.
 * Useful for quick inline testing without creating a MockLLM instance.
 *
 * @param response - The response to return (or a function that generates it)
 * @returns An LLMCallFn
 *
 * @example
 * ```ts
 * const callLLM = createMockCallLLM('Mock response');
 * const result = await callLLM('Write code');
 * ```
 */
export function createMockCallLLM(
  response: string | ((prompt: string) => string | Promise<string>),
): LLMCallFn {
  return async (prompt: string) => {
    if (typeof response === 'function') {
      return await (response as (p: string) => string | Promise<string>)(prompt);
    }
    return response;
  };
}

/**
 * Create an LLMCallFn that rejects with an error.
 * Useful for testing error-handling paths in agents.
 *
 * @param errorMessage - The error message to reject with
 * @returns An LLMCallFn that always rejects
 *
 * @example
 * ```ts
 * const callLLM = createFailingCallLLM('API rate limited');
 * await expect(callLLM('anything')).rejects.toThrow('API rate limited');
 * ```
 */
export function createFailingCallLLM(errorMessage: string): LLMCallFn {
  return async () => {
    throw new Error(errorMessage);
  };
}

// ─── Assertion Utilities ────────────────────────────────────────────────────

/**
 * Assert that an AgentResult has the expected shape.
 * Throws with a descriptive message on failure.
 *
 * @param result - The AgentResult to check
 * @param expectedSuccess - Expected success value (default: true)
 *
 * @example
 * ```ts
 * assertAgentResult(result);
 * assertAgentResult(result, false); // Expect failure
 * ```
 */
export function assertAgentResult(
  result: AgentResult,
  expectedSuccess: boolean = true,
): void {
  if (typeof result !== 'object' || result === null) {
    throw new Error(`Expected AgentResult object, got ${typeof result}`);
  }

  if (typeof result.success !== 'boolean') {
    throw new Error(
      `Expected result.success to be boolean, got ${typeof result.success}`,
    );
  }

  if (result.success !== expectedSuccess) {
    const actualStr = result.success ? 'success' : 'failure';
    const expectedStr = expectedSuccess ? 'success' : 'failure';
    const errorSuffix = result.error ? ` Error: ${result.error}` : '';
    throw new Error(
      `Expected result to be ${expectedStr}, but it was ${actualStr}.${errorSuffix}`,
    );
  }

  if (typeof result.summary !== 'string' || result.summary.length === 0) {
    throw new Error('Expected result.summary to be a non-empty string');
  }

  if (result.details !== undefined && typeof result.details !== 'string') {
    throw new Error(`Expected result.details to be a string, got ${typeof result.details}`);
  }

  if (result.error !== undefined && typeof result.error !== 'string') {
    throw new Error(`Expected result.error to be a string, got ${typeof result.error}`);
  }
}

/**
 * Create a mock AgentResult for testing orchestrators or higher-level logic.
 *
 * @param overrides - Partial result to override defaults
 * @returns A complete AgentResult
 *
 * @example
 * ```ts
 * const result = createMockResult({ summary: 'Modified 2 files' });
 * ```
 */
export function createMockResult(
  overrides: Partial<AgentResult> = {},
): AgentResult {
  return {
    success: true,
    summary: 'Mock execution completed',
    details: 'This is a mock result for testing',
    ...overrides,
  };
}

// ─── File Change Utilities ──────────────────────────────────────────────────

/**
 * Add a file change to an AgentContext.
 *
 * @param context - The context to add the change to
 * @param path - File path
 * @param content - New file content
 * @param status - Change status (default: 'created')
 *
 * @example
 * ```ts
 * const ctx = createTestContext();
 * addFileChange(ctx, 'src/hello.ts', 'export const greet = () => "Hello";');
 * ```
 */
export function addFileChange(
  context: AgentContext,
  path: string,
  content: string,
  status: 'created' | 'modified' | 'deleted' = 'created',
): void {
  const existingIndex = context.fileChanges.findIndex((c) => c.path === path);    const change: FileChange = { path, newContent: content, status };

    if (existingIndex >= 0) {
      context.fileChanges[existingIndex] = change;
    } else {
      context.fileChanges.push(change);
    }
}

/**
 * Get a summary of file changes from a context, suitable for assertions.
 *
 * @param context - The context to summarize
 * @returns An array of change descriptions
 *
 * @example
 * ```ts
 * const changes = getFileChangeSummary(ctx);
 * expect(changes).toContain('📄 src/hello.ts (created)');
 * ```
 */
export function getFileChangeSummary(context: AgentContext): string[] {
  return context.fileChanges.map(
    (c) => {
      const icon =
        c.status === 'created' ? '📄' : c.status === 'deleted' ? '🗑️' : '✏️';
      return `${icon} ${c.path} (${c.status})`;
    },
  );
}
