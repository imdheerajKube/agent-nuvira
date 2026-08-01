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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutoModelRouter,
  getAutoRouter,
  resetAutoRouter,
  isAutoModel,
  isAutoProvider,
  computeWeights,
  scoreProvider,
  computeCostScore,
  estimateCallCostUsd,
  analyzeTaskProfile,
  PROVIDER_PRICING_PER_1K,
  AUTO_MODEL,
  AUTO_PROVIDER,
  DEFAULT_AUTO_PROVIDERS,
  type ProviderCapabilities,
  type ScoredProvider,
  type RoutingDimension,
} from '../../src/learning/auto-router.js';
import { resetRouterBandit, getRouterBandit } from '../../src/learning/router-bandit.js';

// ─── Bandit test isolation ─────────────────────────────────────────────────

let banditTempDir: string;

function isolateBandit() {
  banditTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-bandit-'));
  process.env.BUFF_MEMORY_DIR = banditTempDir;
  resetRouterBandit();
}

function cleanupBandit() {
  delete process.env.BUFF_MEMORY_DIR;
  resetRouterBandit();
  if (banditTempDir) {
    rmSync(banditTempDir, { recursive: true, force: true });
  }
}

// ─── Mocks for runtime-stats tests ─────────────────────────────────────────

const mockBenchmarkRuns = vi.hoisted(() => [] as any[]);
const mockBestModelFor = vi.hoisted(() => new Map<string, string>());

vi.mock('../../src/learning/benchmark.js', () => ({
  getBenchmarkRuns: vi.fn(() => mockBenchmarkRuns),
}));

vi.mock('../../src/learning/agent-stats.js', () => ({
  getAgentStats: vi.fn(() => ({
    getBestModel: vi.fn((agentType: string) => mockBestModelFor.get(agentType)),
  })),
}));

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

// ─── Task profile analysis ────────────────────────────────────────────────

