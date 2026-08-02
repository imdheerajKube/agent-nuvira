/**
 * RouterBandit — bucketed Thompson-sampling bandit for Auto model routing.
 *
 * Inspired by ruflo's `model-router.ts` (Beta-Bernoulli Thompson sampling)
 * and generalized beyond 3 Claude tiers to agent-nuvira's full provider set.
 *
 * Mechanism:
 * - Each provider keeps a Beta(α, β) prior PER complexity bucket
 *   (trivial/simple/moderate/complex/critical) so learning is task-type-local.
 * - During routing, the deterministic score is multiplied by a Thompson draw
 *   θ ~ Beta(α, β). Cold-start Beta(1,1) is uniform, so behavior matches the
 *   deterministic router until outcomes accumulate.
 * - `recordOutcome()` applies a COST-ADJUSTED Bernoulli reward: cheap
 *   providers get the highest α bump on success (a cheap successful call is
 *   the most cost-efficient outcome), failures always β++.
 *
 * Persisted to ~/.buff/memory/router-bandit.json (respects BUFF_MEMORY_DIR).
 * All writes are best-effort — a failed write must never break routing.
 */
import { type ComplexityLevel } from './hybrid-router.js';
/** Routing outcome used to update bandit priors. */
export type BanditOutcome = 'success' | 'failure' | 'escalated';
/** Richer feedback data that can improve the bandit reward signal. */
export interface BanditOutcomeData {
    outcome: BanditOutcome;
    latencyMs?: number;
    tokensUsed?: number;
    costUsd?: number;
    testPassed?: boolean;
    qualityScore?: number;
    userAccepted?: boolean;
    verificationPassed?: boolean;
    metadata?: Record<string, unknown>;
}
/** A single Beta prior pair. */
export interface BetaPrior {
    alpha: number;
    beta: number;
}
/**
 * Minimum accumulated samples (α+β) before a prior is considered "learned".
 * Priors below this have essentially no data — bandit routing treats them as
 * unlearned and (when enabled) escalates to a provider/model that has data.
 */
export declare const DEFAULT_MIN_SAMPLES = 8;
/** The complexity buckets the bandit learns per provider. */
export declare const COMPLEXITY_BUCKETS: ComplexityLevel[];
/** Persisted bandit state. */
export interface RouterBanditState {
    version: number;
    /** priors[complexityBucket][provider] = Beta(α, β) */
    priors: Record<string, Record<string, BetaPrior>>;
    /**
     * Per-modelId Beta priors — modelPriors[complexityBucket][modelId] = Beta(α, β).
     * Mirrors ruflo's ADR-149 `priorsById` shadow state: the bandit learns that
     * e.g. `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b` within the SAME
     * provider, so the concrete model choice can learn from real outcomes.
     */
    modelPriors: Record<string, Record<string, BetaPrior>>;
    /** Recent learning history (bounded, for observability). */
    learningHistory: Array<{
        provider: string;
        /** Concrete model id this outcome was attributed to (per-model learning). */
        model?: string;
        complexity: string;
        outcome: string;
        reward: number;
        latencyMs?: number;
        tokensUsed?: number;
        costUsd?: number;
        testPassed?: boolean;
        qualityScore?: number;
        userAccepted?: boolean;
        verificationPassed?: boolean;
        timestamp: string;
    }>;
}
/** Standard normal via Box–Muller. */
export declare function standardNormal(): number;
/**
 * Sample from Gamma(shape, scale=1) using the Marsaglia–Tsang method.
 * Handles shape < 1 with the GS transform (Gamma(shape+1) · U^(1/shape)).
 */
export declare function sampleGamma(shape: number): number;
/**
 * Sample from Beta(α, β) using the gamma-ratio identity X/(X+Y).
 * Degenerate priors (α ≤ 0 or β ≤ 0) return the neutral midpoint 0.5.
 */
export declare function sampleBeta(alpha: number, beta: number): number;
/**
 * Compute the α-bump for a successful routing outcome.
 * Cheap providers (costScore near 1) get the highest reward because their
 * success is the most cost-efficient — mirrors ruflo's "Haiku-success >
 * Sonnet-success > Opus-success" table, generalized to any provider.
 * Returns a value in [0.1, 0.9] (expensive = 0.1, neutral = 0.5, free = 0.9);
 * β gets `1 - reward` on success.
 */
