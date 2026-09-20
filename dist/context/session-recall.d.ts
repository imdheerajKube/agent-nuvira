/**
 * D1 — Agent-driven auto-recall.
 *
 * `autoRecall` rebuilds a project's working context from prior sessions with
 * ZERO manual commands: workspace project row (A2) → session history scoped by
 * project + optional temporal range (D1 searchSessions) → facts (B1) → latest
 * checkpoint (resume point). The result is a one-line recall card for the user
 * plus a context block that gets injected into the planner/chat prompt so a
 * "continue last week's plan" request resumes with the project's actual state.
 *
 * Cross-command parity (STANDING RULE): chat, execute, and plan all invoke
 * this from the shared NLU dispatch (intent continue/resume → mode 'recall').
 * Best-effort everywhere — recall must never break a command.
 */
import { type WorkspaceProject, type WorkspaceStore } from '../config/workspace.js';
import { type HistorySession } from './history.js';
import { type StoredFact } from '../memory/fact-store.js';
import { type CheckpointMeta } from '../agents/checkpoint-store.js';
/** Test-only: clear the in-memory dedupe map between test cases. */
export declare function resetRecallHitDedupe(): void;
/**
 * Record one recall hit (project + timestamp). Called from autoRecall when
 * the recall actually returned something — one shared choke point, so every
 * entry point (chat / execute / plan / edit / session resume) counts a hit
 * without per-command wiring. Best-effort: a failed append never breaks recall.
 *
 * Dedupe: consecutive hits for the same project within RECALL_HIT_DEDUPE_MS
 * are skipped (same user action re-entering autoRecall). Skipped entirely
 * under test (VITEST) so suites never pollute a real ~/.nuvira telemetry file.
 */
export declare function recordRecallHit(projectId: string): void;
/**
 * Read recall-hit telemetry for the dashboard memory panel. Best-effort;
 * a missing/corrupt file returns zeros.
 */
export declare function readRecallHits(): {
    total: number;
    today: number;
    last7d: number;
    byProject: Record<string, number>;
};
export interface RecallOptions {
    /** Working directory the project is rooted at (default: process.cwd()). */
    cwd?: string;
    /** Explicit project id (A2 deriveProjectId). Derived from cwd when absent. */
    projectId?: string;
    /** Temporal reference from the parsed request ("last week") — resolved with C1's recognizer, no LLM. */
    timeRangeText?: string;
    /** Pre-resolved epoch range (overrides timeRangeText). */
    timeRange?: {
        start?: number;
        end?: number;
    };
    /** Workspace store override (tests / custom config dir). Defaults to getWorkspaceStore(). */
    store?: WorkspaceStore;
    /** Max recent sessions to return (default 8). */
    maxSessions?: number;
    /** Max facts to return (default 5). */
    maxFacts?: number;
}
export interface RecallResult {
    projectId: string;
    project: WorkspaceProject | null;
    sessionCount: number;
    sessions: HistorySession[];
    factCount: number;
    facts: StoredFact[];
    checkpoint: CheckpointMeta | null;
    lastGoal: string;
    runSummary: string;
    /** e.g. "step 3/8" when a checkpoint exists; null otherwise. */
    resumedStep: string | null;
}
/**
 * Resolve a temporal phrase ("last week", "yesterday", "2 days ago") to an
 * epoch range using C1's Microsoft recognizer — the exact "continue last
 * week's plan" path. Returns undefined when nothing temporal is found.
 */
export declare function textRangeToEpoch(text: string, referenceDate?: Date): {
    start?: number;
    end?: number;
} | undefined;
/**
 * Rebuild a project's working context from prior sessions with zero manual
 * commands: workspace row → sessions (project + optional time range) → facts →
 * latest checkpoint. All reads are best-effort (never throw).
 */
export declare function autoRecall(opts?: RecallOptions): Promise<RecallResult>;
/**
 * Convenience wrapper for the action commands: runs autoRecall and returns
 * null when there is nothing to recall (so callers skip the card/injection
 * entirely). Shared by chat / execute / plan / edit — the D1 cross-command
 * parity hook.
 */
export declare function maybeAutoRecall(cwd: string, store?: WorkspaceStore): Promise<RecallResult | null>;
/**
 * Recall policy — ambient awareness of what this project has already done.
 *
 * THE GAP THIS CLOSES: `chat` has always recalled prior project work on EVERY
 * turn with a project attached, but edit, execute, plan and pipeline-tool gated
 * recall behind a continue/resume signal (`intent === 'continue'`,
 * `mode === 'recall'`). So the same request phrased as ordinary work — "fix the
 * slugify parser bug" — began with no knowledge of the project's history: what
 * was already built, what the agent itself had written in a previous session,
 * or which facts had been learned about the codebase. The agent looked like it
 * had amnesia about its own prior work, and only a user who happened to phrase
 * the request as a continuation could unlock it.
 *
 * The gate bought nothing in return: `maybeAutoRecall` already returns null for
 * a project with no history, and recall is local JSON reads — no network, no LLM
 * call, no meaningful latency.
 *
 * Policy:
 *   - ALWAYS recall when the project has prior work (ambient awareness);
 *   - ANNOUNCE (print the visible card) only when the user explicitly asked to
 *     continue/resume, because that is when the recall IS the answer rather than
 *     background context — an unrequested card on every command is noise.
 */
export declare function recallPolicy(input?: {
    intent?: string;
    mode?: string;
}): {
    recall: boolean;
    announce: boolean;
};
/** One-line recall card shown to the user. */
export declare function recallCard(r: RecallResult): string;
/** Context block injected into the planner/chat prompt. */
export declare function recallContextBlock(r: RecallResult): string;
//# sourceMappingURL=session-recall.d.ts.map