describe('analyzeTaskProfile', () => {
  it('classifies verification-heavy tasks and recommends escalation', () => {
    const profile = analyzeTaskProfile('deploy to production and verify the rollout');
    expect(profile.intent).toBe('verification');
    expect(profile.requiresVerification).toBe(true);
    expect(profile.escalationTarget).toBe('openrouter');
  });

  it('classifies architecture and migration work as reasoning-heavy', () => {
    const architecture = analyzeTaskProfile('design a new microservice architecture for the platform');
    const migration = analyzeTaskProfile('migrate the auth service to the new deployment pipeline');
    expect(architecture.intent).toBe('architecture');
    expect(migration.intent).toBe('migration');
    expect(architecture.requiresVerification).toBe(true);
    expect(migration.requiresVerification).toBe(true);
    expect(architecture.escalationTarget).toBe('gemini');
  });

  it('keeps planning tasks lightweight by default', () => {
    const profile = analyzeTaskProfile('outline the authentication architecture');
    expect(profile.intent).toBe('planning');
    expect(profile.requiresVerification).toBe(false);
    expect(profile.escalationTarget).toBeUndefined();
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

  it('prefers a fast cheap model for trivial tasks (gemini free tier wins on cost + reasoning)', () => {
    const decision = router.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
    });
    // trivial complexity weights speed+cost highest; with REAL pricing gemini's
    // free tier ($0) plus high reasoning/speed edges out groq
    expect(decision.provider).toBe('gemini');
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

  it('flags verification-heavy tasks and escalates to a stronger provider when available', () => {
    const decision = router.resolve('writer', 'deploy to production and verify the rollout', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
    });
    expect(decision.taskProfile.requiresVerification).toBe(true);
    expect(['gemini', 'openrouter']).toContain(decision.provider);
    expect(decision.explanation).toContain('verification');
  });

  it('marks verification escalation when the router selects the escalation target', () => {
    const decision = router.resolve('writer', 'deploy to production and verify the rollout', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      maxCostUsd: 0.02,
    });
    expect(decision.escalationApplied).toBe(true);
    expect(decision.provider).toBe('openrouter');
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

// ─── Real Pricing ──────────────────────────────────────────────────────────

describe('real provider pricing', () => {
  it('prices free providers at $0', () => {
    expect(estimateCallCostUsd('local')).toBe(0);
    expect(estimateCallCostUsd('gemini')).toBe(0);
  });

  it('prices cloud providers above zero', () => {
    expect(estimateCallCostUsd('groq')).toBeGreaterThan(0);
    expect(estimateCallCostUsd('openrouter')).toBeGreaterThan(0);
  });

  it('maps zero cost to a 1.0 cost score', () => {
    expect(computeCostScore('local')).toBe(1.0);
    expect(computeCostScore('gemini')).toBe(1.0);
  });

  it('maps expensive providers to a lower cost score', () => {
    expect(computeCostScore('groq')).toBeLessThan(1.0);
    expect(computeCostScore('openrouter')).toBeLessThan(computeCostScore('local'));
  });

  it('clamps cost score to [0, 1]', () => {
    for (const p of ['local', 'groq', 'gemini', 'openrouter', 'nim']) {
      const score = computeCostScore(p);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('has pricing entries for all built-in providers', () => {
    for (const p of DEFAULT_AUTO_PROVIDERS) {
      expect(PROVIDER_PRICING_PER_1K[p]).toBeDefined();
    }
  });

  it('keeps static cost profiles when useRealPricing is false', () => {
    const r = new AutoModelRouter();
    const decision = r.resolve('writer', 'format this code', {
      allowedProviders: ['local', 'groq', 'gemini', 'openrouter'],
      useRealPricing: false,
    });
    // static trivial weights → groq wins on speed+cost as originally designed
    expect(decision.provider).toBe('groq');
  });
});

// ─── Pricing overrides ──────────────────────────────────────────────────────

describe('pricing overrides', () => {
  it('estimateCallCostUsd accepts a pricing override', () => {
    // Free override → $0 regardless of the built-in table
    expect(estimateCallCostUsd('groq', { inputPer1K: 0, outputPer1K: 0 })).toBe(0);
    // Expensive override
    expect(estimateCallCostUsd('groq', { inputPer1K: 0.05, outputPer1K: 0.05 })).toBeGreaterThan(0);
    // No override → built-in table
    expect(estimateCallCostUsd('groq')).toBe(0.00158); // 2*0.00059 + 0.5*0.00079
  });

  it('computeCostScore accepts a pricing override', () => {
    expect(computeCostScore('groq', { inputPer1K: 0, outputPer1K: 0 })).toBe(1.0);
    // Cost above the reference clamps to 0
    expect(computeCostScore('local', { inputPer1K: 0.05, outputPer1K: 0.05 })).toBe(0);
    expect(computeCostScore('groq')).toBeCloseTo(0.842, 2);
  });

  it('getProviderPricing falls back to the built-in table without config', () => {
    const router = new AutoModelRouter();
    expect(router.getProviderPricing('groq')).toEqual({ inputPer1K: 0.00059, outputPer1K: 0.00079 });
    expect(router.getProviderPricing('local')).toEqual({ inputPer1K: 0, outputPer1K: 0 });
    expect(router.getProviderPricing('unknown-provider')).toEqual({ inputPer1K: 0.0001, outputPer1K: 0.0001 });
  });

  it('getProviderPricing applies config overrides per field', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getAll: vi.fn(() => ({ pricing: { groq: { inputPer1K: 0.001 } } })),
    } as any;
    const pricing = router.getProviderPricing('groq', configManager);
    expect(pricing.inputPer1K).toBe(0.001);
    // Unset field falls back to the built-in value
    expect(pricing.outputPer1K).toBe(0.00079);
  });

  it('resolve honors pricing overrides from the config manager', () => {
    const configManager = {
      getAll: vi.fn(() => ({ pricing: { gemini: { inputPer1K: 0.05, outputPer1K: 0.05 } } })),
    } as any;
    const decision = new AutoModelRouter().resolve('writer', 'format this code', {
      allowedProviders: ['groq', 'gemini', 'local'],
    }, configManager);
    // Gemini loses its free-tier cost advantage → groq wins the trivial task on speed+cost
    expect(decision.provider).toBe('groq');
  });
});

// ─── Result weights ─────────────────────────────────────────────────────────

describe('AutoRouteResult.weights', () => {
  it('includes the effective normalized weights used for the decision', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a feature');
    expect(decision.weights).toBeDefined();
    const total = Object.values(decision.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    // Critical tasks weight reasoning above cost
    const critical = new AutoModelRouter().resolve('writer', 'deploy to production');
    expect(critical.weights.reasoning).toBeGreaterThan(critical.weights.cost);
  });
});

// ─── Runtime stats adjustment ───────────────────────────────────────────────

describe('useRuntimeStats', () => {
  beforeEach(() => {
    mockBenchmarkRuns.length = 0;
    mockBestModelFor.clear();
  });

  it('blends benchmark quality into the reasoning dimension', () => {
    mockBenchmarkRuns.push({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      summary: { avgQualityScore: 0.95 },
    });
    // No benchmark data for gemini — with runtime stats, groq's reasoning gets
    // boosted to 0.55*0.7 + 0.95*0.3 = 0.67 (measured data lifts its score)
    const r = new AutoModelRouter();
    const decision = r.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      useRuntimeStats: true,
    });
    // groq is now competitive on reasoning from measured data
    expect(decision.ranked.find((s) => s.provider === 'groq')!.dimensions.reasoning)
      .toBeGreaterThan(0);
    expect(decision.ranked.find((s) => s.provider === 'groq')!.reason)
      .toContain('stats-adjusted');
  });

  it('boosts reliability for the proven best model of the agent type', () => {
    mockBenchmarkRuns.push({
      provider: 'nim',
      model: 'meta/llama-3.1-8b-instruct',
      summary: { avgQualityScore: 0.5 },
    });
    mockBestModelFor.set('writer', 'nim/meta-llama-3.1-8b-instruct');

    const r = new AutoModelRouter();
    const decision = r.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'nim', 'gemini'],
      useRuntimeStats: true,
    });
    const nim = decision.ranked.find((s) => s.provider === 'nim')!;
    expect(nim.reason).toContain('stats-adjusted');
    // nim's reliability was boosted above its static 0.82
    expect(nim.dimensions.reliability).toBeGreaterThan(0.82 * 0.15);
  });

  it('does not adjust scores when useRuntimeStats is false', () => {
    mockBenchmarkRuns.push({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      summary: { avgQualityScore: 0.95 },
    });
    const r = new AutoModelRouter();
    const decision = r.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
    });
    expect(decision.ranked.find((s) => s.provider === 'groq')!.reason)
      .not.toContain('stats-adjusted');
  });

  it('handles missing runtime data gracefully', () => {
    const r = new AutoModelRouter();
    const decision = r.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      useRuntimeStats: true,
    });
    expect(decision.provider).toBeTruthy();
  });
});