export declare function costAdjustedSuccessReward(costScore: number): number;
export declare class RouterBandit {
    private state;
    /** Provider chosen by the last resolve() per agent type (for outcome wiring). */
    private lastProviderByAgent;
    /** Concrete model chosen by the last resolve() per agent type (for per-model learning). */
    private lastModelByAgent;
    constructor();
    /** Load persisted state (best-effort). */
    private load;
    private save;
    /** Get the Beta prior for a model in a complexity bucket (per-model learning). */
    getModelPrior(model: string, complexity: ComplexityLevel): BetaPrior;
    /** Note the concrete model picked for an agent type (per-model outcome wiring). */
    noteModelDecision(agentType: string, model: string): void;
    /** Concrete model picked last for an agent type, if any. */
    getLastModel(agentType: string): string | undefined;
    /**
     * Thompson-sample a model's score for a complexity bucket using its
     * per-model prior. Cold-start Beta(1,1) → uniform draw, so the model choice
     * behaves deterministically until per-model outcomes accumulate.
     */
    sampleModelScore(model: string, complexity: ComplexityLevel, score: number): number;
    /** Get the Beta prior for a provider in a complexity bucket. */
    getPrior(provider: string, complexity: ComplexityLevel): BetaPrior;
    /** Note the provider picked for an agent type (for recordOutcome wiring). */
    noteDecision(agentType: string, provider: string): void;
    /** Provider picked last for an agent type, if any. */
    getLastProvider(agentType: string): string | undefined;
    /**
     * Apply a reward to a Beta prior for the given outcome.
     * Shared by provider-level and per-modelId learning so both surfaces use
     * exactly the same reward math (cost-adjusted success, partial credit for
     * escalation, penalties for failures). Returns the reward applied.
     */
    private applyReward;
    /**
     * Update the bandit prior for a provider in the task's complexity bucket.
     *
     * @param provider       The provider whose prior to update.
     * @param taskDescription Task text — complexity is re-derived with the SAME
     *                        analyzeComplexity path route() uses, so record-time
     *                        and select-time buckets always match.
     * @param outcome        success | failure | escalated
     * @param costScore      0–1 cost score of the provider (1 = cheapest). Drives
     *                       the cost-adjusted success reward. Default 0.5.
     * @param outcomeData    Optional richer outcome telemetry for the reward model.
     */
    recordOutcome(provider: string, taskDescription: string, outcome: BanditOutcome, costScore?: number, outcomeData?: Partial<BanditOutcomeData>): void;
    /**
     * Update the PER-MODEL prior for a concrete model id in the task's complexity
     * bucket (mirror of ruflo's ADR-149 `priorsById` shadow state). Called by the
     * router alongside the provider-level recordOutcome so the model choice learns
     * which concrete model within a provider performs best.
     *
     * @param model          The concrete model id (e.g. 'llama-3.3-70b-versatile').
     * @param taskDescription Task text — complexity bucket re-derived identically.
     * @param outcome        success | failure | escalated
     * @param costScore      0–1 cost score of the model's provider (1 = cheapest).
     * @param outcomeData    Optional richer outcome telemetry for the reward model.
     */
    recordModelOutcome(model: string, taskDescription: string, outcome: BanditOutcome, costScore?: number, outcomeData?: Partial<BanditOutcomeData>): void;
    /**
     * Thompson-sample a provider's deterministic score for a complexity bucket.
     * Cold-start Beta(1,1) → uniform draws, so expected behavior matches the
     * deterministic router; accumulated outcomes skew the sample up/down.
     */
    sampleScore(provider: string, complexity: ComplexityLevel, score: number): number;
    /** Full state snapshot (for CLI display / tests). */
    getState(): RouterBanditState;
    /** Reset all state (used by tests and `buff model bandit reset`). */
    reset(): void;
}
/** Get or create the RouterBandit singleton. */
export declare function getRouterBandit(): RouterBandit;
/** Reset the singleton (useful for testing). */
export declare function resetRouterBandit(): void;
//# sourceMappingURL=router-bandit.d.ts.map