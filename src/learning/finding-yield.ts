/**
 * Finding YIELD — the budget signal for a project assessment.
 *
 * WHY THIS EXISTS (measured). An audit turn is bounded by STEPS, and the step
 * bound is blind to the only thing an audit actually produces: findings. Two
 * runs of the same audit ask on the same repository stopped after exactly the
 * same number of steps — 81 — one of them having written 20 substantiated
 * defects and the other 11, and a third (a much larger tree) never reaching the
 * modules at the bottom of the tree at all. The budget was the same for a
 * 4,700-line project and a 34,000-line one, because nothing in the loop looked
 * at what the work had PRODUCED.
 *
 * The rule this module serves: extend an assessment's budget when the last
 * round ADDED a finding, stop it when a whole round added none. That is the
 * self-limiting shape the user asked for — a small project finishes in one or
 * two rounds because the second round has nothing new to say, while a large
 * project keeps earning steps for as long as it is finding real defects.
 *
 * Two ideas, both deterministic (no model call, no heuristics about prose):
 *
 * 1. A FINDING has a SHAPE: an id (`BUG-01`, `Finding 3`, `Issue #12`) followed
 *    by a severity, or a severity in the first words of a bolded bullet. That is
 *    the format every audit report in this repo already uses. Prose that merely
 *    mentions "critical" is not a finding, which is what keeps the count from
 *    inflating as the report grows.
 * 2. A finding's IDENTITY is its TITLE, normalised. `BUG-05 - MEDIUM - two
 *    wx.App objects per process` and `### BUG 5 (Medium): two wx.App objects
 *    per process` are one finding, so an id renumbering does not look like new
 *    work. A genuinely new defect gets a new title, which is exactly the signal
 *    the budget wants.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** How many findings one report currently substantiates. */
export interface FindingYield {
  /** Distinct findings across every readable source. */
  total: number;
  /** Normalised titles not present in `seen` — the NEW ones. */
  fresh: string[];
  /**
   * True when at least one REPORT FILE on disk was readable. Before that, the
   * findings (if any) came from the model's own answer text, and "no report
   * yet" means the turn is still building rather than out of material.
   */
  reportRead: boolean;
}

/** The severities a report may label a finding with. */
const SEVERITY = '(?:CRITICAL|BLOCKER|HIGH|MEDIUM|MODERATE|LOW|INFO(?:RMATIONAL)?)';

/**
 * An `id`-prefixed finding line: `BUG-01 - CRITICAL - title`, `Finding 3:
 * (High) title`, `Issue #12 — low — title`. The id may be attached
 * (`BUG01`) or spaced (`BUG 01`).
 */
const ID_FINDING_LINE = new RegExp(
  `^\\s*\\**\\s*(?:BUG|FINDING|ISSUE|DEFECT|VULN(?:ERABILITY)?)[-\\s]*(?:#|no\\.?)?\\s*[\\w.]{0,8}\\s*[-—:.)\\]]*\\s*\\(?\\[?\\**\\s*(${SEVERITY})\\b`,
  'i',
);

/** A severity-led finding line: `- **[Critical]** title`, `### High — title`. */
const SEVERITY_FINDING_LINE = new RegExp(
  `^\\s*\\**\\s*\\(?\\[?\\**\\s*(${SEVERITY})\\b`,
  'i',
);

/**
 * Strip one leading block marker: an ATX heading (`### `), a bullet, or an
 * ordered-list number. Applied BEFORE the finding patterns so a heading and a
 * bullet are read by exactly one rule.
 */
const BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;

