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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { platform } from 'node:os';
import { rgPath } from '@vscode/ripgrep';
import { logger } from './logger.js';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES_FS = 1 * 1024 * 1024;
/** Directories + names skipped by default (fs fallback; rg respects .gitignore). */
const DEFAULT_IGNORE = [
    'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache',
    '.turbo', '.DS_Store', 'vendor', '.venv', '__pycache__', 'addon',
];
// ─── Engine selection ───────────────────────────────────────────────────────
/**
 * Resolve a ripgrep binary: the `@vscode/ripgrep` bundled per-platform path
 * first, then `rg` on PATH. Returns null when neither exists.
 */
export function resolveRipgrepBinary() {
    try {
        if (rgPath && existsSync(rgPath))
            return rgPath;
    }
    catch {
        // Bundled binary unavailable on this platform — fall through to PATH.
    }
    const names = platform() === 'win32' ? ['rg.exe', 'rg'] : ['rg'];
    for (const dir of (process.env.PATH || '').split(platform() === 'win32' ? ';' : ':')) {
        if (!dir)
            continue;
        for (const name of names) {
            try {
                const candidate = join(dir, name);
                if (existsSync(candidate))
                    return candidate;
            }
            catch {
                // Unreadable path segment — keep scanning.
            }
        }
    }
    return null;
}
// ─── Public API ─────────────────────────────────────────────────────────────
/**
 * Search code for `pattern` (regex or literal). Never throws — failures come
 * back as `error` on the result. `engine: 'auto'` uses ripgrep when a binary
 * is available, otherwise the fs fallback.
 */
