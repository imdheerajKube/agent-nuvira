/**
 * Harness-narration detection — did the model NARRATE the harness back at the
 * user instead of acting on it?
 *
 * WHY THIS EXISTS. Bundle 37b made every gate nudge a marked `[harness]`
 * `system` directive so the model would act on it rather than answer it. That
 * change is only worth having if it is VERIFIABLE on live traces: some turns
 * would still produce prose ABOUT the harness (`"the command guard misfired on a
 * read-only check, so verification was…"`) instead of quietly continuing.
 *
 * HOW IT DETECTS, WITHOUT A PHRASE LIST. It does not look for words like
 * "guard" or "misfire" — that would be a hand-written list of user phrasings,
 * which this codebase forbids. Instead it takes the harness's OWN text (the
 * refusals and gate summaries the trace recorded for that turn) and asks whether
 * the model's answer reuses a DISTINCTIVE token from it: a hyphenated compound
 * (`state-changing`, `read-only`) or a long word (≥10 chars). Those are the
 * tokens that carry the harness's specific vocabulary; a shared one means the
 * model is quoting the loop's language rather than talking about the task.
 *
 * The vocabulary is DERIVED at runtime from the harness's own strings, so it
 * tracks whatever the harness actually says — it can never drift from a list.
 *
 * It is a REPORTER, not a gate: it never changes what the turn does. It exists so
 * "the model stopped narrating the harness" is a measurement (see
 * `scripts/detect-harness-narration.mjs`).
 */

export interface NarrationVerdict {
  narrated: boolean;
  /** The distinctive tokens the answer shares with the harness text. */
  matches: string[];
}

/**
 * Tokens specific enough to signal the harness's vocabulary: hyphenated
 * compounds, or long words. Deliberately NOT common prose (which is why a short
 * word can never match).
 */
function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9-]+/)) {
    const t = raw.replace(/^-+|-+$/g, '');
    if (!t) continue;
    if (t.length >= 10 || (t.includes('-') && t.length >= 6)) out.add(t);
  }
  return out;
}

/** The pure check. `harnessTexts` are the harness's own strings for this turn. */
export function detectHarnessNarration(
  finalText: string,
  harnessTexts: Array<string | undefined | null>,
): NarrationVerdict {
  const said = distinctiveTokens(finalText);
  if (said.size === 0) return { narrated: false, matches: [] };
  const matches = new Set<string>();
  for (const h of harnessTexts) {
    if (!h) continue;
    for (const t of distinctiveTokens(h)) if (said.has(t)) matches.add(t);
  }
  return { narrated: matches.size > 0, matches: [...matches].sort() };
}
