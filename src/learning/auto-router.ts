/**
 * AutoModelRouter — "Use the right model for the right task."
 *
 * A first-class model selection option (`auto`) that lets Agent-Nuvira decide
 * which provider/model to use for each task instead of pinning a single model.
 *
 * Selection dimensions (all scored 0–1 per provider):
 *   1. **Reasoning** — capability for deep/complex tasks
 *   2. **Speed**     — latency score (higher = faster)
 *   3. **Cost**      — cost score (higher = cheaper)
 *   4. **Privacy**   — data locality (1 = fully local/offline)
 *   5. **Reliability** — uptime / error rate
 *
 * Task complexity (from `analyzeComplexity`) shifts the dimension weights:
 *   - trivial/simple  → cost + speed dominate (fast planning with small model)
 *   - moderate        → balanced
 *   - complex/critical → reasoning + reliability dominate (deep reasoning with
 *     larger model; cloud for high-complexity tasks)
 *
 * Privacy preference (preferenceMode === 'privacy-first') routes private tasks
 * to the local provider. Fallback chains and circuit-breaker cooldowns come from
 * the existing `ProviderFallback` engine — providers in cooldown are deprioritized
 * (or excluded) so reliability is honored at runtime.
 *
 * Integration:
 * - `buff model switch auto` — select Auto as the active model
 * - Model picker shows "Auto — Agent decides" as the first option
 * - `chat` routes every message when the active model is `auto`
 * - Orchestrator routes each agent task when `--model auto` or `--auto-route` is set
 *
 * Usage:
 * ```ts
 * import { getAutoRouter } from './auto-router.js';
 * const router = getAutoRouter();
 * const decision = router.resolve('writer', 'implement JWT auth with refresh tokens');
 * // → { provider: 'gemini', model: 'gemini-2.0-flash-exp', explanation: '...' }
 * ```
 */

import { analyzeComplexity, type ComplexityLevel, type ModelCandidate, type PreferenceMode } from './hybrid-router.js';
import { getTaskType, type TaskType } from './model-router.js';
import { getBenchmarkRuns } from './benchmark.js';
import { getAgentStats } from './agent-stats.js';
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** The special model value that triggers automatic per-task routing. */
export const AUTO_MODEL = 'auto';

/** The special provider value stored in active-model state for Auto mode. */
export const AUTO_PROVIDER = 'auto';

/** The five routing dimensions. */
export type RoutingDimension = 'reasoning' | 'speed' | 'cost' | 'privacy' | 'reliability';

/** Human labels for each dimension (used in explanations). */
export const DIMENSION_LABELS: Record<RoutingDimension, string> = {
  reasoning: 'reasoning',
  speed: 'speed',
  cost: 'cost',
  privacy: 'privacy',
  reliability: 'reliability',
};

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Per-provider capability profile.
 * Every value is 0–1; higher is always better for that dimension.
 */
export interface ProviderCapabilities {
  /** Deep-reasoning capability (1 = frontier model) */
  reasoning: number;
  /** Latency score (1 = fastest) */
  speed: number;
  /** Cost score (1 = cheapest) */
  cost: number;
  /** Privacy / data-locality (1 = fully local, offline) */
  privacy: number;
  /** Reliability / uptime (1 = most reliable) */
  reliability: number;
}

/** Options for a single resolve() call. */
export interface AutoRouterOptions {
  /** Preference mode — shifts dimension weights (default: 'balanced') */
  preferenceMode?: PreferenceMode;
  /** Restrict candidates to these providers (default: all built-in) */
  allowedProviders?: string[];
  /** Manual weight overrides for specific dimensions (0–1, unnormalized OK) */
  weights?: Partial<Record<RoutingDimension, number>>;
  /** Providers currently in circuit-breaker cooldown (ms remaining keyed by provider) */
  circuitBreakerStatus?: Array<{ provider: string; cooldownRemaining: number }>;
  /** Whether to log the decision (default: false) */
  verbose?: boolean;
  /** Session cost budget (USD) — cheapest adequate candidate wins if exceeded */
  sessionBudget?: number;
  /**
   * Blend real provider pricing into the cost dimension instead of static
   * capability profiles (default: true).
   */
  useRealPricing?: boolean;
  /**
   * Adjust provider scores from runtime data — benchmark quality and
   * per-agent best-model stats (default: false).
   */
  useRuntimeStats?: boolean;
}

