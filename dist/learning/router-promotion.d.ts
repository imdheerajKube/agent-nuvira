/**
 * RouterPromotion — promotion gate / A/B validation for the learning router.
 *
 * Mirrors ruflo's `router-parallel-analyze.mjs` (ADR-150): the bandit router is
 * only considered an IMPROVEMENT over the deterministic heuristic if it meets
 * THREE promotion criteria on real trajectories:
 *
 *   (a) qualityScore improvement  > +2%   (relative)
 *   (b) usdPerDecision regression  < +1%  (relative)
 *   (c) p95 routing latency regression < +5% (relative)
 *
 * Mechanism:
 * - During resolve() with bandit enabled, AutoModelRouter calls
 *   `noteParallelDecision()` — recording BOTH the deterministic heuristic pick
 *   and the bandit pick (provider/model/predictedQuality/predictedCostUsd/
 *   estimatedLatencyMs) for the same task.
 * - When the orchestrator records the real outcome, `recordOutcome()` finalizes
 *   the pending decision into a JSONL trajectory file
 *   (`~/.buff/memory/router-promotion.jsonl`, honors BUFF_MEMORY_DIR) with the
 *   ACTUAL outcome (success/failure, latencyMs, costUsd, qualityScore).
 * - `evaluate(minDecisions)` computes the three criteria over the DIVERGED
 *   decisions (where the bandit pick differs from the heuristic pick — a pick
 *   both routers agree on carries no promotion signal).
 *
 * The gate does not forcibly disable the bandit at runtime; it answers the
 * question \"is the bandit actually better than the heuristic?\" and is surfaced
 * via `buff model bandit`. All writes are best-effort.
 */
import type { BanditOutcome } from './router-bandit.js';
/** One router's pick for a task (deterministic heuristic OR bandit). */
export interface ParallelPick {
    provider: string;
    model: string;
    /** Predicted quality from the router's score (0–1). */
    predictedQuality: number;
    /** Predicted USD cost for a typical call on this provider. */
    predictedCostUsd: number;
    /** Estimated latency (ms) derived from the provider's speed score. */
    estimatedLatencyMs: number;
}
/** A finalized A/B decision with the real outcome. */
export interface PromotionDecision {
    agentType: string;
    task: string;
    heuristic: ParallelPick;
    bandit: ParallelPick;
    outcome: BanditOutcome;
    /** Actual latency of the executed call (ms), when measured. */
    latencyMs?: number;
    /** Actual USD cost of the executed call, when measured. */
    costUsd?: number;
    /** Actual quality score (0–1), when measured; else derived from outcome. */
    qualityScore?: number;
    timestamp: string;
}
/** The promotion-gate evaluation result. */
export interface PromotionStatus {
    /** Total finalized decisions in the trajectory. */
    decisionCount: number;
    /** Decisions where the bandit diverged from the heuristic (the A/B signal). */
    divergedCount: number;
    /** Minimum diverged decisions required before the gate is meaningful. */
    minDecisions: number;
    /** Relative quality delta: (bandit − heuristic) / heuristic. */
    qualityDelta: number;
    /** Relative cost delta: (bandit − heuristic) / heuristic. */
    costDelta: number;
    /** Relative p95 latency delta: (bandit − heuristic) / heuristic. */
    latencyDelta: number;
    /** True when at least one decision had a measured latency (else latencyDelta is 0 / n/a). */
    latencyMeasured: boolean;
    /** Per-criterion pass/fail. */
    criteria: {
        quality: boolean;
        cost: boolean;
        latency: boolean;
    };
    /** True when divergedCount >= minDecisions (enough data to judge). */
    sufficient: boolean;
    /** True when ALL criteria pass (bandit is a genuine improvement). */
    promoted: boolean;
}
/** Default minimum diverged decisions before the gate evaluates. */
export declare const DEFAULT_MIN_PROMOTION_DECISIONS = 20;
export declare class RouterPromotion {
    /** Pending (not-yet-finalized) decisions keyed by agentType+task. */
    private pending;
    /**
     * Record the deterministic-heuristic pick AND the bandit pick for a task.
     * Called by AutoModelRouter.resolve() when bandit learning is enabled.
     * The pending pair is finalized by recordOutcome() when the real result lands.
     * Keyed by agentType+task so PARALLEL tasks of the same agent type never
     * overwrite each other's attribution.
     */
    noteParallelDecision(agentType: string, task: string, heuristic: ParallelPick, bandit: ParallelPick): void;
    /**
     * Finalize the pending decision for an agent type + task with the real
     * outcome. Called by AutoModelRouter.recordOutcome() (i.e. by the
     * orchestrator after each auto-routed task). Best-effort append to the
     * trajectory file.
     */
    recordOutcome(agentType: string, task: string, outcome: BanditOutcome, outcomeData?: {
        latencyMs?: number;
        costUsd?: number;
        qualityScore?: number;
    }): void;
    /** All finalized decisions from the trajectory file (best-effort). */
    getDecisions(): PromotionDecision[];
    /**
     * Evaluate the promotion gate over the accumulated trajectory.
     *
     * @param minDecisions Minimum diverged decisions required for the gate to be
     *                     meaningful (ruflo's promotion gate needs a sample).
     */
    evaluate(minDecisions?: number): PromotionStatus;
    /** Clear the trajectory (used by `buff model bandit reset`). */
    reset(): void;
    private append;
}
/** Get or create the RouterPromotion singleton. */
export declare function getRouterPromotion(): RouterPromotion;
/** Reset the singleton (useful for testing). */
export declare function resetRouterPromotion(): void;
//# sourceMappingURL=router-promotion.d.ts.map