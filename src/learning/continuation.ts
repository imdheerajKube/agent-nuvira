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

// ─── Constants / defaults ───────────────────────────────────────────────────

/** Default token budget for a continuation note (the partial-output relay). */
export const DEFAULT_CONTINUATION_MAX_TOKENS = 2048;

/** Chars-per-token heuristic — mirrors ContextPruner's estimate. */
export const CHARS_PER_TOKEN = 4.5;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContinuationOptions {
  /** Token budget for the full note (default 2048). */
  maxTokens?: number;
  /** Chars-per-token heuristic override. */
  charsPerToken?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Token estimate for a text (ContextPruner-compatible heuristic). */
export function estimateNoteTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Classify whether a failure is a PARTIAL (mid-stream) failure worth a
 * continuation. Definitive classes are excluded: auth (401/403), rate-limit
 * (429), model-not-found (404) — the response never started, the provider is
 * dead or the model is wrong, and a continuation would just burn a call.
 * Network drop, server 5xx, timeout/abort and parse errors after a stream
 * started ARE partial candidates.
 */
export function isPartialFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Definitive — never continue on these.
  if (
    /429|rate[ _-]?limit|quota|401|403|unauthor|forbidden|api[ _-]?key|404|invalid[ _-]?model|model[ _-]?not[ _-]?found|not[ _-]?found/.test(msg)
  ) {
    return false;
  }
  // Everything else (network / 5xx / timeout / abort / parse) is a candidate.
  return true;
}

/**
 * Trim a partial output to a char budget, keeping a head + the LONG tail (the
 * most recent tokens matter most for continuation) with a truncation marker.
 */
export function trimPartialOutput(partial: string, maxChars: number): string {
  if (partial.length <= maxChars) return partial;
  const head = partial.slice(0, Math.floor(maxChars * 0.3));
  const tail = partial.slice(-Math.floor(maxChars * 0.7));
  return `${head}\n…[${partial.length.toLocaleString()} chars truncated]…\n${tail}`;
}

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
export function buildContinuationNote(
  prompt: string,
  partialOutput: string,
  opts: ContinuationOptions = {},
): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_CONTINUATION_MAX_TOKENS;
  const charsPerToken = opts.charsPerToken ?? CHARS_PER_TOKEN;
  const maxChars = Math.floor(maxTokens * charsPerToken);

  // The prompt is authoritative — include it in full unless pathological
  // (>60% of the budget); the partial output is what gets bounded.
  const promptCap = Math.floor(maxChars * 0.6);
  const promptPart = prompt.length > promptCap
    ? `${prompt.slice(0, Math.floor(promptCap * 0.8))}\n…[prompt truncated]…`
    : prompt;
  const partialBudget = Math.max(0, maxChars - promptPart.length);
  const partial = trimPartialOutput(partialOutput, partialBudget);

  return [
    '── Previous attempt was interrupted mid-response ──',
    'The task below was being answered by another provider, but the response was cut off',
    'before it finished. Continue the answer from where the previous attempt stopped.',
    'Do NOT restart from scratch. Do NOT repeat the partial output. Do NOT re-explain',
    'what was already produced.',
    '',
    `## Original task`,
    promptPart,
    '',
    `## Partial output already produced`,
    partial || '(none — the failure happened before any output)',
    '',
    '## Continue from here',
  ].join('\n');
}

/**
 * M4.1 budget cap: at most `maxPerTask` continuations per task (default 1).
 * A task that already consumed its continuation budget fails forward instead
 * of continuing in a loop after a second mid-stream death.
 */
export class ContinuationBudget {
  /** taskKey → number of continuations already granted (per-task counter). */
  private used = new Map<string, number>();

  constructor(private readonly maxPerTask = 1) {}

  /**
   * Returns true when this task still has budget and grants it one more
   * continuation; false once the task has used its `maxPerTask` allowance
   * (a task that died mid-stream again is definitive, not unlucky).
   */
  tryUse(taskKey: string): boolean {
    const count = this.used.get(taskKey) ?? 0;
    if (count >= this.maxPerTask) return false;
    this.used.set(taskKey, count + 1);
    return true;
  }

  /** Whether this task still has continuation budget. */
  hasBudget(taskKey: string): boolean {
    return (this.used.get(taskKey) ?? 0) < this.maxPerTask;
  }

  reset(): void {
    this.used.clear();
  }
}
