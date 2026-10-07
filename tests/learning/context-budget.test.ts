/**
 * Context + output budget resolution (Q4).
 *
 * The pipeline hardcoded `contextLimit || 128_000` for pruning and
 * `maxTokens ?? 4096` for every call, even though the registry has always
 * recorded each model's real provider-advertised window. A 1M-token model was
 * therefore pruned as if it had 128K and could emit at most 4096 tokens.
 *
 * These tests pin the resolver's precedence and — most importantly — that an
 * UNKNOWN model behaves exactly as before, so this change cannot regress
 * anything whose window we cannot discover.
 */

import { describe, it, expect, vi } from 'vitest';

// The registry supplies the live per-model window; PROVIDER_CONTEXT_WINDOWS the
// provider-level fallback. Both are stubbed so the tests are deterministic.
const entries = vi.hoisted(() => new Map<string, number>());
const providerWindows = vi.hoisted(() => ({} as Record<string, number>));
// When true the registry throws on access, so the resolver's best-effort
// contract can be exercised without monkey-patching a mocked module.
const registryBroken = vi.hoisted(() => ({ value: false }));

vi.mock('../../src/learning/model-registry.js', () => ({
  getModelRegistry: () => ({
    getEntry: (provider: string, model: string) => {
      if (registryBroken.value) throw new Error('registry exploded');
      const window = entries.get(`${provider}|${model}`);
      return window === undefined ? undefined : { contextWindowTokens: window };
    },
  }),
}));

vi.mock('../../src/learning/model-selection.js', () => ({
  PROVIDER_CONTEXT_WINDOWS: providerWindows,
}));

import {
  resolveContextBudget,
  resolveMaxOutputTokens,
  resolveThreadBudgetChars,
  resolveContextFileBudget,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MAX_OUTPUT_TOKENS,
  LARGE_WINDOW_OUTPUT_TOKENS,
  MIN_CONTEXT_BUDGET,
  CONTEXT_HEADROOM_PCT,
  CHARS_PER_TOKEN,
  MIN_THREAD_BUDGET_CHARS,
  MAX_THREAD_BUDGET_CHARS,
  DEFAULT_CONTEXT_FILES,
  DEFAULT_CONTEXT_FILE_CHARS,
  MAX_CONTEXT_FILE_CHARS,
} from '../../src/learning/context-budget.js';
// The CALLER's default, from its own module — the budget this resolver must now
// be able to go BELOW for a small known window (C1/C5).
import { DEFAULT_THREAD_BUDGET_CHARS } from '../../src/tools/tool-loop.js';

describe('resolveContextBudget', () => {
  it("uses the model's REAL window instead of the 128K hardcode", () => {
    entries.set('gemini|gemini-2.5-flash', 1_000_000);

    const result = resolveContextBudget({ provider: 'gemini', model: 'gemini-2.5-flash' });

    expect(result.source).toBe('model');
    expect(result.window).toBe(1_000_000);
    // Headroom is withheld for the response + tool schemas.
    expect(result.budget).toBe(Math.floor(1_000_000 * (1 - CONTEXT_HEADROOM_PCT)));
    expect(result.budget).toBeGreaterThan(DEFAULT_CONTEXT_BUDGET);
  });

  it('keeps the historical default when the window is UNKNOWN', () => {
    // No registry entry, no provider entry — behaviour must be unchanged.
    const result = resolveContextBudget({ provider: 'mystery', model: 'mystery-model' });
    expect(result.source).toBe('default');
    expect(result.budget).toBe(DEFAULT_CONTEXT_BUDGET);
    expect(result.window).toBeUndefined();
  });

  it("falls back to the provider's advertised window when the model is untracked", () => {
    providerWindows.local = 131_072;

    const result = resolveContextBudget({ provider: 'local', model: 'untracked:7b' });

    expect(result.source).toBe('provider');
    expect(result.window).toBe(131_072);
    expect(result.budget).toBe(Math.floor(131_072 * (1 - CONTEXT_HEADROOM_PCT)));
  });

  it('lets an explicit override win outright', () => {
    entries.set('groq|m', 1_000_000);
    const result = resolveContextBudget({ provider: 'groq', model: 'm', override: 32_000 });
    expect(result).toEqual({ budget: 32_000, source: 'override' });
  });

  it('floors the budget so a tiny window is never pruned to nothing', () => {
    entries.set('local|tiny:0.5b', 4_000);
    const result = resolveContextBudget({ provider: 'local', model: 'tiny:0.5b' });
    expect(result.window).toBe(4_000);
    expect(result.budget).toBe(MIN_CONTEXT_BUDGET);
  });

  it('ignores unresolved model sentinels rather than guessing', () => {
    for (const model of ['default', 'auto', 'unknown', undefined]) {
      const result = resolveContextBudget({ provider: 'gemini', model });
      expect(result.source).toBe('default');
      expect(result.budget).toBe(DEFAULT_CONTEXT_BUDGET);
    }
  });

  it('never throws when the registry misbehaves', () => {
    registryBroken.value = true;
    try {
      expect(() => resolveContextBudget({ provider: 'x', model: 'y' })).not.toThrow();
      expect(resolveContextBudget({ provider: 'x', model: 'y' }).budget).toBe(DEFAULT_CONTEXT_BUDGET);
      expect(() => resolveMaxOutputTokens({ provider: 'x', model: 'y' })).not.toThrow();
    } finally {
      registryBroken.value = false;
    }
  });
});

