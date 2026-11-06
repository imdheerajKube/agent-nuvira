/**
 * RISK SURFACE — a static index of the places defects actually live.
 *
 * WHY THIS EXISTS (measured 2026-11-05, head-to-head audit of a 46k-line Python
 * repository). Both arms ran the same model, the same prompt and the same snapshot.
 * Claude found 2 of the 6 seeded defects; nuvira found 1. The nuvira turn had a
 * 9.7 KB assessment protocol in context that already named the right SEAMS (path
 * sanitising, transfer resume, parsed-but-unused fields), and it still missed them.
 * The gap was not knowledge and not the model: it was that the sweep was stated as
 * advice and never turned into a list of PLACES TO OPEN.
 *
 * This module is that list. It is a bounded, read-only static pass that finds the
 * SINKS a defect can hide in — recursive deletes, transfer/resume status handling,
 * append-mode writes, mutable config defaults, CLI flag parsing, cancellation
 * primitives — and returns each as `path:line` plus the line text. A lead is not a
 * finding: the model still has to open it, decide, and either demonstrate the defect
 * or mark the site safe with the line that proves it.
 *
 * WHY THIS IS NOT BENCH OVERFITTING. The categories are the generic audit classes
 * any reviewer sweeps for (the same set a Semgrep ruleset or an OWASP checklist
 * names); none of them encodes a specific defect, a specific file, or a known answer.
 * On a tree with none of these sinks the block is empty and the prompt is byte-for-
 * byte what it was before. It raises the floor for any repository, not for this one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface RiskLead {
  /** Posix path relative to the workspace root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** What kind of sink this is. */
  category: string;
  /** The source line, trimmed and clipped — evidence to open, not a verdict. */
  text: string;
}

interface RiskRule {
  category: string;
  label: string;
  /** Matched per line. Deliberately about the SINK, never about the defect. */
  pattern: RegExp;
}

/**
 * The classes a defect hides in. Each pattern is a call or a protocol token that
 * only appears where something consequential happens — a delete, a resumed
 * transfer, a partial write, a shared default, a flag, a cancellation.
 */
const RULES: readonly RiskRule[] = [
  {
    category: 'filesystem-delete',
    label: 'recursive delete / unlink',
    pattern: /\b(?:shutil\.rmtree|rmtree|os\.remove|os\.unlink|unlinkSync|rmSync|remove_dir_all|rimraf)\s*\(/,
  },
  {
    category: 'transfer-resume',
    label: 'transfer status / resume handling',
    pattern: /\b(?:Range|Content-Range|Content-Length|416|206)\b/,
  },
  {
    category: 'partial-write',
    label: 'append / partial write',
    pattern: /\bopen\s*\([^)]*['"][rab][+b]*['"]|\bO_APPEND\b/,
  },
  {
    category: 'config-mutation',
    label: 'mutable config default',
    pattern: /\.setdefault\s*\(|\bsetdefault\s*\(/,
  },
  {
    category: 'flag-parse',
    label: 'CLI flag parsing',
    pattern: /\badd_argument\s*\(|\bargparse\b|\b(?:process\.argv|sys\.argv)\b/,
  },
  {
    category: 'cancellation',
    label: 'cancellation / pause primitive',
    pattern: /\.cancel\s*\(|\bis_set\s*\(|\bCancelledError\b/,
  },
];

/** Directories that are dependencies, output, or history — never the audit target. */
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
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.next',
  'coverage',
]);

/** Source files only: a lockfile or a minified bundle is noise, not a sink. */
const SOURCE_FILE = /\.(?:py|pyw|js|mjs|cjs|ts|mts|cts|tsx|jsx|go|rb|rs|java|kt|cs|php|sh|lua|pl)$/i;

/** A test file states what the code SHOULD do; it is not the shipped sink. */
const TEST_PATH = /(?:^|\/)(?:tests?|spec|__tests__)\//i;

const MAX_FILES = 1200;
const MAX_BYTES = 200_000;
const PER_CATEGORY = 3;
const MAX_LEADS = 15;

/**
 * Scan the tree for sink sites. Bounded and best-effort: an unreadable file is
 * skipped, and the result is capped per category and overall so the block can never
 * become the turn's main work.
 */
export function scanRiskSurface(cwd: string, opts: { maxLeads?: number } = {}): RiskLead[] {
  const maxLeads = Math.max(1, Math.min(opts.maxLeads ?? MAX_LEADS, MAX_LEADS));
  const files: string[] = [];
  const stack: string[] = [cwd];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) continue;
      if (!SOURCE_FILE.test(name)) continue;
      const rel = relative(cwd, abs).split(sep).join('/');
      if (TEST_PATH.test(rel)) continue;
      files.push(rel);
    }
  }
  files.sort((a, b) => a.localeCompare(b));

  const perCategory = new Map<string, number>();
  const leads: RiskLead[] = [];
  for (const file of files) {
    if (leads.length >= maxLeads) break;
    let text = '';
    try {
      text = readFileSync(join(cwd, file), 'utf-8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (leads.length >= maxLeads) break;
      const line = lines[i];
      if (!line || line.length > 400) continue;
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        const used = perCategory.get(rule.category) ?? 0;
        if (used >= PER_CATEGORY) continue;
        perCategory.set(rule.category, used + 1);
        leads.push({
          file,
          line: i + 1,
          category: rule.category,
          text: line.trim().slice(0, 160),
        });
        break;
      }
    }
  }
  return leads;
}

/**
 * The prompt section. Empty when the tree has no sink sites, which keeps a clean
 * project's prompt identical to a build without this module.
 *
 * The wording is the contract: a lead is a PLACE TO OPEN, and every lead must end
 * as either a demonstrated defect or a "safe" line naming the guard that makes it
 * safe. That is what turns a static index into recall rather than a to-do list.
 */
export function buildRiskLeadsBlock(leads: readonly RiskLead[]): string {
  if (leads.length === 0) return '';
  const lines = [
    "## RISK SURFACE — candidate sinks found by a static pass (leads, not findings)",
    'These are the places a defect of this kind can live. A lead proves nothing: open',
    'each one, decide with the code in front of you, and record the verdict — a defect',
    'with `file:line`, or `safe` with the guard (validation, size check, containment)',
    'that makes it safe. An unexamined lead is an unexamined seam.',
    '',
  ];
  for (const lead of leads) {
    lines.push(`- \`${lead.file}:${lead.line}\` [${lead.category}] \`${lead.text}\``);
  }
  lines.push(
    '',
    'Do not stop at the leads: they are where the static pass looked, not the whole',
    'tree. A module with no lead can still contain the defect you were asked to find.',
  );
  return lines.join('\n');
}
