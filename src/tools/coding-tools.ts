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
 * use as a coding agent: read with line numbers + offset/limit, list a
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

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolContext } from './registry.js';

/** Max characters returned by read_file (a 40MB file must not flood context). */
const MAX_READ_CHARS = 60000;
/** Max lines returned per read_file call (mirrors the agent's own windowing). */
const MAX_READ_LINES = 2000;
/** Max glob matches returned (bounded walk). */
const MAX_GLOB_RESULTS = 500;

type GateResult = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

/**
 * Deny-first workspace gate. Lexically resolves `p` against `root`; refuses
 * absolute paths elsewhere and `..` escapes. Realpath verification happens
 * per-tool (it needs the target to exist and to catch symlink escapes).
 */
function gatePath(root: string | undefined, p: string): GateResult {
  const base = root || process.cwd();
  if (p === '') return { ok: false, reason: 'empty path' };
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
async function gateReal(root: string | undefined, p: string): Promise<GateResult> {
  const lexical = gatePath(root, p);
  if (!lexical.ok) return lexical;
  try {
    const base = root || process.cwd();
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(lexical.abs)]);
    const rel = relative(realBase, realTarget);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, reason: `path '${p}' resolves outside the workspace (${base}) — denied` };
    }
    return { ok: true, abs: lexical.abs, rel: lexical.rel };
  } catch (err) {
    // realpath fails when the target doesn't exist — surface that distinctly.
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? `no such file or directory: ${p}` : `cannot access '${p}': ${(err as Error).message}` };
  }
}

/** Cheap binary sniff — a NUL byte in the first 8KB means "don't inject". */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

/** ─── read_file ──────────────────────────────────────────────────────────── */

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export async function runReadFile(args: ReadFileArgs, ctx: ToolContext): Promise<string> {
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(args.limit ?? MAX_READ_LINES)));

  const gated = await gateReal(ctx.cwd, args.path);
  if (!gated.ok) return `read_file: ${gated.reason}`;

  let info;
  try {
    info = await stat(gated.abs);
  } catch (err) {
    return `read_file: cannot stat '${gated.rel}': ${(err as Error).message}`;
  }
  if (info.isDirectory()) {
    return `read_file: '${gated.rel}' is a directory — use list_dir to see its contents.`;
  }

  let data: Buffer;
  try {
    data = await readFile(gated.abs);
  } catch (err) {
    return `read_file: cannot read '${gated.rel}': ${(err as Error).message}`;
  }
  if (looksBinary(data)) {
    return `read_file: '${gated.rel}' looks binary (${info.size} bytes) — reading it into context is not useful.`;
  }

  // A trailing newline must not count as an extra empty line.
  const text = data.toString('utf-8').replace(/\n$/, '');
  const lines = text.split('\n');
  const total = lines.length;
  const startIdx = offset - 1;
  const slice = lines.slice(startIdx, startIdx + limit);

  // Number lines, then apply the char cap with a truncation note.
  const numbered = slice.map((l, i) => `${startIdx + i + 1}: ${l}`).join('\n');
  let out = numbered;
  let truncatedLines = false;
  if (numbered.length > MAX_READ_CHARS) {
    out = numbered.slice(0, MAX_READ_CHARS);
    truncatedLines = true;
  }
  const truncatedTotal = offset + slice.length - 1;
  const note = [
    `read_file: ${gated.rel} (${total} lines, ${info.size} bytes)`,
    `showing lines ${offset}–${truncatedTotal}${truncatedLines ? ' (truncated — pass offset/limit to continue)' : ''}:`,
  ].join('\n');
  return `${note}\n${out}`;
}

/** ─── list_dir ───────────────────────────────────────────────────────────── */

export interface ListDirArgs {
  path?: string;
}

export async function runListDir(args: ListDirArgs, ctx: ToolContext): Promise<string> {
  const target = args.path && args.path !== '' ? args.path : '.';
  const gated = await gateReal(ctx.cwd, target);
  if (!gated.ok) return `list_dir: ${gated.reason}`;
  // `relative(root, root)` is '' — display the workspace root as '.', not nothing.
  const display = gated.rel === '' ? '.' : gated.rel;

  let entries;
  try {
    entries = await readdir(gated.abs, { withFileTypes: true });
  } catch (err) {
    return `list_dir: cannot read '${gated.rel}': ${(err as Error).message}`;
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

/** ─── glob ───────────────────────────────────────────────────────────────── */

/** Convert one glob segment (`*`, `?`) to a per-segment regex. `**` handled by the walker. */
function segmentToRegExp(segment: string): RegExp {
  let re = '';
  for (const ch of segment) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface GlobArgs {
  pattern: string;
  max_results?: number;
}

/**
 * Walk the workspace matching glob segments with `**` (zero+ dirs), `*` and
 * `?` within a segment. Deny-first on the pattern itself: absolute patterns
 * or `..` escapes are refused before any walk.
 */
export async function runGlob(args: GlobArgs, ctx: ToolContext): Promise<string> {
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
  if (segments.length === 0) return `glob: empty pattern.`;

  const results: string[] = [];

  const walk = async (dir: string, idx: number): Promise<void> => {
    if (results.length >= max) return;
    if (idx === segments.length) {
      if (results.length < max) results.push(relative(base, dir) || '.');
      return;
    }
    const seg = segments[idx];
    if (seg === '**') {
      // `**` matches zero or more directory levels.
      await walk(dir, idx + 1);
      let children;
      try {
        children = await readdir(dir, { withFileTypes: true });
      } catch {
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
    } catch {
      return;
    }
    for (const e of children) {
      if (results.length >= max) return;
      if (!matcher.test(e.name)) continue;
      const next = join(dir, e.name);
      if (idx === segments.length - 1) {
        results.push(relative(base, next));
      } else if (e.isDirectory()) {
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
