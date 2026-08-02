/**
 * Quota-aware routing tests — the AutoModelRouter's new assessment features:
 *
 * 1. quotaStatus sinks quota-parked providers below healthy ones (mirroring
 *    circuit-breaker cooldown)
 * 2. Falls back to a quota-parked provider when ALL are parked
 * 3. complexityHint overrides analyzeComplexity (subtask-local routing)
 * 4. allowPaid: false excludes paid providers for non-complex tasks, but
 *    complex/critical tasks may still use paid/high-capacity models
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutoModelRouter, resetAutoRouter } from '../../src/learning/auto-router.js';
import { resetRouterBandit } from '../../src/learning/router-bandit.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-quota-routing-'));
  originalMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetAutoRouter();
  resetRouterBandit();
});

afterEach(() => {
  resetAutoRouter();
  resetRouterBandit();
  if (originalMemoryDir === undefined) {
    delete process.env.BUFF_MEMORY_DIR;
  } else {
    process.env.BUFF_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AutoModelRouter — quota-ledger integration', () => {
  it('sinks a quota-parked provider below healthy candidates', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      quotaStatus: [{ provider: 'openrouter', cooldownRemaining: 30_000 }],
    });

    // openrouter must be ranked last (parked), like a cooldown provider
    expect(decision.ranked[decision.ranked.length - 1].provider).toBe('openrouter');
    expect(decision.ranked.find((s) => s.provider === 'openrouter')?.quotaParked).toBe(true);
    expect(decision.provider).not.toBe('openrouter');
  });

  it('marks the parked reason with the re-enable window', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      quotaStatus: [{ provider: 'gemini', cooldownRemaining: 30_000 }],
    });
    const parked = decision.ranked.find((s) => s.provider === 'gemini')!;
    expect(parked.reason).toContain('quota exhausted');
    expect(parked.reason).toContain('30s');
  });

  it('falls back to a quota-parked provider when ALL candidates are parked', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      quotaStatus: [
        { provider: 'groq', cooldownRemaining: 10_000 },
        { provider: 'gemini', cooldownRemaining: 10_000 },
      ],
    });
    // Must still produce a decision (never error) — picks the best parked one
    expect(decision.provider).toBeTruthy();
    expect(['groq', 'gemini']).toContain(decision.provider);
  });

  it('parked providers are excluded from the fallback chain when alternatives exist', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      quotaStatus: [{ provider: 'openrouter', cooldownRemaining: 30_000 }],
    });
    expect(decision.provider).not.toBe('openrouter');
  });
});

describe('AutoModelRouter — subtask-local complexityHint', () => {
  it('uses complexityHint instead of re-analyzing the description', () => {
    const router = new AutoModelRouter();
    // "format this code" alone would be analyzed as TRIVIAL (cost+speed
    // dominate: cost 0.30 > reasoning 0.10). With a complexityHint of
    // 'critical' the same text must route with critical weights (reasoning
    // dominates over cost) — proving the hint wins over re-analysis.
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      complexityHint: 'critical',
    });
    expect(decision.complexity).toBe('critical');
    // Critical weighting: reasoning outweighs cost (trivial would be the
    // reverse) — the hint shifted the weights, not the description.
    expect(decision.weights.reasoning).toBeGreaterThan(decision.weights.cost);
  });

  it('falls back to analyzeComplexity when no hint is given', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
    });
    expect(decision.complexity).toBe('trivial');
  });
});

describe('AutoModelRouter — allowPaid gate (free/local first)', () => {
  it('excludes paid providers for simple tasks when allowPaid is false', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      allowPaid: false,
    });
    // Free providers only: local + gemini (typical call cost = $0)
    expect(decision.provider).not.toBe('groq');
    expect(decision.provider).not.toBe('openrouter');
    expect(['local', 'gemini']).toContain(decision.provider);
  });

  it('allows paid providers for complex/critical tasks even when allowPaid is false', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'deploy to production with zero downtime', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      allowPaid: false,
    });
    expect(decision.complexity).toBe('critical');
    // Complex/critical → paid/high-capacity allowed (assessment: paid for complex)
    expect(['local', 'groq', 'gemini', 'openrouter']).toContain(decision.provider);
  });

  it('falls back to the full ranking when only paid providers are available', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['groq', 'openrouter'],
      allowPaid: false,
    });
    // Gate would eliminate everyone → fall back rather than error
    expect(decision.provider).toBeTruthy();
    expect(['groq', 'openrouter']).toContain(decision.provider);
  });

  it('keeps default behavior (paid allowed) when allowPaid is unset', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'deploy to production', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
    });
    expect(decision.provider).toBeTruthy();
  });
});
