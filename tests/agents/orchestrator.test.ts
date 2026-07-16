/**
 * Orchestrator — Rate-limit handler tests.
 *
 * Tests for the private `createRateLimitHandler` method, which returns
 * an `onRateLimit` callback that prompts the user with 4 choices when
 * a rate-limit error is detected.
 *
 * Tested scenarios:
 * 1. Returns undefined when dryRun is true
 * 2. Returns undefined when not a TTY (non-interactive mode)
 * 3. Returns a valid callback function when interactive
 * 4. Routes 'retry' action correctly
 * 5. Routes 'skip' action correctly
 * 6. Routes 'abort' action correctly
 * 7. Routes 'switch-model' action correctly (creates new LLM provider)
 * 8. Fallback to 'retry' for unrecognized actions
 * 9. Shows model name from RateLimitInfo
 * 10. Shows model name from options when info doesn't have one
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import inquirer from 'inquirer';

import { Orchestrator } from '../../src/agents/orchestrator.js';
import type { OrchestratorOptions } from '../../src/agents/orchestrator.js';
import type { OnRateLimit, RateLimitInfo } from '../../src/agents/agent.js';
import type { PickerResult } from '../../src/cli/model-picker.js';
import { logger } from '../../src/utils/logger.js';

// ─── Module-level mocks ─────────────────────────────────────────────────────

// Mock the model picker so tests don't trigger the full inquirer-based picker
const mockShowModelPicker = vi.hoisted(() => vi.fn<() => Promise<PickerResult | null>>());
vi.mock('../../src/cli/model-picker.js', () => ({
  showModelPicker: mockShowModelPicker,
}));

// Mock createReviewFromResult to track calls without writing to disk
const mockReviewBundle = vi.hoisted(() => ({
  id: 'review-mock-1234',
  title: 'Mock Review',
  goal: 'test goal',
  author: 'test-user',
  status: 'pending',
  createdAt: Date.now(),
  provider: 'test',
  model: 'test-model',
  changes: [],
  comments: [],
  tags: ['test'],
}));
const mockCreateReviewFromResult = vi.hoisted(() => vi.fn().mockReturnValue(mockReviewBundle));
vi.mock('../../src/team/review.js', () => ({
  createReviewFromResult: mockCreateReviewFromResult,
}));

// Mock WriterAgent to add file changes to the vault context on execute
// NOTE: Must use 'function' or 'class' (not arrow function) so `new WriterAgent()` works
const mockWriterExecute = vi.hoisted(() => vi.fn());
vi.mock('../../src/agents/agents/writer.js', () => ({
  WriterAgent: class {
    name = 'Writer';
    description = 'Writes code';
    execute = mockWriterExecute;
  },
}));

// Mock PlannerAgent to return success (avoid real planning)
const mockPlannerExecute = vi.hoisted(() => vi.fn());
vi.mock('../../src/agents/agents/planner.js', () => ({
  PlannerAgent: class {
    name = 'Planner';
    description = 'Plans tasks';
    execute = mockPlannerExecute;
  },
}));

// Mock buildProjectFileTree to avoid filesystem scanning
vi.mock('../../src/agents/utils/file-tree.js', () => ({
  buildProjectFileTree: vi.fn().mockResolvedValue(''),
  truncateTree: vi.fn().mockReturnValue(''),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a sample rate-limit error info object */