/** Per-provider score breakdown. */
export interface ScoredProvider {
  provider: string;
  /** Weighted composite score (0–1) */
  score: number;
  /** Per-dimension contribution (weight × capability, 0–1) */
  dimensions: Record<RoutingDimension, number>;
  /** Total available weight (for normalization) */
  weightTotal: number;
  /** Whether this provider is currently in circuit-breaker cooldown */
  inCooldown: boolean;
  /** Why this provider ranked where it did */
  reason: string;
}

/** The final auto-routing decision for a single task. */
export interface AutoRouteResult {
  /** The agent type this decision is for */
  agentType: string;
  /** Detected task complexity */
  complexity: ComplexityLevel;
  /** Mapped task type (from ModelRouter) */
  taskType: TaskType;
  /** Selected provider */
  provider: string;
  /** Selected model within that provider */
  model: string;
  /** Composite score of the selected provider (0–1) */
  score: number;
  /** All scored providers, ranked best-first */
  ranked: ScoredProvider[];
  /** Full fallback chain (primary first) — ModelCandidate[] for HybridModelRouter compat */
  fallbackChain: ModelCandidate[];
  /** Human-readable explanation */
  explanation: string;
}

// ─── Provider Capability Profiles ───────────────────────────────────────────
//
// Static baseline profiles for the built-in providers. These encode the
// "right tool for the job" tiers:
//   - local      — private, free, offline; modest reasoning
//   - groq       — fastest, cheap, good general coding
//   - nim        — strong reasoning, reasonable cost
//   - gemini     — strong reasoning + speed, good for complex work
//   - openrouter — frontier reasoning (GPT/Claude tier), slower, pricier
//
// Profiles can be overridden per-call via AutoRouterOptions (see weights).

const DEFAULT_PROFILES: Record<string, ProviderCapabilities> = {
  local: { reasoning: 0.30, speed: 0.55, cost: 1.00, privacy: 1.00, reliability: 0.60 },
  groq: { reasoning: 0.55, speed: 1.00, cost: 0.85, privacy: 0.15, reliability: 0.85 },
  nim: { reasoning: 0.72, speed: 0.70, cost: 0.55, privacy: 0.15, reliability: 0.82 },
  gemini: { reasoning: 0.85, speed: 0.80, cost: 0.40, privacy: 0.10, reliability: 0.88 },
  openrouter: { reasoning: 0.95, speed: 0.55, cost: 0.15, privacy: 0.10, reliability: 0.78 },
};

/** Built-in provider ids considered by default. */
export const DEFAULT_AUTO_PROVIDERS = Object.keys(DEFAULT_PROFILES);

// ─── Real Provider Pricing ──────────────────────────────────────────────────
//
// Actual per-1K-token list pricing (USD, input/output) used to derive the cost
// dimension score instead of static profiles. Sources: provider pricing pages
// (approximate; free tiers count as $0). Costs are configurable by overriding
// the pricing table below.

/** Real per-1K-token pricing (USD) — input/output per 1K tokens. */
export const PROVIDER_PRICING_PER_1K: Record<string, { inputPer1K: number; outputPer1K: number }> = {
  groq: { inputPer1K: 0.00059, outputPer1K: 0.00079 },   // Llama-3.3-70B-class
  nim: { inputPer1K: 0.00010, outputPer1K: 0.00050 },     // varies by model
  gemini: { inputPer1K: 0, outputPer1K: 0 },              // free tier default
  openrouter: { inputPer1K: 0.00250, outputPer1K: 0.01000 }, // GPT-4o-class pass-through
  local: { inputPer1K: 0, outputPer1K: 0 },               // free (local compute)
};