// ─── Bandit learning (useBandit) ───────────────────────────────────────────

describe('AutoModelRouter.resolve with bandit learning', () => {
  beforeEach(() => {
    isolateBandit();
  });

  afterEach(() => {
    cleanupBandit();
  });

  it('marks the decision as bandit-routed when useBandit is enabled', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      useBandit: true,
    });
    expect(decision.routedBy).toBe('bandit');
    expect(decision.explanation).toContain('bandit-learned');
  });

  it('cold-start bandit still returns a valid provider', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    expect(['groq', 'gemini']).toContain(decision.provider);
  });

  it('marks the decision as heuristic when bandit is off', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form');
    expect(decision.routedBy).toBe('heuristic');
  });

  it('recordOutcome rewards the provider used for an agent type', () => {
    const router = new AutoModelRouter();
    // Route a task with the bandit on — the chosen provider is noted per agent type
    router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    router.recordOutcome('writer', 'implement a login form', 'success');
    // No crash, and the outcome lands in the bandit's learning history
    const state = getRouterBandit().getState();
    const history = state.learningHistory;
    expect(history.length).toBe(1);
    expect(history[0].outcome).toBe('success');
  });

  it('recordOutcome is a no-op when no decision was made for the agent type', () => {
    const router = new AutoModelRouter();
    expect(() => router.recordOutcome('planner', 'design architecture', 'failure')).not.toThrow();
  });
});

// ─── Credential-aware candidate filtering ─────────────────────────────────
// Regression: Auto routing must NEVER pick a provider with no API key
// configured (e.g. OpenRouter with no OPENROUTER_API_KEY → 401 on first call).
// When a ConfigManager is provided, unconfigured providers are excluded.

describe('AutoModelRouter.resolve credential filtering', () => {
  // NOTE: every mock configManager must include getAll() (returns { pricing: {} })
  // because resolve() calls getProviderPricing(provider, configManager) during
  // scoring, which reads configManager.getAll().pricing.
  function makeConfig(creds: (p: string) => boolean) {
    return {
      getAll: vi.fn(() => ({ pricing: {} })),
      hasRequiredCredentials: vi.fn((p: string) => creds(p)),
    } as any;
  }

  it('excludes providers without credentials when a configManager is provided', () => {
    const configManager = makeConfig((p) => p === 'groq' || p === 'local');
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    // nim/gemini/openrouter have no credentials → never ranked or picked
    expect(decision.ranked.every((s) => s.provider === 'groq' || s.provider === 'local')).toBe(true);
    expect(decision.provider).not.toBe('openrouter');
    expect(decision.provider).not.toBe('gemini');
  });

  it('falls back to all default providers when none have credentials (caller surfaces availability)', () => {
    const configManager = makeConfig(() => false);
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(DEFAULT_AUTO_PROVIDERS).toContain(decision.provider);
    expect(decision.provider).toBeTruthy();
  });

  it('explicit allowedProviders win over credential filtering', () => {
    const configManager = makeConfig(() => false);
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['openrouter'],
    }, configManager);
    expect(decision.provider).toBe('openrouter');
  });

  it('keeps local available without any API key (local needs no credentials)', () => {
    const configManager = makeConfig((p) => p === 'local');
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.every((s) => s.provider === 'local')).toBe(true);
    expect(decision.provider).toBe('local');
  });

  it('ignores credential filtering when configManager lacks hasRequiredCredentials', () => {
    const configManager = { getAll: vi.fn(() => ({})) } as any;
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    // No filter API → full default list is used
    expect(decision.ranked.length).toBe(DEFAULT_AUTO_PROVIDERS.length);
  });
});

