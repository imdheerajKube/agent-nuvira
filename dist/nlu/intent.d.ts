/**
 * C1 — NLU rule fast-path.
 *
 * Deterministic intent classification for developer requests. Pure rules only:
 * zero network, zero model calls, <5ms typical. Unknown inputs return
 * `confidence: 0` (never a guess) so the C2 LLM-verify path takes over.
 *
 * A single dispatch loop, no user-facing
 * mode picker): the intent + modeHint resolved here is the vocabulary the C3
 * action map and the orchestrator pipeline consume, so intent resolution and
 * tool dispatch share one source of truth.
 *
 * Temporal references ("last week", "yesterday", "2 days ago") are extracted
 * via `@microsoft/recognizers-text-date-time` — MIT, pure JS, no model call —
 * which alone covers the headline "continue last week's plan" case.
 */
/** The intents C1 can resolve deterministically. */
export type NluIntent = 'create' | 'continue' | 'fix' | 'explain' | 'configure' | 'write' | 'unknown';
/** The pipeline a resolved intent should run (C3 action-map key). */
export type ModeHint = 'dev' | 'recall' | 'execute' | 'chat' | 'config';
/** A temporal reference normalized from the recognizer. */
export interface TimeRange {
    /** The matched surface text, e.g. "last week". */
    text: string;
    /** ISO start (ranges) or point (dates). */
    start?: string;
    /** ISO end (present for ranges). */
    end?: string;
    /** TIMEX expression when available. */
    timex?: string;
}
/** The deterministic classification result. */
export interface IntentResult {
    intent: NluIntent;
    /** 0–1. 0 means unknown — C2 must verify. */
    confidence: number;
    /** The pipeline hint, or null for unknown. */
    modeHint: ModeHint | null;
    /** Present only for continue/resume with a temporal reference. */
    timeRange?: TimeRange;
}
/** Rule confidence above which the rule path is trusted (C2 only below this). */
export declare const RULE_TRUST_THRESHOLD = 0.8;
/** Explain/interrogative → chat ("explain caching", "how do I add JWT auth?"). */
export declare function matchExplainRule(text: string): IntentResult | null;
/**
 * Continue/resume → recall, with a temporal timeRange when the text carries one
 * ("continue last week's ecommerce plan" → timeRange for last week).
 * The reference date is injectable for deterministic tests.
 */
export declare function matchContinueRule(text: string, referenceDate?: Date): IntentResult | null;
/**
 * Fix/debug → execute ("fix the login bug", "debug the failing test").
 *
 * The keywords must be WHOLE words: a hyphen or underscore on either side means
 * the token is part of an identifier (e.g. the project name `nuvira-fix-validation`
 * or a branch `fix-123`) — a request mentioning it is not a fix request. \b
 * alone is insufficient: it treats `-` and `_` as word boundaries, so
 * "deploy the project nuvira-fix-validation" would false-positive into fix.
 */
export declare function matchFixRule(text: string): IntentResult | null;
/** Configure → config ("configure the gemini api key", "switch provider"). */
export declare function matchConfigureRule(text: string): IntentResult | null;
/**
 * Write/creative → chat (S4). "Write an essay/poem/story/letter/article/…" is
 * a CONTENT request — a direct chat answer, NEVER the coding pipeline (the
 * observed failure: "write an essay" was classified create → the no-model
 * fallback spun up the full multi-agent pipeline for a zero-code task). The
 * model still sees the build/analyze/… tools in the loop and can call them if
 * the request actually needs code — the action only governs the no-model
 * fallback + the routing hint. Runs BEFORE matchCreateRule so "write a test"
 * (test is not a writing artifact) still resolves to create.
 */
export declare function matchWriteRule(text: string): IntentResult | null;
/**
 * Create/build → dev. Requires a verb-initial command or a project-object noun
 * so "the build failed" (build as noun) and "make sure tests pass" never
 * false-positive into developer mode.
 */
export declare function matchCreateRule(text: string): IntentResult | null;
/**
 * Extract the first temporal reference from text via the Microsoft recognizer
 * (MIT, pure JS, no network). Returns undefined when none is found.
 * The reference date is injectable for deterministic tests.
 */
export declare function extractTimeRange(text: string, referenceDate?: Date): TimeRange | undefined;
/**
 * Classify a user request deterministically.
 *
 * Priority order: explain → continue → fix → configure → write → create.
 * Interrogatives win first so "explain how to build X" is a chat question, not
 * a dev command; "continue" wins over "build" so "continue building the app"
 * resumes recall; writing artifacts (essay/poem/story/…) route to chat, never
 * the coding pipeline (S4). Unknown inputs return `{ intent: 'unknown',
 * confidence: 0 }` — never a guess.
 */
export declare function classifyIntent(text: string, referenceDate?: Date): IntentResult;
//# sourceMappingURL=intent.d.ts.map