/**
 * Routing History — records every Auto router decision over time.
 *
 * Every time the Auto model router picks a provider/model for a task, the
 * decision can be recorded here so the dashboard can show:
 *   - Usage stats — which providers/models were actually picked, by source
 *     (chat, orchestrator, explain, benchmark, eval) and by complexity
 *   - Audit trail — a timeline of `buff model explain` snapshots
 *
 * Persisted to ~/.buff/memory/routing-history.json (respects BUFF_MEMORY_DIR
 * for tests). Writes are best-effort — a failure must never break routing.
 *
 * Sources:
 *   - 'chat'          — live `buff chat` auto-routing (per message)
 *   - 'orchestrator'  — live multi-agent pipeline auto-routing (per task)
 *   - 'explain'       — `buff model explain` snapshots (audit trail)
 *   - 'benchmark'     — `buff benchmark --routing` picks
 *   - 'eval'          — `buff eval --routing` picks
 */
/** Where a routing decision came from. */
export type RoutingSource = 'explain' | 'benchmark' | 'eval' | 'chat' | 'orchestrator';
/**
 * A full routing-decision snapshot — the ranked candidate list with scores and
 * the decision context, captured at decision time. Recorded for `explain`
 * decisions so `model explain --since <ref>` (P3-M3.3) can diff two decisions
 * (bandit shift, new verification, constraints added). Additive and optional:
 * older entries without a snapshot diff as "no prior snapshot available".
 */
export interface RoutingSnapshot {
    /** Detected complexity (trivial…critical). */
    complexity: string;
    /** Task type classification (code/reasoning/chat/…). */
    taskType?: string;
    /** Dimension weights at decision time (key = dimension, value 0–1). */
    weights?: Record<string, number>;
    /** The winning pick. */
    winner: {
        provider: string;
        model: string;
        score: number;
    };
    /** Ranked candidate list (best first) — the scored breakdown. */
    ranked: Array<{
        provider: string;
        /** Resolved model for this provider ('' when the ranking is provider-level). */
        model?: string;
        score: number;
        reason: string;
        /** M2.1 capability fit 0–1 (undefined = gate OFF). */
        capabilityFit?: number;
        /** M2.2 cost basis: 'measured' (wire tokens) vs 'estimated'. */
        costSource?: 'measured' | 'estimated';
        /** M2.5 context-fit 0–1 (undefined = gate OFF). */
        contextFit?: number;
    }>;
    /** Ordered fallback chain. */
    fallbackChain?: Array<{
        provider: string;
        model: string;
        reason: string;
    }>;
    /** Providers eliminated by the governance policy (M2.4). */
    governanceBlocked?: Array<{
        provider: string;
        reason: string;
    }>;
}
/** A single recorded routing decision. */
export interface RoutingHistoryEntry {
    /** Unique id (timestamp + random suffix) */
    id: string;
    /** Epoch ms when the decision was made */
    timestamp: number;
    /** Source of the decision */
    source: RoutingSource;
    /** Agent type the decision was for (e.g., 'chat', 'writer', 'planner') */
    agentType: string;
    /** The task description that was routed */
    task: string;
    /** Detected complexity (trivial…critical) */
    complexity: string;
    /** Selected provider */
    provider: string;
    /** Selected model within that provider */
    model: string;
    /** Router composite score of the pick (0–1) */
    score: number;
    /**
     * Full decision snapshot (ranked candidates + context) — recorded for
     * `explain` decisions to power `model explain --since` (P3-M3.3). Optional:
     * non-explain sources and older entries omit it.
     */
    snapshot?: RoutingSnapshot;
}
/** Aggregated usage statistics over the recorded history. */
export interface RoutingUsageStats {
    total: number;
    /** Decisions made in the last 24h */
    last24h: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    bySource: Record<string, number>;
    byComplexity: Record<string, number>;
    updatedAt: number;
}
/**
 * Record a routing decision. Appends to the store (capped at MAX_ENTRIES,
 * keeping the most recent) and persists it.
 */
export declare function recordRoutingDecision(entry: Omit<RoutingHistoryEntry, 'id' | 'timestamp'>): void;
/**
 * Get recorded decisions, most recent first.
 */
export declare function getRoutingHistory(limit?: number): RoutingHistoryEntry[];
/**
 * Explain decisions that carry a full snapshot, most recent first — the
 * candidate set for `model explain --since <ref>` diffs (P3-M3.3).
 */
export declare function getExplainSnapshots(limit?: number): RoutingHistoryEntry[];
/**
 * Aggregate usage statistics over the recorded history:
 * totals, last-24h, and counts by provider/model/source/complexity.
 */
export declare function getRoutingUsageStats(): RoutingUsageStats;
/**
 * Clear all recorded routing history.
 */
export declare function clearRoutingHistory(): void;
//# sourceMappingURL=routing-history.d.ts.map