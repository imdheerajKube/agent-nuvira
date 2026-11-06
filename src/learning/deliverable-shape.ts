/**
 * DELIVERABLE SHAPE — the report a request enumerated, checked against the file.
 *
 * WHY THIS EXISTS (measured 2026-11-05, head-to-head audit of a 46k-line Python
 * repository). The ask named one file and five sections it "must cover", plus a
 * `Limitations` heading and the rule "every claim carries `path:line`". Both agents
 * wrote the file, so the existing gate — which checks that a named deliverable
 * EXISTS — was satisfied. The nuvira arm's report then scored 2/6 sections, 0
 * `path:line` citations and no Limitations heading, and its own `finish` was accepted
 * with "0/3 requirement(s) satisfied" because every enumerated section had been
 * classified as a `behaviour` row, which the ledger can never enforce.
 *
 * That is the hole this closes: when an ask ENUMERATES the parts of a written
 * deliverable, "the file is on disk" is not the requirement — the parts are. The
 * check is deterministic: headings, a citation pattern, and a Limitations heading.
 * It says nothing about whether the prose is good; a heading is not an argument.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never invents a section: with fewer than
 * three enumerated items there is no shape to check and it returns `undefined`.
 * It never reads a file that is absent (the named-deliverable gate owns that), and
 * it never fires on a question, because a question has no deliverable to shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DeliverableShape {
  /** The file that was checked, relative to the workspace. */
  path: string;
  /** The section labels the ask enumerated, normalised to lowercase. */
  requiredSections: string[];
  /** Enumerated sections with no matching heading in the file. */
  missingSections: string[];
  /** `path:line` citations found in the file. */
  citations: number;
  /** The ask required a `Limitations` heading and the file has none. */
  missingLimitations: boolean;
  /** Defect findings (### blocks under Defects) with no `path:line` of their own. */
  uncitedFindings: string[];
}

/** A numbered or bulleted item — the shape an enumerated deliverable takes. */
const ITEM = /^\s*(?:\d+[.)]|[-*])\s+(.+)$/;

/**
 * The line that turns the items below it into the deliverable's required parts.
 * Deliberately narrow: "Requirements:" in a build ask is a feature list, not a
 * report outline, but it is still a list the turn owes, so both are accepted.
 */
const LEAD =
  /(?:must\s+cover|should\s+cover|what\s+to\s+produce|deliverables?|sections?|outline|report\s+must|requirements?)\s*:\s*$/i;

/** A heading line, lowercased, for label matching. */
const HEADING = /^#{1,6}\s+/;

/** `path/to/file.py:123`, in any language the agent is pointed at. */
const CITATION =
  /\b[\w./-]+\.(?:py|pyw|md|json|toml|cfg|ini|txt|ya?ml|js|mjs|cjs|ts|tsx|jsx|sql|rb|go|rs|java|kt|cs|php|sh):\d+/g;

/**
 * The section labels an ask enumerates, and whether it demands a Limitations
 * heading.
 *
 * A label is the bold lead of the item (`**Architecture.** How …`) or its first
 * clause, so "Documentation drift." and "**Defects.** Real defects …" both become
 * the word a heading would carry.
 */
export function requiredSectionsFromAsk(ask: string): { sections: string[]; limitations: boolean } {
  const lines = (ask || '').split(/\r?\n/);
  const sections: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // An ask puts a blank line between "It must cover:" and item 1. That blank
      // line must not cancel the list before the first item arrives — the measured
      // 2026-11-05 ask is written exactly that way.
      if (inList && sections.length === 0) continue;
      if (inList && sections.length > 0) break;
      inList = false;
      continue;
    }
    if (LEAD.test(trimmed)) {
      inList = true;
      continue;
    }
    const item = line.match(ITEM);
    if (inList && item) {
      const label = cleanLabel(item[1]);
      if (label) sections.push(label);
      continue;
    }
    // An item that wrapped onto the next line (the 2026-11-05 ask writes every
    // section that way) is a continuation, not the end of the list.
    if (inList && /^\s+\S/.test(line)) continue;
    if (inList && sections.length > 0) break;
  }
  const limitations =
    /\blimitations?\b/i.test(ask) && /\bheading\b/i.test(ask);
  return { sections: dedupe(sections).slice(0, 8), limitations };
}

