/**
 * ONE capability taxonomy, one ordering rule, and the guard at the seam every
 * caller uses.
 *
 * There were TWO band systems: `model-capability` (name-derived bands, used by
 * pinned handoffs and the router's capability floors) and this module's own
 * `capabilityFit` dimension (a task-relative fit). The same pair could be
 * `high` on one path and `low` on another, and the LOCAL tier held everything
 * from a 0.5B to a 120B with nothing ranking them by size — which is how an
 * agentic ask was answered by the weakest local model on the machine
 * (`trace-1791879575576-x731yp`).
 *
 * These tests pin the unification: the BAND comes from the model's name
 * (deterministic, one source), the WHERE axis (`local`) stays explicit, and
 * inside a tier the STRONGEST model goes first. The last block pins the same
 * rule at `resolveModel` — the function every surface calls for a model id.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTieredFailoverChain,
  classifyTier,
  type ModelCandidate,
} from '../../src/learning/model-first-router.js';
import { getAutoRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { getQuotaLedger, resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';
import { resetProviderFallback } from '../../src/learning/provider-fallback.js';

/** A complete candidate — the dimensions are what the scorer writes. */
function candidate(
  provider: string,
  model: string,
  capabilityFit: number,
  health = 1,
): ModelCandidate {
  return {
    provider,
    model,
    score: 0.8,
    dimensions: {
      costPerMToken: 0,
      costScore: 1,
      capabilityFit,
      health,
      quotaAvailability: 1,
      providerSpeed: 1,
      verification: 1,
    },
    reason: 'test candidate',
  };
}

describe('classifyTier — one band source', () => {
  it('reads the band from the model NAME, not from the task-relative fit', () => {
    // A tiny model fitted to a trivial task scores capabilityFit 0.9 — the old
    // taxonomy called that `high`. Its name says 1B, and the name wins.
    expect(classifyTier(candidate('groq', 'llama-3.2-1b-instruct', 0.9))).toBe('low');
    // The mirror: a strong name with a poor task fit is still a strong model.
    expect(classifyTier(candidate('groq', 'qwen2.5-72b-instruct', 0.2))).toBe('high');
    // An id with no signal is `medium` (unknown is not a failure) — never `low`.
    expect(classifyTier(candidate('groq', 'mystery-model', 0.1))).toBe('medium');
  });

  it('keeps the WHERE axis: a keyless local runner is its own tier whatever its size', () => {
    expect(classifyTier(candidate('local', 'qwen2.5:0.5b', 0.9))).toBe('local');
    expect(classifyTier(candidate('local', 'gpt-oss:120b-cloud', 0.9))).toBe('local');
  });
});

describe('strongest-first within a tier', () => {
  it('orders the LOCAL tier by capability, so a 0.5B never precedes a 120B', () => {
    const best = candidate('groq', 'llama-3.3-70b-versatile', 0.9);
    const all = [
      best,
      candidate('local', 'qwen2.5:0.5b', 0.9),
      candidate('local', 'gpt-oss:120b-cloud', 0.9),
    ];

    const tiers = buildTieredFailoverChain(best, all);
    const local = tiers.find((t) => t.phase === 'local');

    expect(local).toBeDefined();
    expect(local!.candidates.map((c) => c.model)).toEqual([
      'gpt-oss:120b-cloud',
      'qwen2.5:0.5b',
    ]);
  });
});

describe('resolveModel — the guard at the seam every caller uses', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  function makeConfig(): any {
    return {
      getAll: () => ({ providers: {}, routing: {} }),
      // Only the keyless `local` runner is usable.
      hasRequiredCredentials: vi.fn(() => false),
      getProviderConfig: () => ({ type: 'local', config: {} }),
    };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-one-taxonomy-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    resetQuotaLedger();
    resetModelRegistry();
    resetAutoRouter();
    resetRouterBandit();
    resetProviderFallback();
  });

  afterEach(() => {
    resetQuotaLedger();
    resetModelRegistry();
    resetAutoRouter();
    resetRouterBandit();
    resetProviderFallback();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('repairs a weak health-first pick to the strongest usable sibling', () => {
    const registry = getModelRegistry();
    // The WEAK model is the healthiest (lowest latency) — a health-first ranking
    // offers it first, which is exactly how a 0.5B became the resolved model.
    registry.markVerified('local', 'qwen2.5:0.5b', 'telemetry', 40);
    registry.markVerified('local', 'gpt-oss:120b-cloud', 'telemetry', 3_000);

    expect(getAutoRouter().resolveModel('local', 'chat', makeConfig())).toBe(
      'gpt-oss:120b-cloud',
    );
  });

  it('leaves an UNKNOWN-band pick alone (unknown is not a failure)', () => {
    getModelRegistry().markVerified('local', 'house-model-1', 'telemetry', 10);

    // No name signal → `medium`, so the guard does not second-guess it.
    expect(getAutoRouter().resolveModel('local', 'chat', makeConfig())).toBe('house-model-1');
  });

  it('keeps a weak pick when no stronger model is USABLE (a weak model beats none)', () => {
    const registry = getModelRegistry();
    registry.markVerified('local', 'qwen2.5:0.5b', 'telemetry', 40);
    registry.markVerified('local', 'gpt-oss:120b-cloud', 'telemetry', 3_000);
    // The strong sibling rests on its own quota window: it is still verified,
    // but not servable right now.
    getQuotaLedger().parkModel('local', 'gpt-oss:120b-cloud', Date.now() + 60_000, 'rate-limit');
    registry.syncQuota(undefined);

    expect(getAutoRouter().resolveModel('local', 'chat', makeConfig())).toBe('qwen2.5:0.5b');
  });
});
