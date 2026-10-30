/**
 * Coverage ledger — what an assessment actually OPENED, and the code it depends
 * on but never opened.
 *
 * WHY THIS EXISTS (measured 2026-10-25, Cline vs agent-nuvira, same snapshot and
 * prompt). Both reports were ~80 KB, both honest, both 12/12 sections — and Cline
 * found 24 defects against nuvira's 19. The gap was almost entirely BREADTH:
 * Cline read `parsers.py` and the DAISY builders and ran the suite; nuvira wrote
 * "not covered: ~8k lines of GUI it did not read, parsers/DAISY, …" and stopped.
 *
 * The previous plan's answer to that was a nudge asking the model to read more
 * "because reading is cheap". That is a gamble, not engineering: it makes
 * thoroughness depend on the model choosing to be thorough, which is exactly the
 * variable that produced the shortfall. This module replaces the gamble with
 * three facts the harness owns:
 *
 *   1. the CENSUS — how many source files the project has;
 *   2. the OPENED SET — the files whose content actually entered the thread (a
 *      `read_file`/`read_files` result, not a grep hit and not a `list_dir`);
 *   3. the DEPENDENCY FRONTIER — for each file that WAS read, the files it
 *      imports that were NEVER read.
 *
 * (3) is the load-bearing part, and it is the direct answer to "there could be
 * dependencies in another part which are not touched": when a module is opened,
 * the code it depends on becomes a NAMED file on the frontier. The next read is
 * chosen by the import graph, not by luck, and a finding that cites a file never
 * opened is marked as resting on something unread.
 *
 * Everything here is deterministic and costs no model call. The loop decides
 * whether to spend one more bounded round from these numbers — never from prose.
 *
 * WHO RECORDS, AND WHY THAT CHANGED. This ledger used to be constructed only on
 * an ASSESSMENT ask. That left the turns that change code with no breadth record
 * whatsoever: a refactor could alter a function and never open the file that calls
 * it, and the loop had no way to know. It is now constructed on every turn, and
 * the question a build is asked is different from the one an audit is asked —
 * `unreadAround` reports the files related to the EDIT (what it calls, and what
 * calls it), never a percentage of the tree. A build owes "know what this change
 * touches"; it does not owe "read 60% of the repo", and granting it extra steps
 * for a coverage number would be the step ladder this loop just removed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';

/** Directories that are never part of the code an audit should read. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', '__pycache__', '.venv', 'venv', 'env', '.tox', 'target', 'vendor',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo', '.nuvira', 'site-packages',
]);

/** Extensions counted as source an audit can be expected to read. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb',
  '.java', '.kt', '.kts', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.swift',
  '.php', '.scala', '.sh', '.bash', '.lua', '.vue', '.svelte',
]);

/** How many source files the census will enumerate before it saturates. */
export const COVERAGE_MAX_FILES = 2_000;
/** How many OPENED files the frontier scans for imports (bounded work per call). */
const FRONTIER_MAX_FILES = 300;
/** Bytes of an opened file the frontier reads — imports live near the top. */
const FRONTIER_READ_BYTES = 64_000;
/** How many frontier edges a snapshot carries (the report shows fewer). */
const FRONTIER_MAX_EDGES = 60;
/**
 * How many census files a REVERSE scan may read looking for dependents of an edit.
 *
 * The forward direction (what a changed file imports) costs one read per edited
 * file. The reverse (who imports the changed file) has no index to consult, so it
 * reads candidate heads until the bound — which is why it is bounded, and why it
 * runs at most once per turn, at the point the turn is already being continued.
 */
const BREADTH_SCAN_FILES = 400;
/** How many related-but-unopened files one breadth gap report names. */
const BREADTH_MAX_GAPS = 10;
/** Share of source files an audit should have opened before it may call itself broad. */
export const COVERAGE_TARGET = 0.6;

export interface CoverageArea {
  /** First path segment, or `(root)` for files at the project root. */
  area: string;
  total: number;
  opened: number;
  unopened: number;
  /** Up to three unopened file names, so the table is actionable. */
  examples: string[];
}

/**
 * A file related to an EDIT that the turn never opened.
 *
 * Two directions, because they fail differently. `dependency` is what the changed
 * code calls — an edit made against an unseen implementation is a guess.
 * `dependent` is what calls the changed code — an edit made without seeing its
 * callers is how a signature change quietly breaks them, which no test names if
 * the caller has no test.
 */
export interface BreadthGap {
  /** The file that was never opened. */
  file: string;
  /** The edited file it is related to. */
  via: string;
  /** `dependency` = the edit imports it; `dependent` = it imports the edit. */
  direction: 'dependency' | 'dependent';
}

