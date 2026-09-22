/**
 * Provider output-cap learning (enterprise-grade hardening, G15).
 *
 * WHY THIS EXISTS. A live unattended story run (12 pages, no human input)
 * failed EVERY prose unit with the same provider rejection:
 *
 *   Groq API error (400): {"error":{"message":"`max_tokens` must be less than
 *   or equal to `512`, the maximum value for `max_tokens` is less than the
 *   `context_window` for this model","param":"max_tokens"}}
 *
 * The cause was OUR constant, not the model pool: the prose path asks for
 * `maxTokens: 8192` (~900 words with headroom) because a chapter needs it, and
 * the routed model happened to permit only 512. So:
 *
 *   - the agent looked broken ("Repair budget exhausted") when it was misconfigured;
 *   - `resolveMaxOutputTokens()` could not have prevented it — that heuristic
 *     reads the CONTEXT WINDOW, and this model advertises a large window with a
 *     tiny output cap, which is exactly the case the window heuristic cannot see;
 *   - the failure repeated 6 batches in a row, because nothing learned from it.
 *
 * Two disciplines come out of that, and this module is both:
 *
 * 1. `parseMaxTokensLimit()` — a provider that TELLS us its limit has told us
 *    the truth. Read it from the error instead of discarding it, so the retry
 *    is targeted at a number the provider itself named.
 *
 * 2. `rememberMaxTokensLimit()` / `clampMaxTokens()` — the learned limit is
 *    remembered per provider × model and applied PREDICTIVELY to later calls,
 *    so one rejection costs one wasted call per process instead of one per
 *    unit. Only ever clamps DOWN: a provider that accepts our request is
 *    never overruled by a stale or mis-parsed limit.
 *
 * Deliberately pure + process-local (no config writes): a provider contract is
 * a runtime fact, and persisting a mis-parse would poison future sessions.
 */

/**
 * camelCase → snake_case, lowercased, so one set of patterns covers
 * `max_tokens`, `maxCompletionTokens` and `maxOutputTokens` alike. Without
 * this, `maxOutputTokens must be <= 2048` (Gemini) reads as an unrelated
 * error and the agent would keep failing the same way.
 */
function normalize(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Guard: only text that talks about output caps can yield a limit. */
const MENTIONS_MAX_TOKENS = /max[_\s-]?(?:output[_\s-]|completion[_\s-])?tokens?/;

/** A max-output field name followed, within a short distance, by a number. */
const CAP_FIELD = 'max[_\\s-]?(?:output[_\\s-]|completion[_\\s-])?tokens?';

/**
 * Phrasings observed across OpenAI-compatible providers (Groq, Together,
 * Mistral, OpenRouter...), Anthropic and Gemini. Every pattern captures the
 * named limit in group 1; the caller takes the SMALLEST of all matches.
 */
const LIMIT_PATTERNS: RegExp[] = [
  // "max_tokens must be <= 512" / "must be less than or equal to 512"
  new RegExp(
    `${CAP_FIELD}[\\s"'\`]*(?:must be )?(?:less than or equal to|no more than|at most|not exceed|<=?)\\s*["'\`]*(\\d+)`,
  ),
  // "max_tokens: 8192 > 4096, which is the maximum allowed number of output tokens"
  new RegExp(
    `${CAP_FIELD}[\\s"'\`]*[:=]?\\s*(\\d+)[\\s\\S]{0,160}?maximum allowed number of output tokens`,
  ),
  // "...which is the maximum allowed number of output tokens for <model>"
  /(\d+)[\s,)\]]*(?:which is |is )?the maximum allowed number of output tokens/i,
  // "maximum value for max_tokens is 512"
  new RegExp(`maximum(?: allowed)?(?: value)?(?: for| of)?[\\s"'\`]*${CAP_FIELD}[^\\d]{0,60}?(\\d+)`),
];

/**
 * The smallest number any recognised phrasing names, or `null` when the error
 * is not an output-cap rejection. Returning the SMALLEST is the safe read when
 * a message contains several numbers: a retry that is too small still
 * succeeds (shorter output), a retry that is too large fails again and wastes
 * another call — and the whole point of this path is to stop wasting calls.
 */
export function parseMaxTokensLimit(error: unknown): number | null {
  const text = normalize(errorText(error));
  if (!text || !MENTIONS_MAX_TOKENS.test(text)) return null;

  const found: number[] = [];
  for (const pattern of LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > 0) found.push(value);
  }
  if (found.length === 0) return null;
  return Math.min(...found);
}

/** Error → searchable text, digging into `cause` and attached bodies. */
function errorText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const withMessage = error as { message?: unknown; cause?: unknown; response?: unknown };
    const parts: string[] = [];
    if (typeof withMessage.message === 'string') parts.push(withMessage.message);
    // Provider bodies are frequently nested under `cause`/`response.data`.
    const cause = withMessage.cause;
    if (cause && cause !== error) parts.push(errorText(cause));
    const response = withMessage.response as { data?: unknown } | undefined;
    if (response?.data !== undefined) {
      try {
        parts.push(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
      } catch {
        /* best-effort */
      }
    }
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(error);
    } catch {
      return '';
    }
  }
  return String(error);
}

// ── Learned limits ──────────────────────────────────────────────────────────

/** provider × model → the cap the provider itself named. Process-local. */
const learnedLimits = new Map<string, number>();

function limitKey(provider: string | undefined, model: string | undefined): string | null {
  const p = (provider || '').trim().toLowerCase();
  const m = (model || '').trim().toLowerCase();
  if (!p || !m) return null;
  return `${p}::${m}`;
}

/**
 * Record a provider-named output cap. Ignored when the key is incomplete
 * (a bare provider or model is too coarse to clamp against) or the value is
 * not a positive integer. Also clamps against any already-learned value so a
 * later, larger claim cannot raise the cap back up.
 */
export function rememberMaxTokensLimit(
  provider: string | undefined,
  model: string | undefined,
  limit: number,
): void {
  const key = limitKey(provider, model);
  if (!key) return;
  if (!Number.isFinite(limit) || limit <= 0) return;
  const existing = learnedLimits.get(key);
  const next = existing === undefined ? limit : Math.min(existing, limit);
  learnedLimits.set(key, Math.floor(next));
}

/** The learned cap for provider × model, or `undefined` when none is known. */
export function knownMaxTokensLimit(
  provider: string | undefined,
  model: string | undefined,
): number | undefined {
  const key = limitKey(provider, model);
  if (!key) return undefined;
  return learnedLimits.get(key);
}

/**
 * Apply the learned cap to a requested value. Only ever lowers: an unlearned
 * pair and an already-small request both pass through unchanged, so a caller
 * that deliberately asks for less keeps its value.
 */
export function clampMaxTokens(
  requested: number | undefined,
  provider: string | undefined,
  model: string | undefined,
): number | undefined {
  const limit = knownMaxTokensLimit(provider, model);
  if (limit === undefined) return requested;
  if (requested === undefined) return limit;
  return Math.min(requested, limit);
}

/**
 * Read a cap out of an error and remember it. Returns the parsed limit (so the
 * caller can retry with it) or `null` when the error was not a cap rejection.
 */
export function learnMaxTokensLimitFromError(
  error: unknown,
  provider: string | undefined,
  model: string | undefined,
): number | null {
  const limit = parseMaxTokensLimit(error);
  if (limit === null) return null;
  rememberMaxTokensLimit(provider, model, limit);
  return limit;
}

/** Test hook — clears the process-local table. */
export function resetLearnedMaxTokensLimits(): void {
  learnedLimits.clear();
}
