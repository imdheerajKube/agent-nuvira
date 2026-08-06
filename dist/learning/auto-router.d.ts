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
import { type ComplexityLevel, type ModelCandidate, type PreferenceMode } from './hybrid-router.js';
import { type TaskType } from './model-router.js';
import { type BanditOutcome } from './router-bandit.js';
import type { ConfigManager } from '../config/manager.js';
/** The special model value that triggers automatic per-task routing. */
export declare const AUTO_MODEL = "auto";
/** The special provider value stored in active-model state for Auto mode. */
export declare const AUTO_PROVIDER = "auto";
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
export declare const DIMENSION_LABELS: Record<RoutingDimension, string>;
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
export declare class PIIPolicyError extends Error {
    /** Minimum privacy score the policy required (0–1). */
    readonly requiredPrivacy: number;
    constructor(requiredPrivacy: number);
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
export declare class GovernancePolicyError extends Error {
    /** Providers eliminated by the policy, with the reason for each (audit). */
    readonly blocked: Array<{
        provider: string;
        reason: string;
    }>;
    constructor(blocked: Array<{
        provider: string;
        reason: string;
    }>);
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
    circuitBreakerStatus?: Array<{
        provider: string;
        cooldownRemaining: number;
    }>;
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
    quotaStatus?: Array<{
        provider: string;
        cooldownRemaining: number;
    }>;
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
    costBasis?: {
        inputTokens: number;
        outputTokens: number;
    };
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
    governanceBlocked?: Array<{
        provider: string;
        reason: string;
    }>;
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
/**
 * Minimum expected win rate (α/(α+β)) for a provider to qualify as an
 * escalation target. A learned-but-failing provider (win rate near or below
 * 0.5) must never steal routing from a strong cold-start winner.
 */
export declare const ESCALATION_WIN_RATE_FLOOR = 0.55;
/**
 * 0–1 fit between a task type's required capabilities and a provider's
 * offered tags: matched-required / total-required. 1 = the provider covers
 * every capability the task needs; 0 = none.
 *
 * A provider with NO assessable profile (truly unknown, e.g. a brand-new
 * gateway with a neutral profile) returns 1 — neutral: it can host any model,
 * so it is never unfairly boosted OR penalized until real usage data exists.
 */
export declare function capabilityFitScore(taskType: string, provider: string, caps?: ProviderCapabilities): number;
/**
 * Apply the soft capability-fit multiplier, clamped so the score never
 * exceeds 1 (the 0–1 invariant the bandit and tests rely on). Range:
 * no-fit ≈ 0.85×, perfect-fit ≈ 1.10× (then clamped).
 */
export declare function applyCapabilityFit(score: number, fit: number): number;
/** Built-in provider ids considered by default. */
export declare const DEFAULT_AUTO_PROVIDERS: string[];
/** Real per-1K-token pricing (USD) — input/output per 1K tokens. */
export declare const PROVIDER_PRICING_PER_1K: Record<string, {
    inputPer1K: number;
    outputPer1K: number;
}>;
/** Per-model nominal input context window (tokens). */
export declare const MODEL_CONTEXT_WINDOWS: Record<string, number>;
/** Provider-level fallback when the exact model isn't in the table. */
export declare const PROVIDER_CONTEXT_WINDOWS: Record<string, number>;
/** Fallback for unknown providers — large enough to rarely trigger a penalty. */
export declare const DEFAULT_CONTEXT_WINDOW = 32768;
/**
 * M2.5 context preflight — soft utilization-based fit (0–1, higher = better).
 * NEVER a hard block: even a prompt that exceeds the nominal window only caps
 * the penalty, and unknown/zero windows are neutral (fit 1). Neutral below
 * 50% utilization so normal-size tasks never shift a ranking; ramps linearly
 * to a 35% cap at ≥200% utilization.
 */
export declare function computeContextFit(promptTokens: number, windowTokens: number): number;
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
export declare function estimateCallCostUsd(provider: string, pricing?: {
    inputPer1K: number;
    outputPer1K: number;
}, measured?: MeasuredCost): number;
/**
 * Derive the 0–1 cost score (higher = cheaper) from real provider pricing.
 * Free providers (local, Gemini free tier) score 1.0.
 * M2.2: measured tokens (when present) replace the typical-call estimate.
 */
export declare function computeCostScore(provider: string, pricing?: {
    inputPer1K: number;
    outputPer1K: number;
}, measured?: MeasuredCost): number;
/**
 * Check whether a model value means "Auto routing".
 */
export declare function isAutoModel(model?: string | null): boolean;
/**
 * Check whether a provider value means "Auto routing".
 */
export declare function isAutoProvider(provider?: string | null): boolean;
/**
 * Compute the effective dimension weights for a task.
 * Combines complexity baseline + preference-mode adjustments + user overrides,
 * then normalizes to sum 1 so scores are comparable across calls.
 */
export declare function computeWeights(complexity: ComplexityLevel, mode?: PreferenceMode, overrides?: Partial<Record<RoutingDimension, number>>): Record<RoutingDimension, number>;
/**
 * Score a single provider against the effective weights.
 */
export declare function analyzeTaskProfile(taskDescription: string): TaskProfile;
export declare function scoreProvider(provider: string, capabilities: ProviderCapabilities, weights: Record<RoutingDimension, number>): {
    score: number;
    dimensions: Record<RoutingDimension, number>;
    weightTotal: number;
};
/**
 * AutoModelRouter — scores available providers per task and picks the best.
 */
export declare class AutoModelRouter {
    private profiles;
    constructor(profiles?: Record<string, ProviderCapabilities>);
    /** Get the capability profile for a provider (falls back to a neutral profile). */
    getCapabilities(provider: string): ProviderCapabilities;
    /** Update/override capability profiles (e.g., from config). */
    updateProfiles(profiles: Record<string, ProviderCapabilities>): void;
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
    private getDefaultAllowedProviders;
    /**
     * Resolve the optimal provider/model for a task.
     *
     * @param agentType — Agent type (e.g., 'writer', 'planner', 'chat')
     * @param taskDescription — The task text used for complexity analysis
     * @param options — Routing options (mode, allowed providers, circuit-breaker status)
     * @param configManager — Optional; used to resolve provider model defaults
     * @returns An AutoRouteResult with ranked providers, fallback chain, and explanation
     */
    resolve(agentType: string, taskDescription: string, options?: AutoRouterOptions, configManager?: ConfigManager): AutoRouteResult;
    /**
     * M2.5: nominal input context window (tokens) for a provider×model. Model
     * table → provider fallback → generous default. `routing.contextWindows`
     * overrides (keyed by model, or by provider as a provider-level default)
     * always win. Estimation-only input — never a hard block.
     */
    private resolveContextWindow;
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
    recordOutcome(agentType: string, taskDescription: string, outcome: BanditOutcome, configManager?: ConfigManager, outcomeData?: {
        latencyMs?: number;
        costUsd?: number;
        qualityScore?: number;
    }, complexityHint?: ComplexityLevel): void;
    /**
     * Choose the concrete model within the selected provider using per-model
     * bandit priors (ruflo ADR-149 mirror).
     *
     * Candidate models = the provider's configured pin (if real) + the curated
     * known-good defaults for the provider. Cold start (no per-model data yet)
     * keeps the configured model — deterministic. Once outcomes accumulate,
     * the best Thompson-sampled LEARNED model wins, so the model choice learns.
     */
    resolveModelWithLearning(provider: string, configuredModel: string, complexity: ComplexityLevel, minSamples?: number): string;
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
    private toParallelPick;
    /**
     * Resolve the effective per-1K-token pricing for a provider.
     * Config overrides (`buff config set pricing.<provider>...`) win over the
     * built-in pricing table; unknown providers fall back to a cheap default.
     */
    getProviderPricing(provider: string, configManager?: ConfigManager): {
        inputPer1K: number;
        outputPer1K: number;
    };
    /**
     * M2.2: measured wire-token profile for a provider from the Model
     * Availability Registry (sample-weighted EMA). Best-effort — registry
     * bookkeeping must never break routing; undefined ⇒ estimated cost.
     */
    private getMeasuredCost;
    /**
     * Whether any governance policy is configured (so the constraint slot only
     * runs when there is something to enforce).
     */
    private governanceActive;
    /**
     * Effective per-call max-cost cap: the stricter of the per-call option and
     * the admin governance cap. undefined when neither is set.
     */
    private effectiveMaxCost;
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
    private governanceModelReason;
    /**
     * Resolve the model name to use within a chosen provider.
     * Prefers the provider's configured model; falls back to 'default'.
     */
    resolveModel(provider: string, agentType: string, configManager?: ConfigManager): string;
    /**
     * Pick the best model within the selected provider, given a list of model
     * descriptors (e.g., from provider.listModels()). Keeps the configured model
     * if present, otherwise the first non-speech model, otherwise 'default'.
     */
    pickModelFromCatalog(provider: string, models: Array<{
        id: string;
        tags?: string[];
    }>, configManager?: ConfigManager): string;
    /**
     * Load runtime performance data: per-provider benchmark quality and the
     * best-performing model for the given agent type (from agent stats).
     */
    private loadRuntimeAdjustments;
    /**
     * Adjust a provider's capability scores from runtime data:
     * - Benchmark quality blends into `reasoning` (30% measured / 70% static)
     * - A proven best model for this agent type boosts reliability + reasoning
     */
    private adjustCapabilitiesForRuntime;
    /** Build a short reason for a provider's rank. */
    private buildReason;
    /** Build the human-readable decision explanation. */
    private buildExplanation;
}
/**
 * Get or create the AutoModelRouter singleton.
 */
export declare function getAutoRouter(): AutoModelRouter;
/**
 * Reset the singleton (useful for testing).
 */
export declare function resetAutoRouter(): void;
//# sourceMappingURL=auto-router.d.ts.map