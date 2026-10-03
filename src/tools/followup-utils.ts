/**
 * Followup hygiene + continuation helpers — a LEAF module on purpose.
 *
 * These helpers are needed by the LOW-LATENCY surfaces (gateway registry,
 * dashboard chat console, CLI chat) as well as the tool registry. Putting them
 * in `tools/registry.ts` dragged the entire 110-tool registry — and every
 * module it registers — into the gateway/dashboard import graph, which measurably
 * slowed those paths (the gateway e2e suite went from seconds to ~100s). This
 * module imports NOTHING, so any surface can use it for free.
 *
 * `tools/registry.ts` re-exports everything here, so existing importers keep
 * working unchanged.
 */

/** A follow-up recommendation. */
export interface FollowupSuggestion {
  /** The full prompt sent as the next user message when clicked. */
  prompt: string;
  /** Optional short display label (defaults to the prompt). */
  label?: string;
}

/** How many followups any surface renders (the contract aims for 3). */
export const MAX_FOLLOWUPS = 3;
/** Cap on a followup prompt length (chars) — keeps chips / WhatsApp lines readable. */
export const MAX_FOLLOWUP_PROMPT_CHARS = 300;
/** Cap on a followup label length (chars). */
export const MAX_FOLLOWUP_LABEL_CHARS = 60;

