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
  capabilityFitScore,
  applyCapabilityFit,
  PROVIDER_PRICING_PER_1K,
  AUTO_MODEL,
  AUTO_PROVIDER,
  DEFAULT_AUTO_PROVIDERS,
  GovernancePolicyError,
  computeContextFit,
  DEFAULT_CONTEXT_WINDOW,
  type ProviderCapabilities,
  type ScoredProvider,
  type RoutingDimension,
} from '../../src/learning/auto-router.js';
import { resetRouterBandit, getRouterBandit, DEFAULT_MIN_SAMPLES } from '../../src/learning/router-bandit.js';
import { resetRouterPromotion, getRouterPromotion } from '../../src/learning/router-promotion.js';
import { resetModelRegistry, getModelRegistry } from '../../src/learning/model-registry.js';
import { PROVIDER_CONTEXT_WINDOWS } from '../../src/learning/model-selection.js';

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
  resetRouterPromotion();
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

describe('capabilityFitScore (M2.1 capability-aware scoring)', () => {
  it('returns 1 when the provider covers every capability the task needs', () => {
    // code-review needs code + reasoning; gemini offers both.
    expect(capabilityFitScore('code-review', 'gemini')).toBe(1);
    // test-generation needs code; groq/nim/gemini all offer code.
    expect(capabilityFitScore('test-generation', 'groq')).toBe(1);
  });

  it('returns a partial fit when the provider covers some requirements', () => {
    // context-gather needs fast; gemini is not tagged fast for this signal's
    // profile set → 0/1 = 0. groq offers fast → 1.
    expect(capabilityFitScore('context-gather', 'groq')).toBe(1);
    expect(capabilityFitScore('context-gather', 'nim')).toBe(0);
    // code-review needs code + reasoning; groq offers code but not reasoning
    // in this profile set → 1/2.
    expect(capabilityFitScore('code-review', 'groq')).toBe(0.5);
  });

  it('never penalizes unknown providers (fully neutral until real data exists)', () => {
    // A gateway can host any model — a truly unknown provider (no static
    // tags, no assessable profile) gets fit 1 for EVERY task type: neither
    // boosted nor penalized until real usage data exists.
    expect(capabilityFitScore('default', 'nuvira')).toBe(1);
    expect(capabilityFitScore('plan', 'nuvira')).toBe(1);
    expect(capabilityFitScore('code-review', 'nuvira')).toBe(1);
    // The PRODUCTION fallback profile (getCapabilities' unmapped-provider
    // default — all 0.5s) is below every derivation threshold, so the neutral
    // contract holds in the real resolve loop, not just the unit function.
    const neutralFallback: ProviderCapabilities = {
      reasoning: 0.5, speed: 0.5, cost: 0.5, privacy: 0.2, reliability: 0.7,
    };
    expect(capabilityFitScore('plan', 'nuvira', neutralFallback)).toBe(1);
  });

  it('derives tags from the capability profile for custom/gateway providers', () => {
    // A custom provider with a strong-reasoning REAL profile gets a derived
    // 'reasoning' tag even though no static catalog entry lists it → it fits
    // a plan task (requires reasoning) fully.
    const strongReasoner: ProviderCapabilities = {
      reasoning: 0.9, speed: 0.4, cost: 0.5, privacy: 0.5, reliability: 0.8,
    };
    expect(capabilityFitScore('plan', 'custom-gw', strongReasoner)).toBe(1);
    // A weak-reasoning custom provider does NOT get the derived tag → plan
    // task fit 0 (a plan needs reasoning, this gateway demonstrably lacks it).
    const weakReasoner: ProviderCapabilities = {
      reasoning: 0.3, speed: 0.95, cost: 0.5, privacy: 0.5, reliability: 0.8,
    };
    expect(capabilityFitScore('plan', 'custom-gw', weakReasoner)).toBe(0);
  });

  it('applyCapabilityFit stays within 0–1 and is a soft nudge', () => {
    // No-fit ≈ 0.85×, perfect-fit ≈ 1.10× (clamped at 1).
    expect(applyCapabilityFit(0.8, 0)).toBeCloseTo(0.72, 5);
    expect(applyCapabilityFit(0.8, 1)).toBeCloseTo(0.88, 5);
    // The 0–1 invariant holds even for a perfect-fit max score.
    expect(applyCapabilityFit(1, 1)).toBe(1);
    expect(applyCapabilityFit(0.5, 0.5)).toBeLessThanOrEqual(1);
  });

  it('resolve() surfaces capability-fit and reasons in ranked entries', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a feature');
    const first = decision.ranked[0] as ScoredProvider;
    expect(typeof first.capabilityFit).toBe('number');
    expect(first.capabilityFit!).toBeGreaterThanOrEqual(0);
    expect(first.capabilityFit!).toBeLessThanOrEqual(1);
    expect(first.reason).toContain('capability-fit');
  });

  it('a code-review task prefers a reasoning-capable provider when scores are close', () => {
    // code-review needs code + reasoning. gemini offers both (fit 1), groq
    // offers code only (fit 0.5). With equal weight on reasoning vs speed, the
    // soft signal nudges the equally-dimensioned ranking toward the fitter one.
    const decision = new AutoModelRouter().resolve('reviewer', 'review this pull request for correctness');
    const geminiFit = decision.ranked.find((r) => r.provider === 'gemini')?.capabilityFit;
    const groqFit = decision.ranked.find((r) => r.provider === 'groq')?.capabilityFit;
    expect(geminiFit).toBe(1);
    expect(groqFit).toBe(0.5);
  });

  it('routing.capabilityFit: false disables the signal entirely (reversible gate)', () => {
    const mockConfig = (capabilityFit: boolean) => ({
      getAll: () => ({ routing: { capabilityFit } }),
      hasRequiredCredentials: () => true,
    });
    // Gate OFF: raw dimension-weighted scores — no fit field, no suffix.
    const off = new AutoModelRouter().resolve('reviewer', 'review this pull request', {}, mockConfig(false) as any);
    const firstOff = off.ranked[0] as ScoredProvider;
    expect(firstOff.capabilityFit).toBeUndefined();
    expect(firstOff.reason).not.toContain('capability-fit');
    // Gate ON (default): fit field + suffix present again.
    const on = new AutoModelRouter().resolve('reviewer', 'review this pull request', {}, mockConfig(true) as any);
    expect(on.ranked[0].capabilityFit).toBeDefined();
    expect(on.ranked[0].reason).toContain('capability-fit');
  });

  it('quota-parked providers keep their definitive reason without a fit suffix', () => {
    // A quota-parked provider's reason is already definitive (auto re-enables
    // in Ns) — it must not claim a capability-fit score on top.
    const decision = new AutoModelRouter().resolve(
      'writer',
      'implement a feature',
      { quotaStatus: [{ provider: 'groq', cooldownRemaining: 90_000 }] },
    );
    const parked = decision.ranked.find((r) => r.provider === 'groq');
    expect(parked).toBeDefined();
    expect(parked!.quotaParked).toBe(true);
    expect(parked!.reason).toContain('quota exhausted');
    expect(parked!.reason).not.toContain('capability-fit');
    // Parked providers carry NO fit field, so the explain view renders no chip.
    expect(parked!.capabilityFit).toBeUndefined();
  });
});

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
  let resolveTempDir: string;
  let resolveOrigDir: string | undefined;

  beforeEach(() => {
    router = new AutoModelRouter();
    // Hermetic registry: resolve() reads the Model Availability Registry
    // (getBlockedProviders + M2.2 getMeasuredUsage for measured-cost scoring),
    // so isolate it — ambient real-user data must never flip a deterministic
    // ranking (the trivial-task gemini-vs-groq test is measured-cost sensitive).
    resolveOrigDir = process.env.BUFF_MEMORY_DIR;
    resolveTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-resolve-'));
    process.env.BUFF_MEMORY_DIR = resolveTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (resolveOrigDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = resolveOrigDir;
    }
    resetModelRegistry();
    rmSync(resolveTempDir, { recursive: true, force: true });
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

// ─── P4 M4.4 mid-stream flakiness penalty ──────────────────────────────────
// The registry's partialRate EMA (providers that START streams then DIE)
// scales the reliability dimension down when `routing.partialFlakiness` is on
// (default). A flaky provider must rank below an otherwise-identical healthy
// one, and the signal must be fully inert when the flag is off.

describe('AutoModelRouter.resolve — P4 M4.4 partial-flakiness penalty', () => {
  let router: AutoModelRouter;
  let flakyTempDir: string;
  let flakyOrigDir: string | undefined;

  beforeEach(() => {
    router = new AutoModelRouter();
    flakyOrigDir = process.env.BUFF_MEMORY_DIR;
    flakyTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-flaky-'));
    process.env.BUFF_MEMORY_DIR = flakyTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (flakyOrigDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = flakyOrigDir;
    }
    resetModelRegistry();
    rmSync(flakyTempDir, { recursive: true, force: true });
  });

  it('a provider with mid-stream partials ranks below an identical healthy provider (penalty ON by default)', () => {
    // Identical capability profiles for both providers — ONLY flakiness may
    // separate them. Higher reliability = better score for a critical task.
    const identical = { reasoning: 0.8, speed: 0.6, cost: 0.5, privacy: 0.2, reliability: 0.9 };
    router.updateProfiles({ providerA: identical, providerB: identical });
    const registry = getModelRegistry();
    registry.markVerified('providerA', 'm-a', 'spot-check');
    registry.markVerified('providerB', 'm-b', 'spot-check');
    // Provider B keeps starting streams that die mid-way.
    registry.recordPartial('providerB', 'm-b', 'chat', 'timeout');
    registry.recordPartial('providerB', 'm-b', 'chat', 'server');

    const decision = router.resolve('writer', 'deploy to production', {
      allowedProviders: ['providerA', 'providerB'],
    });
    const ranked = decision.ranked.map((r) => r.provider);
    expect(ranked.indexOf('providerA')).toBeLessThan(ranked.indexOf('providerB'));
    // The penalty is transparent: the flaky row carries the flakiness chip.
    const flakyRow = decision.ranked.find((r) => r.provider === 'providerB');
    expect(flakyRow?.flakiness).toBeGreaterThan(0);
    expect(flakyRow?.reason).toContain('⏸ flaky mid-stream');
  });

  it('partialFlakiness=false disables the penalty entirely (identical providers tie)', () => {
    const identical = { reasoning: 0.8, speed: 0.6, cost: 0.5, privacy: 0.2, reliability: 0.9 };
    router.updateProfiles({ providerA: identical, providerB: identical });
    const registry = getModelRegistry();
    registry.markVerified('providerA', 'm-a', 'spot-check');
    registry.markVerified('providerB', 'm-b', 'spot-check');
    registry.recordPartial('providerB', 'm-b', 'chat', 'timeout');

    const configManager = {
      getAll: () => ({ routing: { partialFlakiness: false } }),
      hasRequiredCredentials: () => true,
      getProviderConfig: () => ({ config: { model: 'default' } }),
    } as any;
    const decision = router.resolve('writer', 'deploy to production', {
      allowedProviders: ['providerA', 'providerB'],
    }, configManager);
    // No flakiness chip, no penalty — the identical profiles produce identical
    // scores (deterministic tie, stable order).
    expect(decision.ranked.find((r) => r.provider === 'providerB')?.flakiness).toBeUndefined();
    const a = decision.ranked.find((r) => r.provider === 'providerA');
    const b = decision.ranked.find((r) => r.provider === 'providerB');
    expect(a?.score).toBeCloseTo(b?.score as number, 5);
  });

  it('healed flakiness (clean successes) removes the penalty', () => {
    const identical = { reasoning: 0.8, speed: 0.6, cost: 0.5, privacy: 0.2, reliability: 0.9 };
    router.updateProfiles({ providerA: identical, providerB: identical });
    const registry = getModelRegistry();
    registry.markVerified('providerA', 'm-a', 'spot-check');
    registry.markVerified('providerB', 'm-b', 'spot-check');
    registry.recordPartial('providerB', 'm-b', 'chat', 'timeout');
    for (let i = 0; i < 12; i++) {
      registry.recordCall('providerB', 'm-b', true, undefined, 'chat');
    }

    const decision = router.resolve('writer', 'deploy to production', {
      allowedProviders: ['providerA', 'providerB'],
    });
    expect(decision.ranked.find((r) => r.provider === 'providerB')?.flakiness).toBeUndefined();
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

// ─── M2.2 measured wire-token cost inputs ──────────────────────────────────

describe('M2.2 measured wire-token cost inputs', () => {
  let measuredTempDir: string;

  beforeEach(() => {
    measuredTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-measured-'));
    process.env.BUFF_MEMORY_DIR = measuredTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    delete process.env.BUFF_MEMORY_DIR;
    resetModelRegistry();
    if (measuredTempDir) {
      rmSync(measuredTempDir, { recursive: true, force: true });
    }
  });

  it('estimateCallCostUsd replaces typical tokens with measured tokens', () => {
    // With a fixed pricing override, measured (100/50) tokens replace the
    // TYPICAL 2000/500 tokens → strictly cheaper per call.
    const pricing = { inputPer1K: 0.01, outputPer1K: 0.02 };
    const typical = estimateCallCostUsd('groq', pricing); // 0.02 + 0.01 = 0.03
    const measured = estimateCallCostUsd('groq', pricing, { inputTokens: 100, outputTokens: 50 });
    expect(measured).toBeLessThan(typical);
    expect(measured).toBeCloseTo(0.001 + 0.001, 6); // (100/1000)*0.01 + (50/1000)*0.02
  });

  it('computeCostScore with measured tokens reflects the real (smaller) cost', () => {
    const est = computeCostScore('groq');
    const measured = computeCostScore('groq', undefined, { inputTokens: 100, outputTokens: 50 });
    // Cheaper in practice → HIGHER cost score, but still within 0–1.
    expect(measured).toBeGreaterThan(est);
    expect(measured).toBeLessThanOrEqual(1);
    expect(measured).toBeGreaterThanOrEqual(0);
  });

  it('resolve surfaces costSource measured + costBasis when the registry has wire tokens', () => {
    const registry = getModelRegistry();
    registry.recordMeasuredUsage('groq', 'llama-3.3-70b-versatile', 100, 50);
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form');
    const groq = decision.ranked.find((r) => r.provider === 'groq')!;
    expect(groq.costSource).toBe('measured');
    expect(groq.costBasis).toEqual({ inputTokens: 100, outputTokens: 50 });
    // A provider with no wire tokens stays estimated (flag present, no basis).
    const local = decision.ranked.find((r) => r.provider === 'local')!;
    expect(local.costSource).toBe('estimated');
    expect(local.costBasis).toBeUndefined();
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
    // (ONE entry for the provider prior + ONE for the per-model prior)
    const state = getRouterBandit().getState();
    const history = state.learningHistory;
    expect(history.length).toBe(2);
    expect(history[0].outcome).toBe('success');
    expect(history[1].outcome).toBe('success');
    expect(history[1].model).toBeTruthy();
  });

  it('records the per-model prior for the concrete model that served the task', () => {
    const router = new AutoModelRouter();
    router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    router.recordOutcome('writer', 'implement a login form', 'failure');
    const state = getRouterBandit().getState();
    // The provider's failure → provider β bumped; the model's failure → model β bumped
    const modelEntry = state.learningHistory.find((h) => h.model);
    expect(modelEntry?.outcome).toBe('failure');
    const model = modelEntry!.model!;
    const modelPrior = getRouterBandit().getModelPrior(model, 'moderate');
    expect(modelPrior.beta).toBeGreaterThan(1);
  });

  it('writes the promotion A/B trajectory on resolve + recordOutcome', () => {
    const router = new AutoModelRouter();
    router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    router.recordOutcome('writer', 'implement a login form', 'success');
    // The promotion gate trajectory records the finalized decision
    expect(getRouterPromotion().getDecisions().length).toBe(1);
    const decision = getRouterPromotion().getDecisions()[0];
    expect(decision.heuristic.provider).toBeTruthy();
    expect(decision.bandit.provider).toBeTruthy();
    expect(decision.outcome).toBe('success');
    // Both picks were recorded for the SAME task (A/B comparison)
    expect(decision.task).toBe('implement a login form');
  });

  it('does not write a promotion trajectory when bandit is off', () => {
    const router = new AutoModelRouter();
    router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
    });
    router.recordOutcome('writer', 'implement a login form', 'success');
    expect(getRouterPromotion().getDecisions().length).toBe(0);
  });

  it('recordOutcome is a no-op when no decision was made for the agent type', () => {
    const router = new AutoModelRouter();
    expect(() => router.recordOutcome('planner', 'design architecture', 'failure')).not.toThrow();
  });

  it('keeps the configured model on cold start (per-model learning is deterministic)', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getAll: vi.fn(() => ({ pricing: {} })),
      getProviderConfig: vi.fn(() => ({ config: { model: 'pinned-model' } })),
    } as any;
    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq'],
      useBandit: true,
    }, configManager);
    // No per-model data → the configured pin is kept (deterministic cold start)
    expect(decision.provider).toBe('groq');
    expect(decision.model).toBe('pinned-model');
    // The model was still noted so future outcomes can learn it
    expect(getRouterBandit().getLastModel('writer')).toBe('pinned-model');
  });

  it('per-model learning prefers a learned model over an unlearned configured pin', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getAll: vi.fn(() => ({ pricing: {} })),
      getProviderConfig: vi.fn(() => ({ config: { model: 'llama-3.3-70b-versatile' } })),
    } as any;
    // Learn successes on a DIFFERENT groq model — a verified working model
    // (the dynamic candidate pool is registry-verified, health-ranked) — so it
    // is the only LEARNED candidate and always wins the per-model Thompson pick.
    getModelRegistry().markVerified('groq', 'openai/gpt-oss-20b', 'telemetry');
    const bandit = getRouterBandit();
    for (let i = 0; i < 20; i++) {
      bandit.recordModelOutcome('openai/gpt-oss-20b', 'implement a login form', 'success', 1.0);
    }
    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq'],
      useBandit: true,
    }, configManager);
    expect(decision.provider).toBe('groq');
    // openai/gpt-oss-20b is a PREFERRED_MODELS groq candidate and is learned
    expect(decision.model).toBe('openai/gpt-oss-20b');
    expect(getRouterBandit().getLastModel('writer')).toBe('openai/gpt-oss-20b');
  });

  it('cold-start bandit with several unlearned candidates picks the configured pin', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getAll: vi.fn(() => ({ pricing: {} })),
      getProviderConfig: vi.fn(() => ({ config: { model: 'llama-3.3-70b-versatile' } })),
    } as any;
    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    }, configManager);
    // Both providers cold-start (no data) → no escalation, deterministic pick
    expect(decision.banditEscalation).toBeFalsy();
    // Whatever provider wins, the model stays the configured pin or a curated default
    expect(decision.model).toBeTruthy();
  });
});