// ─── Hard constraints ──────────────────────────────────────────────────────

describe('AutoModelRouter.resolve hard constraints', () => {
  it('maxCostUsd eliminates expensive providers', () => {
    const decision = new AutoModelRouter().resolve('writer', 'deploy to production', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      // openrouter's typical call (~$0.01+) exceeds this; groq/gemini pass
      maxCostUsd: 0.005,
    });
    expect(decision.provider).not.toBe('openrouter');
    expect(decision.ranked.every((s) => s.provider !== 'openrouter')).toBe(true);
  });

  it('minSpeed eliminates slow providers', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini', 'local'],
      minSpeed: 0.6,
    });
    expect(decision.provider).not.toBe('local'); // local speed = 0.55 < 0.6
  });

  it('minReasoning eliminates weak-reasoning providers', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      minReasoning: 0.8,
    });
    expect(['gemini', 'openrouter']).toContain(decision.provider);
  });

  it('falls back to the full ranking when constraints eliminate everyone', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini'],
      minReasoning: 0.99, // neither provider qualifies
    });
    expect(decision.provider).toBeTruthy();
    expect(decision.ranked.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Routing rules ─────────────────────────────────────────────────────────

describe('AutoModelRouter.resolve routing rules', () => {
  // The rule+bandit regression test writes bandit state, so isolate the whole
  // describe to avoid polluting the developer's real ~/.buff/memory and to
  // keep the singleton clean between tests.
  beforeEach(() => {
    isolateBandit();
  });

  afterEach(() => {
    cleanupBandit();
  });

  it('a matching rule forces the provider and marks routedBy = rule', () => {
    const decision = new AutoModelRouter().resolve('writer', 'generate a sales email for Acme Corp', {
      rules: [{
        name: 'marketing copy → groq',
        pattern: 'email|sales|copy',
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
      }],
    });
    expect(decision.provider).toBe('groq');
    expect(decision.model).toBe('llama-3.3-70b-versatile');
    expect(decision.routedBy).toBe('rule');
  });

  it('supports RegExp patterns', () => {
    const decision = new AutoModelRouter().resolve('writer', 'refactor the auth module', {
      rules: [{
        name: 'refactor → local',
        pattern: /refactor/i,
        provider: 'local',
      }],
    });
    expect(decision.provider).toBe('local');
  });

  it('first matching rule wins', () => {
    const decision = new AutoModelRouter().resolve('writer', 'deploy to production NOW', {
      rules: [
        { name: 'deploy → gemini', pattern: 'deploy', provider: 'gemini' },
        { name: 'urgent → openrouter', pattern: 'NOW', provider: 'openrouter' },
      ],
    });
    expect(decision.provider).toBe('gemini');
    expect(decision.explanation).toContain('deploy');
  });

  it('non-matching rules are ignored', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      rules: [{ name: 'irrelevant', pattern: 'sales|marketing', provider: 'openrouter' }],
    });
    expect(['groq', 'gemini']).toContain(decision.provider);
    expect(decision.routedBy).toBe('heuristic');
  });

  it('rule without model resolves the configured/default model', () => {
    const decision = new AutoModelRouter().resolve('writer', 'write a changelog entry', {
      rules: [{ name: 'changelog → gemini', pattern: 'changelog', provider: 'gemini' }],
    });
    expect(decision.provider).toBe('gemini');
    expect(decision.model).toBeTruthy();
  });

  it('notes the rule-forced provider so outcomes are attributed correctly', () => {
    const router = new AutoModelRouter();
    // Rule forces gemini for this writer task
    router.resolve('writer', 'write a sales email', {
      useBandit: true,
      rules: [{ name: 'sales → gemini', pattern: 'sales|email', provider: 'gemini' }],
    });
    router.recordOutcome('writer', 'write a sales email', 'failure');
    const state = getRouterBandit().getState();
    // The failure was recorded against the rule's provider, not a stale one
    expect(state.learningHistory.length).toBe(1);
    expect(state.learningHistory[0].provider).toBe('gemini');
    expect(state.learningHistory[0].outcome).toBe('failure');
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
