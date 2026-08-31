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

import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** ─── edit_file (str_replace-style surgical edit, confirmation-gated) ──── */

/**
 * The confirmation-gate message every state-changing coding tool returns
 * when `confirm` is not set — the model must call ask_user first, then
 * retry with confirm:true (the run_cli precedent, applied to edits).
 */
function confirmFirst(tool: string, path: string, what: string): string {
  return `${tool}: state-changing — NOT applied. Ask the user first via ask_user ("Apply ${what} to ${path}?" with a one-line summary), then retry ${tool} with confirm:true once they approve.`;
}

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
export async function runEditFile(args: EditFileArgs, ctx: ToolContext): Promise<string> {
  if (!args.confirm) {
    return confirmFirst('edit_file', args.path, `this edit: replace "${abbrev(args.old_string)}" with "${abbrev(args.new_string)}"`);
  }
  if (!args.old_string || args.old_string === '') {
    return 'edit_file: old_string must not be empty (use write_file to replace the whole file).';
  }

  const gated = await gateReal(ctx.cwd, args.path);
  if (!gated.ok) return `edit_file: ${gated.reason}`;

  let content: string;
  try {
    content = await readFile(gated.abs, 'utf-8');
  } catch (err) {
    return `edit_file: cannot read '${gated.rel}': ${(err as Error).message}`;
  }

  const firstIdx = content.indexOf(args.old_string);
  if (firstIdx === -1) {
    return `edit_file: old_string not found in '${gated.rel}'. Re-read the file and retry with the exact text — the match is literal, including whitespace.`;
  }

  let occurrences = 0;
  let idx = 0;
  while ((idx = content.indexOf(args.old_string, idx)) !== -1) {
    occurrences += 1;
    idx += args.old_string.length;
  }
  if (occurrences > 1 && !args.allow_multiple) {
    return `edit_file: '${args.old_string}' occurs ${occurrences} times in '${gated.rel}' — ambiguous. Set allow_multiple:true to replace all, or include more surrounding text to narrow the match.`;
  }

  const lineAt = (pos: number): number => content.slice(0, pos).split('\n').length;
  const startLine = lineAt(firstIdx);
  const endLine = lineAt(firstIdx + args.old_string.length);
  const next = args.allow_multiple
    ? content.split(args.old_string).join(args.new_string)
    : content.slice(0, firstIdx) + args.new_string + content.slice(firstIdx + args.old_string.length);

  try {
    await writeFile(gated.abs, next, 'utf-8');
  } catch (err) {
    return `edit_file: write failed on '${gated.rel}': ${(err as Error).message}`;
  }

  const what = occurrences > 1 && args.allow_multiple
    ? `all ${occurrences} occurrences`
    : `lines ${startLine}${endLine !== startLine ? `–${endLine}` : ''}`;
  return `edit_file: applied to '${gated.rel}' (${what}). Written ${args.new_string.length} chars. Re-read the file to verify the change.`;
}

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
export async function runWriteFile(args: WriteFileArgs, ctx: ToolContext): Promise<string> {
  if (!args.confirm) {
    return confirmFirst('write_file', args.path, `writing ${args.content.length} chars${abbrev(args.content) ? ` ("${abbrev(args.content)}")` : ''}`);
  }
  const gated = await gateWrite(ctx.cwd, args.path);
  if (!gated.ok) return `write_file: ${gated.reason}`;

  const existed = existsSync(gated.abs);
  try {
    await mkdir(dirname(gated.abs), { recursive: true });
    await writeFile(gated.abs, args.content, 'utf-8');
  } catch (err) {
    return `write_file: write failed on '${gated.rel}': ${(err as Error).message}`;
  }
  return `write_file: ${existed ? 'overwrote' : 'created'} '${gated.rel}' (${args.content.length} chars).`;
}

/** A short preview of a value for confirmation messages (60 chars max). */
function abbrev(s: string | undefined, max = 60): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * Deny-first gate for WRITES: the target may not exist yet, so realpath the
 * nearest existing ancestor (the target's parent or the first existing dir
 * above it) and require it inside the workspace — a symlinked parent or
 * `..` traversal is denied before any byte is written.
 */
async function gateWrite(root: string | undefined, p: string): Promise<GateResult> {
  const lexical = gatePath(root, p);
  if (!lexical.ok) return lexical;
  try {
    const base = root || process.cwd();
    let probe = dirname(lexical.abs);
    while (!existsSync(probe)) {
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const [realBase, realProbe] = await Promise.all([realpath(base), realpath(probe)]);
    const rel = relative(realBase, realProbe);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { ok: false, reason: `path '${p}' resolves outside the workspace (${base}) — denied` };
    }
    return lexical;
  } catch (err) {
    return { ok: false, reason: `cannot access '${p}': ${(err as Error).message}` };
  }
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
