/**
 * F2 — Code search helper (`src/utils/code-search.ts`).
 *
 * Ripgrep-powered project search for context gathering + sandbox paths.
 * Resolves the ripgrep binary from the `@vscode/ripgrep` per-platform bundle
 * (the same mechanism VSCode uses — no system install required) with a PATH
 * fallback, and degrades to a pure-JS filesystem walker when no binary is
 * available, so callers can never be broken by a missing tool.
 *
 * The helper is deliberately standalone and never throws: every failure path
 * returns a `CodeSearchResult` with `error` set, matching how the pipeline
 * wants to handle context-gathering failures.
 */
/** One matched line (the shape fed to agents / the pipeline board). */
export interface CodeSearchMatch {
    /** Path relative to the search cwd (posix separators). */
    file: string;
    /** 1-based line number. */
    line: number;
    /** 1-based column of the first match on the line. */
    column: number;
    /** The full matched line text. */
    text: string;
    /** The matched substring (first submatch). */
    matchText: string;
}
export type SearchEngine = 'auto' | 'ripgrep' | 'fs';
export interface CodeSearchOptions {
    /** Search root (defaults to process.cwd()). */
    cwd?: string;
    /**
     * Include/exclude globs, e.g. ['src/**', '!**\/*.test.ts']. Entries starting
     * with '!' are excludes. When only includes are given, everything not
     * matching an include is skipped (in addition to the default ignores).
     */
    globs?: string[];
    /** Extra ignore patterns (dir/file name or path segment). */
    ignore?: string[];
    /** Max matches to return (default 100). */
    maxResults?: number;
    /**
     * Case-sensitive match. Both engines default to case-INSENSITIVE so they
     * agree with each other (deliberate divergence from rg's built-in smart-case
     * — smart-case would make rg sensitive to uppercase patterns while the fs
     * fallback stayed insensitive, silently changing results by engine).
     */
    caseSensitive?: boolean;
    /** Whole-word match only. */
    wholeWord?: boolean;
    /** Kill the search after this many ms (default 15s). */
    timeoutMs?: number;
    /** Force an engine ('auto' picks ripgrep when available). */
    engine?: SearchEngine;
}
export interface CodeSearchResult {
    engine: 'ripgrep' | 'fs';
    matches: CodeSearchMatch[];
    /** True when the result was cut off at maxResults. */
    truncated: boolean;
    /** True when the search was killed by the timeout. */
    timedOut: boolean;
    durationMs: number;
    /** Non-fatal error info (missing binary, invalid regex, rg failure). */
    error?: string;
}
/**
 * Resolve a ripgrep binary: the `@vscode/ripgrep` bundled per-platform path
 * first, then `rg` on PATH. Returns null when neither exists.
 */
export declare function resolveRipgrepBinary(): string | null;
/**
 * Search code for `pattern` (regex or literal). Never throws — failures come
 * back as `error` on the result. `engine: 'auto'` uses ripgrep when a binary
 * is available, otherwise the fs fallback.
 */
export declare function searchCode(pattern: string, options?: CodeSearchOptions): Promise<CodeSearchResult>;
//# sourceMappingURL=code-search.d.ts.map