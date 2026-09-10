/**
 * P0.2 — Coding perception tools (`src/tools/coding-tools.ts`).
 *
 * The interactive file-access layer that converts the chat agent from a
 * "window that fires pipelines" into a partner that can READ the project:
 * `read_file` / `list_dir` / `glob` — the perception half of the `coding`
 * toolset (the action half — `edit_file` / `write_file` / `run_terminal` —
 * is P0.3/P0.4).
 *
 * Why these exist (the master-plan brief): the registry had `code_search`
 * but no way to OPEN the files it finds — the agent could locate a bug but
 * never read it. These three tools close that gap with the same surface I
 * use as an AI agent: read with line numbers + offset/limit, list a
 * directory, glob for files.
 *
 * Security model — DENY-FIRST (same rule as the action tools in P0.3/P0.4):
 * every path is resolved against the workspace root (`ctx.cwd`) and any
 * escape — an absolute path outside the workspace, `..` traversal, or a
 * symlink resolving outside — is REFUSED, never resolved. All three tools
 * are read-only, so no confirmation gate is needed, but the boundary is
 * enforced identically so a caller can't silently widen it.
 *
 * Output caps: a huge file must not flood the model context — line cap +
 * character cap with an explicit truncation note, so the model knows the
 * read was partial and can continue with offset/limit.
 */
import type { ToolContext } from './registry.js';
/** ─── read_file ──────────────────────────────────────────────────────────── */
export interface ReadFileArgs {
    path: string;
    offset?: number;
    limit?: number;
}
export declare function runReadFile(args: ReadFileArgs, ctx: ToolContext): Promise<string>;
/** ─── list_dir ───────────────────────────────────────────────────────────── */
export interface ListDirArgs {
    path?: string;
}
export declare function runListDir(args: ListDirArgs, ctx: ToolContext): Promise<string>;
export interface EditFileArgs {
    path: string;
    old_string: string;
    new_string: string;
    allow_multiple?: boolean;
    confirm?: boolean;
}
/**
 * A surgical exact-text replacement — the same edit primitive a human
 * AI agent uses: find the exact old text, replace with new. Refuses
 * ambiguous matches (multiple occurrences without allow_multiple) and
 * reports not-found distinctly so the model re-reads the file. Deny-first
 * on the path (gateReal — file must exist inside the workspace).
 */
export declare function runEditFile(args: EditFileArgs, ctx: ToolContext): Promise<string>;
/** ─── write_file (create / overwrite, confirmation-gated) ───────────────── */
export interface WriteFileArgs {
    path: string;
    content: string;
    confirm?: boolean;
}
/**
 * Write the full content of a file (create or overwrite). Parent dirs are
 * created. Deny-first on the path — the target may not exist yet, so the
 * gate realpaths the nearest EXISTING ancestor (catches symlinked-parent
 * escapes) instead of the target itself.
 */
export declare function runWriteFile(args: WriteFileArgs, ctx: ToolContext): Promise<string>;
export interface GlobArgs {
    pattern: string;
    max_results?: number;
}
/**
 * Walk the workspace matching glob segments with `**` (zero+ dirs), `*` and
 * `?` within a segment. Deny-first on the pattern itself: absolute patterns
 * or `..` escapes are refused before any walk.
 */
export declare function runGlob(args: GlobArgs, ctx: ToolContext): Promise<string>;
//# sourceMappingURL=coding-tools.d.ts.map