/** Reference cost per call (USD) used to normalize the 0–1 cost score. */
const COST_REFERENCE_USD = 0.01;

/** Typical call size used for cost scoring (input/output tokens). */
const TYPICAL_INPUT_TOKENS = 2000;
const TYPICAL_OUTPUT_TOKENS = 500;

/**
 * Estimate the USD cost of a typical call for a provider.
 */
export function estimateCallCostUsd(provider: string): number {
  const p = PROVIDER_PRICING_PER_1K[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };
  const inputCost = (TYPICAL_INPUT_TOKENS / 1000) * p.inputPer1K;
  const outputCost = (TYPICAL_OUTPUT_TOKENS / 1000) * p.outputPer1K;
  return Math.round((inputCost + outputCost) * 100000) / 100000;
}

/**
 * Derive the 0–1 cost score (higher = cheaper) from real provider pricing.
 * Free providers (local, Gemini free tier) score 1.0.
 */
export function computeCostScore(provider: string): number {
  const costUsd = estimateCallCostUsd(provider);
  const score = 1 - costUsd / COST_REFERENCE_USD;
  return Math.max(0, Math.min(1, score));
}

/**
 * Baseline dimension weights per complexity level (balanced mode).
 * These are normalized by the router; the *relative* values matter.
 */
const COMPLEXITY_WEIGHTS: Record<ComplexityLevel, Record<RoutingDimension, number>> = {
  trivial: { reasoning: 0.10, speed: 0.35, cost: 0.30, privacy: 0.10, reliability: 0.15 },
  simple: { reasoning: 0.20, speed: 0.30, cost: 0.25, privacy: 0.10, reliability: 0.15 },
  moderate: { reasoning: 0.30, speed: 0.25, cost: 0.20, privacy: 0.10, reliability: 0.15 },
  complex: { reasoning: 0.40, speed: 0.15, cost: 0.10, privacy: 0.10, reliability: 0.25 },
  critical: { reasoning: 0.45, speed: 0.10, cost: 0.05, privacy: 0.10, reliability: 0.30 },
};

/**
 * Preference-mode weight adjustments (additive, applied on top of complexity weights).
 */