export interface CoverageFrontierEdge {
  /** A file that WAS opened. */
  from: string;
  /** A file it imports that was NEVER opened. */
  to: string;
  /** The specifier as written (`./paths`, `ai_voice_studio.paths`). */
  via: string;
}

export interface CoverageSnapshot {
  root: string;
  totalFiles: number;
  openedFiles: number;
  /** Opened ÷ census, 0–1 (0 when the census is empty). */
  coverage: number;
  /** Per top-level area, worst first. */
  areas: CoverageArea[];
  /** Unread dependencies of read files, deduped by target. */
  frontier: CoverageFrontierEdge[];
  /** Relative paths never opened (bounded by the census cap). */
  unopened: string[];
}

/** `file.ts:12` / `path/to/file.py:88` — a citation an audit report makes. */
const CITATION = /\b([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|cs|swift|php|c|cc|cpp|h|hpp)):(\d{1,6})\b/g;

/** ESM/CJS import specifiers (`from 'x'`, `import('x')`, `require('x')`). */
const JS_SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"\n]+)['"]/g;

/** Python `from x import y` / `from .x import y` / `import x.y`. */
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([.\w]+(?:[ \t]*,[ \t]*[.\w]+)*)/gm;

/** Extensions a resolved specifier may acquire. */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * A path relative to `root`, posix-normalised, or null when it escapes the root.
 *
 * An audit reads `.venv/...` or `../notes.md` all the time; neither is part of the
 * code base, so neither may count toward (or against) coverage.
 */
export function relativeInside(root: string, path: string): string | null {
  if (!path || typeof path !== 'string') return null;
  const absolute = resolve(root, path);
  const rel = toPosix(relative(root, absolute));
  if (!rel || rel === '.' || rel.startsWith('../')) return null;
  return rel;
}

/**
 * Every source file in the project, relative and sorted. Bounded, best-effort:
 * an unreadable directory is skipped, and the walk stops at `maxFiles`.
 */
export function censusSourceFiles(root: string, maxFiles: number = COVERAGE_MAX_FILES): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (found.length >= maxFiles || depth > 8) return;
    let entries: Array<{ name: string; isDir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!SOURCE_EXT.has(extname(entry.name).toLowerCase())) continue;
      // Test fixtures and generated bundles are source, but they are never the
      // subject of a defect report — leaving them in would make coverage look
      // worse than the audit actually is.
      if (/(?:^|\/)(?:node_modules|vendor|third_party)\//.test(childRel)) continue;
      found.push(childRel);
    }
  };
  walk(root, '', 0);
  return found;
}

/**
 * Resolve an import specifier written in `fromFile` to a census path, or null.
 *
 * Relative specifiers (`./x`, `../y`) are joined and resolved against the file's
 * directory. Bare specifiers are matched as a path suffix, which is how Python
 * absolute imports (`from ai_voice_studio.paths import …`) and repo-root imports
 * resolve without a module resolver — npm packages find no match and are ignored.
 */
export function resolveSpecifier(fromFile: string, spec: string, universe: Set<string>): string | null {
  const raw = (spec || '').trim();
  if (!raw || raw.startsWith('node:') || raw.startsWith('http')) return null;
  if (raw.length > 200) return null;

  const candidates: string[] = [];
  if (raw.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(fromFile), raw));
    candidates.push(base);
  } else {
    // Bare: a repo-relative path (tsconfig `baseUrl` style) or a dotted module
    // name (Python). Try the literal path first, then the dotted form.
    const dotted = raw.replace(/\./g, '/');
    if (raw.includes('/')) candidates.push(raw);
    candidates.push(dotted);
  }

  for (const candidate of candidates) {
    const clean = posix.normalize(candidate);
    if (clean.startsWith('../') || clean === '..') continue;
    if (universe.has(clean)) return clean;
    if (!extname(clean) || !SOURCE_EXT.has(extname(clean).toLowerCase())) {
      for (const ext of RESOLVE_EXTS) {
        if (universe.has(clean + ext)) return clean + ext;
        if (universe.has(`${clean}/index${ext}`)) return `${clean}/index${ext}`;
        if (universe.has(`${clean}/__init__${ext}`)) return `${clean}/__init__${ext}`;
      }
    } else {
      for (const ext of RESOLVE_EXTS) {
        const swapped = clean.slice(0, -extname(clean).length) + ext;
        if (universe.has(swapped)) return swapped;
      }
    }
  }
  return null;
}

