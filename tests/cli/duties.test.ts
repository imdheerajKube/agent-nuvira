/**
 * D2 — Auto-run background duties: unit tests for src/cli/duties.ts.
 *
 * Covers:
 * 1. First run executes and produces health + models one-liners.
 * 2. Throttle — a second run within the window is skipped.
 * 3. force bypasses the throttle.
 * 4. silent suppresses logger output.
 * 5. Best-effort — a broken ConfigManager never throws.
 *
 * homedir is mocked to a temp dir so the throttle state file lands there; the
 * ModelRegistry reads its (empty) mirror from the same mocked homedir.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Mock } from 'vitest';

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-duties-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), highlight: vi.fn(), success: vi.fn() },
}));

import { maybeRunBackgroundDuties } from '../../src/cli/duties.js';
import { logger } from '../../src/utils/logger.js';

const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  process.env.BUFF_MEMORY_DIR = join(testDirHolder.value, 'memory');
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(testDirHolder.value, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Remove any prior throttle state file so each test starts fresh.
  try { rmSync(join(testDirHolder.value, '.buff', 'duties-last-run.json'), { force: true }); } catch { /* noop */ }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Minimal ConfigManager stub: 2 configured providers, no vault, tiny workspace. */
function stubConfigManager(): any {
  return {
    getAll: () => ({ providers: { groq: { apiKey: 'x' }, gemini: { apiKey: 'y' }, local: {} } }),
    getVault: () => null,
    getWorkspaceStore: () => ({
      status: () => ({ backend: 'sqlite', projectCount: 3 }),
    }),
  };
}

describe('maybeRunBackgroundDuties', () => {
  it('runs on first call and produces health + models one-liners', async () => {
    const r = await maybeRunBackgroundDuties(stubConfigManager(), { throttleMs: 1000 });
    expect(r.ran).toBe(true);
    expect(r.healthLine).toBeDefined();
    expect(r.healthLine).toContain('provider(s) configured');
    expect(r.healthLine).toContain('workspace: sqlite (3 project(s))');
    expect(r.modelsLine).toBeDefined();
    expect(r.modelsLine).toContain('verified model(s)');
    expect(logger.info).toHaveBeenCalled();
  });

  it('skips a second run within the throttle window', async () => {
    await maybeRunBackgroundDuties(stubConfigManager(), { throttleMs: 60_000 });
    const r = await maybeRunBackgroundDuties(stubConfigManager(), { throttleMs: 60_000 });
    expect(r.ran).toBe(false);
  });

  it('force bypasses the throttle', async () => {
    await maybeRunBackgroundDuties(stubConfigManager(), { throttleMs: 60_000 });
    const r = await maybeRunBackgroundDuties(stubConfigManager(), { throttleMs: 60_000, force: true });
    expect(r.ran).toBe(true);
  });

  it('silent suppresses logger output but still returns lines', async () => {
    const r = await maybeRunBackgroundDuties(stubConfigManager(), { silent: true, throttleMs: 1000 });
    expect(r.ran).toBe(true);
    expect(r.healthLine).toBeDefined();
    expect((logger.info as Mock).mock.calls.length).toBe(0);
  });

  it('never throws on a broken ConfigManager (best-effort)', async () => {
    const broken: any = {
      getAll: () => { throw new Error('boom'); },
      getVault: () => { throw new Error('boom'); },
      getWorkspaceStore: () => { throw new Error('boom'); },
    };
    const r = await maybeRunBackgroundDuties(broken, { throttleMs: 1000 });
    expect(r.ran).toBe(true);
    expect(r.healthLine).toBeUndefined();
  });
});