/** The id a finding line starts with, stripped before the title is taken. */
const ID_PREFIX = /^\s*\**\s*(?:BUG|FINDING|ISSUE|DEFECT|VULN(?:ERABILITY)?)[-\s]*(?:#|no\.?)?\s*[\w.]{0,8}\s*[-—:.)\]]*\s*/i;

/** Strip an id + severity off a finding line, leaving the title. */
function titleOf(line: string): string {
  let rest = line.replace(ID_PREFIX, '');
  // Markdown emphasis and the brackets a severity may be wrapped in.
  rest = rest.replace(/^[\s*_`([\]]+/, '');
  rest = rest.replace(new RegExp(`^${SEVERITY}\\b[\\s*_\\]):.—-]*`, 'i'), '');
  return rest;
}

/** Collapse a title to a comparable identity (markdown, punctuation, spacing). */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * The identities of every finding in `text`.
 *
 * Only lines at the START of a block (heading, bullet, or a plain line that
 * begins with an id/severity) are candidates, so a finding quoted inside a
 * paragraph of prose — "this is the most damaging defect, see BUG-02" — does
 * not count twice.
 */
export function findingTitles(text: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.replace(BLOCK_MARKER, '');
    const match = ID_FINDING_LINE.exec(line) ?? SEVERITY_FINDING_LINE.exec(line);
    if (!match) continue;
    const title = normalizeFindingTitle(titleOf(line));
    // A bare "Critical" with no title after it (a legend line) is not a
    // finding: it names a severity, not a defect.
    if (!title || title === normalizeFindingTitle(match[1] ?? '')) continue;
    if (seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

/** How many distinct findings `text` substantiates. */
export function countFindings(text: string): number {
  return findingTitles(text).length;
}

/**
 * Read the findings an assessment has on record right now.
 *
 * The REPORT FILE wins when one is readable: it is the deliverable, it is what
 * the user will read, and it does not change when the model re-words its chat
 * summary. The model's own text is the fallback for the interval before the
 * report exists — which is also how "no report yet" stays distinguishable from
 * "a report that found nothing".
 */
export function readFindingYield(opts: {
  content?: string;
  reportPaths?: readonly string[];
  root: string;
  seen: ReadonlySet<string>;
}): FindingYield {
  const titles: string[] = [];
  const collected = new Set<string>();
  let reportRead = false;
  for (const candidate of opts.reportPaths ?? []) {
    const absolute = resolve(opts.root, candidate);
    let text: string;
    try {
      const stat = statSync(absolute);
      // A 0-byte report is not a source of findings; a report too large to be
      // one document is not read either (the loop only needs the shape).
      if (!stat.isFile() || stat.size === 0 || stat.size > 4_000_000) continue;
      text = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    reportRead = true;
    for (const title of findingTitles(text)) {
      if (collected.has(title)) continue;
      collected.add(title);
      titles.push(title);
    }
  }
  if (!reportRead) {
    for (const title of findingTitles(opts.content ?? '')) {
      if (collected.has(title)) continue;
      collected.add(title);
      titles.push(title);
    }
  }
  return {
    total: titles.length,
    fresh: titles.filter((title) => !opts.seen.has(title)),
    reportRead,
  };
}

/**
 * How many progress-gated extensions an assessment earns, by the size of the
 * tree it is reading.
 *
 * The numbers come from the two runs that motivated this: the 4,700-line app was
 * finished (all 12 report sections, every module read) inside two rounds, while
 * the larger trees are where findings were still arriving when the blind budget
 * ran out. Deliberately modest at the small end — a small project that has gone
 * a round without a new finding must not be handed more steps — and finite at
 * the large end, because "keep reading" still has to end.
 */
export const ASSESSMENT_EXTENSION_CAP = {
  small: 2,
  medium: 6,
  large: 12,
} as const;

export type AssessmentSize = keyof typeof ASSESSMENT_EXTENSION_CAP;

/** The extension cap for a source-file count. */
export function assessmentExtensionCap(sourceFiles: number): number {
  if (sourceFiles <= 40) return ASSESSMENT_EXTENSION_CAP.small;
  if (sourceFiles <= 250) return ASSESSMENT_EXTENSION_CAP.medium;
  return ASSESSMENT_EXTENSION_CAP.large;
}

/** Directories that are never the audited project's own surface. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.svelte-kit',
  'coverage',
]);

const SOURCE_EXT = /\.(?:py|pyw|ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|cxx|hpp|cs|swift|m|mm|scala|ex|exs|erl|hs|clj|dart|lua|sh|bash|zsh|ps1|vue|svelte|astro)$/i;

/**
 * Count the project's own source files, bounded.
 *
 * Only used to pick an extension cap, so a cheap walk is enough: depth 8, at
 * most 5 000 files, no dependency/build directories, symlinks never followed
 * (a link loop must not hang a budget decision).
 */
export function countSourceFiles(root: string, maxFiles = 5_000): number {
  let count = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && count < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (count >= maxFiles) break;
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < 8) stack.push({ dir: path, depth: depth + 1 });
        continue;
      }
      if (stat.isFile() && SOURCE_EXT.test(name)) count += 1;
    }
  }
  return count;
}
