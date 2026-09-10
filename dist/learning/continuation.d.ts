/**
 * Continuation + context-relay core (Nuvira-Router P4 M4.1 + M4.3).
 *
 * Mid-stream resilience, OFF by default (pure module — callers opt in):
 *   - `isPartialFailure()` — is this error a mid-stream death (partial output
 *     already streamed to the user) vs a DEFINITIVE pre-response failure that
 *     a continuation would waste a call on (auth / rate-limit / model-404)?
 *   - `buildContinuationNote()` — the bounded "continue from here" note. This
 *     doubles as the M4.3 context-relay summary for provider/key rotation: the
 *     next candidate sees the original task + the partial output the previous
 *     provider already produced (head+tail trimmed to a token budget), so it
 *     CONTINUES instead of restarting or repeating.
 *   - `ContinuationBudget` — M4.1 budget cap: at most ONE continuation per
 *     task (a second failure after a continuation is definitive, not unlucky).
 *
 * The token heuristic mirrors ContextPruner (~4.5 chars/token) so the note
 * cost is consistent with the rest of the pipeline's estimates.
 */
/** Default token budget for a continuation note (the partial-output relay). */
export declare const DEFAULT_CONTINUATION_MAX_TOKENS = 2048;
/** Chars-per-token heuristic — mirrors ContextPruner's estimate. */
export declare const CHARS_PER_TOKEN = 4.5;
export interface ContinuationOptions {
    /** Token budget for the full note (default 2048). */
    maxTokens?: number;
    /** Chars-per-token heuristic override. */
    charsPerToken?: number;
}
/** Token estimate for a text (ContextPruner-compatible heuristic). */
export declare function estimateNoteTokens(text: string): number;
/**
 * Classify whether a failure is a PARTIAL (mid-stream) failure worth a
 * continuation. Definitive classes are excluded: auth (401/403), rate-limit
 * (429), model-not-found (404) — the response never started, the provider is
 * dead or the model is wrong, and a continuation would just burn a call.
 * Network drop, server 5xx, timeout/abort and parse errors after a stream
 * started ARE partial candidates.
 */
export declare function isPartialFailure(err: unknown): boolean;
/**
 * Trim a partial output to a char budget, keeping a head + the LONG tail (the
 * most recent tokens matter most for continuation) with a truncation marker.
 */
export declare function trimPartialOutput(partial: string, maxChars: number): string;
/**
 * Build the bounded continuation note (M4.1 core + M4.3 context relay).
 *
 * The next provider sees the original task (authoritative, never dropped) and
 * the partial output already produced (head+tail trimmed to the budget), with
 * explicit instructions to CONTINUE — not restart, not repeat.
 *
 * @param prompt        The full prompt sent to the failed attempt
 * @param partialOutput Tokens already streamed before the failure ('' when the
 *                      failure happened before any output)
 */
export declare function buildContinuationNote(prompt: string, partialOutput: string, opts?: ContinuationOptions): string;
/**
 * M4.1 budget cap: at most `maxPerTask` continuations per task (default 1).
 * A task that already consumed its continuation budget fails forward instead
 * of continuing in a loop after a second mid-stream death.
 */
export declare class ContinuationBudget {
    private readonly maxPerTask;
    /** taskKey → number of continuations already granted (per-task counter). */
    private used;
    constructor(maxPerTask?: number);
    /**
     * Returns true when this task still has budget and grants it one more
     * continuation; false once the task has used its `maxPerTask` allowance
     * (a task that died mid-stream again is definitive, not unlucky).
     */
    tryUse(taskKey: string): boolean;
    /** Whether this task still has continuation budget. */
    hasBudget(taskKey: string): boolean;
    reset(): void;
}
//# sourceMappingURL=continuation.d.ts.map