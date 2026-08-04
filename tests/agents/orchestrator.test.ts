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
import { ContextVault } from '../../src/agents/context-vault.js';
import type { PickerResult } from '../../src/cli/model-picker.js';
import { logger } from '../../src/utils/logger.js';
import { ProviderFactory } from '../../src/inference/factory.js';
import { ConfigManager } from '../../src/config/manager.js';

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

// Mock ReviewerAgent to avoid real review execution in routing-hints tests
const mockReviewerExecute = vi.hoisted(() => vi.fn());
vi.mock('../../src/agents/agents/reviewer.js', () => ({
  ReviewerAgent: class {
    name = 'Reviewer';
    description = 'Reviews code';
    execute = mockReviewerExecute;
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

describe('Orchestrator — routing-aware planning', () => {
  it('insert a verification step when routing indicates verification-heavy work', () => {
    const orchestrator = new Orchestrator();
    const vault = new ContextVault('Verify a bug fix', '/tmp');
    vault.setTaskPlan([
      { id: 'step-1', description: 'Implement the fix', agentType: 'writer', dependsOn: [], status: 'pending' },
    ]);

    (orchestrator as any).applyRoutingPlanAdjustments(vault, {
      taskProfile: {
        intent: 'verification',
        requiresVerification: true,
        notes: ['Validate the result carefully'],
      },
      explanation: 'Verification-heavy task should include an explicit validation step.',
      escalationApplied: true,
    });

    expect(vault.context.taskPlan).toHaveLength(2);
    expect(vault.context.taskPlan[1].agentType).toBe('reviewer');
    expect(vault.context.taskPlan[1].dependsOn).toEqual(['step-1']);
  });
});

describe('Orchestrator — execution strategy', () => {
  it('should shift writer tasks to reviewer and run serially for verification-heavy routing', () => {
    const orchestrator = new Orchestrator();
    const strategy = (orchestrator as any).getExecutionStrategy(
      { agentType: 'writer', description: 'implement a bug fix' },
      {
        taskProfile: {
          intent: 'verification',
          requiresVerification: true,
        },
      },
    );

    expect(strategy.effectiveAgentType).toBe('reviewer');
    expect(strategy.runSerially).toBe(true);
    expect(strategy.useRepair).toBe(true);
    expect(strategy.followUpAgentType).toBe('reviewer');
  });
});

describe('Orchestrator — routing hints on task plan', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    mockWriterExecute.mockReset();
    mockReviewerExecute.mockReset();
    // Prevent applyFileChanges from writing to disk during writer/debugger steps
    vi.spyOn(orchestrator as any, 'applyFileChanges').mockReturnValue(0);
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

  it('should set routingHints on the executed task plan step', async () => {
    const vault = new ContextVault('Write code', '/tmp');
    vault.setTaskPlan([
      { id: 'step-1', agentType: 'writer', description: 'Write code', dependsOn: [], status: 'pending' as const },
    ]);

    mockWriterExecute.mockImplementation(async (context: any) => {
      context.fileChanges.push({
        path: 'src/test.ts',
        originalContent: 'const x = 1;\n',
        newContent: 'const x = 2;\n',
        status: 'modified',
      });
      return { success: true, summary: 'Wrote code' };
    });

    const mockLLM = vi.fn().mockResolvedValue('mock response');
    const agentResults: any[] = [];

    await (orchestrator as any).executeSingleTask(
      vault.context.taskPlan[0],
      vault,
      {},
      agentResults,
      [],
      mockLLM,
    );

    // The task step in the plan must carry the routing hints the orchestrator computed
    const step = vault.context.taskPlan[0];
    expect(step.routingHints).toBeDefined();
    expect(step.routingHints).toEqual({
      effectiveAgentType: 'writer',
      runSerially: false,
      useRepair: false,
      maxRepairs: 3,
      verificationPass: false,
    });
    expect(agentResults).toHaveLength(1);
    expect(agentResults[0].agent).toBe('writer');
  });

  it('should label every executed task step with a per-subtask complexity bucket', async () => {
    const vault = new ContextVault('Write code', '/tmp');
    vault.setTaskPlan([
      { id: 'step-1', agentType: 'writer', description: 'format this code', dependsOn: [], status: 'pending' as const },
    ]);

    mockWriterExecute.mockImplementation(async () => ({ success: true, summary: 'Wrote code' }));
    const mockLLM = vi.fn().mockResolvedValue('mock response');
    const agentResults: any[] = [];

    await (orchestrator as any).executeSingleTask(
      vault.context.taskPlan[0],
      vault,
      {},
      agentResults,
      [],
      mockLLM,
    );

    // Assessment item #1: every subtask carries a complexity label so Auto
    // routing is subtask-local (cheapest adequate model per step).
    const step = vault.context.taskPlan[0];
    expect(step.complexity).toBeDefined();
    expect(['trivial', 'simple', 'moderate', 'complex', 'critical']).toContain(step.complexity);
    // Deterministic fallback from the step description
    expect(step.complexity).toBe('trivial');
  });

  it('should reflect verification-heavy routing in routingHints (writer → reviewer remap)', async () => {
    const vault = new ContextVault('Verify a fix', '/tmp');
    vault.setTaskPlan([
      { id: 'step-1', agentType: 'writer', description: 'Apply fix', dependsOn: [], status: 'pending' as const },
    ]);
    vault.setMeta('routingContext', {
      taskProfile: { intent: 'verification', requiresVerification: true },
    });

    mockReviewerExecute.mockImplementation(async () => ({ success: true, summary: 'Reviewed' }));
    mockWriterExecute.mockImplementation(async () => ({ success: true, summary: 'unexpected' }));

    const mockLLM = vi.fn().mockResolvedValue('mock response');
    const agentResults: any[] = [];

    await (orchestrator as any).executeSingleTask(
      vault.context.taskPlan[0],
      vault,
      {},
      agentResults,
      [],
      mockLLM,
    );

    const step = vault.context.taskPlan[0];
    expect(step.routingHints).toEqual({
      effectiveAgentType: 'reviewer',
      followUpAgentType: 'reviewer',
      runSerially: true,
      useRepair: true,
      maxRepairs: 4,
      verificationPass: true,
    });
    // The reviewer (not the writer) actually executed
    expect(agentResults[0].agent).toBe('reviewer');
    expect(mockReviewerExecute).toHaveBeenCalledTimes(1);
    expect(mockWriterExecute).not.toHaveBeenCalled();
  });
});

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

// ─── Checkpoint Resume ──────────────────────────────────────────────────────
// Assessment item #6 (continuity): a checkpointed pipeline resumes from the
// first pending step — completed steps are never re-run, the planner is skipped,
// and the resumed run continues with the restored plan.

describe('Orchestrator — checkpoint resume', () => {
  let orchestrator: Orchestrator;
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    tempDir = (require('node:fs') as typeof import('node:fs')).mkdtempSync(
      (require('node:os') as typeof import('node:os')).tmpdir() + '/buff-orch-cp-',
    );
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;

    // Reset mock implementations and call history — mockReset clears both.
    // Using mockReset (not mockClear) prevents cross-test interference where
    // a previous test's mockImplementation leaks into the next test.
    mockWriterExecute.mockReset();
    mockPlannerExecute.mockReset();
    mockReviewerExecute.mockReset();

    // Prevent applyFileChanges from writing to disk during writer steps
    vi.spyOn(orchestrator as any, 'applyFileChanges').mockReturnValue(0);
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
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    (require('node:fs') as typeof import('node:fs')).rmSync(tempDir, { recursive: true, force: true });
  });

  it('resumes a checkpointed plan without re-running completed steps', async () => {
    // Seed a checkpoint: step-1 (context-gatherer) already completed,
    // step-2 (writer) pending with a dependency on step-1.
    const { saveCheckpoint, checkpointIdFor } =
      await import('../../src/agents/checkpoint-store.js');
    const context = {
      goal: 'resume goal',
      workingDirectory: process.cwd(),
      taskPlan: [
        { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] as string[], status: 'completed' as const, result: 'done' },
        { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' as const },
      ],
      artifacts: [] as Array<{ path: string; content: string; description: string }>,
      conversations: [] as Array<{ from: string; to: string; content: string; timestamp: number }>,
      fileChanges: [] as Array<{ path: string; originalContent?: string; newContent?: string; status: string }>,
      metadata: {} as Record<string, unknown>,
    };
    const id = saveCheckpoint(context as any, checkpointIdFor('resume goal', process.cwd()));

    mockWriterExecute.mockImplementation(async (ctx: any) => {
      ctx.fileChanges.push({
        path: 'src/resumed.ts',
        originalContent: '',
        newContent: 'export const ok = true;\n',
        status: 'created',
      });
      return { success: true, summary: 'Wrote resumed.ts' };
    });

    const result = await orchestrator.execute('resume goal', {
      resumeCheckpointId: id,
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    expect(result.success).toBe(true);
    expect(result.tasksCompleted).toBe(2);
    expect(result.tasksTotal).toBe(2);
    // The writer step ran (resumed from pending); the completed step did NOT re-run
    expect(mockWriterExecute).toHaveBeenCalledTimes(1);
    // The planner must NOT run on resume — the plan comes from the checkpoint
    expect(mockPlannerExecute).not.toHaveBeenCalled();
    // Only the pending step produced an agent result
    expect(result.agentResults.some((r) => r.agent === 'writer' && r.success)).toBe(true);
  });

  it('keeps checkpointing forward on a resumed run and persists the completed state', async () => {
    const { saveCheckpoint, checkpointIdFor, loadCheckpoint } =
      await import('../../src/agents/checkpoint-store.js');
    const context = {
      goal: 'forward goal',
      workingDirectory: process.cwd(),
      taskPlan: [
        { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] as string[], status: 'completed' as const, result: 'done' },
        { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' as const },
      ],
      artifacts: [] as Array<{ path: string; content: string; description: string }>,
      conversations: [] as Array<{ from: string; to: string; content: string; timestamp: number }>,
      fileChanges: [] as Array<{ path: string; originalContent?: string; newContent?: string; status: string }>,
      metadata: {} as Record<string, unknown>,
    };
    const id = saveCheckpoint(context as any, checkpointIdFor('forward goal', process.cwd()));

    mockWriterExecute.mockImplementation(async (ctx: any) => {
      ctx.fileChanges.push({
        path: 'src/forwarded.ts',
        originalContent: '',
        newContent: 'export const ok = true;\n',
        status: 'created',
      });
      return { success: true, summary: 'Wrote forwarded.ts' };
    });

    const result = await orchestrator.execute('forward goal', {
      resumeCheckpointId: id,
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    expect(result.success).toBe(true);
    expect(result.tasksCompleted).toBe(2);

    // The resumed run must keep saving checkpoints forward, and the FINAL save
    // must capture the completed state (2/2) — so a later `--resume` after this
    // run won't re-execute the last step.
    const after = loadCheckpoint(id);
    expect(after).not.toBeNull();
    expect(after!.tasksCompleted).toBe(2);
    expect(after!.tasksTotal).toBe(2);
    expect(after!.context.taskPlan.every((s) => s.status === 'completed')).toBe(true);
  });

  it('does NOT resume a stale checkpoint when only --checkpoint is set (no resume intent)', async () => {
    const { saveCheckpoint, checkpointIdFor } =
      await import('../../src/agents/checkpoint-store.js');
    // Seed a COMPLETED checkpoint at the auto id for this goal + cwd
    const context = {
      goal: 'stale goal',
      workingDirectory: process.cwd(),
      taskPlan: [
        { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] as string[], status: 'completed' as const, result: 'done' },
      ],
      artifacts: [] as Array<{ path: string; content: string; description: string }>,
      conversations: [] as Array<{ from: string; to: string; content: string; timestamp: number }>,
      fileChanges: [] as Array<{ path: string; originalContent?: string; newContent?: string; status: string }>,
      metadata: {} as Record<string, unknown>,
    };
    saveCheckpoint(context as any, checkpointIdFor('stale goal', process.cwd()));

    mockPlannerExecute.mockImplementation(async (ctx: any) => {
      ctx.taskPlan = [{
        id: 'step-fresh',
        agentType: 'writer',
        description: 'Write fresh code',
        dependsOn: [],
        status: 'pending' as const,
      }];
      return { success: true, summary: 'planned' };
    });
    mockWriterExecute.mockImplementation(async () => ({ success: true, summary: 'Wrote fresh code' }));

    // --checkpoint only (no resume intent): must START FRESH, not re-enter the
    // stale completed plan (which would skip every task and report success
    // without doing anything).
    const result = await orchestrator.execute('stale goal', {
      checkpoint: true,
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    expect(result.success).toBe(true);
    expect(mockPlannerExecute).toHaveBeenCalledTimes(1);
    expect(mockWriterExecute).toHaveBeenCalledTimes(1);
    expect(result.tasksCompleted).toBe(1);
    expect(result.tasksTotal).toBe(1);
  });

  it('runs a fresh pipeline when the checkpoint id does not exist', async () => {
    mockPlannerExecute.mockImplementation(async () => ({
      success: true,
      summary: 'planned',
    }));
    mockPlannerExecute.mockImplementation(async (context: any) => {
      context.taskPlan = [{
        id: 'step-1',
        agentType: 'writer',
        description: 'Write fresh code',
        dependsOn: [],
        status: 'pending' as const,
      }];
      return { success: true, summary: 'planned' };
    });
    mockWriterExecute.mockImplementation(async (ctx: any) => {
      ctx.fileChanges.push({
        path: 'src/fresh.ts',
        originalContent: '',
        newContent: 'export const fresh = true;\n',
        status: 'created',
      });
      return { success: true, summary: 'Wrote fresh.ts' };
    });

    const result = await orchestrator.execute('fresh goal', {
      resumeCheckpointId: 'cp-does-not-exist',
      provider: 'groq',
      model: 'llama-3.3-70b',
    });

    expect(result.success).toBe(true);
    // Fresh pipeline: planner runs, single writer step executes
    expect(mockPlannerExecute).toHaveBeenCalledTimes(1);
    expect(mockWriterExecute).toHaveBeenCalledTimes(1);
    expect(result.tasksCompleted).toBe(1);
  });
});

// ─── Review Mode Integration ────────────────────────────────────────────────

describe('Orchestrator — review mode integration', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator();

    // Reset mock call tracking AND implementation — mockReset prevents
    // cross-test pollution from other describe blocks.
    mockCreateReviewFromResult.mockReset();
    mockCreateReviewFromResult.mockReturnValue(mockReviewBundle);
    mockWriterExecute.mockReset();

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

// ─── Auto model resolution ──────────────────────────────────────────────────
// Regression tests for the "no auto model" error: when the user selects Auto
// (`-m auto` / `buff model switch auto` / `--auto-route`), a literal 'auto'
// must NEVER reach a real provider API. The orchestrator resolves it via the
// AutoModelRouter (per-task) or the provider's configured model (fallback).

describe('Orchestrator — auto model resolution', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    // Reset module-level mocks that could have leaked from previous describe blocks.
    // mockReset is critical here: the 'review mode integration' describe sets
    // mockWriterExecute.mockImplementation(...) which would leak into auto model
    // resolution tests that do NOT set their own implementation.
    mockWriterExecute.mockReset();
    mockPlannerExecute.mockReset();
    mockReviewerExecute.mockReset();
    mockCreateReviewFromResult.mockReset();
    mockCreateReviewFromResult.mockReturnValue(mockReviewBundle);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Local copy of the rate-limit handler helper (scoped to its own describe). */
  function getHandler(
    options: OrchestratorOptions = {},
    model?: string,
  ): OnRateLimit | undefined {
    return (orchestrator as any).createRateLimitHandler.call(orchestrator, options, model);
  }

  const autoSingleWriterPlan = [{
    id: 'step-auto',
    agentType: 'writer',
    description: 'Write test file',
    dependsOn: [],
    status: 'pending' as const,
  }];

  it('should never pass model "auto" to the provider API from createLLMProvider', async () => {
    const cm = new ConfigManager();
    const orch = new Orchestrator(cm);

    // Replace the real provider with a fake that records generate() options
    const generate = vi.fn().mockResolvedValue('mock response');
    const fakeProvider = {
      name: 'Fake',
      generate,
      isAvailable: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      generateStream: vi.fn(),
      getInfo: vi.fn().mockReturnValue('fake'),
    };
    vi.spyOn(ProviderFactory, 'createProvider').mockReturnValue(fakeProvider as any);

    const callLLM = (orch as any).createLLMProvider({ provider: 'local', model: 'auto' });
    await callLLM('Write a function to sort an array');

    expect(generate).toHaveBeenCalledTimes(1);
    const options = generate.mock.calls[0][1];
    expect(options.model).not.toBe('auto');
    // Falls back to the provider's configured model (local default is 'llama2')
    expect(options.model).toBe('llama2');
  });

  it('should never pass provider "auto" to ProviderFactory when createLLMProvider is called', async () => {
    const cm = new ConfigManager();
    const orch = new Orchestrator(cm);

    const createSpy = vi.spyOn(ProviderFactory, 'createProvider');
    // createLLMProvider resolves provider 'auto' to the configured default
    (orch as any).createLLMProvider({ provider: 'auto', model: 'llama3' });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).not.toBe('auto');
    // Should resolve to the actual configured default provider
    expect(createSpy.mock.calls[0][0]).toBe(cm.getAll().defaultProvider);
  });

  it('should auto-route the planner/default LLM when model is auto', async () => {
    const cm = new ConfigManager();
    const orch = new Orchestrator(cm);

    // Route through the AutoModelRouter (never hand 'auto' to a real API)
    const autoRouteSpy = vi
      .spyOn(orch as any, 'createAutoRoutedLLM')
      .mockReturnValue(async () => 'routed');
    // Prevent writes to disk from the writer mock
    vi.spyOn(orch as any, 'applyFileChanges').mockReturnValue(0);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'debug').mockImplementation(() => {});

    mockWriterExecute.mockImplementation(async (context: any) => {
      context.fileChanges.push({
        path: 'src/test.ts',
        originalContent: 'const x = 1;\n',
        newContent: 'const x = 2;\n',
        status: 'modified',
      });
      return { success: true, summary: 'Modified test.ts' };
    });

    const result = await orch.execute('test goal', {
      provider: 'auto',
      model: 'auto',
      prefillPlan: autoSingleWriterPlan,
    });

    expect(result.success).toBe(true);
    // The planner/default LLM must be routed via the AutoModelRouter
    expect(autoRouteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'planner' }),
      expect.objectContaining({ provider: 'auto', model: 'auto' }),
    );
  });

  it('should route via createAutoRoutedLLM when auto is picked in rate-limit switch', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'switch-model' });
    mockShowModelPicker.mockResolvedValue({
      provider: 'auto',
      model: 'auto',
    } as PickerResult);

    const autoRouteSpy = vi
      .spyOn(orchestrator as any, 'createAutoRoutedLLM')
      .mockReturnValue(async () => 'routed');
    const createSpy = vi.spyOn(orchestrator as any, 'createLLMProvider');

    const handler = getHandler({ provider: 'groq' })!;
    const result = await handler(makeRateLimitInfo());

    expect(result.action).toBe('switch-model');
    expect(typeof (result as any).callLLM).toBe('function');
    // Auto pick → routed via router, NOT handed as literal 'auto' to createLLMProvider
    expect(autoRouteSpy).toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'auto', model: 'auto' }),
    );
  });
});