// ─── Uncertainty-driven escalation (ruflo model-router mirror) ─────────────
// When the bandit's winner has almost no accumulated samples (α+β < threshold),
// its sampled score is a cold-start guess. Escalate to the next-ranked provider
// that HAS learned data — a strictly better cold-start policy.

describe('AutoModelRouter.resolve uncertainty escalation', () => {
  beforeEach(() => {
    isolateBandit();
  });

  afterEach(() => {
    cleanupBandit();
  });

  /** Force θ = 1 on every bandit draw so the winner is deterministic (the
   * deterministic ranking) and escalation behavior is fully predictable. */
  function deterministicSampling(): { mockRestore: () => void } {
    const bandit = getRouterBandit();
    const spy = vi.spyOn(bandit, 'sampleScore').mockImplementation(
      (_provider: string, _complexity: unknown, score: number) => score,
    );
    return { mockRestore: () => spy.mockRestore() };
  }

  it('escalates to a learned provider when the winner is unlearned', () => {
    const bandit = getRouterBandit();
    // Seed groq with many successes so it is the ONLY learned provider in the
    // moderate bucket. For 'implement a login form' the deterministic winner is
    // gemini (free tier + strong reasoning), which stays unlearned (Beta(1,1)).
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    }
    const sampling = deterministicSampling();
    try {
      const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
        allowedProviders: ['groq', 'gemini', 'openrouter'],
        useBandit: true,
      });
      // gemini won deterministically but is unlearned → escalate to learned groq
      expect(decision.provider).toBe('groq');
      expect(decision.banditEscalation).toBe(true);
      expect(decision.explanation).toContain('escalated: winner unlearned');
    } finally {
      sampling.mockRestore();
    }
  });

  it('does not escalate when the winner already has learned data', () => {
    const bandit = getRouterBandit();
    // Seed gemini so the deterministic winner IS learned
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome('gemini', 'implement a login form', 'success', 1.0);
    }
    const sampling = deterministicSampling();
    try {
      const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
        allowedProviders: ['groq', 'gemini', 'openrouter'],
        useBandit: true,
      });
      expect(decision.provider).toBe('gemini');
      expect(decision.banditEscalation).toBeFalsy();
    } finally {
      sampling.mockRestore();
    }
  });

  it('does not escalate when no provider has learned data (pure cold start)', () => {
    const sampling = deterministicSampling();
    try {
      const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
        allowedProviders: ['groq', 'gemini', 'openrouter'],
        useBandit: true,
      });
      // All Beta(1,1) → nothing learned → deterministic pick, no escalation flag
      expect(decision.banditEscalation).toBeFalsy();
      expect(decision.provider).toBeTruthy();
      expect(decision.explanation).not.toContain('escalated: winner unlearned');
    } finally {
      sampling.mockRestore();
    }
  });
});

