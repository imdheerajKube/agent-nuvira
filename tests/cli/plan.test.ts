/**
 * Plan command — shared single-shot failover runner adoption tests
 * (Nuvira-Router M0.2 Stage C).
 *
 * plan.ts now generates through runSingleShotAuto instead of a bare
 * provider.generate + retryable-only callWithFallback. These tests capture the
 * runner options plan builds and verify the wiring end-to-end against the REAL
 * registry (temp BUFF_MEMORY_DIR):
 *   - action tag is 'plan' (per-action "learned from real usage" attribution)
 *   - route() returns the picked provider primary + auto-router ranked minus
 *     the primary (full walk for ALL failure classes)
 *   - generate() attributes success to the ACTUAL winner × model
 *   - recordFailure() feeds the FULL shared bookkeeping (registry learns the
 *     block → next pick skips it predictively)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlanCommand } from '../../src/cli/plan.js';
import { resetModelRegistry, getModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRunSingleShotAuto = vi.hoisted(() => vi.fn(async () => 'PLAN OK'));
const mockResolveProvider = vi.hoisted(() => vi.fn((_cm: unknown, type?: string) => ({
  type: type || 'local',
  provider: makeFakeProvider(type || 'local'),
})));
const mockAutoResolve = vi.hoisted(() => vi.fn(() => ({
  provider: 'gemini',
  model: 'gemini-model',
  ranked: [
    { provider: 'gemini', model: 'gemini-model', score: 0.9 },
    { provider: 'local', model: 'llama3', score: 0.4 },
  ],
  complexity: 'moderate',
  score: 0.9,
  explanation: 'test routing',
  agentType: 'plan',
  taskProfile: {},
  escalationApplied: false,
  taskType: 'planning',
  weights: {},
  fallbackChain: [],
  routedBy: 'heuristic',
})));

vi.mock('../../src/cli/failover-runner.js', () => ({
  runSingleShotAuto: mockRunSingleShotAuto,
}));

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: mockResolveProvider,
}));

vi.mock('../../src/learning/auto-router.js', () => ({
  getAutoRouter: () => ({ resolve: mockAutoResolve }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fake provider (available; generate resolves) — router mock returns this. */
function makeFakeProvider(name: string): InferenceProvider {
  return {
    name,
    isAvailable: async () => true,
    generate: async () => 'plan text',
    listModels: async () => [{ id: 'm', name: 'M', provider: name, tags: [] }],
    generateStream: undefined,
    getInfo: () => name,
  } as InferenceProvider;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PlanCommand — shared single-shot failover runner adoption', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'buff-plan-adopt-'));
    writeFileSync(join(tempDir, 'package.json'), '{}');
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('generates through the shared runner with the plan action tag', async () => {
    const plan = new PlanCommand();
    await (plan as any).execute(tempDir, { task: 'add auth' });

    expect(mockRunSingleShotAuto).toHaveBeenCalledTimes(1);
    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    expect(opts.action).toBe('plan');
    expect(opts.task).toBe('add auth');
    // The picker is not triggered: the picked provider is available.
    expect(opts.configManager).toBeDefined();
  });

  it('route() keeps the picked provider primary and ranks auto-router alternatives', async () => {
    const plan = new PlanCommand();
    await (plan as any).execute(tempDir, { task: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const route = await opts.route([]);
    expect(route.type).toBe('local'); // picked (default) provider stays primary
    expect(route.model).toBe('default'); // no explicit --model
    // Ranked = auto-router ranking minus the primary (never re-try the pick).
    expect(route.ranked).toEqual(['gemini']);
    expect(route.complexity).toBe('moderate');
    expect(route.score).toBe(0.9);
  });

  it('route() keeps an EXPLICIT --provider pick primary and excludes it from ranked', async () => {
    const plan = new PlanCommand();
    await (plan as any).execute(tempDir, { task: 't', provider: 'gemini' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const route = await opts.route([]);
    expect(route.type).toBe('gemini'); // pinned provider stays primary
    // gemini (the pick) is excluded from ranked; local is the only alternative.
    expect(route.ranked).toEqual(['local']);
  });

  it('generate() attributes success to the actual winner provider × model (plan row)', async () => {
    const plan = new PlanCommand();
    await (plan as any).execute(tempDir, { task: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const out = await opts.generate(makeFakeProvider('gemini'), 'gemini', 'gemini-2.5-flash');
    expect(out).toBe('plan text');

    // The registry learned the winner is verified with the 'plan' action tag.
    const entry = getModelRegistry().getEntry('gemini', 'gemini-2.5-flash');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('verified');
    expect(getModelRegistry().getUsableProviders()).toContain('gemini');
  });

  it('recordFailure() feeds the full shared bookkeeping → registry learns the block', async () => {
    const plan = new PlanCommand();
    await (plan as any).execute(tempDir, { task: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    // Simulate the runner's per-attempt failure hook: 429 on the picked provider.
    opts.recordFailure('gemini', 'gemini-2.5-flash', new Error('429 rate limit exceeded'));

    const entry = getModelRegistry().getEntry('gemini', 'gemini-2.5-flash');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('unavailable');
    expect(entry!.lastError).toContain('rate-limit');
    // The predictive skip is armed: the next pick routes around gemini.
    expect(getModelRegistry().getBlockedProviders()).toContain('gemini');
  });
});