function cleanLabel(raw: string): string {
  const bold = raw.match(/^\*\*(.+?)\*\*/);
  const text = (bold?.[1] ?? raw).replace(/[*_`]/g, '').trim();
  // Keep the noun phrase before the sentence's first separator: "Architecture. How
  // the app works end to end" must be checked as "architecture", not as a sentence.
  const head = text.split(/[.:—–]/)[0].trim().replace(/\s+/g, ' ');
  return head.length >= 2 ? head.toLowerCase() : '';
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Check the shape of the first named deliverable that exists on disk.
 *
 * Returns `undefined` when the ask enumerated fewer than three sections (there is
 * no outline to hold the file to), when no named path exists (the named-deliverable
 * gate reports that), or when the file cannot be read.
 */
export function checkDeliverableShape(input: {
  ask: string;
  cwd: string;
  paths: readonly string[];
}): DeliverableShape | undefined {
  const { sections, limitations } = requiredSectionsFromAsk(input.ask);
  if (sections.length < 3) return undefined;
  const path = input.paths.find((candidate) => {
    try {
      return existsSync(resolve(input.cwd, candidate));
    } catch {
      return false;
    }
  });
  if (!path) return undefined;
  let text = '';
  try {
    text = readFileSync(resolve(input.cwd, path), 'utf-8');
  } catch {
    return undefined;
  }
  const headings = text
    .split(/\r?\n/)
    .filter((line) => HEADING.test(line))
    .map((line) => line.toLowerCase().replace(/\s+/g, ' '));
  const missingSections = sections.filter(
    (label) => !headings.some((heading) => heading.includes(label)),
  );
  const citations = (text.match(CITATION) ?? []).length;
  const missingLimitations =
    limitations && !headings.some((heading) => /\blimitations?\b/.test(heading));
  return {
    path,
    requiredSections: sections,
    missingSections,
    citations,
    missingLimitations,
    uncitedFindings: uncitedFindings(text),
  };
}

/**
 * The shape gaps as one line each, for the nudge and the finish refusal.
 * Empty when the report is shaped as the ask asked.
 */
/**
 * Defect findings with no citation of their own.
 *
 * "Every claim carries `path:line`" is the ask's rule, and a finding is the claim
 * that matters most. A report can cite 11 lines in its architecture section and
 * still hand the reader a defect with no evidence, which is what the measured
 * 2026-11-05 report did for one of its two findings.
 */
function uncitedFindings(text: string): string[] {
  const defects = /^##\s+.*\bdefects?\b.*$/im.exec(text);
  if (!defects) return [];
  const rest = text.slice(defects.index + defects[0].length);
  const next = /^##\s+/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const heads = [...section.matchAll(/^###\s+(.+)$/gm)];
  const out: string[] = [];
  heads.forEach((head, i) => {
    const start = (head.index ?? 0) + head[0].length;
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? section.length) : section.length;
    if ((section.slice(start, end).match(CITATION) ?? []).length === 0) out.push(head[1].trim());
  });
  return out;
}

export function describeShapeGaps(shape: DeliverableShape): string[] {
  const gaps: string[] = [];
  if (shape.missingSections.length > 0) {
    gaps.push(
      `\`${shape.path}\` has no section for ${shape.missingSections
        .map((s) => `"${s}"`)
        .join(', ')} — the request enumerated ${shape.requiredSections.length} and every one is a deliverable`,
    );
  }
  if (shape.citations === 0) {
    gaps.push(
      `\`${shape.path}\` carries no \`path:line\` citation — the request makes every claim cite one`,
    );
  }
  if (shape.missingLimitations) {
    gaps.push(`\`${shape.path}\` has no Limitations heading — the request asks for one`);
  }
  if (shape.uncitedFindings.length > 0) {
    gaps.push(
      `\`${shape.path}\` has ${shape.uncitedFindings.length} defect finding(s) with no \`path:line\`: ` +
        shape.uncitedFindings.slice(0, 3).map((title) => `"${title}"`).join(', '),
    );
  }
  return gaps;
}
