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
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatUnifiedDiff } from './unified-diff.js';
/** Max characters returned by read_file (a 40MB file must not flood context). */
const MAX_READ_CHARS = 60000;
/** Max lines returned per read_file call (mirrors the agent's own windowing). */
const MAX_READ_LINES = 2000;
/** Max glob matches returned (bounded walk). */
const MAX_GLOB_RESULTS = 500;
/** Max file entries accepted in one batched read (bounds fs work per call). */
const MAX_BATCH_READ_ENTRIES = 40;
/** Shared character budget across a whole batched read (~30K tokens ≈ 120K chars). */
const MAX_BATCH_READ_CHARS = 120_000;
/**
 * Deny-first workspace gate. Lexically resolves `p` against `root`; refuses
 * absolute paths elsewhere and `..` escapes. Realpath verification happens
 * per-tool (it needs the target to exist and to catch symlink escapes).
 */
function gatePath(root, p) {
    const base = root || process.cwd();
    if (p === '')
        return { ok: false, reason: 'empty path' };
    const abs = isAbsolute(p) ? p : resolve(base, p);
    const rel = relative(base, abs);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { ok: false, reason: `path '${p}' escapes the workspace (${base}) — denied` };
    }
    return { ok: true, abs, rel };
}
/**
 * Symlink-aware variant for tools that OPEN something: realpaths both the
 * target and the workspace root and requires the target to stay inside.
 * A symlink inside the workspace pointing outside is an escape — denied.
 */
async function gateReal(root, p) {
    const lexical = gatePath(root, p);
    if (!lexical.ok)
        return lexical;
    try {
        const base = root || process.cwd();
        const [realBase, realTarget] = await Promise.all([realpath(base), realpath(lexical.abs)]);
        const rel = relative(realBase, realTarget);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            return { ok: false, reason: `path '${p}' resolves outside the workspace (${base}) — denied` };
        }
        return { ok: true, abs: lexical.abs, rel: lexical.rel };
    }
    catch (err) {
        // realpath fails when the target doesn't exist — surface that distinctly.
        const code = err.code;
        return { ok: false, reason: code === 'ENOENT' ? `no such file or directory: ${p}` : `cannot access '${p}': ${err.message}` };
    }
}
/** Cheap binary sniff — a NUL byte in the first 8KB means "don't inject". */
function looksBinary(buf) {
    const probe = buf.subarray(0, 8192);
    return probe.includes(0);
}
/**
 * Read + number ONE already-gated file. `charCap` bounds the returned body so
 * a batched read can allocate its remaining budget per file. Never throws —
 * every failure is returned as an `error` string for the caller to embed.
 */
async function readOneFile(gated, offsetRaw, limitRaw, charCap) {
    const offset = Math.max(1, Math.floor(offsetRaw ?? 1));
    const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limitRaw ?? MAX_READ_LINES)));
    let info;
    try {
        info = await stat(gated.abs);
    }
    catch (err) {
        return { rel: gated.rel, error: `cannot stat '${gated.rel}': ${err.message}` };
    }
    if (info.isDirectory()) {
        return { rel: gated.rel, error: `'${gated.rel}' is a directory — use list_dir to see its contents.` };
    }
    let data;
    try {
        data = await readFile(gated.abs);
    }
    catch (err) {
        return { rel: gated.rel, error: `cannot read '${gated.rel}': ${err.message}` };
    }
    if (looksBinary(data)) {
        return { rel: gated.rel, error: `'${gated.rel}' looks binary (${info.size} bytes) — reading it into context is not useful.` };
    }
    // A trailing newline must not count as an extra empty line.
    const text = data.toString('utf-8').replace(/\n$/, '');
    const lines = text.split('\n');
    const total = lines.length;
    const startIdx = offset - 1;
    const slice = lines.slice(startIdx, startIdx + limit);
    // Number lines, then apply the char cap with a truncation note.
    const numbered = slice.map((l, i) => `${startIdx + i + 1}: ${l}`).join('\n');
    let body = numbered;
    let truncated = false;
    if (numbered.length > charCap) {
        body = numbered.slice(0, Math.max(0, charCap));
        truncated = true;
    }
    return {
        rel: gated.rel,
        total,
        bytes: info.size,
        body,
        offset,
        endLine: offset + slice.length - 1,
        truncated,
    };
}
/**
 * `read_file` — open one file (legacy form) or MANY files in one call
 * (batched form). Batching is the round-trip reducer: reading N files is one
 * tool call, one step, one result — instead of N of each. The single-file
 * output is byte-for-byte the original so existing callers/tests are
 * unaffected; only `paths` opts into the batched shape.
 */
