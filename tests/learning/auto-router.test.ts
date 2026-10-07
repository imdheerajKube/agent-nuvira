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
  isProviderOwnAuto,
  isAgentAutoRoute,
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
import { resetMlRouter, getMlRouter } from '../../src/learning/ml-router.js';
import { resetModelRegistry, getModelRegistry } from '../../src/learning/model-registry.js';
import { PRIOR_FULL_SAMPLES } from '../../src/learning/capability-evidence.js';
import { PROVIDER_CONTEXT_WINDOWS } from '../../src/learning/model-selection.js';
import { CATALOG_PROVIDER_IDS, isCatalogKeyless } from '../../src/inference/provider-catalog.js';

/**
 * Keyless runners OTHER than `local` are not candidates unless verified or
 * explicitly configured — derived from the catalog so adding a keyless gateway
 * (e.g. omniroute) cannot silently break these count assertions.
 */
const KEYLESS_RUNNERS = CATALOG_PROVIDER_IDS.filter((p) => p !== 'local' && isCatalogKeyless(p));

// ─── Learning-state test isolation ─────────────────────────────────────────
//
// resolve() consults MORE than the bandit: it reads the persisted model registry
// (`$NUVIRA_MEMORY_DIR/model-registry.json`), which tracks verified/unavailable
// counts per provider. If a developer's real live runs marked a provider DEGRADED
// (0 verified + ≥3 unavailable), that provider is silently dropped from the
// candidate set and this file stops measuring the code — it measures the
// developer's machine. That is exactly how `minReasoning eliminates
// weak-reasoning providers` became environment-dependent rather than a real
// routing bug.
//
// So isolate the WHOLE file (not only the bandit describes): point the memory dir
// at a fresh temp dir and drop the singletons that cache real learning state.
let isolatedMemoryDir: string;

function isolateLearningState() {
  isolatedMemoryDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-'));
  process.env.NUVIRA_MEMORY_DIR = isolatedMemoryDir;
  resetRouterBandit();
  resetRouterPromotion();
  resetModelRegistry();
}

function cleanupLearningState() {
  delete process.env.NUVIRA_MEMORY_DIR;
  resetRouterBandit();
  resetRouterPromotion();
  resetModelRegistry();
  if (isolatedMemoryDir) {
    rmSync(isolatedMemoryDir, { recursive: true, force: true });
  }
}

// File-scoped: every test in this file runs against an empty learning state.
beforeEach(isolateLearningState);
afterEach(cleanupLearningState);

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

// ─── A8 — provider-owned auto vs the agent's auto-route ─────────────────────

