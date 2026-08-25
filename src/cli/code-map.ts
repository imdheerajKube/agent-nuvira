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

/** Recursively collect source files under a directory (respecting IGNORE_DIRS). */
function walkSourceFiles(dir: string, cwd: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
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

/**
 * Build the symbol map for a directory. Pure + sync — testable and usable by
 * the dashboard. Never throws on unreadable files (best-effort per file).
 */
export function buildCodeMap(dir: string): CodeMap {
  const cwd = resolve(dir);
  const filePaths = walkSourceFiles(cwd, cwd);
  const files: CodeMapFile[] = [];

  for (const abs of filePaths) {
    try {
      const code = readFileSync(abs, 'utf-8');
      const language = detectLanguage(abs);
      const nodes = analyzeStructure(code, language);
      files.push({
        path: relative(cwd, abs).split('\\').join('/'),
        language: language === 'unknown' ? 'plain' : language,
        symbols: collectSymbols(nodes),
      });
    } catch {
      // Best-effort — a single unreadable file never breaks the map.
    }
  }

  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);
  return { directory: cwd, files, totalFiles: files.length, totalSymbols };
}

/** Human-readable rendering of a map. */
export function formatCodeMap(map: CodeMap): string {
  const lines: string[] = [];
  lines.push(`📦 Code Map — ${map.directory}`);
  lines.push(`  ${map.totalFiles} file(s) · ${map.totalSymbols} symbol(s)`);
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
