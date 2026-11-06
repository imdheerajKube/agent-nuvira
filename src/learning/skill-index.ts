/**
 * P2 — The skill index (`src/learning/skill-index.ts`).
 *
 * The routing problem this module exists for, measured on this repo's own
 * bundled catalog:
 *
 *   156 skills · median description 194 chars · max 819
 *   132 / 156 are over the 140-char catalog cap
 *   of those, 55 lose their "use when…" clause entirely
 *   `tool_search` keeps only the FIRST sentence, which drops the trigger for
 *   e.g. `design-system` — so the best match for "build a design system"
 *   arrives without the sentence that says it is for building design systems.
 *
 * A description is written for a human reading a marketplace card; an INDEX
 * line is read by a model deciding whether this turn is in scope. This module
 * derives the second from the first, deterministically and without touching
 * the authored text:
 *
 *   - {@link triggerLine} pulls the clause that states WHEN the skill applies,
 *     and falls back to the leading sentence when the author wrote none.
 *   - {@link buildSkillIndex} renders a bounded index: full trigger lines while
 *     the budget lasts, then name-only lines, so NO skill is ever dropped from
 *     the model's view (being invisible is the failure this design prevents).
 *   - {@link lintSkillDescription} reports bad descriptions at install time.
 *     It never rewrites one: the description is the author's signal.
 *
 * Pure functions, no I/O — fixture-testable and usable from the CLI, the
 * installer, the dashboard and the capability search.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** One skill as the index sees it. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

export type SkillDescriptionIssue =
  | 'missing'
  | 'too-short'
  | 'too-long'
  | 'no-trigger'
  | 'generic-open';

export interface SkillDescriptionLint {
  ok: boolean;
  issues: SkillDescriptionIssue[];
  /** The derived index line (what the model would actually read). */
  trigger: string;
}

export interface SkillIndexOptions {
  /**
   * Chars per trigger line — a CEILING, not a fixed width. Default 90.
   * The renderer shrinks it so every skill keeps a trigger line inside the
   * budget (see {@link buildSkillIndex}).
   */
  lineChars?: number;
  /**
   * Total budget for the whole index. Default 12000 chars (~3K tokens).
   *
   * Why 12K and not the 6K this plan first proposed: measured against the real
   * catalog, 156 skills × (name + a 90-char trigger) is ~18K, and even at a
   * 40-char cap it is ~11K. A 6K budget would force ~100 skills to name-only
   * lines, which trades away exactly the signal the index exists to carry.
   * 12K is still under half of the 24.4K full catalog, and it buys a trigger
   * for every skill. The renderer degrades gracefully past ~250 skills.
   */
  budgetChars?: number;
  /** Index heading (default '## Skills'). */
  heading?: string;
}

