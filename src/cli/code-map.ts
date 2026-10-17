/**
 * `nuvira code-map` — project symbol map (revamp row 11).
 *
 * Walks the source tree and parses every file through the AST engine
 * (`editing/ast.ts`) to produce a map of the project's structure:
 * functions, classes, methods, interfaces, etc. — with line numbers.
 *
 * Two output modes:
 *   - default: human-readable tree per file (📦 summary + indented symbols)
 *   - `--json`: machine-readable symbol map (feeds tooling, CI, dashboards)
 *
 * Row-11 scope note: the AST engine is currently regex-based (zero native
 * deps). web-tree-sitter WASM remains the planned upgrade path (see the
 * `TODO: Replace with web-tree-sitter WASM` note in editing/ast.ts) — this
 * command is deliberately engine-agnostic: it consumes `analyzeStructure`,
 * so swapping the backend later changes nothing here.
 */

import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { analyzeStructure, getStructureIcon } from '../editing/ast.js';
import { detectLanguage, type StructuralNode } from '../editing/types.js';
import { SOURCE_EXTENSIONS, IGNORE_DIRS } from '../agents/utils/file-tree.js';

/**
 * Symbol maps are about CODE — exclude docs/config/markup extensions that
 * the project's generic SOURCE_EXTENSIONS includes (README.md, package.json,
 * etc.) but that never contain parseable symbols.
 */
const CODE_EXTENSIONS = new Set(
  [...SOURCE_EXTENSIONS].filter(
    (e) => !['.md', '.json', '.yaml', '.yml', '.toml', '.xml', '.css', '.scss', '.html'].includes(e),
  ),
);

/** One symbol in the map. */
export interface CodeMapSymbol {
  type: StructuralNode['type'];
  name: string;
  /** 1-based line of the node's start. */
  line: number;
}

/** One file's entry in the map. */
export interface CodeMapFile {
  path: string;
  language: string;
  symbols: CodeMapSymbol[];
}

/** The full map for a directory. */
export interface CodeMap {
  directory: string;
  files: CodeMapFile[];
  totalFiles: number;
  totalSymbols: number;
  /**
   * Files that were found but NOT mapped, because mapping them would cost more
   * than the map is worth (see {@link MAX_MAP_FILE_BYTES}). Kept so the skip is
   * visible in the output instead of looking like the file is not there.
   */
  skipped: string[];
}

/** Symbol types that make a node worth listing (blocks/unknowns are noise). */
const MEANINGFUL_TYPES = new Set([
  'function', 'method', 'class', 'interface', 'enum', 'type-alias',
  'struct', 'trait', 'impl', 'module', 'variable',
]);

/** Flatten a node tree, keeping meaningful symbols (children included). */
function collectSymbols(nodes: StructuralNode[], out: CodeMapSymbol[] = []): CodeMapSymbol[] {
  for (const node of nodes) {
    if (MEANINGFUL_TYPES.has(node.type)) {
      // ast.ts positions are already 1-based lines.
      out.push({ type: node.type, name: node.name, line: node.range.start.line });
    }
    if (node.children.length > 0) collectSymbols(node.children, out);
  }
  return out;
}

/** Maximum files to scan before bailing out (prevents event-loop blocking on huge dirs). */
const MAX_SCAN_FILES = 2000;

/**
 * A source file bigger than this is BUNDLED OR GENERATED, not written — so it
 * is not mapped at all.
 *
 * MEASURED (2026-10-16). `buildCodeMap` runs SYNCHRONOUSLY inside the dashboard
 * that answers the user's chat (the turn's project context, `getProjectBundle`),
 * so every millisecond it spends is a millisecond the dashboard answers
 * nothing. Attaching this repository left the dashboard pinned at ~100% CPU
 * for minutes: 93% of the samples were inside `analyzeStructure`, most of them
 * in `offsetToPosition`, converting the positions of the committed 1.5 MB
 * `public/assets/index-V0rIqVbg.js` (64 s for that one file). The position scan
 * is fixed (one index per file — see `offsetToPosition`), and this is the other
 * half: a minified bundle of that size still costs seconds of regex work and
 * maps to nothing anyone reads. A map is OF THE SOURCE; 512 KB of hand-written
 * code in a single file is already exceptional (`src/web-dashboard/server.ts`,
 * this repository's largest source file, is 417 KB).
 */
const MAX_MAP_FILE_BYTES = 512 * 1024;

/**
 * …and a single LINE longer than this is the signature of minified/generated
 * output (a bundle is one line, however many megabytes it is).
 *
 * Checked because size alone is not the shape: `analyzeStructure` is regex-based
 * and its per-file cost grows with the line it scans, so a 400 KB one-liner is
 * as expensive as a 1.5 MB one and just as unreadable as a map. The scan exits
 * at the first over-long line, so the check itself is free.
 */
