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
import { BaseCommand } from './commands.js';
import { type StructuralNode } from '../editing/types.js';
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
/**
 * Build the symbol map for a directory. Pure + sync — testable and usable by
 * the dashboard. Never throws on unreadable files (best-effort per file).
 */
export declare function buildCodeMap(dir: string): CodeMap;
/** Human-readable rendering of a map. */
export declare function formatCodeMap(map: CodeMap): string;
export declare class CodeMapCommand extends BaseCommand {
    create(): Command;
}
//# sourceMappingURL=code-map.d.ts.map