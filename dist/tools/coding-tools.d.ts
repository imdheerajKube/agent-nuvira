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
 *
 * Beyond parity (round-trip reduction):
 * - `read_file` accepts `paths` to read MANY files in one call under a shared
 *   character budget, with per-file errors, dedup, and continuation offsets —
 *   one step instead of many.
 * - `edit_file` accepts `replacements` to apply SEVERAL edits to one file in
 *   one call, TRANSACTIONALLY (all-or-nothing), written ATOMICALLY, and
 *   reported with a unified diff. `dry_run` previews without writing.
 * Both keep the original single-item forms byte-for-byte, so nothing that
 * called them before changes behavior.
 */
import type { ToolContext } from './registry.js';
/** ─── read_file ──────────────────────────────────────────────────────────── */
export interface ReadFileArgs {
    /** Single file to read (the original form). */
    path?: string;
    /**
     * Several files to read in ONE call. Each entry is a path, or an object
     * `{ path, offset, limit }` to window that file. Reads share a bounded
     * character budget; every entry gets its own section (and its own error),
     * so one bad path never discards the rest.
     */
    paths?: ReadFileEntry[];
    /** First line number for the single-file form (1-based). */
    offset?: number;
    /** Max lines for the single-file form. */
    limit?: number;
}
/** One entry in a batched read. */
export type ReadFileEntry = string | {
    path: string;
    offset?: number;
    limit?: number;
};
/**
 * `read_file` — open one file (legacy form) or MANY files in one call
 * (batched form). Batching is the round-trip reducer: reading N files is one
 * tool call, one step, one result — instead of N of each. The single-file
 * output is byte-for-byte the original so existing callers/tests are
 * unaffected; only `paths` opts into the batched shape.
 */
export declare function runReadFile(args: ReadFileArgs, ctx: ToolContext): Promise<string>;
/** ─── list_dir ───────────────────────────────────────────────────────────── */
export interface ListDirArgs {
    path?: string;
}
export declare function runListDir(args: ListDirArgs, ctx: ToolContext): Promise<string>;
/** One exact-text replacement (the batched form's unit). */
export interface EditReplacement {
    old_string: string;
    new_string: string;
    allow_multiple?: boolean;
}
export interface EditFileArgs {
    path: string;
    /** Exact text to find (single-pair form). */
    old_string?: string;
    /** Replacement text (single-pair form; empty string deletes). */
    new_string?: string;
    /** Replace ALL occurrences of `old_string` (single-pair form). */
    allow_multiple?: boolean;
    /**
     * Batched form: several replacements applied to this ONE file in a single
     * call, in order. They are TRANSACTIONAL — if any single replacement fails
     * to match, NOTHING is written, so a refactor can never half-apply.
     */
    replacements?: EditReplacement[];
    /** Validate + preview the change but write nothing (no confirmation needed). */
    dry_run?: boolean;
    confirm?: boolean;
}
/**
 * A surgical exact-text edit — the same primitive a human AI agent uses:
 * find the exact old text, replace with new. Supports SEVERAL replacements in
 * one call (batched), applied TRANSACTIONALLY (all-or-nothing), written
 * ATOMICALLY, and reported with a real unified diff. Refuses ambiguous
 * matches (multiple occurrences without allow_multiple) and reports
 * not-found distinctly so the model re-reads the file. Deny-first on the path
 * (gateReal — file must exist inside the workspace). `dry_run` validates +
 * previews without writing and needs no confirmation.
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