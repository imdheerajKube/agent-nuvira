/**
 * EditCommand — auto-route adoption tests (ISSUE-003).
 *
 * edit.ts now supports the SAME auto routing as chat/execute/plan:
 *   - --auto-route (or 'auto' provider/model) drives the SHARED ranked walk
 *     (runSingleShotAuto) with action tag 'edit'
 *   - route() resolves the PRIMARY through the auto router's FULL feature set
 *     (bandit, quota, runtime stats, floors, paid gate)
 *   - generate() attributes success to the actual winner × model ('edit' row)
 *   - the legacy explicit-provider path is unchanged (no --auto-route)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EditCommand } from '../../src/cli/edit.js';
import { resetModelRegistry, getModelRegistry } from '../../src/learning/model-registry.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRunSingleShotAuto = vi.hoisted(() => vi.fn(async () => 'EDITED CONTENT'));
const mockResolveProvider = vi.hoisted(() => vi.fn((_cm: unknown, type?: string) => ({
  type: type || 'local',
  provider: makeFakeProvider(type || 'local'),
})));
const mockAutoResolve = vi.hoisted(() => vi.fn(() => ({
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  ranked: [
    { provider: 'gemini', model: 'gemini-2.5-flash', score: 0.9 },
    { provider: 'local', model: 'llama3', score: 0.4 },
  ],
  complexity: 'moderate',
  score: 0.9,
  explanation: 'test routing',
  agentType: 'edit',
  taskProfile: {},
  escalationApplied: false,
  taskType: 'editing',
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
  isAutoModel: (m?: string | null) => m === 'auto',
  isAutoProvider: (p?: string | null) => p === 'auto',
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fake provider (available; generate resolves) — router mock returns this. */
function makeFakeProvider(name: string): InferenceProvider {
  return {
    name,
    isAvailable: async () => true,
    generate: async () => 'EDITED CONTENT',
    listModels: async () => [{ id: 'm', name: 'M', provider: name, tags: [] }],
    generateStream: undefined,
    getInfo: () => name,
  } as InferenceProvider;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EditCommand — auto-route adoption', () => {
  let tempDir: string;
  let filePath: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'buff-edit-adopt-'));
    filePath = join(tempDir, 'sample.ts');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = join(tempDir, '.buff', 'memory');
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

  it('--auto-route drives the SHARED ranked walk with the edit action tag', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, instruction: 'add error handling' });

    expect(mockRunSingleShotAuto).toHaveBeenCalledTimes(1);
    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    expect(opts.action).toBe('edit');
    expect(opts.task).toBe('add error handling');
    expect(opts.configManager).toBeDefined();
  });

  it("provider/model 'auto' also activates the ranked walk", async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { provider: 'auto', model: 'auto', instruction: 'fix' });

    expect(mockRunSingleShotAuto).toHaveBeenCalledTimes(1);
  });

  it('route() resolves the PRIMARY through the auto router with the FULL feature set', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, instruction: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const route = await opts.route([]);
    expect(route.type).toBe('gemini');
    expect(route.model).toBe('gemini-2.5-flash');
    // Ranked = auto-router ranking minus the primary (never re-try the pick).
    expect(route.ranked).toEqual(['local']);
    expect(route.complexity).toBe('moderate');
    expect(route.score).toBe(0.9);

    // The resolve call carried the same levers chat + the orchestrator pass.
    // (Routing config is empty in this test, so floor values are unset-but-
    // wired: the KEYS must be present exactly like chat/orchestrator assemble.)
    const resolveOptions = mockAutoResolve.mock.calls[0][2] as Record<string, unknown>;
    expect(resolveOptions.useRuntimeStats).toBe(true);
    expect('useBandit' in resolveOptions).toBe(true);
    expect('maxCostUsd' in resolveOptions).toBe(true);
    expect('minSpeed' in resolveOptions).toBe(true);
    expect('minReasoning' in resolveOptions).toBe(true);
    expect('allowPaid' in resolveOptions).toBe(true);
    expect(Array.isArray(resolveOptions.quotaStatus)).toBe(true);
  });

  it('an explicit --provider stays PRIMARY when combined with --auto-route (user intent wins)', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, provider: 'local', instruction: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const route = await opts.route([]);
    // The router's pick is gemini, but the user pinned local → local leads.
    expect(route.type).toBe('local');
    // gemini (the router's pick) becomes the ranked fallback, not the primary.
    expect(route.ranked).toEqual(['gemini']);
  });

  it('generate() attributes success to the actual winner provider × model (edit row)', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, instruction: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    const out = await opts.generate(makeFakeProvider('gemini'), 'gemini', 'gemini-2.5-flash');
    expect(out).toBe('EDITED CONTENT');

    // The registry learned the winner is verified with the 'edit' action tag.
    const entry = getModelRegistry().getEntry('gemini', 'gemini-2.5-flash');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('verified');
    expect(getModelRegistry().getUsableProviders()).toContain('gemini');
  });

  it('recordFailure() feeds the full shared bookkeeping → registry learns the block', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, instruction: 't' });

    const opts = mockRunSingleShotAuto.mock.calls[0][0];
    opts.recordFailure('gemini', 'gemini-2.5-flash', new Error('429 rate limit exceeded'));

    const entry = getModelRegistry().getEntry('gemini', 'gemini-2.5-flash');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('unavailable');
    expect(entry!.lastError).toContain('rate-limit');
    expect(getModelRegistry().getBlockedProviders()).toContain('gemini');
  });

  it('writes the auto-routed result to the file (dry-run off)', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { autoRoute: true, instruction: 't' });

    // The mocked walk returns 'EDITED CONTENT' (no code fence) → written as-is.
    expect(readFileSync(filePath, 'utf-8')).toBe('EDITED CONTENT');
  });

  it('legacy explicit-provider path is unchanged (no ranked walk, direct generate)', async () => {
    const edit = new EditCommand();
    await (edit as any).execute(filePath, { provider: 'local', instruction: 't' });

    // No --auto-route → runSingleShotAuto is NOT involved.
    expect(mockRunSingleShotAuto).not.toHaveBeenCalled();
    // The legacy path resolves the provider directly and writes the result.
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('EDITED CONTENT');
  });
});