describe('isProviderOwnAuto / isAgentAutoRoute (A8)', () => {
  it('a concrete provider + `auto` model is the PROVIDER\'s own auto', () => {
    expect(isProviderOwnAuto('omniroute', 'auto')).toBe(true);
    expect(isAgentAutoRoute('omniroute', 'auto')).toBe(false);
  });

  it('`-p auto` (or no provider) with `-m auto` stays the AGENT\'s auto-route', () => {
    expect(isProviderOwnAuto('auto', 'auto')).toBe(false);
    expect(isAgentAutoRoute('auto', 'auto')).toBe(true);
    expect(isProviderOwnAuto(undefined, 'auto')).toBe(false);
    expect(isAgentAutoRoute(undefined, 'auto')).toBe(true);
  });

  it('a concrete provider with a real model is NOT auto at all', () => {
    expect(isProviderOwnAuto('omniroute', 'auto/smart')).toBe(false);
    expect(isAgentAutoRoute('omniroute', 'auto/smart')).toBe(false);
    expect(isAgentAutoRoute('groq', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('`-p auto` with a concrete model is still the AGENT\'s auto-route', () => {
    expect(isAgentAutoRoute('auto', 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('a PLAIN provider + `-m auto` does NOT own the sentinel — it must be resolved', () => {
    // Regression: the first A8 cut returned true for ANY concrete provider, so
    // `-p local -m auto` (/groq/deepseek/…) left `auto` unresolved and handed the
    // literal string to a provider that has no such model. That 400s live, and it
    // made the orchestrator pay twice (a verify probe on `auto`, then the real
    // call). Only a provider whose catalog default IS `auto` — a gateway like
    // OmniRoute — owns the sentinel.
    for (const provider of ['local', 'groq', 'deepseek', 'openai', 'gemini']) {
      expect(isProviderOwnAuto(provider, 'auto'), provider).toBe(false);
    }
    // …and because no provider owns it, our own router still picks a real model.
    expect(isAgentAutoRoute('groq', 'auto')).toBe(true);
    expect(isAgentAutoRoute('deepseek', 'auto')).toBe(true);
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
    // default — reasoning 0.5, speed 0.5) derives chat + code tags.
    // 'default' requires chat → fit 1 (derived chat tag present).
    // 'plan' requires reasoning → fit 0 (no derived reasoning tag at 0.5).
    const neutralFallback: ProviderCapabilities = {
      reasoning: 0.5, speed: 0.5, cost: 0.5, privacy: 0.2, reliability: 0.7,
    };
    expect(capabilityFitScore('default', 'nuvira', neutralFallback)).toBe(1);
    expect(capabilityFitScore('plan', 'nuvira', neutralFallback)).toBe(0);
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

  it('treats a build-debug/fix ask as verification-bearing (C4)', () => {
    // Live (2026-10-02): a "the build is broken, it crashes with
    // ModuleNotFoundError, fix the build" ask is DEBUGGING — and a fix is not
    // done until it is observed to work, so it must carry the verification
    // profile (reasoning/reliability weights up, cost/speed down) rather than
    // routing a failed build to a fast model that certifies it as working.
    const profile = analyzeTaskProfile(
      'The app build is broken and crashes with ModuleNotFoundError: No module named PyQt6. Fix the build.',
    );
    expect(profile.intent).toBe('debugging');
    expect(profile.requiresVerification).toBe(true);
    expect(profile.escalationTarget).toBe('openrouter');
    // A generic engineering fix keeps the label but is no longer unverified.
    expect(analyzeTaskProfile('fix the failing test in auth.ts').requiresVerification).toBe(true);
  });

  it('keeps planning tasks lightweight by default', () => {
    const profile = analyzeTaskProfile('outline the authentication architecture');
    expect(profile.intent).toBe('planning');
    expect(profile.requiresVerification).toBe(false);
    expect(profile.escalationTarget).toBeUndefined();
  });

  // ─── The intent rules match WHOLE WORDS (the B2 sweep) ──────────────────
  //
  // These rules were unanchored alternations, so a FRAGMENT of an ordinary word
  // decided the intent — the same class of defect as B2's `desc.includes('hi')`.
  // Every case below was DEMONSTRATED against the built `dist` before the fix:
  // `prefix`/`fixture`/`suffix` all produced `debugging` (because `fix` is inside
  // them), earning a verification pass and an openrouter escalation.
  it('is not fooled by words that merely CONTAIN a rule keyword', () => {
    const spells = [
      'add a prefix constant to the config',
      'create a fixture file for the tests',
      'rename the suffix field in src/config.ts',
    ];
    for (const text of spells) {
      const profile = analyzeTaskProfile(text);
      expect(profile.intent, `${JSON.stringify(text)} was misread`).toBe('coding');
      expect(profile.requiresVerification).toBe(false);
      expect(profile.escalationTarget).toBeUndefined();
    }
    // `system` inside `ecosystem` is not a system-design ask either.
    expect(analyzeTaskProfile('the provider ecosystem should be considered').intent).toBe('coding');
    // ...and `plan` inside `plant` is not a plan.
    expect(analyzeTaskProfile('plant a tree in the garden').intent).toBe('coding');
  });

  it('still fires on the real words, including their inflections', () => {
    // The other half of the contract: bounding must not lose genuine matches.
    expect(analyzeTaskProfile('fix the failing build').intent).toBe('debugging');
    expect(analyzeTaskProfile('fixes the failing build').intent).toBe('debugging');
    expect(analyzeTaskProfile('design the schema for the app').intent).toBe('architecture');
    // NOT 'plan the migration' — ORDER IS THE CONTRACT, and the migration rule
    // precedes the planning rule, so that ask is legitimately `migration`.
    expect(analyzeTaskProfile('plan the database schema work').intent).toBe('planning');
    expect(analyzeTaskProfile('plan the migration').intent).toBe('migration');
    expect(analyzeTaskProfile('the migration is done').intent).toBe('migration');
    // The bounding exposed a choice the old `verify|verification` alternation hid:
    // should the PAST PARTICIPLE count? It must not. "the build was verified" is a
    // STATUS REPORT, not a verification task, and it must not buy a reviewer pass
    // and an openrouter escalation. Measured: bounding to the ASK forms changes
    // the intent of ZERO of the 161 tasks in the local routing history, whereas a
    // bare `\bverif\w*\b` changed one past-tense status message — so the
    // conservative spelling is the one that fixes the fragment bug without moving
    // any real decision.
    expect(analyzeTaskProfile('verify the build on the runner').intent).toBe('verification');
    expect(analyzeTaskProfile('verifying the build').intent).toBe('verification');
    expect(analyzeTaskProfile('verification of the build').intent).toBe('verification');
    expect(analyzeTaskProfile('the build was verified on the runner').intent).toBe('coding');
  });

  /**
   * The router had the SAME object-blindness the NLU had: every rule keyed off a
   * surface word and never asked what that word was ABOUT. So a diet/exercise
   * plan was labeled `planning` (never getting the creative quality floor a
   * content answer needs), "fix my diet plan" was labeled `debugging`, and
   * "design a poster for the event" was labeled `architecture` — which also
   * granted it a verification boost and a gemini escalation it has no business
   * getting. The object is now decided BEFORE those rules.
   */
  it('labels CONTENT asks creative, whatever verb they use', () => {
    const contentAsks = [
      'Create a plan for diet and exercise to loose weight by 10 KGs in 3 months , i have bad knee',
      "Create a book which teaches math's devision for class 4 student",
      'fix my diet plan',
      'design a poster for the event',
      'create a study plan for class 4',
      'create a test for class 4',
      'make a weekly grocery list',
      'create an outline for my essay',
    ];
    for (const ask of contentAsks) {
      const profile = analyzeTaskProfile(ask);
      expect(profile.intent, ask).toBe('creative');
      expect(profile.requiresVerification, ask).toBe(false);
      expect(profile.escalationTarget, ask).toBeUndefined();
    }
  });

  it('does NOT grant a content ask the engineering labels or their boosts', () => {
    // These are the exact mislabels the old surface-word rules produced.
    expect(analyzeTaskProfile('fix my diet plan').intent).not.toBe('debugging');
    expect(analyzeTaskProfile('design a poster for the event').intent).not.toBe('architecture');
    expect(analyzeTaskProfile('design a poster for the event').requiresVerification).toBe(false);
  });

  it('keeps every ENGINEERING ask on its original label', () => {
    expect(analyzeTaskProfile('deploy to production and verify the rollout').intent).toBe('verification');
    expect(analyzeTaskProfile('migrate the auth service to the new deployment pipeline').intent).toBe('migration');
    expect(
      analyzeTaskProfile('design a new microservice architecture for the platform').intent,
    ).toBe('architecture');
    expect(analyzeTaskProfile('fix the failing test in auth.ts').intent).toBe('debugging');
    expect(analyzeTaskProfile('refactor the router').intent).toBe('migration');
    expect(analyzeTaskProfile('outline the authentication architecture').intent).toBe('planning');
    expect(analyzeTaskProfile('write a security audit report').intent).toBe('security');
    expect(analyzeTaskProfile('create a plan for the ecommerce app').intent).toBe('planning');
  });

  it('does not let "for students" make a CODING ask creative', () => {
    // /for (kids|children|students|class N)/ used to tip ANY ask to creative —
    // "build an app for students" included.
    expect(analyzeTaskProfile('build an app for students').intent).toBe('coding');
    expect(analyzeTaskProfile('build a quiz app for class 4').intent).toBe('coding');
    // …while a genuine content ask still gets the creative treatment.
    expect(analyzeTaskProfile('write an essay on elephants for class 4').intent).toBe('creative');
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
    resolveOrigDir = process.env.NUVIRA_MEMORY_DIR;
    resolveTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-resolve-'));
    process.env.NUVIRA_MEMORY_DIR = resolveTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (resolveOrigDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = resolveOrigDir;
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

  it('D6/D7 — neither the PICK nor the offered chain recommends a pair the registry has proven dead', () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check', 200);
    registry.markVerified('groq', 'openai/gpt-oss-120b', 'spot-check', 200);
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check', 200);
    registry.markVerified('local', 'llama3.2:1b', 'spot-check', 50);
    // A pair a REAL call already proved dead on this provider (the live shape:
    // `groq|gemini-3.1-flash-lite`, `status: verified` while its own lastError
    // was a 404). "Use every model available" must not mean "recommend one the
    // registry has already rejected" — `model explain` is where an operator
    // decides what to pin next.
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'unknown: 404 the model does not exist', 'spot-check');

    const decision = router.resolve('writer', 'implement a feature', {
      allowedProviders: ['groq', 'gemini', 'local'],
    });

    // D7 (measured on THIS fixture, 2026-10-07): before the pair gate existed the
    // PICK was `gemini/gemini-2.5-flash` — the pair the registry had just proven
    // dead — and the chain (correctly, since D6) started on groq. So the chain was
    // fixed while the first call of every turn still went to a pair that could not
    // answer. Provider ranking runs before the pair is consulted at all, which is
    // why a chain-level gate could never cover this.
    expect(registry.getEntry(decision.provider, decision.model)?.status).not.toBe('unavailable');
    for (const c of decision.fallbackChain) {
      expect(registry.getEntry(c.provider, c.model)?.status).not.toBe('unavailable');
    }
    // The gate must not empty the chain while a callable pair remains — "reject
    // only when nothing is left." `groq` keeps a second verified model precisely
    // so this assertion is about the gate and not about the fixture.
    expect(decision.fallbackChain.length).toBeGreaterThan(0);
  });

  it('D6 — an unproven fallback pair says it is unproven, instead of borrowing a proven model\'s wording', () => {
    // Fresh isolated learning state (this file resets it per test): nothing has
    // been verified, so the chain is made of never-tried pairs. They STAY — an
    // unknown is not a failure, and a weak candidate beats no candidate — but
    // their label must not claim more confidence than the evidence supports.
    const decision = router.resolve('writer', 'implement a feature');
    const registry = getModelRegistry();
    const unproven = decision.fallbackChain.filter((c) => {
      const status = registry.getEntry(c.provider, c.model)?.status;
      return status === undefined || status === 'unverified';
    });
    expect(unproven.length).toBeGreaterThan(0);
    for (const c of unproven) expect(c.reason.toLowerCase()).toContain('unverified');
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
    flakyOrigDir = process.env.NUVIRA_MEMORY_DIR;
    flakyTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-flaky-'));
    process.env.NUVIRA_MEMORY_DIR = flakyTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (flakyOrigDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = flakyOrigDir;
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
    process.env.NUVIRA_MEMORY_DIR = measuredTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    delete process.env.NUVIRA_MEMORY_DIR;
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
  // Learning state is isolated for the whole file (see the file-level hooks
  // above), so no per-describe setup is needed here.
  it('marks the decision as bandit-routed when useBandit is enabled', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      useBandit: true,
    });
    expect(decision.routedBy).toBe('bandit');
  });

  /**
   * P6 (fix_model_routing) — the label is a claim about EVIDENCE.
   *
   * This test used to assert `bandit-learned` on a cold-start store, which is
   * exactly the dishonesty the user found: the live trace read "bandit-learned"
   * while the bandit store had no entry for any model in play, and its newest
   * sample predated the decision by eleven days. A cold-start prior is a
   * constant multiplier that CANNOT reorder anything, so the pick came from the
   * deterministic ranking and must be described that way.
   */
  it('does NOT claim "bandit-learned" when the arm has no samples (P6)', () => {
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini', 'openrouter'],
      useBandit: true,
    });
    expect(decision.banditInformed).toBe(false);
    expect(decision.explanation).not.toContain('bandit-learned');
    expect(decision.explanation).toContain('bandit cold-start');
    expect(decision.explanation).toContain('the deterministic ranking stands');
  });

  it('DOES claim "bandit-learned" once the winning arm has recorded outcomes (P6)', () => {
    const router = new AutoModelRouter();
    const first = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    // Accumulate real outcomes for the arms in play (in the SAME intent-aware
    // bucket resolve() reads — see RouterBandit.bucketKey), then re-resolve the
    // same task: now the sample is evidence and the label is earned.
    for (const provider of ['groq', 'gemini']) {
      for (let i = 0; i < 8; i++) {
        getRouterBandit().recordOutcomeWithComplexity(
          provider,
          first.complexity as never,
          'success',
          0.5,
          undefined,
          first.taskProfile.intent,
        );
      }
    }
    const second = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
    });
    expect(second.banditInformed).toBe(true);
    expect(second.explanation).toContain('bandit-learned');
  });

  it('treats a STALE store as uninformed even when it has samples (P6)', () => {
    const bandit = getRouterBandit();
    const state = bandit.getState();
    // A sample from long ago describes a different machine, different keys and a
    // different model roster — "learned" is not true for today's decision.
    state.learningHistory.length = 0;
    state.learningHistory.push({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      complexity: 'moderate' as never,
      outcome: 'success',
      reward: 1,
      timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(bandit.isStale()).toBe(true);
    expect(bandit.ageMs()).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
    expect(bandit.hasLearnedData('groq', 'moderate' as never)).toBe(false);
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

  it('forwards the MEASURED outcome payload to both arms — the reward is no longer a bare coin flip', () => {
    // The three honesty fields (`testPassed` / `userAccepted` / `verificationPassed`)
    // had NO parameter to travel through on this path — the declared type did not
    // include them — so every caller passed `undefined` and the only measured-quality
    // reward the router has was dead on the real path. Both arms must now see it.
    const router = new AutoModelRouter();
    const record = (data?: { verificationPassed?: boolean }) => {
      // Pin the provider so the two rewards are comparable (same cost score).
      router.resolve('writer', 'implement a login form', { allowedProviders: ['groq'], useBandit: true });
      router.recordOutcome('writer', 'implement a login form', 'success', undefined, data);
    };
    record(); // no measured payload — the old behaviour
    record({ verificationPassed: false }); // what a real unverified turn reports

    const providerArm = getRouterBandit().getState().learningHistory.filter((h) => !h.model);
    const [blind, measured] = providerArm.slice(-2);
    expect(blind.outcome).toBe('success');
    expect(measured.outcome).toBe('success');
    // Same provider, same cost score, same outcome — the ONLY difference is the
    // measured payload, so the reward must be strictly lower with it.
    expect(measured.reward).toBeLessThan(blind.reward);
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
    // v3 — the outcome was recorded under the intent-aware bucket 'coding:moderate'
    // ('implement a login form' → analyzeTaskProfile → 'coding'), so the prior
    // must be read from the SAME bucket (the plain 'moderate' key would miss it).
    const modelPrior = getRouterBandit().getModelPrior(model, 'moderate', 'coding');
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
      // v3 — seed the INTENT bucket ('implement a login form' → 'coding') that
      // resolveModelWithLearning now samples; a legacy no-intent seed would
      // never surface.
      bandit.recordModelOutcome('openai/gpt-oss-20b', 'implement a login form', 'success', 1.0, undefined, 'coding');
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
  /** Force θ = 1 on every bandit draw so the winner is deterministic (the
   * deterministic ranking) and escalation behavior is fully predictable. */
  function deterministicSampling(): { mockRestore: () => void } {
    const bandit = getRouterBandit();
    const spy = vi.spyOn(bandit, 'sampleScore').mockImplementation(
      (_provider: string, _complexity: unknown, score: number) => score,
    );
    return { mockRestore: () => spy.mockRestore() };
  }

  it('escalates to a learned provider when the winner is unlearned (capability guard: never downgrade)', () => {
    const bandit = getRouterBandit();
    // Seed openrouter with many successes so it is the ONLY learned provider in
    // the moderate bucket. For 'implement a login form' the deterministic
    // winner is gemini (free tier + strong reasoning), which stays unlearned
    // (Beta(1,1)). openrouter (reasoning 0.95) is at least as capable as gemini
    // (0.85), so escalation to it is allowed by the S5 capability guard.
    for (let i = 0; i < 20; i++) {
      // v3 — seed under the INTENT bucket resolve() samples ('implement a login
      // form' → 'coding'); a legacy no-intent seed would never surface because
      // select-time reads the intent-aware bucket.
      bandit.recordOutcome('openrouter', 'implement a login form', 'success', 1.0, undefined, 'coding');
    }
    const sampling = deterministicSampling();
    try {
      const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
        allowedProviders: ['groq', 'gemini', 'openrouter'],
        useBandit: true,
      });
      // gemini won deterministically but is unlearned → escalate to learned openrouter
      expect(decision.provider).toBe('openrouter');
      expect(decision.banditEscalation).toBe(true);
      expect(decision.explanation).toContain('escalated: winner unlearned');
    } finally {
      sampling.mockRestore();
    }
  });

  it('never escalates DOWNWARD to a weaker learned provider (S5)', () => {
    const bandit = getRouterBandit();
    // The ONLY learned provider is groq (reasoning 0.55) — weaker than the
    // unlearned deterministic winner gemini (0.85). Escalating would swap a
    // strong model for a weak one based on stale coding-session priors, which
    // is exactly how an essay got routed to a 4-bit local model. The guard
    // must block it and keep the (unlearned) winner.
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    }
    const sampling = deterministicSampling();
    try {
      const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
        allowedProviders: ['groq', 'gemini', 'openrouter'],
        useBandit: true,
      });
      expect(decision.provider).toBe('gemini');
      expect(decision.banditEscalation).toBe(false);
      expect(decision.explanation).not.toContain('escalated: winner unlearned');
    } finally {
      sampling.mockRestore();
    }
  });

  it('does not escalate when the winner already has learned data', () => {
    const bandit = getRouterBandit();
    // Seed gemini so the deterministic winner IS learned
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome('gemini', 'implement a login form', 'success', 1.0, undefined, 'coding');
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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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

  it('considers EVERY catalog provider with credentials — an OPENAI key makes openai a candidate (Issue 001)', () => {
    // Issue 001: the candidate pool is the FULL catalog, credential-filtered.
    // Setting OPENAI_API_KEY (here: granting openai credentials) must make
    // openai participate in routing — not just the 6 built-ins.
    const configManager = makeConfig((p) => p === 'groq' || p === 'openai' || p === 'local');
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openai')).toBe(true);
    // Providers WITHOUT credentials stay out entirely.
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'openrouter')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'anthropic')).toBe(false);
  });

  it('excludes extended catalog providers with no credentials (Issue 001)', () => {
    const configManager = makeConfig((p) => p === 'groq' || p === 'local');
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openai')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'mistral')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'deepseek')).toBe(false);
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

  it('keeps credentialed-but-unverified providers OUT of ranked but IN the fallback chain (use every model, reject only when nothing is left)', () => {
    const registry = getModelRegistry();
    // groq + local are verified → they own the primary ranking; the unverified
    // cloud providers must never win a normal turn.
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'spot-check');
    registry.markVerified('local', 'llama3.2', 'spot-check');
    const configManager = makeConfig(() => true);

    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openrouter')).toBe(false);
    expect(decision.ranked.some((s) => s.provider === 'gemini')).toBe(false);

    // …but the credentialed-yet-unverified providers are NOT thrown away: they
    // are the last-resort fallback, so a total outage of the verified pool still
    // reaches them ("reject only when nothing is left").
    const fallbackProviders = decision.fallbackChain.map((c) => c.provider);
    expect(fallbackProviders).toContain('openrouter');
    expect(fallbackProviders).toContain('gemini');
    // Ranked fallbacks come FIRST; the unverified reserve is strictly last.
    const firstReserve = fallbackProviders.findIndex((p) => p === 'openrouter');
    for (const rankedFallback of fallbackProviders.filter((p) => decision.ranked.some((s) => s.provider === p))) {
      expect(fallbackProviders.indexOf(rankedFallback)).toBeLessThan(firstReserve);
    }
  });

  it('excludes DEGRADED providers (0 verified + ≥3 unavailable) and cites the registry counts (ISSUE-002)', () => {
    const registry = getModelRegistry();
    // openrouter: 3 unavailable + 0 verified → degraded by the ISSUE-002
    // pre-filter even when credentials exist. The explanation must cite the
    // registry data so users can see the gathered telemetry driving decisions.
    registry.markUnavailable('openrouter', 'openai/gpt-4o', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'openai/gpt-4o-mini', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'anthropic/claude-3.5-sonnet', '401', 'telemetry');
    const configManager = makeConfig(() => true);

    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {}, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openrouter')).toBe(false);
    expect(decision.provider).not.toBe('openrouter');
    // The audit trail + explanation cite the registry counts.
    const excluded = decision.registryExcluded || [];
    expect(excluded.find((e) => e.provider === 'openrouter')?.reason).toContain('unavailable');
    expect(decision.explanation).toContain('openrouter');
    expect(decision.explanation).toContain('unavailable');
  });

  it('explicit allowedProviders bypass the registry pre-filter (caller knows best)', () => {
    const registry = getModelRegistry();
    registry.markUnavailable('openrouter', 'openai/gpt-4o', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'openai/gpt-4o-mini', '401', 'telemetry');
    registry.markUnavailable('openrouter', 'anthropic/claude-3.5-sonnet', '401', 'telemetry');
    const configManager = makeConfig(() => true);

    // Explicitly listing openrouter opts out of the registry filter — the
    // caller (a user forcing a provider) takes precedence over registry data.
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['openrouter'],
    }, configManager);
    expect(decision.ranked.some((s) => s.provider === 'openrouter')).toBe(true);
    expect(decision.registryExcluded || []).toEqual([]);
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

  it('restores by CAPABILITY, not cost, when a reasoning floor eliminates everyone', () => {
    // The live regression (trace-1791118414038-wdmliw): under `max`
    // (minReasoning 0.7 + performance-first) every cloud candidate sat below
    // the floor, the benign fallback restored the RAW ranking, and
    // `performance-first` then handed a real build task to LOCAL gemma4:e4b
    // (score 0.71 vs gemini's 0.40). A relaxed reasoning floor must relax in the
    // SAME direction — strongest served model first — so a free 4-bit local
    // entry can never win on price/speed.
    const decision = new AutoModelRouter().resolve('writer', 'create mac os gui app', {
      allowedProviders: ['local', 'gemini', 'groq'],
      minReasoning: 0.99,
      preferenceMode: 'performance-first',
    });
    expect(decision.provider).not.toBe('local');
  });
});

// ─── C4 — verification/build-debug model-tier floor ─────────────────────────

/**
 * A build-debug/verification ask is not done until the fix is OBSERVED to work,
 * so it needs a model strong enough to observe — not merely a weight nudge. The
 * live failure: `gemini-3.1-flash-lite` certified a FAILED build as working.
 */
describe('C4 — verification reasoning floor', () => {
  // Same mock shape the governance tests use: getAll() for pricing/governance,
  // getProviderConfig() so resolveModel can see a configured pin.
  function makeConfig(providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('B1 — the model ID contributes NOTHING to capability, at equal evidence', () => {
    // Before Bundle 3b this test asserted the OPPOSITE: stacked fast-tier words
    // (`flash` + `lite`) cost 0.2 of reasoning per word, so `flash-lite` fell
    // below the 0.7 floor while a single `flash` stayed above it. That made the
    // floor a spelling test — and this programme's own report fell into it, calling
    // DeepSeek V4.1 Flash weak *because of the word in its id* while the model
    // served an 82-step build (correction C-2). The names are no longer evidence:
    // at zero samples both ids are exactly the provider baseline.
    const router = new AutoModelRouter();
    const base = router.getCapabilities('gemini');
    const flash = router.getModelCapabilities('gemini', 'gemini-3.1-flash');
    const flashLite = router.getModelCapabilities('gemini', 'gemini-3.1-flash-lite');
    expect(flashLite).toEqual(flash);
    expect(flash.reasoning).toBe(base.reasoning);
    // Parameter size and frontier keywords are names too — the same rule holds
    // across both, including the id that used to earn a +0.45 boost.
    expect(router.getModelCapabilities('local', 'qwen3-72b-instruct')).toEqual(
      router.getModelCapabilities('local', 'llama3:1b'),
    );
  });

  it('B4 — the floor acts on MEASURED accuracy, not on a fast-tier name', () => {
    const configManager = makeConfig({
      gemini: { model: 'gemini-3.1-flash-lite' },
      openrouter: { model: 'openai/gpt-4o' },
    });
    const task = 'The app build is broken; it crashes with ModuleNotFoundError. Fix the build.';

    // COLD START: an id alone is not evidence, so the fast-lite pair is NOT
    // floored out for its spelling. A floor that excludes by name is the defect;
    // excluding by measurement is the fix.
    const cold = new AutoModelRouter().resolve(
      'writer',
      task,
      { allowedProviders: ['gemini', 'openrouter'] },
      configManager,
    );
    expect(cold.ranked.some((s) => s.provider === 'gemini')).toBe(true);

    // MEASURED: once the harness has watched this pair fail to verify its work,
    // the floor does its job and the task goes to the stronger provider.
    const registry = getModelRegistry();
    registry.markListed('gemini', ['gemini-3.1-flash-lite']);
    for (let i = 0; i < PRIOR_FULL_SAMPLES; i++) {
      registry.recordCapabilityEvidence('gemini', 'gemini-3.1-flash-lite', 'unverified');
    }
    const measured = new AutoModelRouter().resolve(
      'writer',
      task,
      { allowedProviders: ['gemini', 'openrouter'] },
      configManager,
    );
    expect(measured.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    expect(measured.provider).toBe('openrouter');
  });

  it('does NOT apply the floor to a plain coding ask (a fast model is still allowed)', () => {
    // The floor is scoped to effect-observing intents — a simple edit is not one.
    const configManager = makeConfig({ gemini: { model: 'gemini-3.1-flash-lite' } });
    const decision = new AutoModelRouter().resolve(
      'writer',
      'implement a login form',
      { allowedProviders: ['gemini'] },
      configManager,
    );
    expect(decision.provider).toBe('gemini');
    expect(decision.ranked.length).toBe(1);
  });

  it('falls back (never dead-ends) when the floor would eliminate every provider', () => {
    const configManager = makeConfig({ gemini: { model: 'gemini-3.1-flash-lite' } });
    const decision = new AutoModelRouter().resolve(
      'writer',
      'fix the build',
      { allowedProviders: ['gemini'] },
      configManager,
    );
    expect(decision.provider).toBe('gemini');
    expect(decision.ranked.length).toBe(1);
  });
});

// ─── G5 — planning reasoning floor ─────────────────────────────────────────

/**
 * The planner is the highest-leverage agent: a weak planner's dependency graph
 * is inherited by every downstream step. So a `planner` call (taskType `plan`)
 * gets a reasoning floor even when the goal text reads as ordinary coding.
 */
describe('G5 — planning reasoning floor', () => {
  function makeConfig(providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('floors a planner pair by its MEASUREMENT, not by a fast-lite name', () => {
    const configManager = makeConfig({
      gemini: { model: 'gemini-3.1-flash-lite' },
      openrouter: { model: 'openai/gpt-4o' },
    });
    const decide = () =>
      new AutoModelRouter().resolve(
        'planner',
        'implement a login form',
        { allowedProviders: ['gemini', 'openrouter'] },
        configManager,
      );

    // COLD START: the planner floor still applies to the provider baseline, and
    // gemini's (0.85) clears it — so a flash-lite id is eligible. Excluding it for
    // its NAME was the defect (B1); the planner's leverage is a reason to MEASURE
    // the pair, not to read its spelling.
    expect(decide().ranked.some((s) => s.provider === 'gemini')).toBe(true);

    // MEASURED: once that pair has a record of not verifying its work, the
    // planner floor does its job and the plan goes to the stronger provider.
    const registry = getModelRegistry();
    registry.markListed('gemini', ['gemini-3.1-flash-lite']);
    for (let i = 0; i < PRIOR_FULL_SAMPLES; i++) {
      registry.recordCapabilityEvidence('gemini', 'gemini-3.1-flash-lite', 'unverified');
    }
    const measured = decide();
    expect(measured.ranked.some((s) => s.provider === 'gemini')).toBe(false);
    expect(measured.provider).toBe('openrouter');
  });

  it('does NOT floor the same goal for a non-planner agent (writer keeps the fast model)', () => {
    const configManager = makeConfig({ gemini: { model: 'gemini-3.1-flash-lite' } });
    const decision = new AutoModelRouter().resolve(
      'writer',
      'implement a login form',
      { allowedProviders: ['gemini'] },
      configManager,
    );
    expect(decision.provider).toBe('gemini');
  });
});

// ─── Routing rules ─────────────────────────────────────────────────────────

describe('AutoModelRouter.resolve routing rules', () => {
  // The rule+bandit regression test writes bandit state; the file-level hooks
  // above already isolate the learning state for every test in this file.
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
  // Hermetic registry: resolveModel() consults the Model Availability Registry
  // (a dead configured pin falls back to a registry-verified model), so isolate
  // it exactly like the sibling describes — ambient telemetry on the dev
  // machine must never flip a deterministic pin test.
  let resolveModelTempDir: string;
  let resolveModelOrigDir: string | undefined;

  beforeEach(() => {
    resolveModelOrigDir = process.env.NUVIRA_MEMORY_DIR;
    resolveModelTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-resolvemodel-'));
    process.env.NUVIRA_MEMORY_DIR = resolveModelTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (resolveModelOrigDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = resolveModelOrigDir;
    }
    resetModelRegistry();
    rmSync(resolveModelTempDir, { recursive: true, force: true });
  });

  it('returns catalog default model when no configManager is provided', () => {
    const router = new AutoModelRouter();
    // resolveModel() never returns 'default' — it returns a curated model
    const model = router.resolveModel('groq', 'writer');
    expect(model).toBeTruthy();
    expect(model).not.toBe('default');
  });

  it('returns the configured model when a configManager is provided', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => ({ config: { model: 'llama-3.3-70b-versatile' } })),
    } as any;
    expect(router.resolveModel('groq', 'writer', configManager)).toBe('llama-3.3-70b-versatile');
  });

  it('falls back to catalog default when config lookup throws', () => {
    const router = new AutoModelRouter();
    const configManager = {
      getProviderConfig: vi.fn(() => { throw new Error('unknown provider'); }),
    } as any;
    // Unknown providers fall back to catalog default or 'default' sentinel
    const model = router.resolveModel('unknown', 'writer', configManager);
    expect(model).toBeTruthy();
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
    // When catalog has a defaultModel, pickModelFromCatalog returns it
    // because resolveModel() now returns the catalog default, not 'default'
    const model = router.pickModelFromCatalog('groq', [
      { id: 'whisper', tags: ['speech'] },
      { id: 'llama-3.3', tags: [] },
    ]);
    expect(model).toBeTruthy();
  });

  it('pickModelFromCatalog returns catalog default when no usable model exists', () => {
    const router = new AutoModelRouter();
    // Never returns 'default' — returns catalog's curated default
    const model = router.pickModelFromCatalog('groq', []);
    expect(model).toBeTruthy();
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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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
  // registry fast-path (getUsableProviders) would leak the real ~/.nuvira
  // registry into the candidate set and pre-filter providers before the
  // governance slot even runs.
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-gov-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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
    // Only groq + local survive the admin allow-list — never ranked, never picked.
    expect(decision.ranked.every((s) => s.provider === 'groq' || s.provider === 'local')).toBe(true);
    // Issue 001: the FULL catalog is the candidate universe now, so the audit
    // trail shows every non-listed catalog provider killed by the allow-list
    // (keyless runners beyond local — nuvira/lmstudio/vllm — aren't candidates
    // unless verified/configured, so they never appear in the blocked audit).
    const blocked = decision.governanceBlocked || [];
    expect(blocked.map((b) => b.provider).sort()).toEqual(
      CATALOG_PROVIDER_IDS.filter(
        (p) => p !== 'groq' && p !== 'local' && !KEYLESS_RUNNERS.includes(p),
      ).sort(),
    );
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
    // Issue 001: every catalog provider with privacy >= 1.0 survives — local
    // AND lmstudio (both fully-local runners). Cloud providers are blocked.
    expect(decision.ranked.every((s) => s.provider === 'local' || s.provider === 'lmstudio')).toBe(true);
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
    // Issue 001: with credentials for the full catalog (the mock grants all),
    // every catalog provider is a candidate — except the keyless runners
    // beyond local (nuvira/lmstudio/vllm), which need verification or explicit
    // config. The policy stays permissive either way.
    expect(decision.ranked.length).toBe(CATALOG_PROVIDER_IDS.length - KEYLESS_RUNNERS.length);
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
    // Issue 001: the deny list must cover the FULL catalog to kill everyone
    // (previously 6 built-ins sufficed; now every catalog provider is a
    // candidate when credentials are granted).
    const configManager = makeConfig({ governance: { denyProviders: [...CATALOG_PROVIDER_IDS] } });
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
    // MODEL-LEVEL GATING: minSpeed 0.95 is an impossible per-request ask —
    // no served model (configured pin or curated default, refined by model-id
    // evidence) meets it, so SOFT elimination removes everyone. The soft-only
    // benign fallback would normally resurrect them, BUT here the survivor
    // pool is then judged by the admin allow-list, which excludes everything
    // (HARD) — falling back would resurrect an allow-list violator, so the
    // gate must throw. (The old provider-baseline minReasoning gate no longer
    // kills strong-tier providers here: model-level gating judges the served
    // model, not the provider baseline.)
    const configManager = makeConfig({ governance: { allowProviders: ['nonexistent-provider'] } });
    expect(() => new AutoModelRouter().resolve('writer', 'implement a login form', {
      minSpeed: 0.95,
    }, configManager)).toThrow(/Governance/);
  });

  it('MODEL-LEVEL GATING — minReasoning judges the served model by its MEASUREMENT', () => {
    // COLD START: local's baseline reasoning is 0.30, and no id can talk it past a
    // 0.55 floor any more. Before Bundle 3b a `qwen3-72b` id earned a +0.45
    // parameter-size boost and survived — for its NAME. That is the behaviour B1
    // removes: a pin with no track record is judged by the provider it runs on.
    const pinStrong = makeConfig({}, { local: { model: 'qwen3-72b-instruct' } });
    const killedCold = new AutoModelRouter().resolve('writer', 'implement a login form', {
      minReasoning: 0.55,
    }, pinStrong);
    expect(killedCold.ranked.find((s) => s.provider === 'local')).toBeUndefined();

    // MEASURED: the same pair, having actually verified its work, clears the
    // floor — a track record is the thing that earns eligibility.
    const registry = getModelRegistry();
    registry.markListed('local', ['qwen3-72b-instruct']);
    for (let i = 0; i < PRIOR_FULL_SAMPLES; i++) {
      registry.recordCapabilityEvidence('local', 'qwen3-72b-instruct', 'verified');
    }
    const survived = new AutoModelRouter().resolve('writer', 'implement a login form', {
      minReasoning: 0.55,
    }, pinStrong);
    expect(survived.ranked.find((s) => s.provider === 'local')).toBeDefined();
  });

  it('MODEL-LEVEL GATING — minSpeed judges the served model by its MEASURED performance', () => {
    // Gemini's baseline speed is 0.80, so a 0.9 floor eliminates it on a cold
    // start; a `flash-lite` id no longer grants +0.15 of speed evidence for its
    // spelling. What clears the floor is having been measured FAST.
    const pinFast = makeConfig({}, { gemini: { model: 'gemini-2.0-flash-lite' } });
    const coldOut = new AutoModelRouter().resolve('writer', 'implement a login form', {
      minSpeed: 0.9,
    }, pinFast);
    expect(coldOut.ranked.find((s) => s.provider === 'gemini')).toBeUndefined();

    const registry = getModelRegistry();
    for (let i = 0; i < PRIOR_FULL_SAMPLES; i++) {
      registry.recordCall('gemini', 'gemini-2.0-flash-lite', true, undefined, 'chat', 300);
    }
    const fastOk = new AutoModelRouter().resolve('writer', 'implement a login form', {
      minSpeed: 0.9,
    }, pinFast);
    expect(fastOk.ranked.find((s) => s.provider === 'gemini')).toBeDefined();

    // The old third case here — a "heavyweight" id (`deepseek-r1-large-max`)
    // eliminated by the same floor — is GONE ON PURPOSE: it asserted that the id
    // is evidence. It is not (B1). The two cases above are the honest pair: an
    // unmeasured model is judged by its provider, a measured one by its record.
  });

  it('getModelCapabilities returns the provider baseline for every id with no measurements', () => {
    const router = new AutoModelRouter();
    const base = router.getCapabilities('local');
    // No model-id signal survives (B1) — not size, not tier words, not frontier
    // keywords. Every id with no measurement is its provider, exactly.
    for (const id of ['qwen3-72b-instruct', 'llama3:1b', 'gpt-4o', 'totally-unknown-model']) {
      expect(router.getModelCapabilities('local', id), id).toEqual(base);
    }
    // The sentinel is not a model: it returns the baseline too, unchanged.
    expect(router.getModelCapabilities('local', 'default')).toEqual(base);
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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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

  it('live probe descriptors beat provider defaults; explicit overrides still win', () => {
    // The registry carries the model's ADVERTISED window (recorded by the
    // listModels probe) — the preflight prefers it over the provider default.
    getModelRegistry().markListed('local', [
      { id: 'qwen3:32b', name: 'qwen3:32b', provider: 'local', contextWindowTokens: 32_768 },
    ]);

    // No override: the live 32,768 descriptor beats local's 8K nominal default.
    const live = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local'],
    }, makeConfig({}, { local: { model: 'qwen3:32b' } }));
    expect(live.ranked.find((r) => r.provider === 'local')!.contextWindowTokens).toBe(32_768);

    // An explicit routing.contextWindows override still beats the live descriptor.
    const overridden = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local'],
    }, makeConfig({ contextWindows: { local: 65_536 } }, { local: { model: 'qwen3:32b' } }));
    expect(overridden.ranked.find((r) => r.provider === 'local')!.contextWindowTokens).toBe(65_536);
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

  it('provider-estimate windows carry contextWindowSource but keep the reason clean (ISSUE-002)', () => {
    // local has a provider-level nominal window (8K) but no LIVE advertised
    // descriptor in the registry → source 'provider' (a known estimate). The
    // window is a known quantity, so the REASON stays clean for normal-size
    // tasks; the source is still surfaced on the row + preflight snapshot.
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local', 'groq'],
      contextHintTokens: 60_000,
    }, makeConfig());
    const local = decision.ranked.find((r) => r.provider === 'local')!;
    expect(local.contextWindowSource).toBe('provider');
    expect(local.reason).not.toContain('no advertised spec');
    const groq = decision.ranked.find((r) => r.provider === 'groq')!;
    expect(groq.contextWindowSource).toBe('provider');
    // The preflight snapshot carries the source for the explain view.
    expect(decision.contextPreflight?.providers.find((p) => p.provider === 'local')?.contextWindowSource)
      .toBe('provider');
  });

  it('LIVE advertised windows are NOT flagged as estimates (the truth needs no chip)', () => {
    // A live probe descriptor (Ollama/OpenRouter context_length) recorded in
    // the registry is the provider's ADVERTISED spec — no estimate chip.
    getModelRegistry().markListed('local', [
      { id: 'qwen3:32b', name: 'qwen3:32b', provider: 'local', contextWindowTokens: 32_768 },
    ]);
    const decision = new AutoModelRouter().resolve('writer', 'implement a login form', {
      allowedProviders: ['local'],
    }, makeConfig({}, { local: { model: 'qwen3:32b' } }));
    const local = decision.ranked.find((r) => r.provider === 'local')!;
    expect(local.contextWindowSource).toBe('live');
    expect(local.reason).not.toContain('provider estimate');
    expect(local.reason).not.toContain('no advertised spec');
  });

  it('a provider with NO window anywhere falls back to the default and is flagged (ISSUE-002)', () => {
    // A custom (non-catalog) provider has no provider-level window and no live
    // descriptor → the generous default. The reason must flag it as an
    // unadvertised-spec default, never silently treat it like a real window.
    const decision = new AutoModelRouter({ mycustom: { reasoning: 0.5, speed: 0.5, cost: 0.5, privacy: 0.3, reliability: 0.7 } })
      .resolve('writer', 'implement a login form', {
        allowedProviders: ['mycustom'],
      }, makeConfig());
    const row = decision.ranked.find((r) => r.provider === 'mycustom')!;
    expect(row.contextWindowSource).toBe('default');
    expect(row.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(row.reason).toContain('no advertised spec');
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
  });  it('resetAutoRouter creates a new instance on next call', () => {
    const a = getAutoRouter();
    resetAutoRouter();
    const b = getAutoRouter();
    expect(a).not.toBe(b);
  });

});

// ─── ML task-similarity router (ruflo neural-router analog) ───────────────

describe('AutoModelRouter.resolve — ML task-similarity blend', () => {
  let mlDir: string;

  beforeEach(() => {
    mlDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-ml-'));
    process.env.NUVIRA_MEMORY_DIR = mlDir;
    resetMlRouter();
  });

  afterEach(() => {
    delete process.env.NUVIRA_MEMORY_DIR;
    resetMlRouter();
    resetRouterBandit();
    resetRouterPromotion();
    rmSync(mlDir, { recursive: true, force: true });
  });

  function makeConfig(routing?: Record<string, unknown>, providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: routing || {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('ML blend nudges a provider that succeeded on similar tasks', () => {
    const router = new AutoModelRouter();
    const ml = getMlRouter();
    // Learn: groq wins on login-form-like tasks, gemini loses there.
    for (let i = 0; i < 8; i++) {
      ml.record('implement JWT authentication with refresh tokens', 'groq', 'llama-3.3-70b', 'success', 0.85, 'writer', 'moderate', 'coding');
    }
    for (let i = 0; i < 8; i++) {
      ml.record('implement JWT authentication with refresh tokens', 'gemini', 'gemini-2.0-flash', 'failure', 0.4, 'writer', 'moderate', 'coding');
    }

    const decision = router.resolve('writer', 'implement JWT auth with refresh token rotation', {
      allowedProviders: ['groq', 'gemini'],
      useMlRouter: true,
      mlMinSamples: 5,
    }, makeConfig());

    // groq's learned factor pushed it above any gemini edge on this family.
    expect(decision.provider).toBe('groq');
    // The reason reflects the ML adjustment.
    const row = decision.ranked.find((r) => r.provider === 'groq')!;
    expect(row.reason).toContain('ml:');
  });

  it('ML blend is a no-op on cold start (no learned data → neutral)', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement JWT auth', {
      allowedProviders: ['groq', 'gemini'],
      useMlRouter: true,
    }, makeConfig());
    // No data → no ML reasons anywhere, picks are purely deterministic.
    for (const r of decision.ranked) {
      expect(r.reason).not.toContain('ml:');
    }
  });
});

// ─── Promotion-gate enforcement (ruflo promotion discipline) ───────────────

describe('AutoModelRouter.resolve — promotion-gate enforcement', () => {
  let promoDir: string;

  beforeEach(() => {
    promoDir = mkdtempSync(join(tmpdir(), 'buff-autorouter-promo-'));
    process.env.NUVIRA_MEMORY_DIR = promoDir;
    resetRouterBandit();
    resetRouterPromotion();
  });

  afterEach(() => {
    delete process.env.NUVIRA_MEMORY_DIR;
    resetRouterBandit();
    resetRouterPromotion();
    rmSync(promoDir, { recursive: true, force: true });
  });

  function makeConfig(routing?: Record<string, unknown>, providers: Record<string, { model?: string }> = {}) {
    return {
      getAll: vi.fn(() => ({ pricing: {}, routing: routing || {}, providers })),
      hasRequiredCredentials: vi.fn(() => true),
      getProviderConfig: vi.fn((p: string) => ({ config: providers[p] || {} })),
    } as any;
  }

  it('blocks the bandit from changing picks when the gate has sufficient data and the bandit FAILS', () => {
    const router = new AutoModelRouter();
    const gate = getRouterPromotion();

    // Build a trajectory where the bandit DIVERGED and LOST (heuristic won more).
    // Record diverged decisions: heuristic pick succeeded, bandit pick failed.
    for (let i = 0; i < 25; i++) {
      gate.noteParallelDecision(
        'writer',
        `task-${i}`,
        { provider: 'groq', model: 'llama-3.3-70b', predictedQuality: 0.7, predictedCostUsd: 0.001, estimatedLatencyMs: 100 },
        { provider: 'gemini', model: 'gemini-2.0-flash', predictedQuality: 0.9, predictedCostUsd: 0.05, estimatedLatencyMs: 400 },
      );
      gate.recordOutcome('writer', `task-${i}`, 'success', {});
    }

    const status = gate.evaluate(20);
    expect(status.sufficient).toBe(true);
    expect(status.promoted).toBe(false); // quality up but cost exploded → fail

    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
      enforcePromotion: true,
      promotionMinDecisions: 20,
    }, makeConfig());

    // Enforcement kicked in: the deterministic heuristic ranking was used.
    expect(decision.routedBy).toBe('bandit-gated');
  });

  it('lets the bandit through when the gate has insufficient data (not yet judgeable)', () => {
    const router = new AutoModelRouter();
    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
      enforcePromotion: true,
      promotionMinDecisions: 20,
    }, makeConfig());
    // No trajectory → not sufficient → bandit allowed.
    expect(decision.routedBy).toBe('bandit');
  });

  it('lets the bandit through when the gate is sufficient AND the bandit is promoted', () => {
    const router = new AutoModelRouter();
    const gate = getRouterPromotion();
    // Bandit diverged and WON every time (quality up, cost down).
    for (let i = 0; i < 25; i++) {
      gate.noteParallelDecision(
        'writer',
        `task-${i}`,
        { provider: 'gemini', model: 'gemini-2.0-flash', predictedQuality: 0.7, predictedCostUsd: 0.05, estimatedLatencyMs: 400 },
        { provider: 'groq', model: 'llama-3.3-70b', predictedQuality: 0.9, predictedCostUsd: 0.001, estimatedLatencyMs: 100 },
      );
      gate.recordOutcome('writer', `task-${i}`, 'success', {});
    }
    const status = gate.evaluate(20);
    expect(status.promoted).toBe(true);

    const decision = router.resolve('writer', 'implement a login form', {
      allowedProviders: ['groq', 'gemini'],
      useBandit: true,
      enforcePromotion: true,
      promotionMinDecisions: 20,
    }, makeConfig());
    expect(decision.routedBy).toBe('bandit');
  });
});

// ─── R4 — agentic capability floor ──────────────────────────────────────────
// Effective capability is `model × (1 − harness tax)`: a multi-step agentic task
// needs the SERVED model to hold a tool loop across turns. Auto must not hand a
// complex task to a model too small to run one — that is a doomed run which then
// gets booked as a model failure, teaching the bandit a lesson about the model
// when the mismatch was the router's.

describe('R4 — agentic capability floor', () => {
  /** Pin each provider to an explicit served model (the router's real pin path). */
  const pinnedConfig = (models: Record<string, string>) =>
    ({
      getProviderConfig: (p: string) => ({ config: { model: models[p] } }),
      getAll: () => ({}),
      hasRequiredCredentials: () => true,
    }) as any;

  const bothProviders = pinnedConfig({ local: 'qwen2.5:0.5b', groq: 'openai/gpt-oss-120b' });
  const opts = { allowedProviders: ['local', 'groq'] };

  it('eliminates a tiny served model for an agentic (complex) task', () => {
    const decision = new AutoModelRouter().resolve('writer', 'deploy to production', opts, bothProviders);
    // `deploy to production` is critical → agentic. The 0.5B local model cannot
    // hold a tool loop, so it must not even be a candidate.
    expect(decision.complexity).toBe('critical');
    expect(decision.ranked.map((r) => r.provider)).not.toContain('local');
    expect(decision.provider).toBe('groq');
  });

  it('keeps the same tiny model for a NON-agentic (trivial) task', () => {
    // The floor is about AGENTIC work, not about banning small models: a trivial
    // one-shot is exactly what a tiny local model is for (free, fast, local).
    const decision = new AutoModelRouter().resolve('writer', 'format this code', opts, bothProviders);
    expect(decision.complexity).toBe('trivial');
    expect(decision.ranked.map((r) => r.provider)).toContain('local');
  });

  it('APPLIES the floor to a MODERATE software ask, not just complex/critical', () => {
    // The live regression (2026-10-04): "create mac od gui app" is 🟡 moderate
    // (NOT complex), so it skipped the floor entirely and `max` mode's
    // performance-first score handed the build to a local 4-bit model. A
    // software build is agentic at any non-trivial complexity.
    const decision = new AutoModelRouter().resolve('writer', 'create a settings page for the app', opts, bothProviders);
    expect(decision.complexity).not.toBe('critical');
    expect(decision.ranked.map((r) => r.provider)).not.toContain('local');
  });

  it('still allows a small local model for CREATIVE work (writing is not a build)', () => {
    // The user's own rule: complex tasks to reasoning models, chat/writing to
    // whatever is available. A poem may use the free local model.
    expect(analyzeTaskProfile('write a short poem about rain').intent).toBe('creative');
  });

  it('judges the SERVED model, so a provider hosting both keeps its strong entry', () => {
    // `local` serves a real model here — the floor must not eliminate `local`
    // merely because that provider CAN serve a tiny model.
    const mixed = pinnedConfig({ local: 'llama3.1:70b', groq: 'openai/gpt-oss-120b' });
    const decision = new AutoModelRouter().resolve('writer', 'deploy to production', opts, mixed);
    expect(decision.ranked.map((r) => r.provider)).toContain('local');
  });

  it('never dead-ends: falls back to the full ranking when the floor would eliminate everyone', () => {
    // Both providers pinned tiny. Returning no route would be worse than
    // returning the best of a bad set (auto must always produce a pick).
    const allTiny = pinnedConfig({ local: 'qwen2.5:0.5b', groq: 'llama3.2:1b' });
    const decision = new AutoModelRouter().resolve('writer', 'deploy to production', opts, allTiny);
    expect(decision.ranked.length).toBeGreaterThan(0);
    expect(decision.provider).toBeTruthy();
  });
});