const MAX_MAP_LINE_CHARS = 2000;

/** True when any single line of `code` is longer than {@link MAX_MAP_LINE_CHARS}. */
function hasVeryLongLine(code: string): boolean {
  let lineStart = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 0x0a) lineStart = i + 1;
    else if (i - lineStart >= MAX_MAP_LINE_CHARS) return true;
  }
  return false;
}

/** Recursively collect source files under a directory (respecting IGNORE_DIRS). */
function walkSourceFiles(dir: string, cwd: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length >= MAX_SCAN_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(p, cwd, out, depth + 1);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      out.push(p);
    }
  }
  return out;
}

/** Recursively count ALL files (not just code files) for accurate project stats. */
function countAllFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length >= MAX_SCAN_FILES) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) break;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      countAllFiles(p, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Build the symbol map for a directory. Pure + sync — testable and usable by
 * the dashboard. Never throws on unreadable files (best-effort per file).
 */
export function buildCodeMap(dir: string): CodeMap {
  const cwd = resolve(dir);
  const filePaths = walkSourceFiles(cwd, cwd);
  const allFiles = countAllFiles(cwd);
  const files: CodeMapFile[] = [];
  const skipped: string[] = [];

  for (const abs of filePaths) {
    try {
      const rel = relative(cwd, abs).split('\\').join('/');
      // Size first, so an oversized file is never even read into memory.
      if (statSync(abs).size > MAX_MAP_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      const code = readFileSync(abs, 'utf-8');
      if (hasVeryLongLine(code)) {
        skipped.push(rel);
        continue;
      }
      const language = detectLanguage(abs);
      const nodes = analyzeStructure(code, language);
      files.push({
        path: rel,
        language: language === 'unknown' ? 'plain' : language,
        symbols: collectSymbols(nodes),
      });
    } catch {
      // Best-effort — a single unreadable file never breaks the map.
    }
  }

  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);
  return { directory: cwd, files, totalFiles: allFiles.length, totalSymbols, skipped };
}

/**
 * Count source files cheaply, stopping at `cap`.
 *
 * WHY A SEPARATE WALK. A caller that wants to know whether a map is AFFORDABLE
 * (the loop's ambient context does — see `formatCodeMapBrief`) must decide before
 * paying for one. This is the same bounded walk `buildCodeMap` starts with, with
 * no reads and no parsing, so "can we afford a map?" costs a few milliseconds
 * even on a repository the map itself would take seconds on.
 *
 * MEASURED (2026-10-16): walking this repository's 1 576 source files costs 21 ms;
 * PARSING them costs 4 616 ms. The count is what tells the two apart.
 */
export function countSourceFiles(dir: string): number {
  try {
    const resolved = resolve(dir);
    // The walk is already bounded by MAX_SCAN_FILES, so the count SATURATES there
    // — which is all a caller needs to know "this is far past any turn budget".
    return walkSourceFiles(resolved, resolved).length;
  } catch {
    return 0;
  }
}

/**
 * Cheap freshness signature for a tree: file count + the newest mtime.
 *
 * Deliberately NOT a content hash of every file — that would cost as much as the
 * map. It answers the only question a memo needs: "has anything been written
 * here since the map was built?". A file whose mtime moved BACKWARDS (a revert
 * with a preserved timestamp) is the one change it can miss, which is the same
 * trade the dashboard's cached project context already makes.
 */
function treeSignature(dir: string, cap: number): string {
  let newest = 0;
  let count = 0;
  for (const file of walkSourceFiles(dir, dir)) {
    count += 1;
    if (count > cap) break;
    try {
      const m = statSync(file).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // Unreadable file — it cannot change the signature either way.
    }
  }
  return `${count}:${Math.round(newest)}`;
}

/**
 * `buildCodeMap` memoised per tree state.
 *
 * WHY. The map costs 4.4–4.6 s on this repository (MEASURED 2026-10-16, 1 568
 * files) and it is NOT cached today, so any caller that asks for it per turn pays
 * that every turn. The ambient context asks once per turn, so it must not: with
 * the memo the first turn of a session pays the walk + parse and every later turn
 * pays one bounded stat pass.
 */
export function buildCodeMapCached(dir: string, cap = MAX_SCAN_FILES): CodeMap {
  const key = resolve(dir);
  const signature = treeSignature(key, cap);
  const hit = codeMapMemo.get(key);
  if (hit && hit.signature === signature) return hit.map;
  const map = buildCodeMap(key);
  codeMapMemo.set(key, { signature, map });
  return map;
}

/** One tree's memoised map, keyed by directory. Bounded to a handful of trees. */
const codeMapMemo = new Map<string, { signature: string; map: CodeMap }>();

/** Testing/CLI seam: drop the memo (never needed in production). */
export function clearCodeMapCache(): void {
  codeMapMemo.clear();
}

/** Defaults for {@link formatCodeMapBrief} — sized to ride in a prompt block. */
export interface BriefMapOptions {
  /** Files listed before the rest are counted and named as omitted. */
  maxFiles?: number;
  /** Symbols per file, so one huge module cannot crowd out the rest. */
  maxSymbolsPerFile?: number;
}

/**
 * Compact, capped rendering of a map for a PROMPT (not for a human at a terminal).
 *
 * One line per file — `path (lang · n): name[type] name[type] …` — because the
 * consumer is a model deciding WHICH FILE TO READ, and the one thing it needs per
 * file is the payload of names. `formatCodeMap` (the CLI's output) stays the
 * human rendering; this is its prompt-sized sibling, and both read the same
 * `CodeMap` so they cannot disagree about what a symbol is.
 *
 * Truncation is always stated (files omitted, symbols dropped, files skipped as
 * generated) — a cap nobody can see reads as "this file has no symbols".
 */
export function formatCodeMapBrief(map: CodeMap, opts: BriefMapOptions = {}): string {
  const maxFiles = opts.maxFiles ?? 40;
  const maxSymbolsPerFile = opts.maxSymbolsPerFile ?? 12;
  const lines: string[] = [];
  // Files with NO symbols are not listed: a name is the only payload a line here
  // has, so an empty one costs a line and the reader's attention to say nothing.
  // MEASURED on the audit project: the raw map's 16 files included 8 with no
  // symbols at all (an empty `cordova.js`, generated Android asset placeholders),
  // which is half the section spent on noise. The count is still stated, so a
  // file that really has no declarations does not read as "not in this project".
  const files = map.files.filter((f) => f.symbols.length > 0);
  const empty = map.files.length - files.length;
  const named = files.slice(0, maxFiles);
  lines.push(
    `## Symbol map  (${files.length} file(s) with symbols · ${map.totalSymbols} symbol(s)` +
      (empty > 0 ? ` · ${empty} file(s) with no symbols not listed` : '') +
      (map.skipped.length > 0 ? ` · ${map.skipped.length} generated/oversized not mapped` : '') +
      ')',
  );
  for (const file of named) {
    const symbols = file.symbols.slice(0, maxSymbolsPerFile);
    const body = symbols
      .map((s) => `${s.name}[${s.type === 'type-alias' ? 'type' : s.type}@${s.line}]`)
      .join(' ');
    const more = file.symbols.length - symbols.length;
    lines.push(`  ${file.path} (${file.language}): ${body}${more > 0 ? ` …+${more} more` : ''}`);
  }
  if (files.length > named.length) {
    lines.push(`  … ${files.length - named.length} more file(s) not listed (see \`nuvira code-map\`)`);
  }
  return lines.join('\n');
}

/** Human-readable rendering of a map. */
export function formatCodeMap(map: CodeMap): string {
  const lines: string[] = [];
  lines.push(`📦 Code Map — ${map.directory}`);
  lines.push(`  ${map.totalFiles} file(s) · ${map.totalSymbols} symbol(s)`);
  // Say what was left out, so an absent file reads as "generated, not mapped"
  // rather than "not in this project".
  if (map.skipped.length > 0) {
    lines.push(`  (${map.skipped.length} generated/oversized file(s) not mapped)`);
  }
  for (const file of map.files) {
    lines.push('');
    lines.push(`  ${file.path}  (${file.language} · ${file.symbols.length} symbol${file.symbols.length !== 1 ? 's' : ''})`);
    for (const s of file.symbols) {
      lines.push(`    ${getStructureIcon(s.type)} ${s.name}  (${s.line}:1)`);
    }
  }
  return lines.join('\n');
}

export class CodeMapCommand extends BaseCommand {
  create(): Command {
    const command = new Command('code-map')
      .description('Project symbol map — functions, classes, methods with line numbers (AST engine)')
      .argument('[directory]', 'Directory to map (default: current working directory)')
      .option('--json', 'Emit machine-readable JSON instead of the text tree')
      .action(async (directory: string | undefined, options?: { json?: boolean }) => {
        const dir = directory || process.cwd();
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          logger.error(`Not a directory: ${dir}`);
          process.exitCode = 1;
          return;
        }
        const map = buildCodeMap(dir);
        if (options?.json) {
          console.log(JSON.stringify(map, null, 2));
        } else {
          console.log(formatCodeMap(map));
        }
      });

    return command;
  }
}