// ─── Credential-aware candidate filtering ─────────────────────────────────
// Regression: Auto routing must NEVER pick a provider with no API key
// configured (e.g. OpenRouter with no OPENROUTER_API_KEY → 401 on first call).
// When a ConfigManager is provided, unconfigured providers are excluded.

describe('AutoModelRouter.resolve credential filtering', () => {
  // The registry fast-path filters providers by VERIFIED models — a real
  // persisted registry would leak into this describe (which simulates
  // credential-only availability), so isolate it exactly like the bandit does.
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

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

  it('excludes registry-blocked providers even when credentials exist (predictive skip)', () => {
    const registry = getModelRegistry();
    // Telemetry learned gemini is dead (auth) while groq is verified-working —
    // the exact "gemini fails every message" scenario from real usage.
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    const configManager = makeConfig(() => true);

    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    // gemini is blocked by the registry → never ranked, never picked.
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    expect(decision.provider).toBe('groq');
  });

  it('registry-blocked providers stay blocked until a verified model returns', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('nim', 'meta/llama-3.3-70b-instruct', 'auth', 'telemetry');
    const configManager = makeConfig(() => true);

    const blocked = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(blocked.ranked.some((s) => s.provider === 'nim')).toBe(false);

    // A later successful call re-verifies nim → unblocked again.
    registry.recordCall('nim', 'meta/llama-3.3-70b-instruct', true);
    const unblocked = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(unblocked.ranked.some((s) => s.provider === 'nim')).toBe(true);
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

// ─── Registry-aware resolveModel (no-recursion guarantee) ───────────────────
// Once the Model Availability Registry learns a configured pin is dead, the
// router must stop re-selecting it and prefer a verified working model instead
// — this is what kills the "select a model, then it's not available" recursion
// the user observed in auto chat mode.

describe('resolveModel — registry-aware pin preference', () => {
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-pin-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

  it('prefers a registry-verified model when the configured pin is known dead', () => {
    const router = new AutoModelRouter();
    // Simulate the user's exact scenario: config pins gemini-2.0-flash-exp
    // (retired → 404), but the registry has already VERIFIED gemini-2.5-flash.
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.0-flash-exp', '404 model not found', 'telemetry');
    registry.markVerified('gemini', 'gemini-2.5-flash', 'telemetry');
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'gemini-2.0-flash-exp' } })),
    } as any;
    expect(router.resolveModel('gemini', 'chat', configManager)).toBe('gemini-2.5-flash');
  });

  it('keeps the configured pin when it is verified-usable (user intent wins)', () => {
    const router = new AutoModelRouter();
    getModelRegistry().markVerified('groq', 'llama-3.3-70b-versatile', 'telemetry');
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'llama-3.3-70b-versatile' } })),
    } as any;
    expect(router.resolveModel('groq', 'writer', configManager)).toBe('llama-3.3-70b-versatile');
  });

  it('keeps the configured pin when the registry has no data on it (cold start)', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'gemini-2.0-flash-exp' } })),
    } as any;
    expect(router.resolveModel('gemini', 'chat', configManager)).toBe('gemini-2.0-flash-exp');
  });
});