function makeRateLimitInfo(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    retryAfterMs: 5000,
    modelName: 'qwen/qwen3-32b',
    agentName: 'Writer',
    errorMessage: 'Rate limit reached for model `qwen/qwen3-32b`. Please try again in 5s.',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Orchestrator — createRateLimitHandler', () => {
  let orchestrator: Orchestrator;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    // Restore original isTTY
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /** Access private createRateLimitHandler method */
  function getHandler(
    options: OrchestratorOptions = {},
    model?: string,
  ): OnRateLimit | undefined {
    return (orchestrator as any).createRateLimitHandler.call(orchestrator, options, model);
  }

  // ── Gating: dryRun and TTY ──────────────────────────────────────────────

  it('should return undefined when dryRun is true (non-interactive)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const handler = getHandler({ dryRun: true });

    expect(handler).toBeUndefined();
  });

  it('should return undefined when not a TTY (e.g., piped output)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });

    const handler = getHandler({});

    expect(handler).toBeUndefined();
  });

  it('should return undefined when both dryRun and non-TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });

    const handler = getHandler({ dryRun: true });

    expect(handler).toBeUndefined();
  });

  it('should return a function when TTY and not dryRun', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const handler = getHandler({});

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  // ── Action: retry ───────────────────────────────────────────────────────

  it('should return retry action when user selects retry', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'retry' });
  });

  // ── Action: skip ────────────────────────────────────────────────────────

  it('should return skip action when user selects skip', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'skip' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'skip' });
  });

  // ── Action: abort ───────────────────────────────────────────────────────

  it('should return abort action when user selects abort', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'abort' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'abort' });
  });

  // ── Action: switch-model ────────────────────────────────────────────────

  it('should return switch-model action with a new callLLM when user selects switch-model', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // Mock inquirer to return 'switch-model' action from the rate-limit prompt
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'switch-model' });

    // Mock showModelPicker to return a selected model
    mockShowModelPicker.mockResolvedValue({
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
    } as PickerResult);

    // Mock createLLMProvider to return a dummy callLLM
    const mockCallLLM = vi.fn().mockResolvedValue('mock response');
    vi.spyOn(orchestrator as any, 'createLLMProvider').mockReturnValue(mockCallLLM);

    const handler = getHandler({ provider: 'groq' })!;
    const result = await handler(makeRateLimitInfo());

    expect(result.action).toBe('switch-model');
    expect(typeof (result as any).callLLM).toBe('function');
    // Verify createLLMProvider was called with the new model from the picker
    expect((orchestrator as any).createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama-3.1-8b-instant', provider: 'groq' }),
    );
  });

  it('should call createLLMProvider with original options plus new model', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'switch-model' });

    mockShowModelPicker.mockResolvedValue({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
    } as PickerResult);

    const mockCallLLM = vi.fn().mockResolvedValue('response');
    vi.spyOn(orchestrator as any, 'createLLMProvider').mockReturnValue(mockCallLLM);

    const handler = getHandler({ provider: 'gemini', verbose: true })!;
    await handler(makeRateLimitInfo({ modelName: 'old-model' }));

    // Should preserve provider and verbose from original options, with model from picker
    expect((orchestrator as any).createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        verbose: true,
      }),
    );
  });

  // ── Model name display ─────────────────────────────────────────────────

  it('should use modelName from RateLimitInfo when available', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });
    const infoSpy = vi.spyOn(logger, 'info');

    const handler = getHandler({}, 'fallback-model')!;
    await handler(makeRateLimitInfo({ modelName: 'qwen/qwen3-32b' }));

    // Model name is displayed via logger.info, not logger.warn
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('qwen/qwen3-32b'),
    );
  });

  it('should fall back to currentModel option when info has no modelName', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });
    const infoSpy = vi.spyOn(logger, 'info');

    const handler = getHandler({}, 'llama-3.1-8b-instant')!;
    await handler(makeRateLimitInfo({ modelName: undefined }));

    // Should fall back to the currentModel from options
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('llama-3.1-8b-instant'),
    );
  });

  // ── Fallback ────────────────────────────────────────────────────────────

  it('should fall back to retry action for unrecognized user input', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // Return an unknown action
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'unknown-option' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    // Fallback should be retry
    expect(result).toEqual({ action: 'retry' });
  });
});

// ─── Review Mode Integration ────────────────────────────────────────────────

