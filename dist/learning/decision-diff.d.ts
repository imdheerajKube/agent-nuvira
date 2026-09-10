/**
 * Decision Diff — `model explain --since <ref>` (Nuvira-Router P3-M3.3).
 *
 * Compares two routing-decision snapshots (captured by the explain path and
 * persisted in routing-history.json): what changed between a previous decision
 * and the current one — the winner, per-candidate scores (bandit shift), the
 * dimension weights, governance eliminations, and the capability/context gate
 * states.
 *
 * PURE module: no I/O, no singletons — unit-testable in isolation.
 */
import type { RoutingSnapshot } from './routing-history.js';
/** One candidate's before/after. */
export interface CandidateDiff {
    provider: string;
    /** Highest score for this provider in the previous decision. */
    prevScore?: number;
    /** Highest score for this provider in the current decision. */
    curScore?: number;
    /** cur − prev when the provider ranked in both, else null. */
    delta: number | null;
    /** Human classification of the change. */
    change: 'new' | 'dropped' | 'improved' | 'regressed' | 'unchanged';
    /** Current decision reason for this provider (when present). */
    reason?: string;
}
/** Structured before → after diff of two routing decisions. */
export interface DecisionDiff {
    prevWinner: {
        provider: string;
        model: string;
        score: number;
    } | null;
    curWinner: {
        provider: string;
        model: string;
        score: number;
    } | null;
    winnerChanged: boolean;
    /** Candidate score deltas, changed first then by |Δ| desc. */
    candidates: CandidateDiff[];
    /** Dimension weight deltas (bandit shift) — non-zero only. */
    weightDeltas: Record<string, number>;
    /** Governance policy changes (M2.4). */
    governance: {
        added: Array<{
            provider: string;
            reason: string;
        }>;
        removed: Array<{
            provider: string;
            reason: string;
        }>;
    };
    /** Gate transitions: capability fit / context fit on the winner. */
    gates: Array<{
        dimension: string;
        prev: string | undefined;
        cur: string | undefined;
        change: 'on' | 'off' | 'same';
    }>;
}
/**
 * Pure diff of two decision snapshots. Handles any combination of missing
 * snapshots at the CALLER level (null prev → treated as "new decision").
 */
export declare function diffRoutingDecisions(prev: RoutingSnapshot, cur: RoutingSnapshot): DecisionDiff;
/** Compact human summary of a diff (used by `model explain --since`). */
export declare function formatDecisionDiff(diff: DecisionDiff, opts?: {
    refLabel?: string;
    task?: string;
}): string;
//# sourceMappingURL=decision-diff.d.ts.map