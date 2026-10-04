/**
 * Free-model + provider-reported cost accounting.
 *
 * Two truths this pins:
 *   1. A model that provably costs nothing per call (a provider-declared `:free`
 *      id, or a keyless local runtime) must bill $0 — never a generic rate that
 *      invents spend the user did not pay.
 *   2. When a provider reports the EXACT cost of a call (OpenRouter's
 *      `usage.cost`), that figure is authoritative and is recorded verbatim —
 *      including a reported $0 — instead of a locally-computed estimate.
 *
 * Storage is isolated through NUVIRA_MEMORY_DIR so no real profile is touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CostTracker,
  calculateCost,
  isFreeModel,
  recordCallWithUsage,
} from '../../src/learning/cost-tracker.js';

let memDir: string;
let prevMemDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-free-cost-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  prevCfgDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
  process.env.NUVIRA_CONFIG_DIR = join(memDir, 'cfg');
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  rmSync(memDir, { recursive: true, force: true });
});

describe('isFreeModel — the one authority for "does this cost anything"', () => {
  it('treats a provider-declared :free id as free', () => {
    expect(isFreeModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
  });

  it('treats a keyless local runtime as free', () => {
    expect(isFreeModel('local', 'llama3.2')).toBe(true);
    expect(isFreeModel('ollama', 'qwen2.5')).toBe(true);
  });

  it('does NOT treat a metered model as free', () => {
    expect(isFreeModel('groq', 'llama-3.3-70b-versatile')).toBe(false);
    expect(isFreeModel('openrouter', 'anthropic/claude-3.5-sonnet')).toBe(false);
  });

  it('does NOT treat a zero-catalog-price keyed provider as free (Gemini caveat)', () => {
    // Gemini lists 0/0 but paid models 403 without billing — unknown, not free.
    expect(isFreeModel('gemini', 'gemini-2.0-flash')).toBe(false);
  });
});

describe('calculateCost — free models bill $0', () => {
  it('returns 0 for an OpenRouter :free id regardless of token count', () => {
    expect(calculateCost('openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 100000, 100000)).toBe(0);
  });

  it('returns 0 for a local runtime', () => {
    expect(calculateCost('local', 'llama3.2', 50000, 50000)).toBe(0);
  });

  it('still bills a metered model (no regression)', () => {
    expect(calculateCost('groq', 'llama-3.3-70b-versatile', 1000, 1000)).toBeGreaterThan(0);
  });
});

describe('calculateCost — provider-reported cost wins', () => {
  it('returns the reported figure verbatim for a metered model', () => {
    expect(calculateCost('openrouter', 'anthropic/claude-3.5-sonnet', 1000, 1000, 0.0042)).toBe(0.0042);
  });

  it('honors a reported zero as a true zero', () => {
    expect(calculateCost('openrouter', 'anthropic/claude-3.5-sonnet', 1000, 1000, 0)).toBe(0);
  });

  it('ignores a non-finite reported value and falls back to the price table', () => {
    expect(calculateCost('groq', 'llama-3.3-70b-versatile', 1000, 1000, Number.NaN)).toBeGreaterThan(0);
  });
});

describe('CostTracker.recordCall — reported cost is stored and flagged', () => {
  it('marks costReported and stores the reported cost', () => {
    const entry = new CostTracker().recordCall(
      'openrouter',
      'anthropic/claude-3.5-sonnet',
      100,
      50,
      undefined,
      true,
      0.00123,
    );
    expect(entry.costUsd).toBe(0.00123);
    expect(entry.costReported).toBe(true);
    expect(entry.measured).toBe(true);
  });

  it('omits the flag when no cost was reported', () => {
    const entry = new CostTracker().recordCall('groq', 'llama-3.3-70b-versatile', 100, 50);
    expect(entry.costReported).toBeUndefined();
    expect(entry.costUsd).toBeGreaterThan(0);
  });
});

describe('recordCallWithUsage — measured usage + carried cost', () => {
  it('records measured tokens with the cost carried on the usage object', () => {
    const tracker = new CostTracker();
    recordCallWithUsage(tracker, 'openrouter', 'anthropic/claude-3.5-sonnet', 'prompt', 'answer', {
      promptTokens: 120,
      completionTokens: 30,
      costUsd: 0.0099,
    });

    const entries = tracker.getAllEntries();
    const entry = entries[entries.length - 1];
    expect(entry.measured).toBe(true);
    expect(entry.inputTokens).toBe(120);
    expect(entry.outputTokens).toBe(30);
    expect(entry.costUsd).toBe(0.0099);
    expect(entry.costReported).toBe(true);
  });

  it('falls back to an estimate (still honoring a reported cost) when usage is absent', () => {
    const tracker = new CostTracker();
    recordCallWithUsage(tracker, 'openrouter', 'anthropic/claude-3.5-sonnet', 'hello world', 'ok', undefined, 0.002);

    const entries = tracker.getAllEntries();
    const entry = entries[entries.length - 1];
    expect(entry.measured).toBeUndefined();
    expect(entry.costUsd).toBe(0.002);
    expect(entry.costReported).toBe(true);
    expect(entry.inputTokens).toBeGreaterThan(0);
  });
});
