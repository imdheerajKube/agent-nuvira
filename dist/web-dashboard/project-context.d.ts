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
export interface ProjectContextBundle {
    path: string;
    name: string;
    /** Capped, human-readable code map (files + symbols). */
    codeMap: string;
    /** Capped, compact directory tree. */
    fileTree: string;
    fileCount: number;
    symbolCount: number;
    /** True when the map was truncated to fit the caps. */
    truncated: boolean;
    builtAt: number;
}
export interface ProjectContextOptions {
    maxFiles?: number;
    maxSymbols?: number;
    maxTreeLines?: number;
}
/**
 * Build the bounded project snapshot for `path`. Returns null when the path
 * is not a readable directory. Pure + sync (mirrors buildCodeMap's contract).
 */
export declare function buildProjectContext(path: string, opts?: ProjectContextOptions): ProjectContextBundle | null;
/** The full injected text — what the agent actually reads. */
export declare function formatProjectText(bundle: ProjectContextBundle): string;
/**
 * A compact directory tree (2 levels, first file of each subdir) built from
 * the sorted file paths. Capped with a "+N" footer so a huge project never
 * blows the token budget.
 */
export declare function formatProjectTree(filePaths: string[], maxLines: number, omitted: number): string;
//# sourceMappingURL=project-context.d.ts.map