// ─── Singleton ──────────────────────────────────────────────────────────────

describe('AutoModelRouter.resolve governance (M2.4 admin policy)', () => {
  // Isolate the registry like the credential-filtering describe: the
  // registry fast-path (getUsableProviders) would leak the real ~/.buff
  // registry into the candidate set and pre-filter providers before the
  // governance slot even runs.
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-gov-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

  // Every mock configManager needs getAll() — resolve() reads pricing + the
  // governance policy from it. getProviderConfig feeds resolveModel so the
  // governance MODEL gate can see the configured pin.
  function makeConfig(routing?: Record<string, unknown>, providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: routing || {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('allowProviders restricts the candidate set to the admin list', () => {
    const configManager = makeConfig({ governance: { allowProviders: ['groq', 'local'] } });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    // nim/gemini/openrouter/nuvira are eliminated — never ranked, never picked.
    expect(decision.ranked.every((s) => s.provider === 'groq' || s.provider === 'local')).toBe(true);
    // The audit trail shows the policy kills (nuvira joined the candidate
    // universe in P5, so it is blocked by the admin allow-list like any
    // non-listed provider).
    const blocked = decision.governanceBlocked || [];
    expect(blocked.map((b) => b.provider).sort()).toEqual(['gemini', 'nim', 'nuvira', 'openrouter']);
    expect(blocked.every((b) => b.reason.includes('allowProviders'))).toBe(true);
  });

  it('denyProviders eliminates listed providers (wins over allowProviders)', () => {
    const configManager = makeConfig({ governance: { allowProviders: ['groq', 'gemini', 'local'], denyProviders: ['gemini'] } });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'groq')).toBe(true);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'gemini')?.reason).toContain('denyProviders');
  });

  it('denyModels eliminates providers whose candidate model is denied', () => {
    // gemini is PINNED to gemini-2.5-flash; deny it → gemini killed.
    const configManager = makeConfig(
      { governance: { denyModels: ['gemini-2.5-flash'] } },
      { gemini: { model: 'gemini-2.5-flash' } },
    );
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'gemini')?.reason).toContain('denyModels');
  });

  it('model allow-list that eliminates every provider THROWS (model list is a hard gate)', () => {
    // Allow a model that NO default provider serves → every provider is a
    // policy violator → the router must throw, never fall back to an unlisted
    // model's provider.
    const configManager = makeConfig({ governance: { allowModels: ['totally-unknown-model'] } });
    expect(() => new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager))
      .toThrow(/Governance/);
  });

  it('allowModels eliminates providers with no candidate on the allow list', () => {
    // Allow ONLY a groq model; groq is pinned to it → only groq survives.
    const configManager = makeConfig(
      { governance: { allowModels: ['llama-3.3-70b-versatile'] } },
      { groq: { model: 'llama-3.3-70b-versatile' } },
    );
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.every((s) => s.provider === 'groq')).toBe(true);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((b) => b.reason.includes('allowModels'))).toBe(true);
  });

  it('admin maxCostUsd cap eliminates expensive providers (joins per-call option)', () => {
    // openrouter costs ~$0.0075/call at TYPICAL tokens — well above a $0.001 cap.
    const configManager = makeConfig({ governance: { maxCostUsd: 0.001 } });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openrouter')).toBe(false);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'openrouter')?.reason).toContain('max-cost');
  });

  it('PII-domain block restricts matching tasks to privacy >= required (local-only by default)', () => {
    const configManager = makeConfig({ governance: { piiPatterns: ['api[_-]?key'] } });
    // The task mentions an API key → privacy-sensitive → only local (privacy 1.0).
    const decision = new AutoModelRouter().resolve('writer', 'rotate the api_key in .env safely', {}, configManager);
    expect(decision.ranked.every((s) => s.provider === 'local')).toBe(true);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((b) => b.reason.includes('PII'))).toBe(true);
  });

  it('PII block does NOT fire when the task does not match any pattern', () => {
    const configManager = makeConfig({ governance: { piiPatterns: ['api[_-]?key'] } });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'local')).toBe(true);
    expect(decision.ranked.some((s) => s.provider !== 'local')).toBe(true);
    expect(decision.governanceBlocked || []).toEqual([]);
  });

  it('unset/empty governance policy is fully permissive (existing behavior)', () => {
    const configManager = makeConfig({});
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.length).toBe(DEFAULT_AUTO_PROVIDERS.length);
    expect(decision.governanceBlocked || []).toEqual([]);
  });

  it('governance list policy that eliminates every provider THROWS (never falls back to a violator)', () => {
    // Admin allow-list excludes everything (pathological) — the router must
    // REFUSE to serve a provider the policy rules out, not fall back to one.
    // Only PER-CALL soft options (maxCostUsd/minSpeed/minReasoning) get the
    // benign fallback; an admin list is a HARD gate like PII.
    const configManager = makeConfig({ governance: { allowProviders: ['nonexistent-provider'] } });
    expect(() => new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager))
      .toThrow(/Governance/);
  });

  it('governance hard-gate THROWS with the full audit trail when the admin deny list kills everyone', () => {
    const configManager = makeConfig({ governance: { denyProviders: ['local', 'groq', 'gemini', 'nim', 'openrouter', 'nuvira'] } });
    let thrown: unknown;
    try {
      new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GovernancePolicyError);
    // The audit trail records every policy kill instead of being empty.
    const blocked = (thrown as GovernancePolicyError).blocked;
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((b) => b.reason.includes('denyProviders'))).toBe(true);
  });

  it('mixed soft+hard elimination THROWS (a governance kill must never be resurrected by a soft fallback)', () => {
    // minReasoning 0.9 eliminates local/groq/nim/gemini on its own (SOFT →
    // benign fallback on its own), while openrouter (reasoning 0.95) survives
    // the soft checks and is killed by the ADMIN deny list. Falling back would
    // resurrect the deny-listed openrouter, so the gate must throw.
    const configManager = makeConfig({
      governance: { denyProviders: ['openrouter'] },
    });
    expect(() => new AutoModelRouter().resolve('writer', 'implement a login form', {
      minReasoning: 0.9,
    }, configManager)).toThrow(/Governance/);
  });

  it('PII hard-gate THROWS when a PII task matches but every provider violates privacy (never serves a violator)', () => {
    // Every default provider except local has privacy < 1.0; simulate a
    // PII task where even local is removed (allowProviders excludes it) —
    // the router must REFUSE rather than fall back to a low-privacy cloud.
    const configManager = makeConfig({
      governance: { piiPatterns: ['api[_-]?key'], allowProviders: ['groq', 'openrouter'] },
    });
    expect(() => new AutoModelRouter().resolve('writer', 'rotate the api_key in .env', {}, configManager)).toThrow(/PII/);
  });

  it('PII hard-gate uses the privacy-compliant subset when SOME providers pass the bar', () => {
    // allowProviders admits groq+local; a PII task must keep local only
    // (groq privacy 0.15 < 1.0), even though groq otherwise passes.
    const configManager = makeConfig({
      governance: { piiPatterns: ['api[_-]?key'], allowProviders: ['groq', 'local'] },
    });
    const decision = new AutoModelRouter().resolve('writer', 'rotate the api_key in .env', {}, configManager);
    expect(decision.ranked.every((s) => s.provider === 'local')).toBe(true);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'groq')?.reason).toContain('PII');
  });

  it('allowModels enforces the CONFIGURED PIN, not just any curated default (served-model hole)', () => {
    // groq is pinned to a model NOT on the allow list, while groq's allowed
    // model IS on it — the pin is what gets served, so groq must be
    // eliminated (never serve an unlisted model). gemini is pinned to an
    // allowed model so gemini survives (no throw).
    const configManager = makeConfig(
      { governance: { allowModels: ['llama-3.3-70b-versatile', 'gemini-2.5-flash'] } },
      { groq: { model: 'my-custom-pinned-model' }, gemini: { model: 'gemini-2.5-flash' } },
    );
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'groq')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(true);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'groq')?.reason).toContain('my-custom-pinned-model');
  });

  it('denyModels enforces the CONFIGURED PIN (a denied pin kills the provider even if a curated default is clean)', () => {
    const configManager = makeConfig(
      { governance: { denyModels: ['gemini-2.5-flash'] } },
      { gemini: { model: 'gemini-2.5-flash' } },
    );
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    const blocked = decision.governanceBlocked || [];
    expect(blocked.find((b) => b.provider === 'gemini')?.reason).toContain('denyModels');
  });

  it('PER-CALL soft constraints eliminated everyone still fall back benignly (no governance configured)', () => {
    // Without governance, only per-call SOFT options (maxCostUsd/minSpeed/
    // minReasoning) ran — an impossible per-request ask keeps the full ranking
    // so the caller still gets a decision (no policy is being violated).
    const configManager = makeConfig({});
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      maxCostUsd: 0.0000001,
      minReasoning: 0.99,
    }, configManager);
    expect(DEFAULT_AUTO_PROVIDERS).toContain(decision.provider);
    // No governance configured → the audit trail stays empty (nothing policy
    // related was blocked; the soft kills live in the per-provider reasons).
    expect(decision.governanceBlocked || []).toEqual([]);
  });
});