export async function runReadFile(args, ctx) {
    if (Array.isArray(args.paths) && args.paths.length > 0) {
        return runBatchedRead(args, ctx);
    }
    const rawPath = args.path;
    if (!rawPath) {
        return `read_file: no path given — pass 'path' (one file) or 'paths' (several in one call).`;
    }
    const gated = await gateReal(ctx.cwd, rawPath);
    if (!gated.ok)
        return `read_file: ${gated.reason}`;
    const r = await readOneFile(gated, args.offset, args.limit, MAX_READ_CHARS);
    if (r.error)
        return `read_file: ${r.error}`;
    const note = [
        `read_file: ${r.rel} (${r.total} lines, ${r.bytes} bytes)`,
        `showing lines ${r.offset}–${r.endLine}${r.truncated ? ' (truncated — pass offset/limit to continue)' : ''}:`,
    ].join('\n');
    return `${note}\n${r.body}`;
}
/**
 * Batched read: gate + read each entry, dedup repeats, and enforce a SHARED
 * character budget so a 20-file call cannot flood the context. Every entry
 * produces its own labelled section — a missing/denied/binary file reports
 * inline and the rest still read. Order is preserved (the result maps back to
 * the caller's entry order).
 */
async function runBatchedRead(args, ctx) {
    const raw = [
        ...(args.path ? [args.path] : []),
        ...(Array.isArray(args.paths) ? args.paths : []),
    ];
    if (raw.length === 0) {
        return `read_file: no paths given — pass 'paths' with at least one entry.`;
    }
    const overflow = raw.length > MAX_BATCH_READ_ENTRIES;
    const entries = raw.slice(0, MAX_BATCH_READ_ENTRIES).map((e) => typeof e === 'string' ? { path: e } : { path: e.path, offset: e.offset, limit: e.limit });
    const sections = [];
    const seen = new Map(); // rel → first entry index (1-based)
    let remaining = MAX_BATCH_READ_CHARS;
    let readCount = 0;
    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (!entry.path || entry.path === '') {
            sections.push(`### (entry #${i + 1}) — not read (empty path)`);
            continue;
        }
        const gated = await gateReal(ctx.cwd, entry.path);
        if (!gated.ok) {
            sections.push(`### ${entry.path} — not read (${gated.reason})`);
            continue;
        }
        const prior = seen.get(gated.rel);
        if (prior !== undefined) {
            sections.push(`### ${gated.rel} — duplicate of entry #${prior} (skipped)`);
            continue;
        }
        seen.set(gated.rel, i + 1);
        if (remaining <= 0) {
            sections.push(`### ${gated.rel} — not read (batch budget exhausted — read this file directly with read_file)`);
            continue;
        }
        const r = await readOneFile(gated, entry.offset, entry.limit, Math.min(MAX_READ_CHARS, remaining));
        if (r.error) {
            sections.push(`### ${gated.rel} — not read (${r.error})`);
            continue;
        }
        readCount += 1;
        remaining -= r.body.length;
        const cont = r.truncated ? ` (truncated — continue at offset ${r.endLine + 1})` : '';
        sections.push(`### ${r.rel} (${r.total} lines, ${r.bytes} bytes) — lines ${r.offset}–${r.endLine}${cont}\n${r.body}`);
    }
    const header = [
        `read_file: ${entries.length} file${entries.length === 1 ? '' : 's'} requested, ${readCount} read — ${MAX_BATCH_READ_CHARS - remaining} chars used`,
        `(shared budget ${MAX_BATCH_READ_CHARS} chars; per-file cap ${MAX_READ_CHARS})${overflow ? ` (capped at ${MAX_BATCH_READ_ENTRIES} entries)` : ''}`,
    ].join(' ');
    return [header, ...sections].join('\n\n');
}
export async function runListDir(args, ctx) {
    const target = args.path && args.path !== '' ? args.path : '.';
    const gated = await gateReal(ctx.cwd, target);
    if (!gated.ok)
        return `list_dir: ${gated.reason}`;
    // `relative(root, root)` is '' — display the workspace root as '.', not nothing.
    const display = gated.rel === '' ? '.' : gated.rel;
    let entries;
    try {
        entries = await readdir(gated.abs, { withFileTypes: true });
    }
    catch (err) {
        return `list_dir: cannot read '${gated.rel}': ${err.message}`;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
    const rows = [
        ...dirs.map((d) => `  📁 ${d}/`),
        ...files.map((f) => `  📄 ${f}`),
    ];
    const hidden = entries.filter((e) => e.name.startsWith('.')).length;
    return [
        `list_dir: ${display} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${dirs.length} dir, ${files.length} file${files.length === 1 ? '' : 's'}${hidden ? `, ${hidden} hidden` : ''}):`,
        ...rows,
    ].join('\n');
}
/** ─── edit_file (str_replace-style surgical edit, confirmation-gated) ──── */
/**
 * The confirmation-gate message every state-changing coding tool returns
 * when `confirm` is not set — the model must call ask_user first, then
 * retry with confirm:true (the run_cli precedent, applied to edits).
 */
function confirmFirst(tool, path, what) {
    return `${tool}: state-changing — NOT applied. Ask the user first via ask_user ("Apply ${what} to ${path}?" with a one-line summary), then retry ${tool} with confirm:true once they approve.`;
}
/** Normalize the legacy single pair and/or the batched array into one list. */
function normalizePairs(args) {
    const pairs = [];
    if (args.old_string !== undefined || args.new_string !== undefined) {
        pairs.push({ old_string: args.old_string ?? '', new_string: args.new_string ?? '', allow_multiple: args.allow_multiple });
    }
    if (Array.isArray(args.replacements)) {
        for (const r of args.replacements) {
            pairs.push({ old_string: r.old_string, new_string: r.new_string, allow_multiple: r.allow_multiple });
        }
    }
    return pairs;
}
/** Count non-overlapping occurrences of `needle` in `hay`. */
function countOccurrences(hay, needle) {
    if (needle === '')
        return 0;
    let count = 0;
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
        count += 1;
        idx += needle.length;
    }
    return count;
}
/** 1-based line number of a character position. */
function lineAt(content, pos) {
    return content.slice(0, pos).split('\n').length;
}
/** Logical line count — a trailing newline does not add an empty line. */
function logicalLineCount(text) {
    if (text === '')
        return 0;
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}
/**
 * Apply every replacement in order against the EVOLVING content. Returns the
 * fully-edited text plus per-pair outcomes; `failed` is true when any pair
 * could not be applied (the caller then writes nothing).
 */