export interface SkillIndex {
  /** The rendered block (empty string when there are no entries). */
  text: string;
  /** Entries rendered with a trigger line. */
  withTrigger: number;
  /** Entries rendered name-only because the budget ran out. */
  nameOnly: number;
  /** Total characters of `text`. */
  chars: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Clause markers that mean "this is the activation condition". */
const TRIGGER_RE =
  /\b(use (?:this |it )?when|use (?:this )?for|use it for|when the (?:task|user|goal|request|ask)|when asked|when you (?:need|want)|use if|appropriate when|good for)\b/i;

/** An opening that describes the skill instead of when to reach for it. */
const GENERIC_OPEN_RE = /^(?:build|create|make|generate|write|a |an |this skill|provides?|helps?|enables?)\b/i;

const DEFAULT_LINE_CHARS = 90;
const DEFAULT_BUDGET_CHARS = 12_000;

/** Below this, a trigger line carries no more signal than the name alone. */
const MIN_TRIGGER_CHARS = 24;

// ─── Text helpers ───────────────────────────────────────────────────────────

function normalize(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Split a description into sentence-ish clauses. We cut on sentence ends and
 * semicolons rather than parsing markdown: descriptions in the wild are prose,
 * bullets or a single run-on line, and a clause is the right granularity for
 * both cases.
 */
function clauses(text: string): string[] {
  return normalize(text)
    .split(/(?<=[.!?])\s+|\s*;\s*|\s+\|\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Cut on a word boundary and append an ellipsis when the text did not fit. */
export function capWords(text: string, maxChars: number): string {
  const t = normalize(text);
  if (maxChars <= 0) return '';
  if (t.length <= maxChars) return t;
  const hard = t.slice(0, maxChars - 1);
  const cut = hard.lastIndexOf(' ');
  const body = (cut > maxChars * 0.5 ? hard.slice(0, cut) : hard).replace(/[\s,;:.]+$/, '');
  return `${body}…`;
}

/**
 * The activation clause of a description — what the model needs to decide
 * "is this turn about that?".
 *
 * Preference order:
 *   1. the clause containing a trigger marker ("Use when…", "When the user…")
 *   2. the first clause (authors who lead with the trigger)
 *
 * The chosen clause is capped on a word boundary. Returns '' for an empty
 * description.
 */
export function triggerLine(description: string, maxChars = DEFAULT_LINE_CHARS): string {
  const parts = clauses(description);
  if (parts.length === 0) return '';
  const hit = parts.find((c) => TRIGGER_RE.test(c));
  const chosen = hit ?? parts[0];
  // Strip a leading list marker some descriptions carry ("- Use when …").
  return capWords(chosen.replace(/^[-*•]\s*/, ''), maxChars);
}

/**
 * Lint a description as an INDEX entry.
 *
 * Rules (deliberately few — each one corresponds to an observed routing miss):
 *   - missing        → the skill is unindexable; install should warn loudly
 *   - too-short      → nothing to match on (< 40 chars)
 *   - too-long       → truncated in every bounded surface (> 200 chars)
 *   - no-trigger     → never says WHEN; the model has to infer the domain
 *   - generic-open   → opens with "Build/Create/A …" and has no trigger clause
 */
export function lintSkillDescription(description: string): SkillDescriptionLint {
  const text = normalize(description);
  const issues: SkillDescriptionIssue[] = [];
  if (!text) {
    return { ok: false, issues: ['missing'], trigger: '' };
  }
  if (text.length < 40) issues.push('too-short');
  if (text.length > 200) issues.push('too-long');
  const hasTrigger = clauses(text).some((c) => TRIGGER_RE.test(c));
  if (!hasTrigger) {
    issues.push('no-trigger');
    if (GENERIC_OPEN_RE.test(text)) issues.push('generic-open');
  }
  return {
    ok: issues.length === 0,
    issues,
    trigger: triggerLine(text),
  };
}

/** A short human explanation for a lint issue (CLI + dashboard). */
export function describeLintIssue(issue: SkillDescriptionIssue): string {
  switch (issue) {
    case 'missing':
      return 'no description — the skill cannot be matched or searched';
    case 'too-short':
      return 'description under 40 chars — too little to match on';
    case 'too-long':
      return 'description over 200 chars — it is truncated in every bounded surface';
    case 'no-trigger':
      return 'never states WHEN to use it (no "Use when…" clause) — add one so routing can fire';
    case 'generic-open':
      return 'opens with a generic verb and has no trigger clause — lead with the situation';
  }
}

// ─── Index rendering ────────────────────────────────────────────────────────

/**
 * Render the bounded, always-on skill index.
 *
 * Every entry is present. The per-line cap is ADAPTIVE: the renderer sizes the
 * trigger width from the budget and the number of skills, so a growing catalog
 * shortens every line evenly instead of giving the first alphabetic 50 a
 * trigger and starving the rest. Below {@link MIN_TRIGGER_CHARS} it falls back
 * to name-only lines — the skill stays visible either way.
 */
export function buildSkillIndex(entries: SkillIndexEntry[], opts: SkillIndexOptions = {}): SkillIndex {
  const maxLineChars = opts.lineChars ?? DEFAULT_LINE_CHARS;
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const heading = opts.heading ?? '## Skills';
  if (entries.length === 0) {
    return { text: '', withTrigger: 0, nameOnly: 0, chars: 0 };
  }

  // Each line costs: "  - " (4) + name + ": " (2) + trigger + newline (1).
  const overhead = heading.length + entries.reduce((sum, e) => sum + e.name.length + 7, 0);
  const available = budget - overhead;
  const perLine = Math.min(maxLineChars, Math.floor(available / entries.length));
  const triggerChars = perLine >= MIN_TRIGGER_CHARS ? perLine : 0;

  const lines: string[] = [heading];
  let withTrigger = 0;
  let nameOnly = 0;

  for (const entry of entries) {
    const trigger = triggerChars > 0 && entry.description ? triggerLine(entry.description, triggerChars) : '';
    if (trigger) {
      lines.push(`  - ${entry.name}: ${trigger}`);
      withTrigger += 1;
    } else {
      lines.push(`  - ${entry.name}`);
      nameOnly += 1;
    }
  }

  const text = lines.join('\n');
  return { text, withTrigger, nameOnly, chars: text.length };
}