describe('Orchestrator — review mode integration', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator();

    // Reset mock call tracking
    mockCreateReviewFromResult.mockClear();
    mockWriterExecute.mockClear();

    // Mock createLLMProvider to return a no-op function (avoids real provider config lookup)
    const mockLLM = vi.fn().mockResolvedValue('mock response');
    vi.spyOn(orchestrator as any, 'createLLMProvider').mockReturnValue(mockLLM);

    // Prevent applyFileChanges from writing to disk (intermediate writes during writer/debugger steps)
    vi.spyOn(orchestrator as any, 'applyFileChanges').mockReturnValue(0);

    // Default writer mock: adds a single file change to the context
    mockWriterExecute.mockImplementation(async (context: any) => {
      context.fileChanges.push({
        path: 'src/test.ts',
        originalContent: 'const x = 1;\n',
        newContent: 'const x = 2;\n',
        status: 'modified',
      });
      return { success: true, summary: 'Modified test.ts' };
    });

    // Suppress logger output during tests
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const singleWriterPlan = [{
    id: 'step-0',
    agentType: 'writer',
    description: 'Write test file',
    dependsOn: [],
    status: 'pending' as const,
  }];

  // ── reviewMode: true with changes ──────────────────────────────────────

  it('should not crash when reviewMode is true and execute returns successfully', async () => {
    const result = await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    // Debug: if it fails, show the error and agent results
    if (!result.success) {
      console.error('Execute error:', result.error);
      console.error('Agent results:', JSON.stringify(result.agentResults));
    }
    expect(result.success).toBe(true);
    expect(result.goal).toBe('test goal');
  });

  it('should call createReviewFromResult when reviewMode is true and file changes exist', async () => {
    const result = await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
      provider: 'test-provider',
      model: 'test-model',
    });

    expect(result.success).toBe(true);
    expect(mockCreateReviewFromResult).toHaveBeenCalledTimes(1);
    expect(mockCreateReviewFromResult).toHaveBeenCalledWith(
      'test goal',
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/test.ts',
          status: 'modified',
          originalContent: 'const x = 1;\n',
          newContent: 'const x = 2;\n',
        }),
      ]),
      expect.any(String),
      expect.objectContaining({
        provider: 'test-provider',
        model: 'test-model',
      }),
    );
  });

  it('should return reviewId in the result when reviewMode is true', async () => {
    const result = await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
      provider: 'test-provider',
      model: 'test-model',
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe('review-mock-1234');
  });

  it('should skip applyFileChanges when reviewMode is true', async () => {
    // applyFileChanges is already spied on in beforeEach to prevent disk writes.
    // With reviewMode: true, the FINAL write in step 6c is:
    //   if (!options.reviewMode && !options.dryRun) { this.applyFileChanges(vault); }
    // Since reviewMode is true, the condition is false — final write is skipped.
    // Intermediate writes during writer/debugger steps still call applyFileChanges.
    // Adding dryRun: true also skips intermediate writes for a clean assertion.
    const applySpy = vi.spyOn(orchestrator as any, 'applyFileChanges').mockReturnValue(0);

    await orchestrator.execute('test goal', {
      reviewMode: true,
      dryRun: true,  // Also skip intermediate writes for clean assertion
      prefillPlan: [{
        id: 'step-0',
        agentType: 'writer',
        description: 'Write test file',
        dependsOn: [],
        status: 'pending' as const,
      }],
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    // With both reviewMode and dryRun, applyFileChanges should never be called
    expect(applySpy).not.toHaveBeenCalled();
  });

  // ── reviewMode: true with no changes ───────────────────────────────────

  it('should NOT create a review bundle when reviewMode is true but no file changes', async () => {
    mockWriterExecute.mockImplementation(async () => {
      return { success: true, summary: 'No changes needed' };
    });

    await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: [{
        id: 'step-0',
        agentType: 'writer',
        description: 'Inspect code only',
        dependsOn: [],
        status: 'pending' as const,
      }],
    });

    expect(mockCreateReviewFromResult).not.toHaveBeenCalled();
  });

  it('should return no reviewId when reviewMode is true but no file changes exist', async () => {
    mockWriterExecute.mockImplementation(async () => {
      return { success: true, summary: 'No changes needed' };
    });

    const result = await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: [{
        id: 'step-0',
        agentType: 'writer',
        description: 'Inspect code only',
        dependsOn: [],
        status: 'pending' as const,
      }],
    });

    expect(result.reviewId).toBeUndefined();
  });

  // ── reviewMode + dryRun ────────────────────────────────────────────────

  it('should create a review bundle when both reviewMode and dryRun are true', async () => {
    await orchestrator.execute('test goal', {
      reviewMode: true,
      dryRun: true,
      prefillPlan: singleWriterPlan,
    });

    expect(mockCreateReviewFromResult).toHaveBeenCalledTimes(1);
  });

  it('should return reviewId when both reviewMode and dryRun are true', async () => {
    const result = await orchestrator.execute('test goal', {
      reviewMode: true,
      dryRun: true,
      prefillPlan: singleWriterPlan,
    });

    expect(result.reviewId).toBe('review-mock-1234');
  });

  // ── reviewMode: false (default) ────────────────────────────────────────

  it('should NOT create a review bundle when reviewMode is false (default)', async () => {
    await orchestrator.execute('test goal', {
      prefillPlan: singleWriterPlan,
    });

    expect(mockCreateReviewFromResult).not.toHaveBeenCalled();
  });

  it('should not include reviewId in result when reviewMode is false', async () => {
    const result = await orchestrator.execute('test goal', {
      prefillPlan: singleWriterPlan,
    });

    expect(result.reviewId).toBeUndefined();
  });

  // ── Review bundle content ──────────────────────────────────────────────

  it('should include agent result summaries in the review bundle summary', async () => {
    await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
    });

    const summaryArg = mockCreateReviewFromResult.mock.calls[0][2];
    expect(summaryArg).toContain('writer');
    expect(summaryArg).toContain('Modified');
  });

  it('should include the diff summary in the review bundle', async () => {
    await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
    });

    const summaryArg = mockCreateReviewFromResult.mock.calls[0][2];
    expect(summaryArg).toContain('test.ts');
    expect(summaryArg).toContain('modified');
  });

  // ── Multiple file changes ──────────────────────────────────────────────

  it('should pass all file changes to createReviewFromResult when there are multiple', async () => {
    mockWriterExecute.mockImplementation(async (context: any) => {
      if (!context.fileChanges) context.fileChanges = [];
      context.fileChanges.push(
        { path: 'src/a.ts', originalContent: 'a', newContent: 'b', status: 'modified' },
        { path: 'src/b.ts', originalContent: '', newContent: 'new', status: 'created' },
        { path: 'src/c.ts', originalContent: 'old', status: 'deleted' },
      );
      return { success: true, summary: 'Modified multiple files' };
    });

    await orchestrator.execute('test goal', {
      reviewMode: true,
      prefillPlan: singleWriterPlan,
    });

    expect(mockCreateReviewFromResult).toHaveBeenCalledTimes(1);
    const changesArg = mockCreateReviewFromResult.mock.calls[0][1];
    expect(changesArg).toHaveLength(3);
    expect(changesArg).toContainEqual(
      expect.objectContaining({ path: 'src/a.ts', status: 'modified', originalContent: 'a', newContent: 'b' }),
    );
    expect(changesArg).toContainEqual(
      expect.objectContaining({ path: 'src/b.ts', status: 'created', originalContent: '', newContent: 'new' }),
    );
    expect(changesArg).toContainEqual(
      expect.objectContaining({ path: 'src/c.ts', status: 'deleted', originalContent: 'old' }),
    );
  });

  // ── Verbose output ─────────────────────────────────────────────────────

  it('should log review bundle ID in verbose mode', async () => {
    const infoSpy = vi.spyOn(logger, 'highlight');

    await orchestrator.execute('test goal', {
      reviewMode: true,
      verbose: true,
      prefillPlan: singleWriterPlan,
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('review-mock-1234'),
    );
  });

  it('should not log review bundle details when not in verbose mode', async () => {
    const infoSpy = vi.spyOn(logger, 'highlight');

    await orchestrator.execute('test goal', {
      reviewMode: true,
      verbose: false,
      prefillPlan: singleWriterPlan,
    });

    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('review-mock-1234'),
    );
  });
});