function applyPairs(content, pairs) {
    let working = content;
    const outcomes = [];
    let failed = false;
    for (let i = 0; i < pairs.length; i += 1) {
        const pair = pairs[i];
        if (!pair.old_string || pair.old_string === '') {
            outcomes.push({ index: i, ok: false, reason: 'old_string is empty (use write_file to replace the whole file)' });
            failed = true;
            continue;
        }
        const occurrences = countOccurrences(working, pair.old_string);
        if (occurrences === 0) {
            outcomes.push({ index: i, ok: false, reason: 'old_string not found — re-read the file; the match is literal, including whitespace' });
            failed = true;
            continue;
        }
        if (occurrences > 1 && !pair.allow_multiple) {
            outcomes.push({ index: i, ok: false, reason: `ambiguous — occurs ${occurrences} times (set allow_multiple:true, or include more surrounding text)` });
            failed = true;
            continue;
        }
        const idx = working.indexOf(pair.old_string);
        const startLine = lineAt(working, idx);
        const endLine = lineAt(working, idx + pair.old_string.length);
        working = pair.allow_multiple
            ? working.split(pair.old_string).join(pair.new_string)
            : working.slice(0, idx) + pair.new_string + working.slice(idx + pair.old_string.length);
        outcomes.push({
            index: i,
            ok: true,
            occurrences,
            startLine,
            endLine,
            addedLines: pair.new_string === '' ? 0 : pair.new_string.split('\n').length,
            removedLines: pair.old_string.split('\n').length,
        });
    }
    return { working, outcomes, failed };
}
/** One-line human summary of an applied replacement. */
function formatOutcomeLine(o) {
    const span = o.startLine === o.endLine ? `line ${o.startLine}` : `lines ${o.startLine}–${o.endLine}`;
    const times = o.occurrences && o.occurrences > 1 ? ` (×${o.occurrences})` : '';
    return `  ✓ #${o.index + 1} ${span}${times}: −${o.removedLines} +${o.addedLines} line(s)`;
}
/**
 * Durable single-file write: write a sibling temp file, preserve the target's
 * mode, then `rename` over the target. `rename` within a directory is atomic,
 * so a crash can leave the OLD file or the NEW file — never a truncated one.
 */