/** Collapse whitespace/newlines and trim — followups render on one line. */
function tidyFollowupText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Strip one layer of wrapping quotes/backticks and a leading bullet/number. */
function stripFollowupDecoration(text: string): string {
  let out = text.trim();
  out = out.replace(/^(?:[-*•]|\d+[.)])\s+/, ''); // "- ", "1. ", "1) "
  out = out.replace(/^[`"'“”]+/, '').replace(/[`"'“”]+$/, '');
  return out.trim();
}

/**
 * Whether a followup string is leaked tool-call scaffolding rather than a real
 * suggestion (a raw `{"tool":"suggest_followups",...}` block, or a stray
 * `<function=…>` tag). Such entries were the cause of raw JSON chips/lines, so
 * they are dropped instead of rendered.
 */
function looksLikeToolScaffolding(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (/"tool"\s*:/.test(t)) return true;
  if (/<function\s*=/.test(t)) return true;
  if (/<\/?think>/.test(t)) return true;
  return false;
}

/** Truncate at a word boundary (never mid-word when avoidable). */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/**
 * Clean + structure followups before ANY surface renders them. Deterministic
 * (no LLM): the model's raw suggestions are trimmed, decoration stripped,
 * leaked tool JSON dropped, the previous question excluded, duplicates
 * removed, and prompt/label lengths capped — so every surface (CLI menu,
 * dashboard chips, gateway "Try next" list) shows the same clean 1–3 items.
 *
 * Returns [] when nothing survives (callers fall back to their own defaults).
 */
export function normalizeFollowups(
  raw: readonly FollowupSuggestion[] | undefined | null,
  opts?: { question?: string; limit?: number },
): FollowupSuggestion[] {
  if (!raw || raw.length === 0) return [];
  const limit = Math.max(1, opts?.limit ?? MAX_FOLLOWUPS);
  const asked = opts?.question ? tidyFollowupText(opts.question).toLowerCase() : '';
  const seen = new Set<string>();
  const out: FollowupSuggestion[] = [];

  for (const item of raw) {
    if (!item || typeof item.prompt !== 'string') continue;
    let prompt = tidyFollowupText(stripFollowupDecoration(item.prompt));
    if (!prompt || looksLikeToolScaffolding(prompt)) continue;
    const key = prompt.toLowerCase();
    if (asked && key === asked) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    prompt = truncateAtWord(prompt, MAX_FOLLOWUP_PROMPT_CHARS);

    // Only keep a DISTINCT label — a label equal to the prompt is noise (every
    // surface already falls back to the prompt), and inventing one would
    // change the shape callers/tests rely on.
    const rawLabel = typeof item.label === 'string' ? tidyFollowupText(stripFollowupDecoration(item.label)) : '';
    const label = rawLabel && !looksLikeToolScaffolding(rawLabel) && rawLabel.toLowerCase() !== key
      ? truncateAtWord(rawLabel, MAX_FOLLOWUP_LABEL_CHARS)
      : undefined;

    out.push(label ? { prompt, label } : { prompt });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A4 — the CONTINUATION affordance.
 *
 * WHY THIS EXISTS: A1/A3 make a run RECORD honestly that it did not conclude
 * (`outcome.kind === 'incomplete'` / `cancelled`). That record is only useful if
 * the user can ACT on it. Live, an interrupted or cancelled turn ended with
 * nothing to click — the work simply stopped, and the only way back in was to
 * re-type the whole ask (which restarted it). These two chips are the path back:
 *
 *   ▶ Continue where it stopped  — resume the unfinished work, not a restart
 *   🔁 Retry this step           — re-attempt the step that failed
 *
 * Both are ordinary followups (they become the next message when clicked), so
 * they ride the existing continuation-marker machinery and no new UI is needed.
 */
export interface ContinuationInput {
  /** The run did not conclude (outcome `incomplete` or `cancelled`). */
  unfinished?: boolean;
  /** At least one tool ran — so there is a step to retry. */
  hadTools?: boolean;
}

/** The prompt behind the "Continue" chip — resumption, explicitly not a restart. */
export const CONTINUE_PROMPT =
  'Continue where the previous turn stopped. Do NOT restart the work that is already done — ' +
  're-read the current state of the files/artifacts first, then finish the remaining steps.';

/** The prompt behind the "Retry" chip. */
export const RETRY_PROMPT =
  'Retry the step that did not complete in the previous turn. Keep the same goal, but change ' +
  'the approach to fix the failure that stopped it.';

/** Is this followup already a continuation/retry affordance? */
function looksLikeContinuation(f: FollowupSuggestion): boolean {
  const text = `${f.label ?? ''} ${f.prompt}`.toLowerCase();
  return /\bcontinue\b|\bretry\b|\bresume\b|where (?:it|you|we) (?:stopped|left off)\b/.test(text);
}

/**
 * Ensure an unfinished run offers a way to continue or retry.
 *
 * Returns the model's followups UNCHANGED for a concluded run (so nothing is
 * added to a turn that finished — the affordance must mean something). For an
 * unfinished run it prepends "Continue" and, when a tool actually ran, appends
 * "Retry", keeping the model's own suggestions in between, and respecting the
 * same MAX_FOLLOWUPS cap every surface already applies.
 */
export function withContinuationFollowups(
  followups: readonly FollowupSuggestion[] | undefined | null,
  input: ContinuationInput,
): FollowupSuggestion[] {
  const base = [...(followups ?? [])];
  if (!input.unfinished) return base;
  if (base.some(looksLikeContinuation)) return base;

  const continuation: FollowupSuggestion[] = [
    { label: '▶ Continue where it stopped', prompt: CONTINUE_PROMPT },
  ];
  if (input.hadTools) {
    continuation.push({ label: '🔁 Retry this step', prompt: RETRY_PROMPT });
  }
  // The affordance outranks the model's suggestions for the one remaining slot.
  const room = Math.max(0, MAX_FOLLOWUPS - continuation.length);
  return [...continuation, ...base.slice(0, room)];
}

/**
 * The machine-readable continuation marker prepended to a message the user
 * produced by CLICKING a previously suggested followup. Without it a clicked
 * followup arrives as an unrelated one-liner ("add a day in Hanoi") and the
 * model can treat it as a brand-new request; with it the previous turn's
 * context, decisions and results are explicitly in scope.
 */
export const FOLLOWUP_CONTINUATION_MARKER =
  '[CONTINUATION — this message is a follow-up to your IMMEDIATELY PRECEDING answer in this same conversation. ' +
  'Reuse the context, decisions, and results from that turn (and any earlier turns). ' +
  'Resolve pronouns like "it", "that", "the plan", or "the same" against that prior answer. ' +
  'Do NOT treat this as a new, standalone request.]';

/**
 * Build the message actually sent when a suggested followup is chosen: the
 * continuation marker + the followup prompt. Idempotent — a message that
 * already carries the marker is returned unchanged.
 */
export function buildFollowupContinuationPrompt(prompt: string): string {
  const body = (prompt ?? '').toString().trim();
  if (!body) return body;
  if (body.startsWith(FOLLOWUP_CONTINUATION_MARKER)) return body;
  return `${FOLLOWUP_CONTINUATION_MARKER}\n\n${body}`;
}

/** Whether a message is (or already carries) a marked continuation. */
export function isFollowupContinuation(prompt: string): boolean {
  return (prompt ?? '').includes(FOLLOWUP_CONTINUATION_MARKER);
}

/** Normalized comparison key for a followup prompt. */
function followupKey(text: string): string {
  return tidyFollowupText(text).toLowerCase().replace(/[.!?…]+$/, '');
}

/**
 * Whether an incoming user message is one of the followups the agent just
 * suggested (optionally from a caller-held list, e.g. a dashboard session or a
 * gateway contact). Used by the surfaces that cannot annotate at click time
 * (dashboard chips, WhatsApp replies) to recognise a followup and wrap it with
 * the continuation marker.
 */
export function isSuggestedFollowup(
  prompt: string,
  suggestions?: readonly FollowupSuggestion[] | undefined | null,
): boolean {
  const body = prompt ?? '';
  if (!body.trim() || isFollowupContinuation(body)) return false;
  const key = followupKey(body);
  if (!key) return false;
  for (const s of suggestions ?? []) {
    if (!s || typeof s.prompt !== 'string') continue;
    const candidate = followupKey(s.prompt);
    if (candidate && (candidate === key || key.startsWith(candidate) || candidate.startsWith(key))) {
      return true;
    }
  }
  return false;
}
