/**
 * P3 — Project context (DASHBOARD_FIRST_PLAN Phase 3: "assess THIS project").
 *
 * When the user attaches a project to the chat, the agent needs to know what
 * the project IS without being told. This module builds a compact, bounded
 * snapshot from the EXISTING engine pieces — `buildCodeMap` (the `buff
 * code-map` AST engine: pure, sync, dashboard-usable, ignores node_modules /
 * dist / junk) — and renders it into a single string that rides into the
 * turn's thread as a `[Project context]` message, exactly like the CLI's
 * `--file` context does.
 *
 * Two properties matter beyond the content:
 * - DETERMINISM: `readdir` order is OS-dependent, so file paths are SORTED
 *   before the caps apply — the same project yields the same context on
 *   Windows, macOS and Linux (platform independence is a hard constraint).
 * - BOUNDED SIZE: a giant monorepo must not blow the token budget. The map
 *   is capped (files, symbols, tree lines) with a visible "… N more" footer
 *   so the model knows the shape is truncated, not complete.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildCodeMap } from '../cli/code-map.js';
const DEFAULT_MAX_FILES = 150;
const DEFAULT_MAX_SYMBOLS = 300;
const DEFAULT_MAX_TREE_LINES = 200;
/**
 * Build the bounded project snapshot for `path`. Returns null when the path
 * is not a readable directory. Pure + sync (mirrors buildCodeMap's contract).
 */
export function buildProjectContext(path, opts = {}) {
    const dir = resolve(path);
    if (!existsSync(dir))
        return null;
    try {
        if (!statSync(dir).isDirectory())
            return null;
    }
    catch {
        return null;
    }
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
    const maxTreeLines = opts.maxTreeLines ?? DEFAULT_MAX_TREE_LINES;
    const map = buildCodeMap(dir);
    // Deterministic order (readdir is OS-dependent) BEFORE capping.
    const files = [...map.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = files.length > maxFiles;
    const cappedFiles = files.slice(0, maxFiles);
    // Per-file paths are already /-joined by buildCodeMap (Windows-safe).
    const fileTree = formatProjectTree(cappedFiles.map((f) => f.path), maxTreeLines, map.totalFiles - cappedFiles.length);
    const codeMap = formatCodeMapCapped({ ...map, files: cappedFiles }, maxSymbols, truncated);
    return {
        path: dir,
        name: basename(dir) || dir,
        codeMap,
        fileTree,
        fileCount: map.totalFiles,
        symbolCount: map.totalSymbols,
        truncated,
        builtAt: Date.now(),
    };
}
/** The full injected text — what the agent actually reads. */
export function formatProjectText(bundle) {
    return [
        `Project: ${bundle.name}`,
        `Path: ${bundle.path}`,
        `Files: ${bundle.fileCount} · Symbols: ${bundle.symbolCount}${bundle.truncated ? ' (map truncated to fit context — use read_file for the rest)' : ''}`,
        `Note: File count includes all source files in this directory and its subdirectories.`,
        '',
        '## File tree',
        bundle.fileTree,
        '',
        '## Symbol map',
        bundle.codeMap,
    ].join('\n');
}
/**
 * A compact directory tree (2 levels, first file of each subdir) built from
 * the sorted file paths. Capped with a "+N" footer so a huge project never
 * blows the token budget.
 */
export function formatProjectTree(filePaths, maxLines, omitted) {
    const root = new Map();
    const deeper = new Map();
    for (const p of filePaths) {
        const parts = p.split('/');
        const top = parts[0] ?? '';
        if (parts.length <= 1) {
            const e = root.get(top) ?? { dirs: new Set(), files: [] };
            e.files.push(p);
            root.set(top, e);
            continue;
        }
        const e = root.get(top) ?? { dirs: new Set(), files: [] };
        if (parts.length === 2) {
            e.files.push(parts[1]);
        }
        else {
            e.dirs.add(parts[1]);
            const deeperKey = `${top}/${parts[1]}`;
            if (!deeper.has(deeperKey))
                deeper.set(deeperKey, []);
            deeper.get(deeperKey).push(parts.slice(2).join('/'));
        }
        root.set(top, e);
    }
    const lines = [];
    let truncated = false;
    for (const [top, entry] of root) {
        if (lines.length >= maxLines) {
            truncated = true;
            break;
        }
        lines.push(top === '' ? './' : `${top}/`);
        for (const d of [...entry.dirs].sort()) {
            if (lines.length >= maxLines) {
                truncated = true;
                break;
            }
            lines.push(`  ${d}/`);
            const sub = deeper.get(`${top}/${d}`) ?? [];
            if (sub.length > 0 && lines.length < maxLines)
                lines.push(`    ${sub[0]}`);
        }
        for (const f of entry.files) {
            if (lines.length >= maxLines) {
                truncated = true;
                break;
            }
            lines.push(`  ${f}`);
        }
    }
    if (truncated)
        lines.push('… (tree truncated)');
    else if (omitted > 0)
        lines.push(`… ${omitted} more file(s) not shown`);
    return lines.join('\n') || '(no source files)';
}
/** Capped rendering of the code map (formatCodeMap + truncation + footer). */
function formatCodeMapCapped(map, maxSymbols, filesTruncated) {
    const lines = [];
    lines.push(`${map.totalFiles} file(s) · ${map.totalSymbols} symbol(s) across the project`);
    let shown = 0;
    for (const file of map.files) {
        if (shown >= maxSymbols && file.symbols.length > 0)
            break;
        lines.push('');
        lines.push(`${file.path}  (${file.language} · ${file.symbols.length} symbol${file.symbols.length !== 1 ? 's' : ''})`);
        for (const s of file.symbols) {
            if (shown >= maxSymbols)
                break;
            lines.push(`    ${symbolIcon(s.type)} ${s.name}  (line ${s.line})`);
            shown += 1;
        }
    }
    if (shown < map.totalSymbols) {
        lines.push(`… ${map.totalSymbols - shown} more symbol(s) — read_file the paths above for details`);
    }
    else if (filesTruncated) {
        lines.push('… (files truncated — the tree above lists the rest)');
    }
    return lines.join('\n');
}
function symbolIcon(type) {
    switch (type) {
        case 'class':
        case 'interface':
        case 'struct':
        case 'trait':
        case 'enum':
        case 'type-alias':
            return '📦';
        case 'method':
        case 'function':
            return 'ƒ';
        case 'variable':
            return '•';
        case 'module':
            return '📁';
        default:
            return '·';
    }
}
//# sourceMappingURL=project-context.js.map