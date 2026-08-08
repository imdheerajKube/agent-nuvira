/**
 * KeyHygiene — ISSUE-004 (4b/4d) tests.
 *
 * Covers:
 * 1. Consecutive auth failures count toward a persisted per-provider counter
 * 2. Below the threshold: warning only, key NOT cleared, counter persists
 * 3. At the threshold: the invalid key is cleared from the config file
 * 4. Env-sourced keys are NOT cleared from the file — the env var is reported
 * 5. A real success resets the counter (one blip can't clear a valid key)
 * 6. Best-effort: a throwing config manager never breaks the call
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KeyHygiene,
  getKeyHygiene,
  resetKeyHygiene,
  AUTH_CLEAR_THRESHOLD,
} from '../../src/learning/key-hygiene.js';

describe('KeyHygiene', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;
  // ConfigManager stub — only clearProviderApiKey is exercised here.
  let configManager: { clearProviderApiKey: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'buff-key-hygiene-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = join(tempDir, '.buff', 'memory');
    resetKeyHygiene();
    configManager = {
      clearProviderApiKey: vi.fn(() => ({ cleared: true, envSourced: false })),
    };
  });

  afterEach(() => {
    resetKeyHygiene();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('counts consecutive auth failures toward a persisted per-provider counter', () => {
    const kh = getKeyHygiene();
    kh.recordAuthFailure('groq', configManager as never);
    kh.recordAuthFailure('groq', configManager as never);
    expect(kh.getState().groq).toBe(2);
    // Independent providers don't interfere.
    kh.recordAuthFailure('nim', configManager as never);
    expect(kh.getState().groq).toBe(2);
    expect(kh.getState().nim).toBe(1);
  });

  it('below the threshold: warns but does NOT clear the key', () => {
    const kh = getKeyHygiene();
    for (let i = 1; i < AUTH_CLEAR_THRESHOLD; i++) {
      const outcome = kh.recordAuthFailure('openrouter', configManager as never);
      expect(outcome.cleared).toBe(false);
      expect(outcome.consecutive).toBe(i);
      expect(configManager.clearProviderApiKey).not.toHaveBeenCalled();
    }
  });

  it('at the threshold: the invalid key is CLEARED from the config', () => {
    const kh = getKeyHygiene();
    let outcome;
    for (let i = 0; i < AUTH_CLEAR_THRESHOLD; i++) {
      outcome = kh.recordAuthFailure('openrouter', configManager as never);
    }
    expect(outcome!.cleared).toBe(true);
    // No specific key was passed (undefined) → the primary is cleared.
    expect(configManager.clearProviderApiKey).toHaveBeenCalledWith('openrouter', undefined);
    // Counter resets after the clear — the next failure starts fresh.
    expect(kh.getState().openrouter).toBe(0);
  });

  it('env-sourced keys are reported, not cleared from the file', () => {
    configManager.clearProviderApiKey.mockReturnValueOnce({
      cleared: false,
      envSourced: true,
      envVar: 'OPENROUTER_API_KEY',
    });
    const kh = getKeyHygiene();
    let outcome;
    for (let i = 0; i < AUTH_CLEAR_THRESHOLD; i++) {
      outcome = kh.recordAuthFailure('openrouter', configManager as never);
    }
    expect(outcome!.cleared).toBe(false);
    expect(outcome!.envSourced).toBe(true);
    expect(outcome!.envVar).toBe('OPENROUTER_API_KEY');
    expect(configManager.clearProviderApiKey).toHaveBeenCalledWith('openrouter', undefined);
  });

  it('a real success resets the counter (one blip can never clear a valid key)', () => {
    const kh = getKeyHygiene();
    kh.recordAuthFailure('gemini', configManager as never);
    kh.recordAuthFailure('gemini', configManager as never);
    kh.recordAuthSuccess('gemini');
    expect(kh.getState().gemini).toBeUndefined();
    // A fresh counter means the NEXT two failures are only 1/3, 2/3 — not 3/3.
    kh.recordAuthFailure('gemini', configManager as never);
    kh.recordAuthFailure('gemini', configManager as never);
    expect(configManager.clearProviderApiKey).not.toHaveBeenCalled();
  });

  it('best-effort: a throwing config manager never breaks the call, and the counter is NOT reset so the clear retries', () => {
    configManager.clearProviderApiKey.mockImplementation(() => {
      throw new Error('disk error');
    });
    const kh = getKeyHygiene();
    expect(() => {
      for (let i = 0; i < AUTH_CLEAR_THRESHOLD; i++) {
        kh.recordAuthFailure('groq', configManager as never);
      }
    }).not.toThrow();
    // The clear failed — the counter stays at the threshold so the NEXT auth
    // failure immediately retries the clear (no fresh 3-failure wait).
    expect(kh.getState().groq).toBe(AUTH_CLEAR_THRESHOLD);
  });

  it('the counter survives a process restart (persisted JSON)', () => {
    const kh = new KeyHygiene();
    kh.recordAuthFailure('openrouter', configManager as never);
    kh.recordAuthFailure('openrouter', configManager as never);
    // New instance = simulated restart.
    const reloaded = new KeyHygiene();
    expect(reloaded.getState().openrouter).toBe(2);
  });
});