describe('resolveMaxOutputTokens', () => {
  it('lifts the 4096 ceiling for a large-window model', () => {
    entries.set('gemini|big', 1_000_000);
    expect(resolveMaxOutputTokens({ provider: 'gemini', model: 'big' })).toBe(
      LARGE_WINDOW_OUTPUT_TOKENS,
    );
  });

  it('keeps 4096 for an unknown or modest model', () => {
    entries.set('local|mid:8b', 32_768);
    expect(resolveMaxOutputTokens({ provider: 'local', model: 'mid:8b' })).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
    expect(resolveMaxOutputTokens({ provider: 'who', model: 'knows' })).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS,
    );
  });

  it('lets an explicit override win', () => {
    entries.set('gemini|big', 1_000_000);
    expect(resolveMaxOutputTokens({ provider: 'gemini', model: 'big', override: 2_048 })).toBe(2_048);
  });
});

describe('resolveThreadBudgetChars (T2 — loop thread budget)', () => {
  it('returns undefined for an UNKNOWN window so the loop default is untouched', () => {
    expect(resolveThreadBudgetChars({ provider: 'mystery', model: 'mystery-model' })).toBeUndefined();
  });

  it('raises the budget for a 1M window (capped) instead of a 128K keyhole', () => {
    entries.set('gemini|big', 1_048_576);
    const chars = resolveThreadBudgetChars({ provider: 'gemini', model: 'big' });
    expect(chars).toBe(MAX_THREAD_BUDGET_CHARS);
    expect(chars!).toBeGreaterThan(DEFAULT_THREAD_BUDGET_CHARS);
  });

  it('a 128K window converts to its real char budget', () => {
    entries.set('local|mid', 131_072);
    const chars = resolveThreadBudgetChars({ provider: 'local', model: 'mid' });
    expect(chars).toBe(Math.floor(131_072 * (1 - CONTEXT_HEADROOM_PCT) * CHARS_PER_TOKEN));
    expect(chars!).toBeGreaterThan(DEFAULT_THREAD_BUDGET_CHARS);
  });

  // ─── C1/C5 — the WINDOW decides, in BOTH directions ──────────────────────
  //
  // This block used to assert the opposite, and the assertion was the defect:
  // "never SHRINKS below the loop default for a small window" pinned a 32K-token
  // model to a 200,000-char budget (~44K tokens) — 1.4× its own window, from the
  // lookup that had just established the window. A mid-turn handoff to a smaller
  // model could therefore overflow the window the router already knew about.
  it('FITS a small window instead of handing it the loop default', () => {
    entries.set('local|small', 32_768);
    const chars = resolveThreadBudgetChars({ provider: 'local', model: 'small' });
    expect(chars).toBe(Math.floor(32_768 * (1 - CONTEXT_HEADROOM_PCT) * CHARS_PER_TOKEN));
    // The whole point: it is now BELOW the caller's default, and below the
    // window it was derived from.
    expect(chars!).toBeLessThan(DEFAULT_THREAD_BUDGET_CHARS);
    // ...and below the model's OWN window converted to characters, which is the
    // property the old never-shrink rule violated.
    expect(chars!).toBeLessThan(Math.floor(32_768 * CHARS_PER_TOKEN));
  });

  it('never shrinks below the sanity floor, even for a degenerate window', () => {
    // A window this small is a registry error rather than a model; trimming to
    // near-zero would destroy the turn, so one small floor survives the change.
    entries.set('local|tiny', 512);
    const chars = resolveThreadBudgetChars({ provider: 'local', model: 'tiny' });
    expect(chars).toBe(MIN_THREAD_BUDGET_CHARS);
    expect(MIN_THREAD_BUDGET_CHARS).toBeLessThan(DEFAULT_THREAD_BUDGET_CHARS);
  });
});

describe('resolveContextFileBudget (T2 — writer/edit file caps)', () => {
  it('keeps the historical caps for an UNKNOWN window', () => {
    expect(resolveContextFileBudget({ provider: 'mystery', model: 'mystery-model' })).toEqual({
      maxFiles: DEFAULT_CONTEXT_FILES,
      maxChars: DEFAULT_CONTEXT_FILE_CHARS,
    });
  });

  it('scales the char budget with a 1M window and caps it', () => {
    entries.set('gemini|big', 1_048_576);
    const b = resolveContextFileBudget({ provider: 'gemini', model: 'big' });
    expect(b.maxChars).toBe(MAX_CONTEXT_FILE_CHARS);
    expect(b.maxFiles).toBeGreaterThan(DEFAULT_CONTEXT_FILES);
  });

  it('a modest window stays at the historical defaults (no shrink, no over-send)', () => {
    entries.set('local|small', 8_000);
    const b = resolveContextFileBudget({ provider: 'local', model: 'small' });
    expect(b.maxChars).toBe(DEFAULT_CONTEXT_FILE_CHARS);
    expect(b.maxFiles).toBe(DEFAULT_CONTEXT_FILES);
  });
});
