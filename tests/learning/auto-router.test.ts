/**
 * Tests for AutoModelRouter — the "Use the right model for the right task"
 * routing engine.
 *
 * Coverage:
 * - isAutoModel / isAutoProvider helpers
 * - computeWeights — complexity baselines, preference-mode adjustments, overrides, normalization
 * - scoreProvider — weighted scoring math
 * - AutoModelRouter.resolve — complexity detection, provider selection per
 *   complexity, privacy-first routing, circuit-breaker deprioritization,
 *   allowedProviders restriction, fallback chain, explanation
 * - resolveModel / pickModelFromCatalog with and without a ConfigManager
 * - Singleton behavior
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoModelRouter,
  getAutoRouter,
  resetAutoRouter,
  isAutoModel,
  isAutoProvider,
  computeWeights,
  scoreProvider,
  AUTO_MODEL,
  AUTO_PROVIDER,
  DEFAULT_AUTO_PROVIDERS,
  type ProviderCapabilities,
  type ScoredProvider,
  type RoutingDimension,
} from '../../src/learning/auto-router.js';

// ─── isAutoModel / isAutoProvider ───────────────────────────────────────────

describe('isAutoModel / isAutoProvider', () => {
  it('recognizes the exact auto tokens', () => {
    expect(isAutoModel('auto')).toBe(true);
    expect(isAutoProvider('auto')).toBe(true);
  });

  it('rejects concrete models/providers', () => {
    expect(isAutoModel('llama-3.3-70b-versatile')).toBe(false);
    expect(isAutoModel('default')).toBe(false);
    expect(isAutoProvider('groq')).toBe(false);
    expect(isAutoProvider('gemini')).toBe(false);
  });

  it('handles undefined/null', () => {
    expect(isAutoModel(undefined)).toBe(false);
    expect(isAutoModel(null)).toBe(false);
    expect(isAutoProvider(undefined)).toBe(false);
  });

  it('exports the canonical constants', () => {
    expect(AUTO_MODEL).toBe('auto');
    expect(AUTO_PROVIDER).toBe('auto');
  });

  it('default auto providers include all built-ins', () => {
    for (const p of ['local', 'groq', 'nim', 'gemini', 'openrouter']) {
      expect(DEFAULT_AUTO_PROVIDERS).toContain(p);
    }
  });
});

// ─── computeWeights ─────────────────────────────────────────────────────────

describe('computeWeights', () => {
  it('returns normalized weights that sum to 1', () => {
    const weights = computeWeights('moderate');
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('weights every dimension', () => {
    const weights = computeWeights('simple');
    for (const dim of ['reasoning', 'speed', 'cost', 'privacy', 'reliability'] as RoutingDimension[]) {
      expect(weights[dim]).toBeDefined();
    }
  });

  it('cost + speed dominate for trivial tasks', () => {
    const w = computeWeights('trivial');
    expect(w.cost).toBeGreaterThan(w.reasoning);
    expect(w.speed).toBeGreaterThan(w.reasoning);
  });

  it('reasoning + reliability dominate for critical tasks', () => {
    const w = computeWeights('critical');
    expect(w.reasoning).toBeGreaterThan(w.cost);
    expect(w.reliability).toBeGreaterThan(w.cost);
  });

  it('privacy-first mode boosts privacy weight', () => {
    const balanced = computeWeights('moderate');
    const privacy = computeWeights('moderate', 'privacy-first');
    expect(privacy.privacy).toBeGreaterThan(balanced.privacy);
  });

  it('cost-first mode boosts cost weight', () => {
    const balanced = computeWeights('moderate');
    const costFirst = computeWeights('moderate', 'cost-first');
    expect(costFirst.cost).toBeGreaterThan(balanced.cost);
  });

  it('performance-first mode boosts reasoning + speed', () => {
    const balanced = computeWeights('moderate');
    const perf = computeWeights('moderate', 'performance-first');
    expect(perf.reasoning).toBeGreaterThan(balanced.reasoning);
    expect(perf.speed).toBeGreaterThan(balanced.speed);
  });

  it('applies manual overrides on top of everything', () => {
    const w = computeWeights('complex', 'balanced', { privacy: 1.0, reasoning: 0.01, speed: 0.01, cost: 0.01, reliability: 0.01 });
    // After normalization privacy remains the dominant dimension
    expect(w.privacy).toBeGreaterThan(0.9);
    expect(w.privacy).toBeGreaterThan(w.reasoning);
  });

  it('normalizes after overrides so the sum stays 1', () => {
    const w = computeWeights('moderate', 'balanced', { cost: 5, speed: 5 });
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('clamps negative adjustments at zero before normalization', () => {
    const w = computeWeights('simple', 'cost-first');
    for (const dim of Object.keys(w) as RoutingDimension[]) {
      expect(w[dim]).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── scoreProvider ──────────────────────────────────────────────────────────

describe('scoreProvider', () => {
  it('scores a provider by weighted capabilities', () => {
    const caps: ProviderCapabilities = {
      reasoning: 1.0, speed: 0.5, cost: 0.5, privacy: 0.1, reliability: 0.5,
    };
    const weights = computeWeights('critical');
    const { score, dimensions, weightTotal } = scoreProvider('gemini', caps, weights);
    expect(score).toBeGreaterThan(0);
    expect(dimensions.reasoning).toBeCloseTo(weights.reasoning * 1.0, 10);
    expect(weightTotal).toBeCloseTo(1, 10);
  });

  it('a perfect provider scores equal to the weight total', () => {
    const perfect: ProviderCapabilities = {
      reasoning: 1, speed: 1, cost: 1, privacy: 1, reliability: 1,
    };
    const weights = computeWeights('moderate');
    const { score } = scoreProvider('perfect', perfect, weights);
    expect(score).toBeCloseTo(1, 10);
  });

  it('a zero-capability provider scores zero', () => {
    const zero: ProviderCapabilities = {
      reasoning: 0, speed: 0, cost: 0, privacy: 0, reliability: 0,
    };
    const weights = computeWeights('moderate');
    const { score } = scoreProvider('zero', zero, weights);
    expect(score).toBe(0);
  });
});

// ─── AutoModelRouter.resolve ────────────────────────────────────────────────

describe('AutoModelRouter.resolve', () => {
  let router: AutoModelRouter;

  beforeEach(() => {
    router = new AutoModelRouter();
  });

  it('returns a valid decision with provider/model/explanation', () => {
    const decision = router.resolve('writer', 'implement a login form');
    expect(decision.agentType).toBe('writer');
    expect(decision.provider).toBeTruthy();
    expect(decision.model).toBeTruthy();
    expect(decision.explanation.length).toBeGreaterThan(10);
    expect(decision.ranked.length).toBeGreaterThanOrEqual(1);
  });

  it('detects complexity from the task description', () => {
    expect(router.resolve('writer', 'format this code').complexity).toBe('trivial');
    expect(router.resolve('writer', 'deploy to production').complexity).toBe('critical');
  });

  it('maps the agent type to a task type', () => {
    const decision = router.resolve('writer', 'implement something');
    expect(decision.taskType).toBeTruthy();
  });

  it('prefers a fast cheap model for trivial tasks (groq wins on speed+cost)', () => {
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
    });
    // trivial complexity weights speed+cost highest; groq has max speed + high cost score
    expect(decision.provider).toBe('groq');
  });

  it('prefers a strong provider for critical tasks', () => {
    const decision = router.resolve('writer', 'deploy to production', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
    });
    // critical weights reasoning+reliability highest; openrouter has best reasoning
    expect(['openrouter', 'gemini']).toContain(decision.provider);
  });

  it('routes to local when privacy-first even for complex tasks', () => {
    const decision = router.resolve('writer', 'implement distributed microservices', {
      preferenceMode: 'privacy-first',
      allowedProviders: ['local', 'groq', 'gemini'],
    });
    expect(decision.provider).toBe('local');
  });

  it('restricts candidates to allowedProviders', () => {
    const decision = router.resolve('planner', 'design system architecture', {
      allowedProviders: ['groq'],
    });
    expect(decision.provider).toBe('groq');
    expect(decision.ranked.length).toBe(1);
  });

  it('sinks circuit-breaker cooldown providers below healthy ones', () => {
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      circuitBreakerStatus: [{ provider: 'openrouter', cooldownRemaining: 30_000 }],
    });
    // openrouter must not be selected while in cooldown
    expect(decision.provider).not.toBe('openrouter');
    // but still appears in ranked (last)
    expect(decision.ranked[decision.ranked.length - 1].provider).toBe('openrouter');
    expect(decision.ranked.find((s) => s.provider === 'openrouter')?.inCooldown).toBe(true);
  });

  it('falls back to a cooldown provider when ALL are in cooldown', () => {
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      circuitBreakerStatus: [
        { provider: 'groq', cooldownRemaining: 10_000 },
        { provider: 'gemini', cooldownRemaining: 10_000 },
      ],
    });
    expect(['groq', 'gemini']).toContain(decision.provider);
  });

  it('sorts ranked providers best-first', () => {
    const decision = router.resolve('writer', 'implement a feature');
    const scores = decision.ranked.map((s) => s.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('builds a fallback chain excluding the selected provider', () => {
    const decision = router.resolve('writer', 'implement a feature');
    const chainProviders = decision.fallbackChain.map((c) => c.provider);
    expect(chainProviders).not.toContain(decision.provider);
    expect(chainProviders.length).toBeGreaterThanOrEqual(1);
  });

  it('fallback chain candidates have valid shape', () => {
    const decision = router.resolve('writer', 'implement a feature');
    for (const c of decision.fallbackChain) {
      expect(c.provider).toBeTruthy();
      expect(c.model).toBeTruthy();
      expect(typeof c.qualityScore).toBe('number');
      expect(c.reason).toBeTruthy();
    }
  });

  it('ranks the selected provider first when not in cooldown', () => {
    const decision = router.resolve('writer', 'implement a feature');
    expect(decision.ranked[0].provider).toBe(decision.provider);
  });

  it('includes the score on the result', () => {
    const decision = router.resolve('writer', 'implement a feature');
    expect(decision.score).toBeGreaterThan(0);
    expect(decision.score).toBeLessThanOrEqual(1);
  });

  it('produces per-dimension contributions in ranked entries', () => {
    const decision = router.resolve('writer', 'implement a feature');
    const first = decision.ranked[0] as ScoredProvider;
    expect(first.dimensions.reasoning).toBeDefined();
    expect(first.weightTotal).toBeCloseTo(1, 5);
  });

  it('respects custom profiles passed to the constructor', () => {
    const customRouter = new AutoModelRouter({
      myprovider: { reasoning: 0.9, speed: 0.9, cost: 0.9, privacy: 0.9, reliability: 0.9 },
    });
    const decision = customRouter.resolve('writer', 'implement a feature', {
      allowedProviders: ['myprovider', 'local'],
    });
    expect(decision.provider).toBe('myprovider');
  });

  it('updateProfiles overrides existing profiles', () => {
    router.updateProfiles({
      local: { reasoning: 1.0, speed: 1.0, cost: 1.0, privacy: 1.0, reliability: 1.0 },
    });
    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['local', 'groq'],
    });
    expect(decision.provider).toBe('local');
  });
});

// ─── resolveModel / pickModelFromCatalog ────────────────────────────────────

describe('resolveModel / pickModelFromCatalog', () => {
  it('returns default when no configManager is provided', () => {
    const router = new AutoModelRouter();
    expect(router.resolveModel('groq', 'writer')).toBe('default');
  });

  it('returns the configured model when a configManager is provided', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'llama-3.3-70b-versatile' } })),
    } as any;
    expect(router.resolveModel('groq', 'writer', configManager)).toBe('llama-3.3-70b-versatile');
  });

  it('falls back to default when config lookup throws', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => { throw new Error('unknown provider'); }),
    } as any;
    expect(router.resolveModel('unknown', 'writer', configManager)).toBe('default');
  });

  it('pickModelFromCatalog prefers the configured model', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'configured-model' } })),
    } as any;
    expect(router.pickModelFromCatalog('groq', [{ id: 'model-a' }], configManager)).toBe('configured-model');
  });

  it('pickModelFromCatalog picks the first non-speech model when no config', () => {
    const router = new AutoModelRouter();
    expect(router.pickModelFromCatalog('groq', [
      { id: 'whisper', tags: ['speech'] },
      { id: 'llama-3.3', tags: [] },
    ])).toBe('llama-3.3');
  });

  it('pickModelFromCatalog returns default when no usable model exists', () => {
    const router = new AutoModelRouter();
    expect(router.pickModelFromCatalog('groq', [])).toBe('default');
  });
});

// ─── Singleton ──────────────────────────────────────────────────────────────

describe('singleton', () => {
  afterEach(() => {
    resetAutoRouter();
  });

  it('getAutoRouter returns an instance', () => {
    expect(getAutoRouter()).toBeInstanceOf(AutoModelRouter);
  });

  it('getAutoRouter returns the same instance on repeated calls', () => {
    expect(getAutoRouter()).toBe(getAutoRouter());
  });

  it('resetAutoRouter creates a new instance on next call', () => {
    const a = getAutoRouter();
    resetAutoRouter();
    const b = getAutoRouter();
    expect(a).not.toBe(b);
  });
});