/** Import specifiers written in one file's text (JS/TS + Python shapes). */
export function importSpecifiers(text: string, file: string): string[] {
  const out: string[] = [];
  const ext = extname(file).toLowerCase();
  if (ext === '.py') {
    for (const m of text.matchAll(PY_FROM)) out.push(m[1]);
    for (const m of text.matchAll(PY_IMPORT)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) out.push(name);
      }
    }
    return out;
  }
  for (const m of text.matchAll(JS_SPECIFIER)) out.push(m[1]);
  return out;
}

/**
 * The coverage state of one turn.
 *
 * A ledger is cheap to construct and does no I/O until `snapshot()` — the loop
 * creates one per assessment turn and records reads as they land.
 */
export class CoverageLedger {
  private readonly opened = new Set<string>();
  private censusCache: string[] | null = null;
  private readonly universe = new Set<string>();

  constructor(private readonly root: string) {}

  /** Record one path the model actually READ (its content entered the thread). */
  recordRead(path: string | null | undefined): void {
    const rel = relativeInside(this.root, path ?? '');
    if (!rel) return;
    if (!this.census().includes(rel)) return;
    this.opened.add(rel);
  }

  /**
   * Record several paths at once (`read_file` accepts a `paths[]` batch whose
   * entries are a path or `{ path, offset, limit }`).
   */
  recordReads(paths: Iterable<unknown>): void {
    for (const entry of paths) {
      if (typeof entry === 'string') this.recordRead(entry);
      else if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        this.recordRead((entry as { path: string }).path);
      }
    }
  }

  /** How many distinct files this turn has opened. */
  openedCount(): number {
    return this.opened.size;
  }

  /** The census, computed once per ledger. */
  census(): string[] {
    if (this.censusCache === null) {
      this.censusCache = censusSourceFiles(this.root);
      for (const f of this.censusCache) this.universe.add(f);
    }
    return this.censusCache;
  }

  /**
   * Files related to an EDIT that were never opened, in both directions.
   *
   * WHY THIS IS NOT `frontier()`. The frontier answers "what does the reading
   * depend on", which is the assessment question. A REFACTOR asks the other one:
   * I just changed this file — what did I change it without reading? Forward, that
   * is what the file imports; backward, it is what imports the file. The backward
   * half is the one nothing else covers: a signature change is checked by tests
   * that exist, and the caller with no test is the silent breakage.
   *
   * Bounded on purpose. The forward half reads one file per edit. The reverse half
   * has no index, so it scans at most `maxScan` census heads, and a caller that can
   * only afford one direction passes `reverse: false`.
   */
  unreadAround(
    paths: readonly string[],
    opts: { reverse?: boolean; maxScan?: number; limit?: number } = {},
  ): BreadthGap[] {
    const edited = new Set<string>();
    for (const path of paths) {
      const rel = relativeInside(this.root, path ?? '');
      if (rel && this.census().includes(rel)) edited.add(rel);
    }
    if (edited.size === 0) return [];

    const limit = opts.limit ?? BREADTH_MAX_GAPS;
    const gaps: BreadthGap[] = [];
    const seen = new Set<string>();
    const push = (gap: BreadthGap): void => {
      if (seen.has(gap.file) || edited.has(gap.file)) return;
      seen.add(gap.file);
      gaps.push(gap);
    };

    // Forward: what the edited code calls.
    for (const file of edited) {
      for (const spec of importSpecifiers(this.head(file) ?? '', file)) {
        const target = resolveSpecifier(file, spec, this.universe);
        if (!target || this.opened.has(target)) continue;
        push({ file: target, via: file, direction: 'dependency' });
        if (gaps.length >= limit) return gaps;
      }
    }

    if (opts.reverse === false) return gaps;

    // Backward: what calls the edited code. No index exists, so this is a bounded
    // scan of unopened candidates — the ones worth reading are exactly the ones
    // the turn has not looked at.
    const maxScan = opts.maxScan ?? BREADTH_SCAN_FILES;
    let scanned = 0;
    for (const candidate of this.census()) {
      if (scanned >= maxScan || gaps.length >= limit) break;
      if (edited.has(candidate) || this.opened.has(candidate)) continue;
      scanned += 1;
      const text = this.head(candidate);
      if (!text) continue;
      for (const spec of importSpecifiers(text, candidate)) {
        const target = resolveSpecifier(candidate, spec, this.universe);
        if (target && edited.has(target)) {
          push({ file: candidate, via: target, direction: 'dependent' });
          break;
        }
      }
    }
    return gaps;
  }

  /** The head of one file, or null when it cannot be read — the shared read for both directions. */
  private head(file: string): string | null {
    try {
      const abs = join(this.root, file);
      if (statSync(abs).size > 4_000_000) return null;
      return readFileSync(abs, 'utf8').slice(0, FRONTIER_READ_BYTES);
    } catch {
      return null;
    }
  }

  /**
   * The one-line ask for a build/refactor turn that edited code it has not read.
   *
   * Deliberately NOT a coverage percentage. A refactor does not owe "read 60% of the
   * repo"; it owes "know what this change touches". So the ask names the specific
   * unopened files, says which direction each one is, and allows the turn to answer
   * with a reason instead of a read — a change that provably cannot affect a caller
   * (a comment, an unreachable branch) must not be forced into a token spend to
   * satisfy a number.
   */
  editBreadthNudge(gaps: readonly BreadthGap[], editedCount = 1): string {
    const deps = gaps.filter((g) => g.direction === 'dependency');
    const dependents = gaps.filter((g) => g.direction === 'dependent');
    const lines = [
      `[breadth of this edit — you changed ${editedCount} file(s); these related files were never opened]`,
    ];
    for (const g of deps) lines.push(`- \`${g.via}\` imports \`${g.file}\`, which you have not read`);
    for (const g of dependents) {
      lines.push(`- \`${g.file}\` imports \`${g.via}\` and you have not read it — a caller of the code you just changed`);
    }
    lines.push(
      '',
      'Open the ones that can actually be affected, in ONE batched call, and re-check this edit against them.',
      'If a file genuinely cannot be affected by the change (a comment, dead code, an unchanged contract), say so',
      'in one line instead of reading it — do NOT read all of them for the count.',
    );
    return lines.join('\n');
  }

  /**
   * Unread dependencies of the files that WERE read, deduped by target.
   *
   * Bounded three ways so this can run inside a turn without stalling it: the
   * number of opened files scanned, the bytes read per file, and the edges kept.
   */
  frontier(): CoverageFrontierEdge[] {
    const scanned = [...this.opened].slice(0, FRONTIER_MAX_FILES);
    const edges = new Map<string, CoverageFrontierEdge>();
    for (const file of scanned) {
      let text: string;
      try {
        const abs = join(this.root, file);
        if (statSync(abs).size > 4_000_000) continue;
        text = readFileSync(abs, 'utf8').slice(0, FRONTIER_READ_BYTES);
      } catch {
        continue;
      }
      for (const spec of importSpecifiers(text, file)) {
        const target = resolveSpecifier(file, spec, this.universe);
        if (!target || target === file || this.opened.has(target)) continue;
        if (edges.has(target)) continue;
        edges.set(target, { from: file, to: target, via: spec });
        if (edges.size >= FRONTIER_MAX_EDGES) return [...edges.values()];
      }
    }
    return [...edges.values()];
  }

  /** The whole picture, for the loop's decision and the model's nudge. */
  snapshot(): CoverageSnapshot {
    const census = this.census();
    const opened = census.filter((f) => this.opened.has(f));
    const byArea = new Map<string, CoverageArea>();
    for (const file of census) {
      const area = file.includes('/') ? file.slice(0, file.indexOf('/')) : '(root)';
      const existing = byArea.get(area) ?? { area, total: 0, opened: 0, unopened: 0, examples: [] };
      existing.total += 1;
      if (this.opened.has(file)) existing.opened += 1;
      else {
        existing.unopened += 1;
        if (existing.examples.length < 3) existing.examples.push(file.slice(file.indexOf('/') + 1));
      }
      byArea.set(area, existing);
    }
    return {
      root: this.root,
      totalFiles: census.length,
      openedFiles: opened.length,
      coverage: census.length > 0 ? opened.length / census.length : 0,
      areas: [...byArea.values()].sort((a, b) => b.unopened - a.unopened),
      frontier: this.frontier(),
      unopened: census.filter((f) => !this.opened.has(f)),
    };
  }

  /**
   * The citation check: `file:line` references whose file was never opened.
   *
   * A finding can legitimately come from a grep hit, but a claim about a file
   * nobody read rests on something the turn did not see. Naming those citations is
   * how "half-baked" becomes visible instead of silent.
   */
  unbackedCitations(texts: readonly string[], limit = 12): string[] {
    const census = new Set(this.census());
    const found: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) {
      for (const m of (text || '').matchAll(CITATION)) {
        const cited = posix.normalize(m[1].replace(/^\.\//, ''));
        // A report may cite `paths.py` without its directory; match by suffix so
        // the check cannot be dodged by abbreviating the path.
        const match = census.has(cited)
          ? cited
          : this.census().find((f) => f === cited || f.endsWith(`/${cited}`)) ?? null;
        if (!match || this.opened.has(match)) continue;
        const key = `${match}:${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(key);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  /**
   * The coverage table, as the report should carry it.
   *
   * Deterministic and already formatted: the model's only job is to paste it,
   * not to compute it (a model left to count its own reads over-reports).
   */
  report(snapshot: CoverageSnapshot = this.snapshot(), unbacked: readonly string[] = []): string {
    const pct = Math.round(snapshot.coverage * 100);
    const lines = [
      `## Coverage`,
      ``,
      `| Source files | Opened | Coverage |`,
      `|---|---:|---:|`,
      `| ${snapshot.totalFiles} | ${snapshot.openedFiles} | ${pct}% |`,
    ];
    const unopenedAreas = snapshot.areas.filter((a) => a.unopened > 0).slice(0, 8);
    if (unopenedAreas.length > 0) {
      lines.push('', `| Area | Opened / total | Still unopened |`, `|---|---:|---|`);
      for (const a of unopenedAreas) {
        lines.push(`| ${a.area} | ${a.opened} / ${a.total} | ${a.examples.join(', ')}${a.unopened > a.examples.length ? ', …' : ''} |`);
      }
    }
    if (snapshot.frontier.length > 0) {
      lines.push('', `Unread dependencies of files that were read:`);
      for (const e of snapshot.frontier.slice(0, 10)) lines.push(`- \`${e.from}\` imports \`${e.to}\``);
      if (snapshot.frontier.length > 10) lines.push(`- … ${snapshot.frontier.length - 10} more`);
    }
    if (unbacked.length > 0) {
      lines.push('', `Findings citing a file that was never opened (verify or mark them):`);
      for (const c of unbacked) lines.push(`- \`${c}\``);
    }
    return lines.join('\n');
  }

  /**
   * The bounded round the loop may spend: read the frontier, then re-check.
   *
   * Returns null when the ledger has nothing to add — the turn is already broad
   * enough, or every named dependency has been read — so the loop's dry-round stop
   * applies unchanged. This function decides NOTHING about how many rounds are
   * allowed; the loop owns that bound.
   */
  nudge(opts: { unbacked?: readonly string[]; remainingSteps?: number } = {}): string | null {
    const snapshot = this.snapshot();
    const unbacked = opts.unbacked ?? [];
    if (snapshot.totalFiles === 0) return null;
    const shallow = snapshot.coverage < COVERAGE_TARGET && snapshot.unopened.length > 0;
    if (!shallow && snapshot.frontier.length === 0 && unbacked.length === 0) return null;

    const pct = Math.round(snapshot.coverage * 100);
    const target = Math.round(COVERAGE_TARGET * 100);
    const lines = [
      `[coverage check — this assessment read ${snapshot.openedFiles} of ${snapshot.totalFiles} source files (${pct}%)]`,
      `Your budget is spent and the last round added no new finding, but the review is not broad enough to call finished (target ${target}%).`,
    ];
    if (snapshot.frontier.length > 0) {
      lines.push(
        '',
        'These files were READ and they import files that were NEVER opened — that is the shortest path to a seam this report cannot see:',
        ...snapshot.frontier.slice(0, 12).map((e) => `- \`${e.from}\` → \`${e.to}\` (via \`${e.via}\`)`),
      );
    }
    const areas = snapshot.areas.filter((a) => a.unopened > 0).slice(0, 6);
    if (shallow && areas.length > 0) {
      lines.push('', 'Unopened areas, heaviest first:');
      for (const a of areas) {
        lines.push(`- ${a.area}: ${a.unopened} unopened (${a.examples.join(', ')})`);
      }
    }
    if (unbacked.length > 0) {
      lines.push(
        '',
        'These findings cite a file that was never opened. Either open it and confirm the claim, or mark the finding as unverified — do not leave a confident claim resting on something unread:',
        ...unbacked.slice(0, 12).map((c) => `- \`${c}\``),
      );
    }
    lines.push(
      '',
      'Do this now, in this order:',
      '1. Open the frontier files above (batch the reads into ONE call).',
      '2. Follow one more level of imports from anything that looks load-bearing, and run the project\'s own tests or a probe where a claim is uncertain.',
      '3. Add each NEW defect to the report, and add this table to it verbatim (do not recompute the numbers):',
      '',
      this.report(snapshot, unbacked),
      '',
      'If a file genuinely cannot be assessed, list it under "not covered" with the reason. Do not claim a module is clean because it was not opened.',
    );
    return lines.join('\n');
  }
}
