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
 * // → { provider: '<best available>', model: '<resolved model>', explanation: '...' }
 * ```
 */

import { analyzeComplexity, type ComplexityLevel, type ModelCandidate, type PreferenceMode } from './hybrid-router.js';
import { getTaskType, type TaskType } from './model-router.js';
import { getBenchmarkRuns } from './benchmark.js';
import { getAgentStats } from './agent-stats.js';
import { getRouterBandit, DEFAULT_MIN_SAMPLES, type BanditOutcome } from './router-bandit.js';
import { getRouterPromotion, type ParallelPick } from './router-promotion.js';
import { getModelRegistry } from './model-registry.js';
import { estimateTokens } from './cost-tracker.js';
import { preferredModelsFor, PROVIDER_CONTEXT_WINDOWS } from './model-selection.js';
import type { ConfigManager } from '../config/manager.js';
import type { ProviderPricing, GovernanceConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** The special model value that triggers automatic per-task routing. */
export const AUTO_MODEL = 'auto';

/** The special provider value stored in active-model state for Auto mode. */
export const AUTO_PROVIDER = 'auto';

/** The five routing dimensions. */
export type RoutingDimension = 'reasoning' | 'speed' | 'cost' | 'privacy' | 'reliability';

/** High-level task intents the router can use to bias provider choice. */
export type TaskIntent = 'planning' | 'coding' | 'verification' | 'security' | 'debugging' | 'architecture' | 'migration' | 'unknown';

/** A lightweight task profile used to shape routing behavior. */
export interface TaskProfile {
  intent: TaskIntent;
  requiresVerification: boolean;
  escalationTarget?: string;
  notes: string[];
}

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

/**
 * Thrown by resolve() when a PII-domain task matches a configured governance
 * PII pattern and EVERY candidate provider fails the privacy bar. The PII
 * policy is a HARD gate — "no PII to low-privacy cloud" holds even when it
 * eliminates every provider, so the router refuses to serve a violator and
 * lets the caller surface the policy block to the user.
 */
export class PIIPolicyError extends Error {
  /** Minimum privacy score the policy required (0–1). */
  readonly requiredPrivacy: number;

  constructor(requiredPrivacy: number) {
    super(
      `PII governance policy: no provider meets the privacy requirement (privacy ≥ ${requiredPrivacy}) for this task — refusing to route PII to a low-privacy provider.`,
    );
    this.name = 'PIIPolicyError';
    this.requiredPrivacy = requiredPrivacy;
  }
}

/**
 * Thrown by resolve() when an ADMIN governance rule (provider allow/deny
 * list, model allow/deny list, or the admin max-cost cap) eliminates EVERY
 * candidate provider. Like PII, these are HARD policy gates: falling back to
 * the full ranking would resurrect a provider the admin policy rules out, so
 * the router refuses to serve a policy-violating provider and lets the caller
 * surface the block (chat/plan render the message, `models explain` renders
 * the full audit trail).
 */
export class GovernancePolicyError extends Error {
  /** Providers eliminated by the policy, with the reason for each (audit). */
  readonly blocked: Array<{ provider: string; reason: string }>;

  constructor(blocked: Array<{ provider: string; reason: string }>) {
    super(
      `Governance policy: every candidate provider was eliminated by an admin rule (${blocked.length} blocked: ${blocked.map((b) => b.provider).join(', ')}) — refusing to serve a policy-violating provider.`,
    );
    this.name = 'GovernancePolicyError';
    this.blocked = blocked;
  }
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
  /**
   * Enable Thompson-sampling bandit learning. Each provider's score is
   * multiplied by a Beta draw from its complexity-bucketed prior, learned
   * from `recordOutcome()`. Cold start = Beta(1,1) = deterministic behavior
   * until outcomes accumulate (default: false).
   */
  useBandit?: boolean;
  /**
   * Minimum accumulated samples (α+β) before a provider's bandit prior counts
   * as "learned". When the bandit's winner has FEWER samples, routing escalates
   * to the next-ranked provider that HAS learned data (uncertainty-driven
   * escalation, mirroring ruflo's model-router). Default: DEFAULT_MIN_SAMPLES (8).
   */
  escalationMinSamples?: number;
  /**
   * Hard constraint: max estimated USD cost per call. Providers whose
   * typical-call cost exceeds this are ELIMINATED (not just scored lower).
   */
  maxCostUsd?: number;
  /**
   * Hard constraint: max latency score floor. Providers with speed below
   * this value (0–1) are ELIMINATED. (Higher speed = faster.)
   */
  minSpeed?: number;
  /**
   * Hard constraint: min reasoning score. Providers with reasoning below
   * this value (0–1) are ELIMINATED.
   */
  minReasoning?: number;
  /**
   * Rule overrides evaluated before scoring. First match wins.
   */
  rules?: RoutingRule[];
  /**
   * Quota-ledger parked providers (ms remaining until auto re-enable) — same
   * shape as `circuitBreakerStatus` so the router treats quota exhaustion
   * exactly like a circuit-breaker cooldown: parked providers sink below
   * healthy ones and are only picked when every candidate is parked.
   * Computed by `QuotaLedger.getRouterQuotaStatus()` from configured
   * `routing.quota` limits + explicit cooldowns.
   */
  quotaStatus?: Array<{ provider: string; cooldownRemaining: number }>;
  /**
   * Per-task complexity label from the plan (TaskStep.complexity). When set,
   * routing uses it INSTEAD of re-analyzing the description, so a planner that
   * decomposes a goal into labeled subtasks gets subtask-local routing
   * instead of goal-global routing.
   */
  complexityHint?: ComplexityLevel;
  /**
   * Free/local-first gate. When false, providers whose typical call is PAID
   * (non-zero cost) are excluded from Auto routing for non-complex tasks
   * (trivial/simple/moderate); complex/critical tasks may still use paid
   * models. Falls back to the full ranking if the gate would eliminate
   * everyone. Default: true (paid providers always allowed).
   */
  allowPaid?: boolean;
  /**
   * M2.5 context preflight: caller-provided estimate of the prompt size in
   * tokens (the REAL payload about to be sent — conversation history, gathered
   * context, workspace files). When set, it REPLACES the router's default
   * task-text estimate for context-fit scoring, so a long conversation or a
   * heavy workspace naturally routes toward providers whose nominal input
   * windows fit. Estimation only — never a hard block.
   */
  contextHintTokens?: number;
}

/**
 * A routing rule that overrides scoring when its task pattern matches.
 * Mirrors ruflo's `multi-model-router` rule-based mode, but evaluated against
 * the task text before scoring so an explicit intent always wins.
 */
export interface RoutingRule {
  /** Rule name (shown in explanations). */
  name: string;
  /** Regex (or string) matched against the task description (case-insensitive). */
  pattern: string | RegExp;
  /** Provider to force when the pattern matches. */
  provider: string;
  /** Optional model to force within that provider. */
  model?: string;
}

/**
 * How a decision was produced — the router's auditability field.
 * Mirrors ruflo's `routedBy` (heuristic | hybrid | bandit-fallback).
 */
export type RoutedBy = 'heuristic' | 'rule' | 'bandit';

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
  /** Whether this provider is parked by the quota ledger (exhausted window) */
  quotaParked?: boolean;
  /** Why this provider ranked where it did */
  reason: string;
  /**
   * 0–1 task-type → capability fit (Nuvira-Router M2.1): how well the
   * provider's offered tags cover the capabilities this task needs.
   */
  capabilityFit?: number;
  /**
   * M2.2 cost scoring source: 'measured' when real wire tokens from
   * provider-reported usage fed the cost score, 'estimated' when the
   * TYPICAL-token estimate was used. Surfaced in `models explain`.
   */
  costSource?: 'measured' | 'estimated';
  /** M2.2: the exact measured token basis used (when measured). */
  costBasis?: { inputTokens: number; outputTokens: number };
  /**
   * P4 M4.4: mid-stream flakiness (partialRate EMA 0–1) read from the model
   * registry at decision time — present only when `routing.partialFlakiness`
   * is enabled and the provider has a positive partial rate. The reliability
   * dimension was scaled down by this much.
   */
  flakiness?: number;
  /**
   * M2.5: nominal input context window (tokens) for this provider×model, from
   * the context preflight table (or `routing.contextWindows` overrides). Set
   * only when the context-fit signal is enabled.
   */
  contextWindowTokens?: number;
  /**
   * M2.5: estimated utilization — prompt tokens ÷ nominal window (0–1; may
   * exceed 1 when the prompt is larger than the window). Set only when the
   * context-fit signal is enabled.
   */
  contextUtilization?: number;
  /**
   * M2.5: soft context-fit score (0–1) applied to this provider's score.
   * 1 = neutral (small task, big window); lower = heavily-utilized window.
   * NEVER eliminates — even a prompt exceeding the window only caps the
   * penalty. Set only when the context-fit signal is enabled.
   */
  contextFit?: number;
}

/** The final auto-routing decision for a single task. */
export interface AutoRouteResult {
  /** The agent type this decision is for */
  agentType: string;
  /** Detected task complexity */
  complexity: ComplexityLevel;
  /** Task intent profile used to shape this decision */
  taskProfile: TaskProfile;
  /** Whether verification-aware escalation was applied for this route */
  escalationApplied: boolean;
  /** Mapped task type (from ModelRouter) */
  taskType: TaskType;
  /** Selected provider */
  provider: string;
  /** Selected model within that provider */
  model: string;
  /** Composite score of the selected provider (0–1) */
  score: number;
  /** Effective dimension weights used for this decision */
  weights: Record<RoutingDimension, number>;
  /** All scored providers, ranked best-first */
  ranked: ScoredProvider[];
  /** Full fallback chain (primary first) — ModelCandidate[] for HybridModelRouter compat */
  fallbackChain: ModelCandidate[];
  /** Human-readable explanation */
  explanation: string;
  /** How this decision was produced: heuristic | rule | bandit */
  routedBy: RoutedBy;
  /**
   * True when bandit uncertainty escalated selection away from an unlearned
   * winner to the next-ranked provider WITH learned data.
   */
  banditEscalation?: boolean;
  /**
   * M2.4: providers eliminated by the governance policy (allow/deny lists,
   * admin max-cost cap, or PII privacy block), with the reason. Empty when no
   * policy is configured or nothing was blocked — keeps the audit trail
   * honest and lets `models explain` / the dashboard show policy decisions.
   */
  governanceBlocked?: Array<{ provider: string; reason: string }>;
  /**
   * M2.5: context preflight snapshot — the estimated prompt size used for
   * scoring, its basis (task text vs caller hint), and per-provider
   * utilization (estimated tokens ÷ nominal window). Present only when the
   * context-fit signal is enabled (`routing.contextFit`, default ON) — the
   * gate-off path omits it entirely (reversible, like capability-fit).
   */
  contextPreflight?: {
    estimatedPromptTokens: number;
    basis: 'task' | 'hint';
    providers: Array<{
      provider: string;
      contextWindowTokens: number;
      utilization?: number;
      fit?: number;
    }>;
  };
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

/**
 * Minimum expected win rate (α/(α+β)) for a provider to qualify as an
 * escalation target. A learned-but-failing provider (win rate near or below
 * 0.5) must never steal routing from a strong cold-start winner.
 */
export const ESCALATION_WIN_RATE_FLOOR = 0.55;

const DEFAULT_PROFILES: Record<string, ProviderCapabilities> = {
  local: { reasoning: 0.30, speed: 0.55, cost: 1.00, privacy: 1.00, reliability: 0.60 },
  groq: { reasoning: 0.55, speed: 1.00, cost: 0.85, privacy: 0.15, reliability: 0.85 },
  nim: { reasoning: 0.72, speed: 0.70, cost: 0.55, privacy: 0.15, reliability: 0.82 },
  gemini: { reasoning: 0.85, speed: 0.80, cost: 0.40, privacy: 0.10, reliability: 0.88 },
  openrouter: { reasoning: 0.95, speed: 0.55, cost: 0.15, privacy: 0.10, reliability: 0.78 },
  // P5 M5.3: the Nuvira sidecar gateway (any OpenAI-compatible endpoint) is a
  // NEUTRAL multi-model host — it can serve any upstream model, so it scores a
  // deliberately neutral profile: never dominates a dimension it can't prove,
  // never excluded from routing (it joins the same registry/bandit learning as
  // built-ins once real usage data exists). Its REAL profile derives from
  // measured usage / runtime stats over time.
  nuvira: { reasoning: 0.50, speed: 0.50, cost: 0.50, privacy: 0.50, reliability: 0.70 },
};

// ─── Capability-aware scoring (Nuvira-Router P2 M2.1) ───────────────────────
//
// A SOFT signal on top of the five weighted dimensions: which capabilities a
// task ACTUALLY needs (from its task type) vs which capabilities a provider
// offers (from its profile). This is deliberately a small, clamped multiplier
// — it nudges equally-scored providers toward the one whose strengths match
// the task (a code-review wants reasoning, a quick edit wants speed), but it
// can never overturn a large dimension-weight advantage or break the 0–1
// score invariant.

/** Model-catalog-style tags a task type genuinely needs. */
const TASK_CAPABILITY_TAGS: Record<string, string[]> = {
  plan: ['reasoning'],
  // Code generation cares about correctness, not latency — every code-capable
  // provider fits equally, so the signal stays neutral for writer tasks and
  // never overturns the dimension-weighted ranking.
  'simple-edit': ['code'],
  'code-review': ['code', 'reasoning'],
  'test-generation': ['code'],
  debug: ['code', 'reasoning'],
  'context-gather': ['fast'],
  default: ['chat'],
};

/** Model-catalog-style tags each built-in provider offers (from its profile). */
const PROVIDER_CAPABILITY_TAGS: Record<string, string[]> = {
  local: ['chat', 'code'],
  groq: ['chat', 'code', 'fast'],
  nim: ['chat', 'code', 'reasoning'],
  gemini: ['chat', 'code', 'reasoning', 'fast', 'vision'],
  openrouter: ['chat', 'code', 'reasoning', 'vision', 'agentic'],
};

/**
 * Offered tags for a provider: static catalog tags UNION tags derived from
 * the capability profile (so custom/gateway providers are scored by their
 * REAL profile, not a hardcoded map — a custom strong-reasoning provider gets
 * a 'reasoning' tag even though no static entry lists it).
 */
function providerOfferedTags(provider: string, caps?: ProviderCapabilities): string[] {
  const staticTags = PROVIDER_CAPABILITY_TAGS[provider] || [];
  const derived: string[] = [];
  if (caps) {
    if (caps.reasoning >= 0.75) derived.push('reasoning');
    if (caps.speed >= 0.9) derived.push('fast');
    // NOTE: 'cheap'/'reliable' are DELIBERATELY not derived. No current task
    // type requires them, so deriving them would only add tags NO task ever
    // matches — making every derived tag a guaranteed capability-fit MISS
    // (fit = matched/required = 0 → a 0.9× penalty) for any provider that
    // derives them (e.g. a zero-cost gateway like the nuvira sidecar, whose
    // pricing-adjusted cost is 1.0). A provider is only penalized by the
    // soft fit signal for capabilities a task ACTUALLY needs.
  }
  return [...new Set([...staticTags, ...derived])];
}

/**
 * 0–1 fit between a task type's required capabilities and a provider's
 * offered tags: matched-required / total-required. 1 = the provider covers
 * every capability the task needs; 0 = none.
 *
 * A provider with NO assessable profile (truly unknown, e.g. a brand-new
 * gateway with a neutral profile) returns 1 — neutral: it can host any model,
 * so it is never unfairly boosted OR penalized until real usage data exists.
 */
export function capabilityFitScore(taskType: string, provider: string, caps?: ProviderCapabilities): number {
  const required = TASK_CAPABILITY_TAGS[taskType] || TASK_CAPABILITY_TAGS.default;
  const offered = providerOfferedTags(provider, caps);
  // No assessable tags (unknown provider with no static entry and a neutral
  // profile) → neutral fit: neither boosted nor penalized.
  if (offered.length === 0) return 1;
  if (required.length === 0) return 1;
  const matched = required.filter((tag) => offered.includes(tag)).length;
  return matched / required.length;
}

/**
 * Apply the soft capability-fit multiplier, clamped so the score never
 * exceeds 1 (the 0–1 invariant the bandit and tests rely on). Range:
 * no-fit ≈ 0.85×, perfect-fit ≈ 1.10× (then clamped).
 */
export function applyCapabilityFit(score: number, fit: number): number {
  return Math.min(1, score * (0.9 + 0.2 * fit));
}

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
  // P5 M5.3: a local sidecar gateway is pass-through — its spend depends on
  // the upstream model, which only real usage can know. Default 0 (local-first
  // sidecar convention); M2.2 MEASURED wire-token cost replaces this the moment
  // the gateway reports usage, so the free-first gate judges by truth.
  nuvira: { inputPer1K: 0, outputPer1K: 0 },
};

/** Reference cost per call (USD) used to normalize the 0–1 cost score. */
const COST_REFERENCE_USD = 0.01;

/** Typical call size used for cost scoring (input/output tokens). */
const TYPICAL_INPUT_TOKENS = 2000;
const TYPICAL_OUTPUT_TOKENS = 500;

// ─── M2.5 Context preflight — nominal input context windows ────────────────
// Nominal provider-level context windows (tokens) are imported from
// model-selection (PROVIDER_CONTEXT_WINDOWS) — capability metadata, never a
// per-model name table. Config overrides via `routing.contextWindows[model]`
// (or `[provider]` as a provider-level default) always win, and the live
// model descriptors from a probe win where available.

/** Fallback for unknown providers — large enough to rarely trigger a penalty. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/**
 * M2.5 context preflight — soft utilization-based fit (0–1, higher = better).
 * NEVER a hard block: even a prompt that exceeds the nominal window only caps
 * the penalty, and unknown/zero windows are neutral (fit 1). Neutral below
 * 50% utilization so normal-size tasks never shift a ranking; ramps linearly
 * to a 35% cap at ≥200% utilization.
 */
export function computeContextFit(promptTokens: number, windowTokens: number): number {
  if (!windowTokens || windowTokens <= 0) return 1;
  const utilization = Math.max(0, promptTokens) / windowTokens;
  const penalty = Math.max(0, Math.min(0.35, (utilization - 0.5) / 1.5));
  return 1 - penalty;
}

/**
 * Measured per-call token profile (M2.2 wire-token metering): a sample-
 * weighted average of exact tokens reported by the provider/gateway `usage`.
 * When present, cost scoring uses MEASURED tokens instead of TYPICAL ones.
 */
export interface MeasuredCost {
  inputTokens: number;
  outputTokens: number;
  /** How many measured calls fed the average (informational). */
  samples?: number;
}

/**
 * Estimate the USD cost of a typical call for a provider.
 * An optional pricing override (e.g., from `buff config set pricing.*`)
 * takes precedence over the built-in table.
 *
 * M2.2: when `measured` (real wire tokens from provider-reported usage) is
 * available, it replaces the TYPICAL-token estimate — measured cost is the
 * truth when the provider reports it.
 */
export function estimateCallCostUsd(
  provider: string,
  pricing?: { inputPer1K: number; outputPer1K: number },
  measured?: MeasuredCost,
): number {
  const p = pricing || PROVIDER_PRICING_PER_1K[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };
  const inputTokens = measured ? measured.inputTokens : TYPICAL_INPUT_TOKENS;
  const outputTokens = measured ? measured.outputTokens : TYPICAL_OUTPUT_TOKENS;
  const inputCost = (inputTokens / 1000) * p.inputPer1K;
  const outputCost = (outputTokens / 1000) * p.outputPer1K;
  return Math.round((inputCost + outputCost) * 100000) / 100000;
}

/**
 * Derive the 0–1 cost score (higher = cheaper) from real provider pricing.
 * Free providers (local, Gemini free tier) score 1.0.
 * M2.2: measured tokens (when present) replace the typical-call estimate.
 */
export function computeCostScore(
  provider: string,
  pricing?: { inputPer1K: number; outputPer1K: number },
  measured?: MeasuredCost,
): number {
  const costUsd = estimateCallCostUsd(provider, pricing, measured);
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
export function analyzeTaskProfile(taskDescription: string): TaskProfile {
  const text = (taskDescription || '').toLowerCase();

  if (/migrat(e|ion)|upgrade|refactor|pipeline|deployment/.test(text)) {
    return {
      intent: 'migration',
      requiresVerification: true,
      escalationTarget: 'gemini',
      notes: ['migration-related task detected'],
    };
  }

  if (/architect|architecture|design|system|microservice|platform/.test(text) && !/outline|plan|roadmap|strategy/.test(text)) {
    return {
      intent: 'architecture',
      requiresVerification: true,
      escalationTarget: 'gemini',
      notes: ['architecture-focused task detected'],
    };
  }

  if (/verify|verification|validate|rollout|deploy|production|launch|release/.test(text)) {
    return {
      intent: 'verification',
      requiresVerification: true,
      escalationTarget: 'openrouter',
      notes: ['verification-related task detected'],
    };
  }

  if (/security|audit|vulnerab|threat|exploit/.test(text)) {
    return {
      intent: 'security',
      requiresVerification: true,
      escalationTarget: 'openrouter',
      notes: ['security-sensitive task detected'],
    };
  }

  if (/debug|bug|error|fix|trace/.test(text)) {
    return {
      intent: 'debugging',
      requiresVerification: false,
      notes: ['debugging task detected'],
    };
  }

  if (/plan|outline|roadmap|strategy/.test(text)) {
    return {
      intent: 'planning',
      requiresVerification: false,
      notes: ['planning task detected'],
    };
  }

  return {
    intent: 'coding',
    requiresVerification: false,
    notes: ['general coding task detected'],
  };
}

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
   * Default candidate providers — restricted to providers that have required
   * credentials configured when a ConfigManager is available, so Auto routing
   * NEVER picks a cloud provider with no API key (which would fail with a 401
   * and undermine trust in auto model selection).
   *
   * Falls back to the full built-in list when nothing has credentials (or when
   * no config manager is provided), so the router still produces a decision
   * and the caller surfaces availability. Explicit `allowedProviders` always
   * win over this filtering.
   */
  private getDefaultAllowedProviders(configManager?: ConfigManager): string[] {
    if (!configManager || typeof configManager.hasRequiredCredentials !== 'function') {
      return DEFAULT_AUTO_PROVIDERS;
    }

    // ── Registry-aware filtering: prefer providers with VERIFIED, usable
    // models over bare credential checks. A key existing ≠ the models on that
    // provider actually serving (OpenRouter lists 300+ models your credits
    // can't buy; Gemini paid models 403 without billing). When the registry
    // has real data, restrict Auto routing to providers we've verified — this
    // is the "no more routing into 404s" guarantee.
    const registry = getModelRegistry();
    // Hard skip: providers whose every tracked model the registry marks
    // unavailable/quota-parked (learned from real usage telemetry) are never
    // even scored — dead providers can't win a task they'd fail.
    const blocked = new Set(registry.getBlockedProviders());
    let base = DEFAULT_AUTO_PROVIDERS.filter((p) => !blocked.has(p));

    const registered = registry.getUsableProviders();
    if (registered.length > 0) {
      const intersection = base.filter((p) => registered.includes(p));
      if (intersection.length > 0) {
        return intersection;
      }
    }

    const usable = base.filter((p) => {
      try {
        return configManager.hasRequiredCredentials(p);
      } catch {
        return false;
      }
    });
    // Never return an empty list: if EVERY default provider is registry-blocked
    // (pathological), fall back to the full built-in list so the caller still
    // gets a decision and surfaces availability instead of crashing on an
    // empty ranking.
    return usable.length > 0 ? usable : (base.length > 0 ? base : DEFAULT_AUTO_PROVIDERS);
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
    // Subtask-local routing: a complexityHint from the plan (TaskStep.complexity)
    // wins over re-analyzing the description, so a planner that labels each
    // step simple/moderate/complex routes that step accordingly — not the whole
    // goal's complexity. Bandit bucketing uses the SAME value on recordOutcome
    // (the orchestrator threads task.complexity through), keeping select-time
    // and record-time buckets consistent.
    const complexity = options.complexityHint ?? analyzeComplexity(taskDescription);
    const taskType = getTaskType(agentType);
    const taskProfile = analyzeTaskProfile(taskDescription);
    const mode = options.preferenceMode || 'balanced';
    let weights = computeWeights(complexity, mode, options.weights);

    if (taskProfile.requiresVerification) {
      const boosted = {
        ...weights,
        reasoning: Math.min(1, weights.reasoning + 0.12),
        reliability: Math.min(1, weights.reliability + 0.10),
        cost: Math.max(0, weights.cost - 0.08),
        speed: Math.max(0, weights.speed - 0.04),
      };
      const total = Object.values(boosted).reduce((a, b) => a + b, 0) || 1;
      weights = {
        reasoning: boosted.reasoning / total,
        speed: boosted.speed / total,
        cost: boosted.cost / total,
        privacy: boosted.privacy / total,
        reliability: boosted.reliability / total,
      };
    }

    // ── Rule overrides: an explicit intent always wins over scoring ─────────
    // Mirrors ruflo's `multi-model-router` rule mode — a regex/string pattern
    // that matches the task forces a specific provider (and optionally model),
    // short-circuiting scoring entirely.
    if (options.rules?.length) {
      for (const rule of options.rules) {
        const re = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
        if (re.test(taskDescription)) {
          const provider = rule.provider;
          const model = rule.model || this.resolveModel(provider, agentType, configManager);
          // Note the forced decision so bandit outcome recording attributes
          // successes/failures to the rule's provider — not a stale one from a
          // previous task of the same agent type. Harmless when bandit is off
          // (the orchestrator gates recording on routing.bandit === true).
          getRouterBandit().noteDecision(agentType, provider);
          if (options.verbose) {
            logger.info(`  🛑 Routing rule '${rule.name}' matched → ${provider}/${model}`);
          }
          return {
            agentType,
            complexity,
            taskProfile,
            escalationApplied: false,
            taskType,
            provider,
            model,
            score: 1,
            weights,
            ranked: [{
              provider,
              score: 1,
              dimensions: { reasoning: 1, speed: 1, cost: 1, privacy: 1, reliability: 1 },
              weightTotal: 1,
              inCooldown: false,
              reason: `forced by routing rule '${rule.name}'`,
            }],
            fallbackChain: [],
            explanation: `Routing rule '${rule.name}' matched task → ${provider}/${model}`,
            routedBy: 'rule',
          };
        }
      }
    }

    const allowed = options.allowedProviders?.length
      ? options.allowedProviders
      : this.getDefaultAllowedProviders(configManager);

    let escalationApplied = false;
    let allowedProviders = allowed;
    if (taskProfile.requiresVerification && taskProfile.escalationTarget) {
      const escalationTarget = taskProfile.escalationTarget;
      if (allowedProviders.includes(escalationTarget)) {
        allowedProviders = [escalationTarget, ...allowedProviders.filter((p) => p !== escalationTarget)];
        escalationApplied = true;
      }
    }

    const cooldown = new Map<string, number>();
    for (const cb of options.circuitBreakerStatus || []) {
      if (cb.cooldownRemaining > 0) cooldown.set(cb.provider, cb.cooldownRemaining);
    }

    // ── Quota ledger (quotaStatus): exhausted providers sink exactly like
    // circuit-breaker cooldown providers. Quota parking is SEPARATE from
    // cooldown so a provider can be quota-parked without circuit-breaker
    // state (and vice versa) — both exclude it from the healthy pick.
    const quotaParked = new Map<string, number>();
    for (const qs of options.quotaStatus || []) {
      if (qs.cooldownRemaining > 0) quotaParked.set(qs.provider, qs.cooldownRemaining);
    }

    // Load runtime stats once (benchmark quality + best-model per agent type)
    const runtime = options.useRuntimeStats ? this.loadRuntimeAdjustments(agentType) : null;
    if (runtime && options.verbose) {
      logger.info(`  📊 Runtime stats: ${runtime.summary}`);
    }

    // M2.1 gate: `routing.capabilityFit` (default ON) makes the soft
    // capability-fit signal reversible — set false to revert to pure
    // dimension-weight scoring. Best-effort config read (mocks / plugin
    // configs may lack getAll): never let the gate break routing.
    let capabilityFitEnabled = true;
    try {
      capabilityFitEnabled = (configManager?.getAll?.()?.routing?.capabilityFit ?? true) !== false;
    } catch {
      // Best-effort
    }

    // M2.4 governance: admin policy from `routing.governance`. Best-effort
    // config read — an unset/empty policy is fully permissive (existing
    // behavior unchanged). All violations are hard-eliminations inside the
    // constraint slot below (never scored lower).
    let governance: GovernanceConfig | undefined;
    try {
      governance = configManager?.getAll?.()?.routing?.governance;
    } catch {
      // Best-effort — policy must never break routing.
    }

    // M2.5 context preflight: `routing.contextFit` (default ON) gates the soft
    // utilization signal exactly like capability-fit — set false to revert to
    // pure dimension-weight scoring. The estimated prompt size is the caller's
    // context hint when provided (the REAL payload — conversation history,
    // gathered context), else the task text itself. Estimation only, never a
    // hard block. Best-effort config read — never let it break routing.
    let contextFitEnabled = true;
    try {
      contextFitEnabled = (configManager?.getAll?.()?.routing?.contextFit ?? true) !== false;
    } catch {
      // Best-effort
    }
    // P4 M4.4 mid-stream flakiness: `routing.partialFlakiness` (default ON)
    // gates the reliability penalty the registry's partialRate EMA applies to
    // providers that keep starting streams that die mid-way. When OFF the
    // signal is fully inert (no penalty, no ⏸ chip in `models explain`).
    // Best-effort config read — never let it break routing.
    let partialFlakinessEnabled = true;
    try {
      partialFlakinessEnabled = (configManager?.getAll?.()?.routing?.partialFlakiness ?? true) !== false;
    } catch {
      // Best-effort
    }
    const promptTokens = options.contextHintTokens ?? estimateTokens(taskDescription);

    // Score every allowed provider
    let scored: ScoredProvider[] = allowedProviders.map((provider) => {
      let caps = this.getCapabilities(provider);
      // Real pricing replaces the static cost capability; M2.2 measured wire
      // tokens (when the provider/gateway reports usage) replace the
      // TYPICAL-token estimate — measured cost is the truth when available.
      let measuredCost: MeasuredCost | undefined;
      if (options.useRealPricing !== false) {
        const pricing = this.getProviderPricing(provider, configManager);
        measuredCost = this.getMeasuredCost(provider);
        caps = { ...caps, cost: computeCostScore(provider, pricing, measuredCost) };
      }
      // Runtime data adjusts reasoning/reliability from real performance
      if (runtime) {
        caps = this.adjustCapabilitiesForRuntime(caps, provider, runtime);
      }
      // P4 M4.4 mid-stream flakiness penalty: a provider that keeps starting
      // streams that die before completion is a WORSE reliability bet than one
      // that errors cleanly (its model is real — it just can't finish). The
      // registry's partialRate EMA (0–1, healed by clean successes) scales the
      // reliability dimension down; gated by `routing.partialFlakiness`.
      let flakiness: number | undefined;
      if (partialFlakinessEnabled) {
        const registryFlakiness = getModelRegistry().getProviderFlakiness(provider);
        if (registryFlakiness > 0) {
          flakiness = registryFlakiness;
          // Cap the penalty at 40% of the reliability dimension — a flaky
          // provider loses ground but is never hard-blocked (it may heal).
          caps = {
            ...caps,
            reliability: Math.max(0, (caps.reliability ?? 0) * (1 - Math.min(0.4, registryFlakiness * 0.5))),
          };
        }
      }
      const { score, dimensions, weightTotal } = scoreProvider(provider, caps, weights);
      const inCooldown = cooldown.has(provider);
      const qp = quotaParked.get(provider);
      // Capability fit (M2.1): the soft task-type → capability signal, gated
      // by `routing.capabilityFit` (default ON). When disabled the signal is
      // fully inert — raw dimension-weighted scores, no fit field, no suffix.
      // Only HEALTHY candidates get a fit: a parked provider's reason is
      // already definitive, so it carries no fit field (and the explain view
      // shows no chip for it). `caps` is passed through so custom/gateway
      // providers are scored by their REAL capability profile (a strong-
      // reasoning custom provider gets a derived 'reasoning' tag even though
      // no static entry lists it).
      const capabilityFit = qp === undefined && capabilityFitEnabled
        ? capabilityFitScore(taskType, provider, caps)
        : undefined;
      const fitScore = capabilityFit !== undefined ? applyCapabilityFit(score, capabilityFit) : score;
      // M2.5 context preflight (soft, estimation-only): how well the provider's
      // nominal input window fits the estimated prompt size. Gated by
      // `routing.contextFit` (default ON) like capability-fit. NEVER a hard
      // block — even a prompt exceeding the window only caps the penalty
      // (computeContextFit), and unknown windows are neutral. Healthy
      // candidates only: a quota-parked reason is already definitive. NOTE: the
      // window is judged on the CONFIGURED pin (resolveModel); bandit per-model
      // learning may serve a different concrete model whose window differs —
      // an acceptable soft-estimate divergence (bandit is off by default).
      const contextWindowTokens = qp === undefined && contextFitEnabled
        ? this.resolveContextWindow(provider, this.resolveModel(provider, agentType, configManager), configManager)
        : undefined;
      const contextUtilization = contextWindowTokens !== undefined && promptTokens > 0
        ? promptTokens / contextWindowTokens
        : undefined;
      const contextFit = contextWindowTokens !== undefined
        ? computeContextFit(promptTokens, contextWindowTokens)
        : undefined;
      const finalScore = fitScore * (contextFit ?? 1);
      const reason = qp !== undefined
        ? `${provider} (quota exhausted — auto re-enables in ${Math.ceil(qp / 1000)}s)`
        : this.buildReason(provider, caps, complexity, mode, inCooldown, runtime?.adjusted.has(provider));
      let finalReason = qp !== undefined || capabilityFit === undefined
        ? reason
        : `${reason} · capability-fit ${Math.round(capabilityFit * 100)}%`;
      // Context chip only when the window actually matters (penalty regime) —
      // a normal-size task keeps a clean reason; a squeezed window shows the
      // estimate and the nominal window it was judged against.
      if (contextFit !== undefined && contextFit < 1 && contextWindowTokens !== undefined) {
        finalReason = `${finalReason} · context-fit ${Math.round(contextFit * 100)}% (${promptTokens} tok of ${contextWindowTokens})`;
      }
      // P4 M4.4 flakiness chip — the reliability penalty is transparent.
      if (flakiness !== undefined && flakiness > 0) {
        finalReason = `${finalReason} · ⏸ flaky mid-stream (${Math.round(flakiness * 100)}%)`;
      }
      return {
        provider,
        score: finalScore,
        dimensions,
        weightTotal,
        inCooldown,
        quotaParked: qp !== undefined,
        capabilityFit,
        contextFit,
        contextUtilization,
        contextWindowTokens,
        flakiness,
        costSource: measuredCost ? 'measured' : 'estimated',
        costBasis: measuredCost
          ? { inputTokens: measuredCost.inputTokens, outputTokens: measuredCost.outputTokens }
          : undefined,
        reason: finalReason,
      };
    });

    // ── Hard constraints: ELIMINATE candidates that can't meet the ask ──────
    // Mirrors ruflo's per-request maxCost/maxLatency/minQuality hard filters —
    // violating providers are dropped (not just scored lower). If constraints
    // eliminate everything, fall back to the full list rather than erroring.
    // ── Free/local-first gate (allowPaid: false) ───────────────────────────
    // Mirrors the assessment's "prefer free/local unless complexity demands":
    // when the user disallows paid providers, ELIMINATE paid ones (typical
    // call cost > $0) for trivial/simple/moderate tasks so free/local models
    // win unless the task demands otherwise. Complex/critical tasks may still
    // use paid/high-capacity models. Falls back to the full list when the gate
    // would eliminate everyone (e.g. only paid providers have credentials).
    if (
      options.allowPaid === false &&
      (complexity === 'trivial' || complexity === 'simple' || complexity === 'moderate')
    ) {
      const freeOnly = scored.filter((s) => {
        // M2.2: judge by MEASURED cost when the provider reports usage — a
        // gateway with real (tiny) token counts may be free-in-practice even
        // if its list price is non-zero.
        const costUsd = estimateCallCostUsd(
          s.provider,
          this.getProviderPricing(s.provider, configManager),
          s.costBasis,
        );
        return costUsd === 0;
      });
      if (freeOnly.length > 0) {
        scored = freeOnly;
      } else if (options.verbose) {
        logger.warn('  ⚠️ allowPaid: false eliminated every provider — falling back to full ranking');
      }
    }

    // M2.4: eliminated-provider audit trail — populated only when the
    // governance/hard-constraint slot actually removes a provider for POLICY
    // reasons (admin lists, admin cost cap, PII block). minSpeed/minReasoning
    // kills stay in the per-provider reason, not this list.
    let governanceBlocked: Array<{ provider: string; reason: string }> = [];
    if (
      options.maxCostUsd !== undefined ||
      options.minSpeed !== undefined ||
      options.minReasoning !== undefined ||
      this.governanceActive(governance)
    ) {
      // ── Pass 1: NON-PII constraints (two-pass so the PII hard-gate always
      // sees exactly the survivors of the other rules). ────────────────────
      // M2.4: admin max-cost cap joins the per-call option — the effective
      // cap is the stricter of the two. A governance allow/deny list or admin
      // cap is a HARD elimination. Eliminated providers are recorded in
      // `governanceBlocked` (only policy-related kills; minSpeed/minReasoning
      // stay in the per-provider reason) so the audit trail + explain view
      // show exactly what policy removed.
      const effectiveMaxCostUsd = this.effectiveMaxCost(options.maxCostUsd, governance?.maxCostUsd);
      const blockedHere: Array<{ provider: string; reason: string }> = [];

      // PII patterns are compiled ONCE per resolve (not per provider) — and a
      // task that matches is computed once, not re-lowered per candidate.
      const taskLower = (taskDescription || '').toLowerCase();
      const compiledPii: RegExp[] = (governance?.piiPatterns || [])
        .map((p) => {
          try {
            return new RegExp(p, 'i');
          } catch {
            return null; // malformed pattern — ignored, never breaks routing
          }
        })
        .filter((r): r is RegExp => r !== null);
      const piiMatched = compiledPii.length > 0 && compiledPii.some((re) => re.test(taskLower));
      const minPrivacy = governance?.minPrivacyForPii ?? 1.0;

      const constrained = scored.filter((s) => {
        if (effectiveMaxCostUsd !== undefined) {
          const costUsd = estimateCallCostUsd(
            s.provider,
            this.getProviderPricing(s.provider, configManager),
            s.costBasis,
          );
          if (costUsd > effectiveMaxCostUsd) {
            if (governance?.maxCostUsd !== undefined) {
              blockedHere.push({ provider: s.provider, reason: `admin max-cost cap $${effectiveMaxCostUsd} (cost $${costUsd})` });
            }
            return false;
          }
        }
        if (options.minSpeed !== undefined) {
          if (this.getCapabilities(s.provider).speed < options.minSpeed) return false;
        }
        if (options.minReasoning !== undefined) {
          if (this.getCapabilities(s.provider).reasoning < options.minReasoning) return false;
        }
        // ── M2.4 governance (non-PII rules) ─────────────────────────────
        // Provider allow/deny lists (admin policy beats credential filtering).
        if (governance?.allowProviders?.length && !governance.allowProviders.includes(s.provider)) {
          blockedHere.push({ provider: s.provider, reason: 'not on admin allowProviders list' });
          return false;
        }
        if (governance?.denyProviders?.length && governance.denyProviders.includes(s.provider)) {
          blockedHere.push({ provider: s.provider, reason: 'on admin denyProviders list' });
          return false;
        }
        // Model allow/deny lists enforced against the model the router will
        // ACTUALLY serve (the configured pin, or the curated default when no
        // pin is set) — never against an unrelated candidate that happens to
        // be allowed. denyModels wins over allowModels.
        const modelReason = this.governanceModelReason(s.provider, agentType, configManager, governance);
        if (modelReason) {
          blockedHere.push({ provider: s.provider, reason: modelReason });
          return false;
        }
        return true;
      });

      // ── Pass 2: PII hard-gate on the NON-PII survivors. ────────────────
      // PII is a PRIVACY policy, not a cost/speed tradeoff: "no PII to
      // low-privacy cloud" holds even when it eliminates every candidate. If
      // any compliant provider survives the other rules, keep ONLY the
      // compliant subset. If NOTHING meets the privacy bar (or the non-PII
      // pass already eliminated everyone), NEVER fall back to a violator —
      // throw PIIPolicyError so the caller surfaces the block instead of
      // silently leaking PII to the cloud.
      if (piiMatched) {
        const piiCompliant = constrained.filter((s) => this.getCapabilities(s.provider).privacy >= minPrivacy);
        for (const s of constrained) {
          if (this.getCapabilities(s.provider).privacy < minPrivacy) {
            blockedHere.push({ provider: s.provider, reason: `PII-domain task — privacy ${this.getCapabilities(s.provider).privacy} < required ${minPrivacy}` });
          }
        }
        if (piiCompliant.length > 0) {
          scored = piiCompliant;
          governanceBlocked = blockedHere;
        } else {
          governanceBlocked = blockedHere;
          throw new PIIPolicyError(minPrivacy);
        }
      } else if (constrained.length > 0) {
        scored = constrained;
        governanceBlocked = blockedHere;
      } else if (blockedHere.length > 0) {
        // HARD governance gate: an ADMIN rule (provider allow/deny list, model
        // allow/deny list, or the admin max-cost cap) eliminated every
        // candidate. The benign fallback below would resurrect those
        // violators — NEVER serve a provider the admin policy rules out, even
        // when that leaves nothing to serve. Throw so the caller surfaces the
        // policy block honestly (chat/plan render the message, `models
        // explain` renders the full audit trail) instead of silently
        // violating the policy. NOTE: blockedHere holds ONLY governance kills
        // (per-call maxCostUsd/minSpeed/minReasoning never push to it), so
        // this branch is unreachable when only per-call SOFT options were set.
        governanceBlocked = blockedHere;
        throw new GovernancePolicyError(blockedHere);
      } else {
        // Benign fallback — only PER-CALL soft options (maxCostUsd/minSpeed/
        // minReasoning) eliminated everyone (an impossible per-request ask),
        // not an admin policy. Keep the full ranking so the caller still gets
        // a decision instead of erroring.
        governanceBlocked = blockedHere;
        if (options.verbose) {
          logger.warn('  ⚠️ Governance/hard constraints eliminated every provider — falling back to full ranking');
        }
      }
    }

    // Rank: circuit-breaker-cooldown providers sink first, then quota-parked
    // ones, then healthy ones; ties broken by score. A quota-parked provider
    // is only selected when every candidate is parked (matching cooldown).
    scored.sort((a, b) => {
      if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
      if (!!a.quotaParked !== !!b.quotaParked) return a.quotaParked ? 1 : -1;
      return b.score - a.score;
    });

    // ── Thompson-sampling bandit: multiply each score by a Beta draw ────────
    // Mirrors ruflo's model-router: final score = deterministicScore × θ where
    // θ ~ Beta(α, β) per complexity bucket. Cold start Beta(1,1) ≈ deterministic.
    // Also: the DETERMINISTIC ranking is captured BEFORE bandit sampling so the
    // promotion gate can A/B the two strategies on the same task (feature 3).
    const deterministicRanking = [...scored];
    const heuristicWinner = deterministicRanking.find((s) => !s.inCooldown) || deterministicRanking[0];
    let routedBy: RoutedBy = 'heuristic';
    let banditEscalation = false;
    let escalatedProvider: string | undefined;
    if (options.useBandit) {
      const bandit = getRouterBandit();
      scored = scored.map((s) => ({
        ...s,
        score: bandit.sampleScore(s.provider, complexity, s.score),
      }));
      scored.sort((a, b) => {
        if (a.inCooldown !== b.inCooldown) return a.inCooldown ? 1 : -1;
        return b.score - a.score;
      });
      routedBy = 'bandit';

      // ── Uncertainty-driven escalation (ruflo model-router mirror) ─────────
      // If the bandit's winner has almost no accumulated data (α+β < threshold),
      // its sampled score is a cold-start guess — committing to it is a coin
      // flip. Escalate to the next-ranked provider that HAS learned data so a
      // strictly better cold-start policy: prefer learned providers over
      // unlearned ones when data exists, behave deterministically otherwise.
      // SANITY BOUND: only escalate to a provider the bandit actually believes
      // in — expected win rate (α/(α+β)) must be meaningfully above 0.5, so a
      // learned-but-failing provider can never steal routing from a strong
      // cold-start winner.
      const minSamples = options.escalationMinSamples ?? DEFAULT_MIN_SAMPLES;
      const winner = scored.find((s) => !s.inCooldown) || scored[0];
      const winnerPrior = bandit.getPrior(winner.provider, complexity);
      if (winnerPrior.alpha + winnerPrior.beta < minSamples) {
        const learnedAlternative = scored.find(
          (s) =>
            s.provider !== winner.provider &&
            !s.inCooldown &&
            (() => {
              const p = bandit.getPrior(s.provider, complexity);
              return (
                p.alpha + p.beta >= minSamples &&
                p.alpha / (p.alpha + p.beta) >= ESCALATION_WIN_RATE_FLOOR
              );
            })(),
        );
        if (learnedAlternative) {
          banditEscalation = true;
          escalatedProvider = learnedAlternative.provider;
          if (options.verbose) {
            logger.info(
              `  🎲 Bandit uncertainty: ${winner.provider} has no learning data (α+β=${winnerPrior.alpha + winnerPrior.beta}) — escalating to learned ${learnedAlternative.provider} (win-rate ≥ ${ESCALATION_WIN_RATE_FLOOR})`,
            );
          }
        }
      }
    }

    // Pick the best candidate that is not in cooldown and not quota-parked
    // (unless ALL are). When uncertainty escalation fired, select the learned
    // alternative instead.
    const selected = escalatedProvider
      ? scored.find((s) => s.provider === escalatedProvider)!
      : scored.find((s) => !s.inCooldown && !s.quotaParked) || scored[0];
    const provider = selected.provider;
    let model = this.resolveModel(provider, agentType, configManager);

    // Note the decision so outcome recording (recordOutcome) can reward the
    // provider that actually served the task.
    if (options.useBandit) {
      const bandit = getRouterBandit();
      bandit.noteDecision(agentType, provider);

      // ── Per-modelId learning (ruflo ADR-149 mirror) ───────────────────────
      // The provider-level prior learns "which PROVIDER won"; the per-model
      // prior learns "which concrete MODEL won" within that provider
      // (llama-3.3-70b-versatile ≠ openai/gpt-oss-20b on the SAME provider).
      // When any candidate model has learned data, prefer the best Thompson-
      // sampled one; cold start keeps the configured model (deterministic).
      model = this.resolveModelWithLearning(
        provider,
        model,
        complexity,
        options.escalationMinSamples ?? DEFAULT_MIN_SAMPLES,
      );
      bandit.noteModelDecision(agentType, model);

      // ── Promotion gate A/B (ruflo router-parallel mirror) ─────────────────
      // Record both the deterministic pick and the bandit pick for this task.
      // The orchestrator's recordOutcome() finalizes it with the real outcome,
      // and `buff model bandit` evaluates the three promotion criteria.
      getRouterPromotion().noteParallelDecision(
        agentType,
        taskDescription,
        this.toParallelPick(heuristicWinner, agentType, configManager),
        this.toParallelPick(selected, agentType, configManager, model),
      );
    }

    // Build fallback chain (skip in-cooldown providers when alternatives exist)
    const fallbackChain: ModelCandidate[] = scored
      .filter((s) => s.provider !== provider)
      .map((s) => ({
        provider: s.provider,
        model: this.resolveModel(s.provider, agentType, configManager),
        estimatedCost: 0,
        qualityScore: s.score,
        contextWindowTokens: s.contextWindowTokens,
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
      taskProfile,
    ) + (routedBy === 'bandit' ? ' | bandit-learned' : '') +
      (banditEscalation ? ' | escalated: winner unlearned' : '');

    if (options.verbose) {
      logger.info(`  🤖 Auto routing: ${explanation}`);
    }

    // M2.5: context preflight snapshot over the FINAL ranked set (post
    // governance/constraints), so the explain view shows exactly what the
    // surviving candidates were judged against.
    const contextPreflight = contextFitEnabled
      ? {
          estimatedPromptTokens: promptTokens,
          basis: options.contextHintTokens !== undefined ? ('hint' as const) : ('task' as const),
          // Resolve the window even for quota-parked candidates (their scored
          // entry deliberately omits the context fields — the park reason is
          // definitive — but the preflight snapshot must still show a window;
          // the human explain renderer calls toLocaleString() on it).
          providers: scored.map((s) => ({
            provider: s.provider,
            contextWindowTokens:
              s.contextWindowTokens ??
              this.resolveContextWindow(s.provider, this.resolveModel(s.provider, agentType, configManager), configManager),
            utilization: s.contextUtilization,
            fit: s.contextFit,
          })),
        }
      : undefined;

    return {
      agentType,
      complexity,
      taskProfile,
      escalationApplied,
      taskType,
      provider,
      model,
      score: selected.score,
      weights,
      ranked: scored,
      fallbackChain,
      explanation,
      routedBy,
      banditEscalation,
      governanceBlocked,
      contextPreflight,
    };
  }

  /**
   * M2.5: nominal input context window (tokens) for a provider×model. Model
   * table → provider fallback → generous default. `routing.contextWindows`
   * overrides (keyed by model, or by provider as a provider-level default)
   * always win. Estimation-only input — never a hard block.
   */
  private resolveContextWindow(provider: string, model: string, configManager?: ConfigManager): number {
    try {
      const overrides = configManager?.getAll?.()?.routing?.contextWindows;
      if (overrides) {
        // Coerce string values (e.g. `buff config set routing.contextWindows.local
        // 16384` stores "16384") to numbers so utilization math never relies on
        // JS coercion; invalid/non-positive values fall through.
        const fromOverride = (key: string): number | undefined => {
          const v = overrides[key];
          if (v === undefined) return undefined;
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : undefined;
        };
        const modelWin = fromOverride(model);
        if (modelWin !== undefined) return modelWin;
        const providerWin = fromOverride(provider);
        if (providerWin !== undefined) return providerWin;
      }
    } catch {
      // Best-effort — config read must never break routing.
    }
    // Provider-level nominal window + user overrides only — never a hardcoded
    // per-model table (live model descriptors / registry win where available).
    return PROVIDER_CONTEXT_WINDOWS[provider] ?? DEFAULT_CONTEXT_WINDOW;
  }

  /**
   * Record a real task outcome so the bandit can learn from actual results.
   * A `complexityHint` (the plan's TaskStep.complexity) keeps the bandit
   * bucket consistent with the hint used at resolve() time.
   * Only meaningful when `useBandit` is enabled during resolve(); the reward
   * is cost-adjusted — the provider's real pricing drives the α bump so a
   * cheap provider's success is worth the most (mirrors ruflo's cost-adjusted
   * reward table).
   *
   * @param agentType  The agent type the routed task belonged to
   * @param taskDescription The task text (complexity bucket is re-derived)
   * @param outcome    success | failure | escalated
   * @param configManager Optional — used to resolve per-provider pricing
   *                       overrides when computing the cost-adjusted reward
   */
  recordOutcome(
    agentType: string,
    taskDescription: string,
    outcome: BanditOutcome,
    configManager?: ConfigManager,
    outcomeData?: { latencyMs?: number; costUsd?: number; qualityScore?: number },
    complexityHint?: ComplexityLevel,
  ): void {
    const bandit = getRouterBandit();
    const provider = bandit.getLastProvider(agentType);
    if (!provider) return;
    const costScore = computeCostScore(provider, this.getProviderPricing(provider, configManager));
    if (complexityHint) {
      bandit.recordOutcomeWithComplexity(provider, complexityHint, outcome, costScore);
    } else {
      bandit.recordOutcome(provider, taskDescription, outcome, costScore);
    }

    // Per-modelId learning: attribute the same outcome to the concrete model
    // that served the task (ruflo ADR-149 mirror) so the model choice learns.
    const model = bandit.getLastModel(agentType);
    if (model) {
      if (complexityHint) {
        bandit.recordModelOutcomeWithComplexity(model, complexityHint, outcome, costScore);
      } else {
        bandit.recordModelOutcome(model, taskDescription, outcome, costScore);
      }
    }

    // Promotion gate: finalize the parallel A/B decision with the real outcome
    // so `buff model bandit` can judge bandit-vs-heuristic on real trajectories.
    // Keyed by agentType+task so parallel tasks never misattribute outcomes.
    try {
      getRouterPromotion().recordOutcome(agentType, taskDescription, outcome, outcomeData);
    } catch {
      // Best-effort — never break outcome recording on a promotion error.
    }
  }

  /**
   * Choose the concrete model within the selected provider using per-model
   * bandit priors (ruflo ADR-149 mirror).
   *
   * Candidate models = the provider's configured pin (if real) + the curated
   * known-good defaults for the provider. Cold start (no per-model data yet)
   * keeps the configured model — deterministic. Once outcomes accumulate,
   * the best Thompson-sampled LEARNED model wins, so the model choice learns.
   */
  resolveModelWithLearning(
    provider: string,
    configuredModel: string,
    complexity: ComplexityLevel,
    minSamples: number = DEFAULT_MIN_SAMPLES,
  ): string {
    const bandit = getRouterBandit();
    const candidates: string[] = [];
    if (configuredModel && configuredModel !== 'default') candidates.push(configuredModel);
    for (const m of preferredModelsFor(provider)) {
      if (!candidates.includes(m)) candidates.push(m);
    }
    if (candidates.length === 0) return configuredModel || 'default';

    const learned = candidates.filter((m) => {
      const p = bandit.getModelPrior(m, complexity);
      return p.alpha + p.beta >= minSamples;
    });
    // Cold start: no per-model data → keep the configured model (deterministic).
    if (learned.length === 0) return candidates[0];

    // Learned: pick the candidate with the best Thompson-sampled per-model draw.
    const sampled = learned
      .map((m) => ({ model: m, score: bandit.sampleModelScore(m, complexity, 1) }))
      .sort((a, b) => b.score - a.score);
    return sampled[0].model;
  }

  /**
   * Build a ParallelPick (promotion-gate A/B record) for a scored provider.
   * Used to log the deterministic pick vs the bandit pick for the same task.
   *
   * @param modelOverride  The ACTUAL model chosen for the bandit side (e.g. a
   *                       per-model-learned pick). Defaults to the provider's
   *                       configured pin so the A/B records the real served
   *                       model — otherwise per-model divergence would be
   *                       invisible to the promotion gate.
   */
  private toParallelPick(
    scored: ScoredProvider,
    agentType: string,
    configManager?: ConfigManager,
    modelOverride?: string,
  ): ParallelPick {
    const caps = this.getCapabilities(scored.provider);
    return {
      provider: scored.provider,
      model: modelOverride ?? this.resolveModel(scored.provider, agentType, configManager),
      predictedQuality: scored.score,
      predictedCostUsd: estimateCallCostUsd(scored.provider, this.getProviderPricing(scored.provider, configManager)),
      // Rough latency estimate from the speed capability (higher = faster).
      estimatedLatencyMs: Math.round(3000 + (1 - caps.speed) * 6000),
    };
  }

  /**
   * Resolve the effective per-1K-token pricing for a provider.
   * Config overrides (`buff config set pricing.<provider>...`) win over the
   * built-in pricing table; unknown providers fall back to a cheap default.
   */
  getProviderPricing(
    provider: string,
    configManager?: ConfigManager,
  ): { inputPer1K: number; outputPer1K: number } {
    const override: ProviderPricing | undefined = configManager?.getAll().pricing?.[provider];
    const builtin = PROVIDER_PRICING_PER_1K[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };
    return {
      inputPer1K: override?.inputPer1K ?? builtin.inputPer1K,
      outputPer1K: override?.outputPer1K ?? builtin.outputPer1K,
    };
  }

  /**
   * M2.2: measured wire-token profile for a provider from the Model
   * Availability Registry (sample-weighted EMA). Best-effort — registry
   * bookkeeping must never break routing; undefined ⇒ estimated cost.
   */
  private getMeasuredCost(provider: string): MeasuredCost | undefined {
    try {
      return getModelRegistry().getMeasuredUsage(provider);
    } catch {
      return undefined;
    }
  }

  // ── M2.4 governance helpers ───────────────────────────────────────────────

  /**
   * Whether any governance policy is configured (so the constraint slot only
   * runs when there is something to enforce).
   */
  private governanceActive(g: GovernanceConfig | undefined): boolean {
    if (!g) return false;
    return Boolean(
      (g.allowProviders?.length ?? 0) > 0 ||
      (g.denyProviders?.length ?? 0) > 0 ||
      (g.allowModels?.length ?? 0) > 0 ||
      (g.denyModels?.length ?? 0) > 0 ||
      (g.piiPatterns?.length ?? 0) > 0 ||
      g.maxCostUsd !== undefined,
    );
  }

  /**
   * Effective per-call max-cost cap: the stricter of the per-call option and
   * the admin governance cap. undefined when neither is set.
   */
  private effectiveMaxCost(
    perCallUsd: number | undefined,
    adminUsd: number | undefined,
  ): number | undefined {
    if (perCallUsd === undefined) return adminUsd;
    if (adminUsd === undefined) return perCallUsd;
    return Math.min(perCallUsd, adminUsd);
  }

  /**
   * Why a provider fails the governance MODEL allow/deny lists, or undefined
   * when it passes. Enforced against the model the router will ACTUALLY serve:
   *   - the CONFIGURED pin when one is set (resolveModel returns it) — a pin
   *     on the deny-list, or NOT on the allow-list, kills the provider. This
   *     closes the "any candidate passes but the served pin violates" hole.
   *   - the curated defaults when NO pin is set (the adapter's default model
   *     is what a no-pin resolve serves) — deny wins, allow must include one.
   * denyModels always wins over allowModels.
   */
  private governanceModelReason(
    provider: string,
    agentType: string,
    configManager: ConfigManager | undefined,
    governance: GovernanceConfig | undefined,
  ): string | undefined {
    if (!governance) return undefined;
    const configured = this.resolveModel(provider, agentType, configManager);
    const served = configured && configured !== 'default' ? [configured] : preferredModelsFor(provider);
    const candidates = served.length > 0 ? served : ['default'];

    if (governance.denyModels?.length && candidates.some((m) => governance.denyModels!.includes(m))) {
      const denied = candidates.find((m) => governance.denyModels!.includes(m));
      return `model '${denied}' on admin denyModels list`;
    }
    if (governance.allowModels?.length && !candidates.some((m) => governance.allowModels!.includes(m))) {
      return `model '${candidates.join(', ')}' not on admin allowModels list`;
    }
    return undefined;
  }

  /**
   * Resolve the model name to use within a chosen provider.
   * Prefers the provider's configured model; falls back to 'default'.
   *
   * Registry-aware pin preference (the "no more recursion" guarantee): when
   * the Model Availability Registry has DEFINITIVELY ruled out the configured
   * pin (unavailable / quota-parked from real telemetry or a probe), the
   * router must NOT keep re-selecting it — the validator would re-repair it
   * with a "model not available" warning on every message. Instead, prefer a
   * registry-VERIFIED working model for the provider so auto routing lands on
   * a model that is known to work from the start.
   *
   * A pin the registry has no data on (cold start) is returned unchanged —
   * the live-list validator repairs it (once) and telemetry then verifies the
   * replacement, so the registry learns before the next message.
   */
  resolveModel(provider: string, agentType: string, configManager?: ConfigManager): string {
    if (configManager) {
      try {
        const { config } = configManager.getProviderConfig(provider);
        if (config?.model) {
          // Best-effort registry consult — never let it break model resolution.
          try {
            const registry = getModelRegistry();
            const entry = registry.getEntry(provider, config.model);
            const pinDead = !!entry && (entry.status === 'unavailable' || entry.quotaParkedUntil > Date.now());
            if (pinDead) {
              const verified = registry.resolveVerifiedModel(provider, preferredModelsFor(provider));
              if (verified) return verified;
            }
          } catch {
            // Fall through to the configured pin
          }
          return config.model;
        }
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
    taskProfile: TaskProfile,
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
    const profileSuffix = taskProfile.requiresVerification ? ' | verification' : '';
    return `${agentType} (${complexityLabels[complexity]}, ${taskType}) → ${selected.provider}/${model} ` +
      `score ${selected.score.toFixed(2)} | dominant: ${DIMENSION_LABELS[dominant]}${modeStr}${profileSuffix}`;
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
