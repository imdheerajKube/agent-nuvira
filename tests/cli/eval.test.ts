/**
 * EvalCommand — Unit tests for `buff eval --routing`.
 *
 * The routing mode asks the Auto router which provider/model it would pick for
 * each eval task, dedupes the picks, then runs the eval suite per pick. These
 * tests drive the real Commander command with the eval-framework and router
 * modules mocked so no real providers or orchestrator runs execute.
 *
 * Coverage:
 * 1. --routing flag dispatches to routing mode (header + pick list printed)
 * 2. Picks are deduped with task counts (2 tasks → 1 pick)
 * 3. Unavailable provider is skipped with a warning
 * 4. Routing Pick Comparison table + 🏆 best pick is printed after runs
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getEvalTasks, runEvalSuite } from '../../src/learning/eval-framework.js';
import { resolveProvider } from '../../src/cli/router.js';
import { getAutoRouter } from '../../src/learning/auto-router.js';
import { EvalCommand } from '../../src/cli/eval.js';

// ─── Isolate routing-history writes (routing mode records decisions) ────────
const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const tmpMemoryDir = mkdtempSync(join(TMP_BASE, 'buff-eval-test-'));
beforeAll(() => {
  process.env.BUFF_MEMORY_DIR = join(tmpMemoryDir, '.buff', 'memory');
});

afterAll(() => {
  delete process.env.BUFF_MEMORY_DIR;
  rmSync(tmpMemoryDir, { recursive: true, force: true });
});

// ─── Module mocks (hoisted before imports) ─────────────────────────────────

vi.mock('../../src/learning/eval-framework.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/eval-framework.js')>();
  return {
    ...actual,
    getEvalTasks: vi.fn(() => [
      { id: 'js-anagram', title: 'Anagram', category: 'algorithm', difficulty: 'easy', goal: 'Implement anagram checker', setupFiles: [], hiddenTests: [{ file: 'test.js', command: 'node test.js' }], tokenBudget: 6000, timeEstimate: 'quick' },
      { id: 'js-queue', title: 'Queue', category: 'feature', difficulty: 'easy', goal: 'Implement a Queue', setupFiles: [], hiddenTests: [{ file: 'test.js', command: 'node test.js' }], tokenBudget: 8000, timeEstimate: 'medium' },
    ]),
    runEvalSuite: vi.fn(async (_provider, providerName: string, model: string) => ({
      id: `eval-test-${providerName}`,
      provider: providerName,
      model,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      results: [],
      summary: {
        totalTasks: 2,
        tasksPassed: 2,
        completionRate: 1,
        testPassRate: 1,
        avgTimeToFixMs: 30000,
        avgEditAccuracy: 0.9,
        avgTokenEfficiency: 0.7,
        totalRollbacks: 0,
        dependencyInstallRate: 1,
        recoveryRate: 0.5,
        avgCompositeScore: providerName === 'groq' ? 0.9 : 0.75,
        totalCostUsd: 0.001,
      },
    })),
  };
});

// NOTE: We mock router.js with ONLY resolveProvider (no importOriginal) because
// the real router.js has module-level side effects — it constructs every CLI
// command (including EvalCommand itself), which would create a circular import
// and hang the test. eval.ts only imports resolveProvider from router.js, so a
// minimal mock is safe.
vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_configManager: unknown, provider: string) => ({
    type: provider,
    provider: {
      name: `Mock-${provider}`,
      isAvailable: async () => true,
    },
  })),
}));

vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    getAutoRouter: vi.fn(() => ({
      resolve: vi.fn(() => ({
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        complexity: 'simple',
        score: 0.87,
        ranked: [],
        fallbackChain: [],
        explanation: 'test decision',
        agentType: 'chat',
        taskType: 'code',
        weights: { reasoning: 0.3, speed: 0.3, cost: 0.2, privacy: 0.1, reliability: 0.1 },
      })),
    })),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function runCommand(args: string[]): Promise<string> {
  const cmd = new EvalCommand().create();
  return cmd.parseAsync(args, { from: 'user' }).then(() => {
    const logLines = vi.mocked(console.log).mock.calls
      .map((c) => c.map((v) => String(v)).join(' '))
      .join('\n');
    const errLines = vi.mocked(console.error).mock.calls
      .map((c) => c.map((v) => String(v)).join(' '))
      .join('\n');
    return `${logLines}\n${errLines}`;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EvalCommand --routing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getEvalTasks).mockClear();
    vi.mocked(runEvalSuite).mockClear();
    vi.mocked(resolveProvider).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enters routing mode and prints the router picks', async () => {
    const output = await runCommand(['run', '--routing']);

    expect(output).toContain('Routing Eval');
    expect(output).toContain('groq');
    expect(output).toContain('llama-3.3-70b-versatile');
    // Both tasks route to the same pick → deduped to 1 with task count 2
    expect(output).toContain('(2 tasks)');
  });

  it('runs the eval suite once per distinct pick and prints the report', async () => {
    await runCommand(['run', '--routing']);

    expect(getEvalTasks).toHaveBeenCalled();
    // 2 tasks → 1 distinct pick → 1 suite run
    expect(runEvalSuite).toHaveBeenCalledTimes(1);
    expect(runEvalSuite).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mock-groq' }),
      'groq',
      'llama-3.3-70b-versatile',
      expect.objectContaining({ keepWorkspaces: false }),
    );
  });

  it('prints the Routing Pick Comparison table with a best pick', async () => {
    const output = await runCommand(['run', '--routing']);

    expect(output).toContain('Routing Pick Comparison');
    expect(output).toContain('Provider/Model');
    expect(output).toContain('groq/llama-3.3-70b-versatile');
    expect(output).toContain('Best router pick');
    expect(output).toContain('composite 90.0%');
  });

  it('skips unavailable providers with a warning', async () => {
    // First availability check returns false → pick is skipped
    vi.mocked(resolveProvider).mockReturnValueOnce({
      type: 'groq',
      provider: { name: 'Mock-groq', isAvailable: async () => false },
    });

    const output = await runCommand(['run', '--routing']);

    // Assert the suite was not run first (cheapest check, clearest failure)
    expect(runEvalSuite).not.toHaveBeenCalled();
    expect(output).toContain('is not available');
    expect(output).toContain('No router picks could be evaluated');
  });

  it('records routing decisions to the history store', async () => {
    // BUFF_MEMORY_DIR is set in beforeAll to a temp dir, so records stay isolated
    const { getRoutingHistory, clearRoutingHistory } = await import('../../src/learning/routing-history.js');
    clearRoutingHistory();

    await runCommand(['run', '--routing']);

    // The mock resolve() returns one decision per task → 2 recorded entries
    const history = getRoutingHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.every((h) => h.source === 'eval')).toBe(true);
    expect(history.every((h) => h.provider === 'groq')).toBe(true);
  });
});