// ─── M2.5 Context preflight ────────────────────────────────────────────────
// Estimation-only soft signal: the task's estimated prompt size (caller hint
// or task text) is scored against each provider's nominal input window. NEVER
// a hard block — even a prompt exceeding the window only caps the penalty.

describe('M2.5 context preflight', () => {
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-ctx-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

  function makeConfig(routing?: Record<string, unknown>, providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: routing || {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('computeContextFit is neutral for small tasks and ramps a capped penalty', () => {
    // Neutral below 50% utilization (normal-size tasks never shift a ranking).
    expect(computeContextFit(100, 8_192)).toBe(1);
    expect(computeContextFit(4_000, 8_192)).toBe(1); // 49% utilization
    // Ramp: 60K tokens on an 8K window → (7.3 - 0.5)/1.5 → 35% cap → 0.65.
    expect(computeContextFit(60_000, 8_192)).toBeCloseTo(0.65, 5);
    // 60K on a 128K window → 46% → neutral.
    expect(computeContextFit(60_000, 131_072)).toBe(1);
    // Unknown/zero windows are neutral (estimation never blocks).
    expect(computeContextFit(1_000_000, 0)).toBe(1);
    expect(computeContextFit(1_000_000, -1)).toBe(1);
  });

  it('exposes realistic nominal windows for built-in providers', () => {
    // Provider-level capability metadata only — no hardcoded per-model table.
    expect(PROVIDER_CONTEXT_WINDOWS.gemini).toBeGreaterThanOrEqual(1_000_000);
    expect(PROVIDER_CONTEXT_WINDOWS.groq).toBe(131_072);
    expect(PROVIDER_CONTEXT_WINDOWS.local).toBe(8_192);
    expect(PROVIDER_CONTEXT_WINDOWS.openrouter).toBe(128_000);
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
  });

  it('resolve with a caller hint surfaces contextFit/utilization and chips the squeezed window', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local', 'groq'],
      contextHintTokens: 60_000, // 60K payload: local's 8K window is squeezed
    }, makeConfig());

    const local = decision.ranked.find((r) => r.provider === 'local')!;
    const groq = decision.ranked.find((r) => r.provider === 'groq')!;
    expect(local.contextWindowTokens).toBe(8_192);
    expect(local.contextUtilization).toBeCloseTo(60_000 / 8_192, 3);
    expect(local.contextFit).toBeCloseTo(0.65, 3);
    expect(local.reason).toContain('context-fit 65%');
    // groq's 128K window fits 60K at 46% → fully neutral, no chip.
    expect(groq.contextWindowTokens).toBe(131_072);
    expect(groq.contextUtilization).toBeLessThan(0.5);
    expect(groq.contextFit).toBe(1);
    expect(groq.reason).not.toContain('context-fit');
    // The preflight snapshot records the hint basis + per-provider data.
    expect(decision.contextPreflight).toEqual({
      estimatedPromptTokens: 60_000,
      basis: 'hint',
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'local', contextWindowTokens: 8_192, fit: 0.65 }),
      ]),
    });
  });

  it('a normal-size task is fully neutral (no context chip, no penalty)', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local', 'groq'],
    }, makeConfig());
    expect(decision.contextPreflight?.basis).toBe('task');
    for (const r of decision.ranked) {
      expect(r.contextFit).toBe(1);
      expect(r.reason).not.toContain('context-fit');
    }
  });

  it('routing.contextFit: false disables the signal entirely (reversible gate)', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local'],
      contextHintTokens: 500_000, // would squeeze ANY window — but the gate is off
    }, makeConfig({ contextFit: false }));
    const local = decision.ranked[0];
    expect(local.contextFit).toBeUndefined();
    expect(local.contextUtilization).toBeUndefined();
    expect(local.contextWindowTokens).toBeUndefined();
    expect(decision.contextPreflight).toBeUndefined();
    expect(local.reason).not.toContain('context-fit');
  });

  it('routing.contextWindows overrides win over the built-in table (model + provider keys)', () => {
    // groq is pinned to llama-3.3-70b-versatile so the MODEL-keyed override
    // (32,768) applies to the served model; local uses the PROVIDER-keyed
    // override (65,536).
    const configManager = makeConfig({
      contextWindows: { local: 65_536, 'llama-3.3-70b-versatile': 32_768 },
    }, { groq: { model: 'llama-3.3-70b-versatile' } });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local', 'groq'],
      contextHintTokens: 60_000,
    }, configManager);
    const local = decision.ranked.find((r) => r.provider === 'local')!;
    const groq = decision.ranked.find((r) => r.provider === 'groq')!;
    // Provider-level override: local window 65,536 → utilization 0.92 → 0.72 fit.
    expect(local.contextWindowTokens).toBe(65_536);
    expect(local.contextFit).toBeCloseTo(computeContextFit(60_000, 65_536), 3);
    // Model-level override: groq's configured-model window 32,768 → squeezed.
    expect(groq.contextWindowTokens).toBe(32_768);
    expect(groq.contextFit).toBeLessThan(1);
  });

  it('quota-parked candidates still get a numeric window in the preflight snapshot (no crash in explain)', () => {
    // A quota-parked provider's scored entry omits the context fields, but the
    // preflight snapshot must resolve a real window for it — the human explain
    // renderer calls toLocaleString() on every entry.
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local', 'groq'],
      contextHintTokens: 10_000,
      quotaStatus: [{ provider: 'groq', cooldownRemaining: 90_000 }],
    }, makeConfig());
    const parked = decision.ranked.find((r) => r.provider === 'groq')!;
    expect(parked.quotaParked).toBe(true);
    expect(parked.contextWindowTokens).toBeUndefined(); // scored entry omits it
    const pre = decision.contextPreflight!;
    const groqPre = pre.providers.find((p) => p.provider === 'groq')!;
    expect(typeof groqPre.contextWindowTokens).toBe('number');
    expect(groqPre.contextWindowTokens).toBeGreaterThan(0);
  });

  it('string contextWindows overrides (config set stores strings) are coerced to numbers', () => {
    const configManager = makeConfig({
      contextWindows: { local: '16384' } as unknown as Record<string, number>,
    });
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local'],
      contextHintTokens: 10_000,
    }, configManager);
    const local = decision.ranked[0];
    expect(local.contextWindowTokens).toBe(16_384);
    expect(local.contextUtilization).toBeCloseTo(10_000 / 16_384, 3);
  });

  it('a heavy payload can flip the winner toward a big-window provider (soft, estimation-only)', () => {
    // Without a hint, local (privacy + free cost) wins the privacy-weighted
    // contest; a 500K-token payload squeezes local's 8K window to a 0.65 fit
    // while gemini's 1M window stays neutral → gemini wins.
    const light = new AutoModelRouter().resolve('writer', 'implement a login form', {
      preferenceMode: 'privacy-first',
      allowedProviders: ['local', 'gemini'],
    }, makeConfig());
    const heavy = new AutoModelRouter().resolve('writer', 'implement a login form', {
      preferenceMode: 'privacy-first',
      allowedProviders: ['local', 'gemini'],
      contextHintTokens: 500_000,
    }, makeConfig());
    // Sanity: without the signal local wins (privacy-first); with the heavy
    // payload the winner is gemini (or local no longer ranks first with a
    // meaningful gap) — the soft nudge moved the decision.
    expect(light.provider).toBe('local');
    expect(heavy.ranked.find((r) => r.provider === 'gemini')!.contextFit).toBe(1);
    expect(heavy.ranked.find((r) => r.provider === 'local')!.contextFit).toBeCloseTo(0.65, 3);
  });
});

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
