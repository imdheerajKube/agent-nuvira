/**
 * Chat command — runDeveloperMode auto-resolution tests.
 *
 * Regression tests for the "auto overwrites my selected model" bug:
 * when the active provider/model is `auto`, developer mode must resolve
 * a concrete provider/model via the AutoModelRouter BEFORE handing it
 * to the orchestrator — never a literal 'auto'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDeveloperMode } from '../../src/cli/chat.js';
import { ConfigManager } from '../../src/config/manager.js';
import { logger } from '../../src/utils/logger.js';
import type { InferenceProvider } from '../../src/inference/interface.js';
import { resetModelRegistry } from '../../src/learning/model-registry.js';

// ─── Model-health mock ──────────────────────────────────────────────────────
// Simulates a provider whose pinned model is GONE (like the user's
// gemini-2.0-flash-exp → 404) while other models still work. The auto path
// must repair to a verified-working model.
const mockListModels = vi.hoisted(() => vi.fn().mockResolvedValue([
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', tags: ['chat'] },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', tags: ['chat'] },
]));
const mockFakeProvider = vi.hoisted(() => ({
  name: 'Fake Gemini',
  listModels: mockListModels,
  isAvailable: vi.fn().mockResolvedValue(true),
  generate: vi.fn().mockResolvedValue('ok'),
  getInfo: () => 'Fake Gemini',
} as unknown as InferenceProvider));

// Mock the router so runDeveloperMode's auto resolution uses a fake Gemini
// provider whose live model list EXCLUDES the deprecated pinned model.
vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn(() => ({ type: 'gemini', provider: mockFakeProvider })),
}));

// Deterministically stub the auto router: the real one reads the machine's
// buffconfig.json (environment-dependent). Here it always picks gemini with
// the DEPRECATED model so the model-health layer must repair it.
vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    getAutoRouter: () => ({
      resolve: () => ({
        agentType: 'chat',
        provider: 'gemini',
        model: 'gemini-2.0-flash-exp',
        complexity: 'simple',
        taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
        escalationApplied: false,
        taskType: 'code-generation',
        score: 0.8,
        weights: { reasoning: 0.2, speed: 0.3, cost: 0.3, privacy: 0.1, reliability: 0.1 },
        ranked: [{ provider: 'gemini', score: 0.8, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' }],
        fallbackChain: [],
        explanation: 'test decision',
        routedBy: 'heuristic',
      }),
    }),
  };
});

// ─── Module-level mocks ─────────────────────────────────────────────────────

const mockExecute = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    success: true,
    goal: 'test goal',
    summary: 'done',
    tasksCompleted: 1,
    tasksTotal: 1,
    agentResults: [{ agent: 'Writer', success: true, summary: 'ok' }],
    // printOrchestrationResult calls fileChanges.split('\n') — use a string
    fileChanges: 'No files changed.',
    stats: {},
  }),
);

// Mock the orchestrator so runDeveloperMode doesn't run a real pipeline
vi.mock('../../src/agents/orchestrator.js', () => ({
  Orchestrator: class {
    constructor(_cm: any) {}
    execute = mockExecute;
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runDeveloperMode — auto provider/model resolution', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    mockExecute.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve auto provider/model to a concrete model before calling the orchestrator', async () => {
    const cm = new ConfigManager();

    await runDeveloperMode('create a todo app', cm, { provider: 'auto', model: 'auto' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [goal, options] = mockExecute.mock.calls[0];
    expect(goal).toBe('create a todo app');
    // A literal 'auto' must never reach the orchestrator
    expect(options.provider).not.toBe('auto');
    expect(options.model).not.toBe('auto');
    expect(typeof options.model).toBe('string');
    expect(options.model.length).toBeGreaterThan(0);
  });

  it('should pass through explicit provider/model untouched', async () => {
    const cm = new ConfigManager();

    await runDeveloperMode('create a todo app', cm, { provider: 'groq', model: 'llama-3.3-70b-versatile' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, options] = mockExecute.mock.calls[0];
    expect(options.provider).toBe('groq');
    expect(options.model).toBe('llama-3.3-70b-versatile');
  });

  it('should resolve to a provider from the auto router when only provider is auto', async () => {
    const cm = new ConfigManager();

    await runDeveloperMode('fix a flaky test', cm, { provider: 'auto' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, options] = mockExecute.mock.calls[0];
    expect(options.provider).not.toBe('auto');
    expect(options.model).not.toBe('auto');
    expect(typeof options.model).toBe('string');
    expect(options.model.length).toBeGreaterThan(0);
  });
});

describe('runDeveloperMode — model health (working models only)', () => {
  // Isolate the ModelRegistry: its JSON mirror lives in BUFF_MEMORY_DIR and a
  // real (previously populated) registry would short-circuit the model-health
  // repair path (a stale pinned model verified in the registry would pass
  // through instead of being swapped for a live one).
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'success').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'highlight').mockImplementation(() => {});
    mockExecute.mockClear();
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-chat-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should repair a deprecated pinned model to a verified-working model before the orchestrator', async () => {
    const cm = new ConfigManager();

    // The auto router resolves to a provider/model pair; the model health layer
    // must swap the stale model for one that exists on the provider.
    await runDeveloperMode('create a todo app', cm, { provider: 'auto', model: 'auto' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, options] = mockExecute.mock.calls[0];
    // The orchestrator receives a model that actually exists on the provider
    expect(options.model).toBe('gemini-2.5-flash');
    expect(options.provider).toBe('gemini');
  });
});