async function atomicWriteFile(abs, content) {
    const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    let mode;
    try {
        mode = (await stat(abs)).mode & 0o7777;
    }
    catch {
        // Target missing/unreadable — proceed without mode preservation.
    }
    try {
        await writeFile(tmp, content, 'utf-8');
        if (mode !== undefined) {
            try {
                await chmod(tmp, mode);
            }
            catch {
                // Best-effort mode preservation.
            }
        }
        await rename(tmp, abs);
    }
    catch (err) {
        try {
            await unlink(tmp);
        }
        catch {
            // Temp already gone.
        }
        throw err;
    }
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
export async function runEditFile(args, ctx) {
    const pairs = normalizePairs(args);
    const multi = pairs.length > 1;
    const dryRun = args.dry_run === true;
    if (pairs.length === 0) {
        return "edit_file: no replacement given — pass old_string/new_string (single) or replacements[] (batch).";
    }
    if (!args.confirm && !dryRun) {
        if (multi) {
            return `edit_file: state-changing — NOT applied. Ask the user first via ask_user ("Apply ${pairs.length} replacements to ${args.path}?" with a one-line summary), then retry edit_file with confirm:true once they approve.`;
        }
        return confirmFirst('edit_file', args.path, `this edit: replace "${abbrev(pairs[0].old_string)}" with "${abbrev(pairs[0].new_string)}"`);
    }
    const gated = await gateReal(ctx.cwd, args.path);
    if (!gated.ok)
        return `edit_file: ${gated.reason}`;
    let content;
    try {
        content = await readFile(gated.abs, 'utf-8');
    }
    catch (err) {
        return `edit_file: cannot read '${gated.rel}': ${err.message}`;
    }
    const { working, outcomes, failed } = applyPairs(content, pairs);
    if (failed) {
        const report = outcomes.map((o) => o.ok
            ? `  ✓ #${o.index + 1}: would apply (line${o.startLine === o.endLine ? '' : `s`} ${o.startLine}${o.startLine === o.endLine ? '' : `–${o.endLine}`})`
            : `  ✗ #${o.index + 1}: ${o.reason}`);
        return [
            `edit_file: NO changes applied — ${outcomes.filter((o) => !o.ok).length} of ${pairs.length} replacement(s) failed. All-or-nothing: nothing was written to '${gated.rel}'.`,
            ...report,
            `Re-read '${gated.rel}' and retry the whole batch with exact matches.`,
        ].join('\n');
    }
    // Compute the diff once (used by dry_run and the multi-pair result).
    const needDiff = multi || dryRun;
    const diff = needDiff ? formatUnifiedDiff(content.split('\n'), working.split('\n'), { path: gated.rel }) : null;
    if (dryRun) {
        return [
            `edit_file (dry_run): ${pairs.length} replacement(s) validated for '${gated.rel}' — nothing written.`,
            ...outcomes.map(formatOutcomeLine),
            diff ? `\n${diff}` : '\n(diff omitted — file too large to summarize inline)',
        ].join('\n');
    }
    try {
        await atomicWriteFile(gated.abs, working);
    }
    catch (err) {
        return `edit_file: write failed on '${gated.rel}': ${err.message}`;
    }
    // Single-pair keeps its original, byte-compatible message.
    if (!multi) {
        const o = outcomes[0];
        const what = o.occurrences > 1 && pairs[0].allow_multiple
            ? `all ${o.occurrences} occurrences`
            : `lines ${o.startLine}${o.endLine !== o.startLine ? `–${o.endLine}` : ''}`;
        return `edit_file: applied to '${gated.rel}' (${what}). Written ${pairs[0].new_string.length} chars. Re-read the file to verify the change.`;
    }
    const oldLineCount = logicalLineCount(content);
    const newLineCount = logicalLineCount(working);
    const delta = newLineCount - oldLineCount;
    return [
        `edit_file: applied ${pairs.length} replacement(s) to '${gated.rel}' (${oldLineCount} → ${newLineCount} lines, ${delta >= 0 ? '+' : ''}${delta}).`,
        ...outcomes.map(formatOutcomeLine),
        diff ? `\n${diff}` : '\n(diff omitted — file too large to summarize inline)',
    ].join('\n');
}
/**
 * Write the full content of a file (create or overwrite). Parent dirs are
 * created. Deny-first on the path — the target may not exist yet, so the
 * gate realpaths the nearest EXISTING ancestor (catches symlinked-parent
 * escapes) instead of the target itself.
 */
export async function runWriteFile(args, ctx) {
    if (!args.confirm) {
        return confirmFirst('write_file', args.path, `writing ${args.content.length} chars${abbrev(args.content) ? ` ("${abbrev(args.content)}")` : ''}`);
    }
    const gated = await gateWrite(ctx.cwd, args.path);
    if (!gated.ok)
        return `write_file: ${gated.reason}`;
    const existed = existsSync(gated.abs);
    try {
        await mkdir(dirname(gated.abs), { recursive: true });
        await writeFile(gated.abs, args.content, 'utf-8');
    }
    catch (err) {
        return `write_file: write failed on '${gated.rel}': ${err.message}`;
    }
    return `write_file: ${existed ? 'overwrote' : 'created'} '${gated.rel}' (${args.content.length} chars).`;
}
/** A short preview of a value for confirmation messages (60 chars max). */
function abbrev(s, max = 60) {
    if (!s)
        return '';
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}
/**
 * Deny-first gate for WRITES: the target may not exist yet, so realpath the
 * nearest existing ancestor (the target's parent or the first existing dir
 * above it) and require it inside the workspace — a symlinked parent or
 * `..` traversal is denied before any byte is written.
 */
async function gateWrite(root, p) {
    const lexical = gatePath(root, p);
    if (!lexical.ok)
        return lexical;
    try {
        const base = root || process.cwd();
        let probe = dirname(lexical.abs);
        while (!existsSync(probe)) {
            const up = dirname(probe);
            if (up === probe)
                break;
            probe = up;
        }
        const [realBase, realProbe] = await Promise.all([realpath(base), realpath(probe)]);
        const rel = relative(realBase, realProbe);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            return { ok: false, reason: `path '${p}' resolves outside the workspace (${base}) — denied` };
        }
        return lexical;
    }
    catch (err) {
        return { ok: false, reason: `cannot access '${p}': ${err.message}` };
    }
}
/** ─── glob ───────────────────────────────────────────────────────────────── */
/** Convert one glob segment (`*`, `?`) to a per-segment regex. `**` handled by the walker. */
function segmentToRegExp(segment) {
    let re = '';
    for (const ch of segment) {
        if (ch === '*')
            re += '[^/]*';
        else if (ch === '?')
            re += '[^/]';
        else
            re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}
/**
 * Walk the workspace matching glob segments with `**` (zero+ dirs), `*` and
 * `?` within a segment. Deny-first on the pattern itself: absolute patterns
 * or `..` escapes are refused before any walk.
 */
export async function runGlob(args, ctx) {
    const base = ctx.cwd || process.cwd();
    const max = Math.min(MAX_GLOB_RESULTS, Math.max(1, Math.floor(args.max_results ?? 200)));
    const pattern = args.pattern.trim().replace(/\/+$/, '');
    // Deny-first on the pattern shape.
    if (pattern.startsWith('/') || pattern.startsWith(sep)) {
        return `glob: absolute pattern '${args.pattern}' denied — patterns are relative to the workspace (${base}).`;
    }
    const segments = pattern.split('/');
    if (segments.some((s) => s === '..')) {
        return `glob: pattern '${args.pattern}' escapes the workspace — denied.`;
    }
    if (segments.length === 0)
        return `glob: empty pattern.`;
    const results = [];
    const walk = async (dir, idx) => {
        if (results.length >= max)
            return;
        if (idx === segments.length) {
            if (results.length < max)
                results.push(relative(base, dir) || '.');
            return;
        }
        const seg = segments[idx];
        if (seg === '**') {
            // `**` matches zero or more directory levels.
            await walk(dir, idx + 1);
            let children;
            try {
                children = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return; // unreadable subtree — skip silently, like a real glob
            }
            for (const e of children) {
                if (e.isDirectory() && results.length < max) {
                    await walk(join(dir, e.name), idx);
                }
            }
            return;
        }
        const matcher = segmentToRegExp(seg);
        let children;
        try {
            children = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of children) {
            if (results.length >= max)
                return;
            if (!matcher.test(e.name))
                continue;
            const next = join(dir, e.name);
            if (idx === segments.length - 1) {
                results.push(relative(base, next));
            }
            else if (e.isDirectory()) {
                await walk(next, idx + 1);
            }
        }
    };
    await walk(base, 0);
    if (results.length === 0) {
        return `glob: no files match '${args.pattern}' under ${base}.`;
    }
    const truncated = results.length >= max ? '\n(truncated — narrowing the pattern or checking a subdirectory gives the rest)' : '';
    return `glob: ${results.length} match${results.length === 1 ? '' : 'es'} for '${args.pattern}' (relative to ${base})${truncated}\n${results.join('\n')}`;
}
//# sourceMappingURL=coding-tools.js.map