export async function searchCode(pattern, options = {}) {
    const startedAt = Date.now();
    const engine = options.engine ?? 'auto';
    const binary = engine === 'fs' ? null : resolveRipgrepBinary();
    if (binary) {
        try {
            const result = await searchWithRipgrep(binary, pattern, options, startedAt);
            if (engine === 'ripgrep')
                return result;
            // Auto: keep the rg result unless rg errored AND found nothing (invalid
            // regex, bad flags) — then degrade to the fs walker for a graceful answer.
            if (result.matches.length > 0 || result.error === undefined)
                return result;
            // Observable degradation: a warn keeps the silent fallback debuggable
            // (the caller still gets a useful fs answer, but knows rg failed first).
            logger.warn(`ripgrep search failed (${result.error}); falling back to fs walker`);
        }
        catch (err) {
            // rg crashed (spawn error, etc.) — fall through to the fs walker.
            const message = err instanceof Error ? err.message : String(err);
            if (engine === 'ripgrep') {
                return {
                    engine: 'ripgrep', matches: [], truncated: false, timedOut: false,
                    durationMs: Date.now() - startedAt,
                    error: message,
                };
            }
            logger.warn(`ripgrep failed to run (${message}); falling back to fs walker`);
        }
    }
    return searchWithFs(pattern, options, startedAt);
}
// ─── Ripgrep engine ─────────────────────────────────────────────────────────
function searchWithRipgrep(binary, pattern, options, startedAt) {
    return new Promise((resolvePromise) => {
        const cwd = resolve(options.cwd ?? process.cwd());
        const maxResults = options.maxResults ?? 100;
        // Mirror the fs fallback's DEFAULT_IGNORE so both engines agree on what
        // is excluded (rg otherwise only respects .gitignore).
        const defaultExcludes = DEFAULT_IGNORE.flatMap((name) => ['--glob', `!**/${name}/**`, '--glob', `!**/${name}`]);
        const args = [
            '--json',
            '--line-number',
            '--no-messages',
            // No --max-count: unlimited per-file by default; we cap TOTAL matches on
            // our side (rg emits one match object per line).
            // Case-insensitive by default (matches the fs fallback's 'i' flag);
            // opt-in to case-sensitivity for both engines.
            ...(options.caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
            ...(options.wholeWord ? ['--word-regexp'] : []),
            ...defaultExcludes,
            ...(options.globs ?? []).map((g) => ['--glob', g]).flat(),
            '--',
            pattern,
            '.', // relative root — spawn cwd is the search root
        ];
        // Spawn with cwd + a RELATIVE root ('.'): rg globs are anchored to the
        // path start, so an absolute search root breaks include globs like
        // 'src/**'. A relative root keeps both globs AND the emitted paths
        // relative to the search root.
        const child = spawn(binary, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const matches = [];
        let truncated = false;
        let timedOut = false;
        let stderr = '';
        let buffer = '';
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            // kill() is async — data already buffered in the pipe can still arrive
            // after we truncated. Ignore it so maxResults stays exact.
            if (truncated || timedOut)
                return;
            buffer += chunk.toString();
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (!line.trim())
                    continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.type !== 'match' || !obj.data)
                        continue;
                    const data = obj.data;
                    // rg emits paths in the same form as the search root — an absolute
                    // cwd yields absolute paths. Relativize against cwd so both engines
                    // report the same `file` (e.g. 'src/main.ts').
                    const pathText = data.path?.text ?? '';
                    const isAbsolute = pathText.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathText);
                    const file = toPosix(relative(cwd, isAbsolute ? pathText : join(cwd, pathText)));
                    const linesText = (data.lines?.text ?? '').replace(/\r?\n$/, '');
                    const submatch = data.submatches?.[0];
                    matches.push({
                        file,
                        line: data.line_number ?? 0,
                        column: (submatch?.start ?? 0) + 1,
                        text: linesText,
                        matchText: submatch?.match?.text ?? '',
                    });
                    if (matches.length >= maxResults) {
                        truncated = true;
                        child.kill('SIGKILL');
                        break;
                    }
                }
                catch {
                    // Non-JSON line (shouldn't happen with --json) — ignore.
                }
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolvePromise({
                engine: 'ripgrep', matches, truncated, timedOut,
                durationMs: Date.now() - startedAt,
                error: err.message,
            });
        });
        child.on('close', () => {
            clearTimeout(timer);
            // rg exits 2 on invalid regex / bad flags — surface the reason.
            const error = stderr.trim() ? stderr.trim().split('\n')[0] : undefined;
            resolvePromise({
                engine: 'ripgrep',
                matches,
                truncated,
                timedOut,
                durationMs: Date.now() - startedAt,
                ...(error ? { error } : {}),
            });
        });
    });
}
// ─── FS fallback engine ─────────────────────────────────────────────────────
function searchWithFs(pattern, options, startedAt) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const maxResults = options.maxResults ?? 100;
    const caseSensitive = options.caseSensitive ?? false;
    const flags = `${caseSensitive ? '' : 'i'}u`;
    let regex;
    try {
        regex = new RegExp(options.wholeWord ? `\\b${pattern}\\b` : pattern, flags);
    }
    catch {
        // Invalid regex → treat the pattern as a literal.
        const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(options.wholeWord ? `\\b${literal}\\b` : literal, flags);
    }
    const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
    const matches = [];
    const walked = [];
    const start = Date.now();
    const walk = (dir) => {
        if (Date.now() - start > (options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (matches.length >= maxResults)
                return;
            const name = entry.name;
            if (ignore.has(name))
                continue;
            // rg skips hidden files/dirs by default — mirror that in the fallback.
            if (name.startsWith('.') && !ignore.has(name))
                continue;
            const full = join(dir, name);
            let stat;
            try {
                stat = statSync(full);
            }
            catch {
                continue;
            }
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!stat.isFile())
                continue;
            if (stat.size > MAX_FILE_BYTES_FS)
                continue;
            const rel = toPosix(relative(cwd, full));
            if (!matchesGlobs(rel, options.globs))
                continue;
            walked.push(rel);
            let content;
            try {
                content = readFileSync(full, 'utf-8');
            }
            catch {
                continue;
            }
            if (content.length === 0)
                continue;
            // Skip binary files (null byte in the first 8 KB).
            if (content.slice(0, 8192).includes('\0'))
                continue;
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                const m = lines[i].match(regex);
                if (m) {
                    matches.push({
                        file: rel,
                        line: i + 1,
                        column: (m.index ?? 0) + 1,
                        text: lines[i],
                        matchText: m[0],
                    });
                }
            }
        }
    };
    walk(cwd);
    return {
        engine: 'fs',
        matches,
        truncated: matches.length >= maxResults,
        timedOut: Date.now() - start > (options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        durationMs: Date.now() - startedAt,
    };
}
// ─── Small helpers ──────────────────────────────────────────────────────────
function toPosix(p) {
    return p.split(sep).join('/');
}
/** Whether a relative path passes the include/exclude glob list. */
function matchesGlobs(rel, globs) {
    if (!globs || globs.length === 0)
        return true;
    const includes = globs.filter((g) => !g.startsWith('!'));
    const excludes = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
    if (excludes.some((g) => globToRegExp(g).test(rel)))
        return false;
    if (includes.length === 0)
        return true;
    return includes.some((g) => globToRegExp(g).test(rel));
}
/** Minimal glob → RegExp (supports **, *, ?, and directory prefixes). */
function globToRegExp(glob) {
    const src = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__DOUBLE_STAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/__DOUBLE_STAR__/g, '.*');
    // 'src/**' should also match files directly under src/.
    const normalized = src.endsWith('/.*') ? `${src}|${src.slice(0, -3)}[^/]*` : src;
    return new RegExp(`^${normalized}$`);
}
//# sourceMappingURL=code-search.js.map