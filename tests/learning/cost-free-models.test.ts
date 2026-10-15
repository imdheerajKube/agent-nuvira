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
  setPricingContext,
  resetPricingContextCache,
} from '../../src/learning/cost-tracker.js';
import type { PricingContext } from '../../src/learning/cost-classification.js';

/** A context that declares ONE provider `paid` — no config file needed. */
function paidContext(provider: string): PricingContext {
  return {
    billingTierFor: (p) => (p === provider ? 'paid' : 'unknown'),
    configPricingFor: () => undefined,
  };
}

/** A context that declares ONE provider a free tier. */
function unbilledContext(provider: string): PricingContext {
  return {
    billingTierFor: (p) => (p === provider ? 'free' : 'unknown'),
    configPricingFor: () => undefined,
  };
}

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

  it('omits the reported flag when no cost was reported', () => {
    const entry = new CostTracker().recordCall('groq', 'llama-3.3-70b-versatile', 100, 50);
    expect(entry.costReported).toBeUndefined();
    // The list price is still recorded — as `listPriceUsd` — but with the account
    // tier UNDECLARED it is not counted as billed. Charging it as `costUsd` here
    // is exactly the fabrication this change removes (a free Groq tier was billed
    // a 70B-class list rate on a real profile).
    expect(entry.listPriceUsd).toBeGreaterThan(0);
    expect(entry.costUsd).toBe(0);
    expect(entry.costSource).toBe('catalog');
    expect(entry.billingTier).toBe('unknown');
    expect(entry.pricingBasis).toContain('undeclared');
  });

  it('counts a list-priced call as billed once the account is declared paid', () => {
    setPricingContext(paidContext('groq'));
    try {
      const entry = new CostTracker().recordCall('groq', 'llama-3.3-70b-versatile', 1000, 1000);
      expect(entry.billingTier).toBe('paid');
      expect(entry.costSource).toBe('catalog');
      // 1000/1000 × ($0.00059 + $0.00079 per 1K) — the catalog's own Groq price.
      expect(entry.costUsd).toBeCloseTo(0.00138, 6);
      expect(entry.pricingBasis).toContain('estimated bill');
    } finally {
      resetPricingContextCache();
    }
  });

  it('bills a declared free tier $0 and reports the list price as value', () => {
    setPricingContext(unbilledContext('groq'));
    try {
      const entry = new CostTracker().recordCall('groq', 'llama-3.3-70b-versatile', 1000, 1000);
      expect(entry.costUsd).toBe(0);
      expect(entry.costSource).toBe('free');
      expect(entry.billingTier).toBe('free');
      expect(entry.listPriceUsd).toBeCloseTo(0.00138, 6);
      expect(entry.pricingBasis).toContain('free tier');
    } finally {
      resetPricingContextCache();
    }
  });

  it('records NO price (unpriced) for a provider the catalog does not describe', () => {
    const entry = new CostTracker().recordCall('some-unknown-provider', 'mystery-model', 1000, 1000);
    expect(entry.costUsd).toBe(0);
    expect(entry.costSource).toBe('unknown');
    expect(entry.listPriceUsd).toBeUndefined();
    expect(entry.pricingBasis).toContain('no price evidence');
  });

  it('treats a keyless pass-through gateway as unpriced, never as $0 spend', () => {
    // omniroute runs on localhost and forwards elsewhere: the catalog declares its
    // own price as 0, and that zero means "not priced here", not "free here".
    const entry = new CostTracker().recordCall('omniroute', 'auto', 1000, 1000);
    expect(entry.costUsd).toBe(0);
    expect(entry.costSource).toBe('passthrough');
    expect(entry.listPriceUsd).toBeUndefined();
  });

  it('tags the row with its origin, so a test run can be told from real usage', () => {
    const entry = new CostTracker().recordCall('groq', 'llama-3.3-70b-versatile', 10, 10);
    // This file runs under vitest → the registry's own origin rule says `test`.
    expect(entry.origin).toBe('test');
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
