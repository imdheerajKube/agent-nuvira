/**
 * Tier0Router — Deterministic, $0 routing for mechanical edits.
 *
 * Inspired by ruflo's `enhanced-model-router.ts` Tier-1 "Agent Booster" codemods:
 * simple, fully-deterministic transforms (remove console.log, rename a symbol,
 * dedupe imports) are applied <1ms and for $0 — no LLM round-trip at all.
 * agent-nuvira's tier-0 is built on its existing editing engine (`renameSymbol`),
 * guarded by AST syntax validation so we never emit broken code.
 *
 * Contract:
 * - `detectTier0Intent(goal, artifacts)` — is this task mechanically doable?
 *   Returns a high-confidence intent or null (→ fall through to the LLM).
 * - `tryTier0Route(goal, artifacts)` — if an intent applies to at least one
 *   artifact and every transformed file still parses, returns FileChange[]
 *   with a summary; otherwise null so the caller keeps the normal LLM path.
 *
 * The tier-0 router NEVER writes to disk — it returns FileChange objects just
 * like the EditModule, so the orchestrator applies them through the same
 * safe-apply pipeline (dry-run, sandbox, review bundles all keep working).
 */
import type { Artifact, FileChange } from '../agents/agent.js';
/** The mechanical edit kinds tier-0 can perform deterministically. */
export type Tier0IntentType = 'remove-console' | 'rename-symbol' | 'dedupe-import';
/** A detected mechanical edit intent. */
export interface Tier0Intent {
    type: Tier0IntentType;
    /** 0–1 confidence this intent truly matches the user's goal */
    confidence: number;
    /** Free-form parameters (e.g., { oldName, newName } for rename) */
    params: Record<string, string>;
    /** Human-readable description shown in summaries */
    description: string;
}
/** Result of a successful tier-0 route (ready for the safe-apply pipeline). */
export interface Tier0Result {
    intent: Tier0Intent;
    changes: FileChange[];
    summary: string;
    changeCount: number;
}
/**
 * Detect whether a goal can be handled deterministically without an LLM.
 * Rename additionally requires the old symbol to actually appear in an artifact.
 */
export declare function detectTier0Intent(goal: string, artifacts: Artifact[]): Tier0Intent | null;
/**
 * Detect whether a symbol name appears inside a string literal or comment.
 * Used to keep the rename transform conservative — renaming a symbol that also
 * appears in strings/comments would corrupt user-facing text, which the syntax
 * validator can't catch.
 */
export declare function symbolInStringOrComment(code: string, name: string): boolean;
/** Apply a single mechanical transform. Returns null when the file was unchanged. */
export declare function applyTier0Transform(intent: Tier0Intent, artifact: Artifact): {
    path: string;
    originalContent: string;
    newContent: string;
} | null;
/**
 * Try to fulfill the goal deterministically (no LLM). Returns a Tier0Result
 * when a mechanical intent was detected AND at least one file was transformed
 * AND every transformed file still passes syntax validation. Otherwise null.
 */
export declare function tryTier0Route(goal: string, artifacts: Artifact[]): Tier0Result | null;
//# sourceMappingURL=tier0-router.d.ts.map