const MODE_ADJUSTMENTS: Record<PreferenceMode, Partial<Record<RoutingDimension, number>>> = {
  balanced: {},
  'performance-first': { reasoning: 0.10, speed: 0.15, cost: -0.10, reliability: 0.05 },
  'cost-first': { cost: 0.20, reasoning: -0.10, speed: -0.05 },
  'privacy-first': { privacy: 0.60, cost: 0.05, reasoning: -0.15, reliability: 0.05 },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check whether a model value means "Auto routing".
 */
export function isAutoModel(model?: string | null): boolean {
  return model === AUTO_MODEL;
}

/**
 * Check whether a provider value means "Auto routing".
 */
export function isAutoProvider(provider?: string | null): boolean {
  return provider === AUTO_PROVIDER;
}

/**
 * Compute the effective dimension weights for a task.
 * Combines complexity baseline + preference-mode adjustments + user overrides,
 * then normalizes to sum 1 so scores are comparable across calls.
 */
export function computeWeights(
  complexity: ComplexityLevel,
  mode: PreferenceMode = 'balanced',
  overrides?: Partial<Record<RoutingDimension, number>>,
): Record<RoutingDimension, number> {
  const base = { ...COMPLEXITY_WEIGHTS[complexity] };
  const adj = MODE_ADJUSTMENTS[mode] || {};

  const merged: Record<RoutingDimension, number> = { ...base };
  for (const dim of Object.keys(DIMENSION_LABELS) as RoutingDimension[]) {
    merged[dim] = (base[dim] || 0) + (adj[dim] || 0);
    if (overrides?.[dim] !== undefined) {
      merged[dim] = overrides[dim]!;
    }
    if (merged[dim] < 0) merged[dim] = 0;
  }

  const total = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
  const normalized = {} as Record<RoutingDimension, number>;
  for (const dim of Object.keys(DIMENSION_LABELS) as RoutingDimension[]) {
    normalized[dim] = merged[dim] / total;
  }
  return normalized;
}

/**
 * Score a single provider against the effective weights.
 */
export function scoreProvider(
  provider: string,
  capabilities: ProviderCapabilities,
  weights: Record<RoutingDimension, number>,
): { score: number; dimensions: Record<RoutingDimension, number>; weightTotal: number } {
  const dimensions = {} as Record<RoutingDimension, number>;
  let score = 0;
  let weightTotal = 0;
  for (const dim of Object.keys(DIMENSION_LABELS) as RoutingDimension[]) {
    const w = weights[dim] || 0;
    const contribution = w * (capabilities[dim] ?? 0);
    dimensions[dim] = contribution;
    score += contribution;
    weightTotal += w;
  }
  return { score, dimensions, weightTotal };
}

// ─── Auto Model Router ──────────────────────────────────────────────────────

/**
 * AutoModelRouter — scores available providers per task and picks the best.
 */
export class AutoModelRouter {
  private profiles: Record<string, ProviderCapabilities>;

  constructor(profiles?: Record<string, ProviderCapabilities>) {
    this.profiles = profiles ? { ...DEFAULT_PROFILES, ...profiles } : { ...DEFAULT_PROFILES };
  }

  /** Get the capability profile for a provider (falls back to a neutral profile). */
  getCapabilities(provider: string): ProviderCapabilities {
    return this.profiles[provider] || { reasoning: 0.5, speed: 0.5, cost: 0.5, privacy: 0.2, reliability: 0.7 };
  }

  /** Update/override capability profiles (e.g., from config). */
  updateProfiles(profiles: Record<string, ProviderCapabilities>): void {
    this.profiles = { ...this.profiles, ...profiles };
  }

  /**
   * Resolve the optimal provider/model for a task.
   *
   * @param agentType — Agent type (e.g., 'writer', 'planner', 'chat')
   * @param taskDescription — The task text used for complexity analysis
   * @param options — Routing options (mode, allowed providers, circuit-breaker status)
   * @param configManager — Optional; used to resolve provider model defaults
   * @returns An AutoRouteResult with ranked providers, fallback chain, and explanation
   */
  resolve(
    agentType: string,
    taskDescription: string,
    options: AutoRouterOptions = {},
    configManager?: ConfigManager,
  ): AutoRouteResult {
    const complexity = analyzeComplexity(taskDescription);
    const taskType = getTaskType(agentType);
    const mode = options.preferenceMode || 'balanced';
    const weights = computeWeights(complexity, mode, options.weights);

    const allowed = options.allowedProviders?.length
      ? options.allowedProviders
      : DEFAULT_AUTO_PROVIDERS;

    const cooldown = new Map<string, number>();
    for (const cb of options.circuitBreakerStatus || []) {
      if (cb.cooldownRemaining > 0) cooldown.set(cb.provider, cb.cooldownRemaining);
    }

    // Load runtime stats once (benchmark quality + best-model per agent type)
    const runtime = options.useRuntimeStats ? this.loadRuntimeAdjustments(agentType) : null;
    if (runtime && options.verbose) {
      logger.info(`  📊 Runtime stats: ${runtime.summary}`);
    }

    // Score every allowed provider
    const scored: ScoredProvider[] = allowed.map((provider) => {
      let caps = this.getCapabilities(provider);
      // Real pricing replaces the static cost capability
      if (options.useRealPricing !== false) {
        caps = { ...caps, cost: computeCostScore(provider) };
      }
      // Runtime data adjusts reasoning/reliability from real performance
      if (runtime) {
        caps = this.adjustCapabilitiesForRuntime(caps, provider, runtime);
      }
      const { score, dimensions, weightTotal } = scoreProvider(provider, caps, weights);
      const inCooldown = cooldown.has(provider);
      const reason = this.buildReason(provider, caps, complexity, mode, inCooldown, runtime?.adjusted.has(provider));
      return { provider, score, dimensions, weightTotal, inCooldown, reason };
    });

    // Rank: in-cooldown providers sink below non-cooldown ones; ties broken by score
    scored.sort((a, b) => {
      if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
      return b.score - a.score;
    });

    // Pick the best candidate that is not in cooldown (unless ALL are in cooldown)
    const selected = scored.find((s) => !s.inCooldown) || scored[0];
    const provider = selected.provider;
    const model = this.resolveModel(provider, agentType, configManager);

    // Build fallback chain (skip in-cooldown providers when alternatives exist)
    const fallbackChain: ModelCandidate[] = scored
      .filter((s) => s.provider !== provider)
      .map((s) => ({
        provider: s.provider,
        model: this.resolveModel(s.provider, agentType, configManager),
        estimatedCost: 0,
        qualityScore: s.score,
        reason: s.inCooldown ? `Fallback (in cooldown): ${s.provider}` : `Fallback: ${s.provider}`,
      }));

    const explanation = this.buildExplanation(
      agentType,
      complexity,
      taskType,
      selected,
      mode,
      model,
      weights,
    );

    if (options.verbose) {
      logger.info(`  🤖 Auto routing: ${explanation}`);
    }

    return {
      agentType,
      complexity,
      taskType,
      provider,
      model,
      score: selected.score,
      ranked: scored,
      fallbackChain,
      explanation,
    };
  }

  /**
   * Resolve the model name to use within a chosen provider.
   * Prefers the provider's configured model; falls back to 'default'.
   */
  resolveModel(provider: string, agentType: string, configManager?: ConfigManager): string {
    if (configManager) {
      try {
        const { config } = configManager.getProviderConfig(provider);
        if (config?.model) return config.model;
      } catch {
        // Fall through to default
      }
    }
    return 'default';
  }

  /**
   * Pick the best model within the selected provider, given a list of model
   * descriptors (e.g., from provider.listModels()). Keeps the configured model
   * if present, otherwise the first non-speech model, otherwise 'default'.
   */
  pickModelFromCatalog(
    provider: string,
    models: Array<{ id: string; tags?: string[] }>,
    configManager?: ConfigManager,
  ): string {
    const configured = this.resolveModel(provider, 'default', configManager);
    if (configured !== 'default') return configured;
    const usable = models.find((m) => !(m.tags || []).includes('speech'));
    return usable?.id || 'default';
  }

  /**
   * Load runtime performance data: per-provider benchmark quality and the
   * best-performing model for the given agent type (from agent stats).
   */
  private loadRuntimeAdjustments(agentType: string): {
    benchmarkQuality: Record<string, number>;
    bestModelForAgent?: string;
    adjusted: Set<string>;
    summary: string;
  } {
    const benchmarkQuality: Record<string, number> = {};
    const counts: Record<string, number> = {};
    try {
      for (const run of getBenchmarkRuns()) {
        benchmarkQuality[run.provider] = (benchmarkQuality[run.provider] || 0) + run.summary.avgQualityScore;
        counts[run.provider] = (counts[run.provider] || 0) + 1;
      }
      for (const provider of Object.keys(benchmarkQuality)) {
        benchmarkQuality[provider] /= counts[provider] || 1;
      }
    } catch {
      // Benchmark data unavailable — proceed without it
    }

    let bestModelForAgent: string | undefined;
    try {
      bestModelForAgent = getAgentStats().getBestModel(agentType);
    } catch {
      // Stats unavailable
    }

    const parts: string[] = [];
    if (Object.keys(benchmarkQuality).length > 0) {
      parts.push(`${Object.keys(benchmarkQuality).length} provider(s) benchmarked`);
    }
    if (bestModelForAgent) {
      parts.push(`best model for '${agentType}' is ${bestModelForAgent}`);
    }

    return {
      benchmarkQuality,
      bestModelForAgent,
      adjusted: new Set(),
      summary: parts.join('; ') || 'no data yet',
    };
  }

  /**
   * Adjust a provider's capability scores from runtime data:
   * - Benchmark quality blends into `reasoning` (30% measured / 70% static)
   * - A proven best model for this agent type boosts reliability + reasoning
   */
  private adjustCapabilitiesForRuntime(
    caps: ProviderCapabilities,
    provider: string,
    runtime: { benchmarkQuality: Record<string, number>; bestModelForAgent?: string; adjusted: Set<string> },
  ): ProviderCapabilities {
    const adjusted = { ...caps };
    let touched = false;

    const bq = runtime.benchmarkQuality[provider];
    if (bq !== undefined) {
      adjusted.reasoning = Math.min(1, caps.reasoning * 0.7 + bq * 0.3);
      touched = true;
    }

    if (runtime.bestModelForAgent && runtime.bestModelForAgent.startsWith(provider + '/')) {
      adjusted.reliability = Math.min(1, caps.reliability + 0.08);
      adjusted.reasoning = Math.min(1, adjusted.reasoning + 0.05);
      touched = true;
    }

    if (touched) runtime.adjusted.add(provider);
    return adjusted;
  }

  /** Build a short reason for a provider's rank. */
  private buildReason(
    provider: string,
    caps: ProviderCapabilities,
    complexity: ComplexityLevel,
    mode: PreferenceMode,
    inCooldown: boolean,
    runtimeAdjusted: boolean = false,
  ): string {
    if (inCooldown) return `${provider} (circuit-breaker cooldown active)`;
    const parts: string[] = [];
    if (caps.privacy >= 0.9) parts.push('fully private/local');
    if (caps.speed >= 0.9) parts.push('fastest');
    if (caps.reasoning >= 0.9) parts.push('strongest reasoning');
    if (caps.cost >= 0.85) parts.push('cheapest');
    if (mode === 'privacy-first') parts.push('privacy-weighted');
    if (runtimeAdjusted) parts.push('📊 stats-adjusted');
    return parts.length ? `${provider}: ${parts.join(', ')}` : `${provider}: adequate for ${complexity} complexity`;
  }

  /** Build the human-readable decision explanation. */
  private buildExplanation(
    agentType: string,
    complexity: ComplexityLevel,
    taskType: TaskType,
    selected: ScoredProvider,
    mode: PreferenceMode,
    model: string,
    weights: Record<RoutingDimension, number>,
  ): string {
    const complexityLabels: Record<ComplexityLevel, string> = {
      trivial: '🟢 trivial',
      simple: '🔵 simple',
      moderate: '🟡 moderate',
      complex: '🟠 complex',
      critical: '🔴 critical',
    };

    const dominant = (Object.keys(DIMENSION_LABELS) as RoutingDimension[])
      .reduce((a, b) => (weights[b] > weights[a] ? b : a), 'reasoning' as RoutingDimension);

    const modeStr = mode !== 'balanced' ? ` | ${mode}` : '';
    return `${agentType} (${complexityLabels[complexity]}, ${taskType}) → ${selected.provider}/${model} ` +
      `score ${selected.score.toFixed(2)} | dominant: ${DIMENSION_LABELS[dominant]}${modeStr}`;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let autoRouterInstance: AutoModelRouter | null = null;

/**
 * Get or create the AutoModelRouter singleton.
 */
export function getAutoRouter(): AutoModelRouter {
  if (!autoRouterInstance) {
    autoRouterInstance = new AutoModelRouter();
  }
  return autoRouterInstance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetAutoRouter(): void {
  autoRouterInstance = null;
}
