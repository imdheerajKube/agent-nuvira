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

import { appendFile, chmod, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { recordArtifact } from './artifact-append.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { formatUnifiedDiff } from './unified-diff.js';
import type { ToolContext } from './registry.js';
import {
  decideStateChange,
  decideWriteConfirmation,
  isSurgicalEdit,
  requestNamesPath,
} from '../learning/autonomy-policy.js';
import { envelopeCoversAction, envelopeNamesPath } from '../learning/intent-envelope.js';
import { sessionGrantCovers } from '../learning/session-grant.js';
import { grantCategoryOfTool } from './capability-registry.js';

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

type GateResult = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

/**
 * Deny-first workspace gate. Lexically resolves `p` against `root`; refuses
 * absolute paths elsewhere and `..` escapes. Realpath verification happens
 * per-tool (it needs the target to exist and to catch symlink escapes).
 *
 * NOTE: `rel` (the display path) uses the NATIVE separator, matching the
 * pre-existing convention of these coding tools — `write_file` has always
 * reported `deep\nested\new-file.ts` on Windows. Callers asserting on it must
 * build expectations with `join`/`sep` rather than hard-coded slashes.
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

/**
 * A tool result that says the operation FAILED, in the one place the tool loop
 * reads.
 *
 * WHY THE PREFIX, and why this is not cosmetic. The loop's accounting is
 * `ok: !result.startsWith('Error:')` (`tool-loop.ts:1526`; the child's copy is
 * `child-agent-runtime.ts:405`), and everything downstream trusts that flag: the
 * dashboard renders a green step card, the verification gate counts an ok call as
 * proof, and the model's next move depends on knowing that nothing was read.
 *
 * MEASURED, and the reason this exists: `read_file` on a missing path and
 * `list_dir` on a missing directory both reported `ok: true` on every one of the
 * five surfaces — found by the parity harness while a failing-tool scenario was
 * being chosen. A read that never happened, counted as work, is exactly the
 * false-success defect this repo already has a tracker and a shared contract for
 * (`tool-refusal.ts`).
 *
 * A REFUSAL GOES THROUGH HERE TOO. An empty path, a boundary denial, a binary
 * file, a path that is a directory — every one of them did NO WORK, and the rule
 * this repo settled for `run_terminal` is that doing no work is not a success:
 * an empty command, a denied command and a command still waiting on approval are
 * all `Error:` there, and `tests/tools/run-terminal.test.ts` pins it ("no-op
 * refusals are FAILURES"). `ToolRefusal` is the same idea on the typed side — it
 * carries `ok: false` (`tool-refusal.ts`). So there is exactly one case in these
 * tools where doing nothing is a success: a glob that matched nothing, because
 * the search itself ran. Everything else says so.
 *
 * `classifyToolRefusal` (`tool-loop.ts:2203`) still records WHICH refusal it was
 * for the trace — it matches the phrasing, not the prefix, so a denial is both an
 * `Error:` for the accounting and a `gate: 'workspace'` refusal in the record.
 *
 * (Named `failureResult`, not `failed`, because `runEditFile` destructures a
 * local `failed` out of `applyPairs` — the shadowing would silently pick the
 * boolean and the compiler only caught it because a boolean is not callable.)
 */
function failureResult(tool: string, detail: string): string {
  return `Error: ${tool}: ${detail}`;
}

/** Cheap binary sniff — a NUL byte in the first 8KB means "don't inject". */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * Extensions `read_extract` turns into text (mirrors read-extract.ts
 * IMPLEMENTED_FORMATS). Used only to phrase the binary refusal: a PDF/DOCX a
 * user asks about must hear the reader that CAN open it, by name.
 */
const READ_EXTRACT_EXTS = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.html', '.htm', '.csv', '.tsv',
  '.json', '.xml', '.yaml', '.yml', '.txt', '.md', '.markdown', '.text', '.log',
]);

/**
 * The alternative to name in a binary `read_file` refusal. `read_extract` is a
 * CORE tool (toolsets.ts), so this refusal never points at a tool the model
 * cannot call.
 */
function binaryReadAlternative(rel: string): string {
  const dot = rel.lastIndexOf('.');
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : '';
  if (READ_EXTRACT_EXTS.has(ext)) {
    return `call read_extract with filePath '${rel}' to extract its text.`;
  }
  return 'for a document (PDF/DOCX/XLSX/PPTX), call read_extract to extract its text.';
}

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
export type ReadFileEntry = string | { path: string; offset?: number; limit?: number };

interface ReadOneResult {
  rel: string;
  /**
   * Why the file could not be read. Never a partial success: the caller turns
   * every one of these into the `Error:` result the loop reads — see
   * `failureResult`.
   */
  error?: string;
  total?: number;
  bytes?: number;
  body?: string;
  offset?: number;
  endLine?: number;
  truncated?: boolean;
}

/**
 * Read + number ONE already-gated file. `charCap` bounds the returned body so
 * a batched read can allocate its remaining budget per file. Never throws —
 * every failure is returned as an `error` string for the caller to embed.
 */
async function readOneFile(
  gated: { abs: string; rel: string },
  offsetRaw: number | undefined,
  limitRaw: number | undefined,
  charCap: number,
): Promise<ReadOneResult> {
  const offset = Math.max(1, Math.floor(offsetRaw ?? 1));
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(limitRaw ?? MAX_READ_LINES)));

  let info;
  try {
    info = await stat(gated.abs);
  } catch (err) {
    return { rel: gated.rel, error: `cannot stat '${gated.rel}': ${(err as Error).message}` };
  }
  if (info.isDirectory()) {
    return { rel: gated.rel, error: `'${gated.rel}' is a directory — use list_dir to see its contents.` };
  }

  let data: Buffer;
  try {
    data = await readFile(gated.abs);
  } catch (err) {
    return { rel: gated.rel, error: `cannot read '${gated.rel}': ${(err as Error).message}` };
  }
  if (looksBinary(data)) {
    return {
      rel: gated.rel,
      error:
        `'${gated.rel}' looks binary (${info.size} bytes) — its bytes are not text, so reading it `
        + `into context is not useful; ${binaryReadAlternative(gated.rel)}`,
    };
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
export async function runReadFile(args: ReadFileArgs, ctx: ToolContext): Promise<string> {
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    return runBatchedRead(args, ctx);
  }

  const rawPath = args.path;
  if (!rawPath) {
    return failureResult('read_file', "no path given — pass 'path' (one file) or 'paths' (several in one call).");
  }
  const gated = await gateReal(ctx.cwd, rawPath);
  if (!gated.ok) return failureResult('read_file', gated.reason);

  const r = await readOneFile(gated, args.offset, args.limit, MAX_READ_CHARS);
  if (r.error) return failureResult('read_file', r.error);
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
async function runBatchedRead(args: ReadFileArgs, ctx: ToolContext): Promise<string> {
  const raw: ReadFileEntry[] = [
    ...(args.path ? [args.path] : []),
    ...(Array.isArray(args.paths) ? args.paths : []),
  ];
  if (raw.length === 0) {
    return failureResult('read_file', "no paths given — pass 'paths' with at least one entry.");
  }
  const overflow = raw.length > MAX_BATCH_READ_ENTRIES;
  const entries = raw.slice(0, MAX_BATCH_READ_ENTRIES).map((e) =>
    typeof e === 'string' ? { path: e } : { path: e.path, offset: e.offset, limit: e.limit },
  );

  const sections: string[] = [];
  const seen = new Map<string, number>(); // rel → first entry index (1-based)
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
    remaining -= r.body!.length;
    const cont = r.truncated ? ` (truncated — continue at offset ${r.endLine! + 1})` : '';
    sections.push(`### ${r.rel} (${r.total} lines, ${r.bytes} bytes) — lines ${r.offset}–${r.endLine}${cont}\n${r.body}`);
  }

  const header = [
    `read_file: ${entries.length} file${entries.length === 1 ? '' : 's'} requested, ${readCount} read — ${MAX_BATCH_READ_CHARS - remaining} chars used`,
    `(shared budget ${MAX_BATCH_READ_CHARS} chars; per-file cap ${MAX_READ_CHARS})${overflow ? ` (capped at ${MAX_BATCH_READ_ENTRIES} entries)` : ''}`,
  ].join(' ');
  // A batch that read NOTHING did no work, so the whole call reports as a failure
  // even though each section is phrased as an inline note. A batch that read SOME
  // of what it asked for succeeded — the failures stay inline, where a partial
  // result is exactly what the caller asked for.
  return [readCount === 0 ? failureResult('read_file', header) : header, ...sections].join('\n\n');
}

/** ─── list_dir ───────────────────────────────────────────────────────────── */

export interface ListDirArgs {
  path?: string;
}

export async function runListDir(args: ListDirArgs, ctx: ToolContext): Promise<string> {
  const target = args.path && args.path !== '' ? args.path : '.';
  const gated = await gateReal(ctx.cwd, target);
  if (!gated.ok) return failureResult('list_dir', gated.reason);
  // `relative(root, root)` is '' — display the workspace root as '.', not nothing.
  const display = gated.rel === '' ? '.' : gated.rel;

  let entries;
  try {
    entries = await readdir(gated.abs, { withFileTypes: true });
  } catch (err) {
    // ENOTDIR (a file, not a directory) and any permission/IO failure land here:
    // the listing did not happen, so the model must not be told that it did.
    return failureResult('list_dir', `cannot read '${gated.rel}': ${(err as Error).message}`);
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

/**
 * The message a WRITE returns when the turn has NO workspace at all.
 *
 * MEASURED (2026-10-07, Cluster G). A dashboard turn can run with nothing
 * attached: no folder in the request, none attached earlier in the
 * conversation, none named in the user's message, and no configured
 * `dashboard.cwd`. Its `ctx.cwd` then falls back to the directory the DASHBOARD
 * PROCESS was started from — a deployment directory that belongs to nobody
 * asking the question. A `write_file` there is the worst of both worlds: the
 * user cannot see it, cannot find it afterwards, and the agent reports success
 * on a file in an unrelated tree.
 *
 * So the write does NOT happen, and — this is the part that makes it "gently
 * ask" rather than "refuse" — the result names the exact ask to make and the
 * three answers that are honoured. It follows the {@link confirmFirst}
 * precedent: no work, plus the model's precise next move. The alternative,
 * today's behaviour for an ask that slips past the workspace guard, is a silent
 * write into the process's own cwd.
 */
function unscopedWriteRefusal(tool: string, path: string): string {
  return [
    `${tool}: no project folder is attached to this chat, so there is nowhere to put '${path}' — nothing was written.`,
    '',
    'Call `ask_user` ONCE and ask which folder to use, offering these ways out:',
    '  • attach a folder in the dashboard (the **Select Project Folder** box above the composer);',
    '  • paste the folder\'s absolute path in their reply — then the next write lands inside it;',
    '  • or confirm they want the file created outside any project.',
    'Then retry this call with a path INSIDE the folder they name.',
    '',
    'Do NOT retry this call unchanged, and do NOT say the file was created — it was not.',
  ].join('\n');
}

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

/** Per-replacement outcome recorded during the transactional pass. */
interface PairOutcome {
  index: number;
  ok: boolean;
  reason?: string;
  occurrences?: number;
  startLine?: number;
  endLine?: number;
  addedLines?: number;
  removedLines?: number;
}

/** Normalize the legacy single pair and/or the batched array into one list. */
function normalizePairs(args: EditFileArgs): EditReplacement[] {
  const pairs: EditReplacement[] = [];
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
function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

/** 1-based line number of a character position. */
function lineAt(content: string, pos: number): number {
  return content.slice(0, pos).split('\n').length;
}

/** Logical line count — a trailing newline does not add an empty line. */
function logicalLineCount(text: string): number {
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

/**
 * Apply every replacement in order against the EVOLVING content. Returns the
 * fully-edited text plus per-pair outcomes; `failed` is true when any pair
 * could not be applied (the caller then writes nothing).
 */
function applyPairs(content: string, pairs: EditReplacement[]): { working: string; outcomes: PairOutcome[]; failed: boolean } {
  let working = content;
  const outcomes: PairOutcome[] = [];
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
function formatOutcomeLine(o: PairOutcome): string {
  const span = o.startLine === o.endLine ? `line ${o.startLine}` : `lines ${o.startLine}–${o.endLine}`;
  const times = o.occurrences && o.occurrences > 1 ? ` (×${o.occurrences})` : '';
  return `  ✓ #${o.index + 1} ${span}${times}: −${o.removedLines} +${o.addedLines} line(s)`;
}

/**
 * Durable single-file write: write a sibling temp file, preserve the target's
 * mode, then `rename` over the target. `rename` within a directory is atomic,
 * so a crash can leave the OLD file or the NEW file — never a truncated one.
 */
async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(abs)).mode & 0o7777;
  } catch {
    // Target missing/unreadable — proceed without mode preservation.
  }
  try {
    await writeFile(tmp, content, 'utf-8');
    if (mode !== undefined) {
      try {
        await chmod(tmp, mode);
      } catch {
        // Best-effort mode preservation.
      }
    }
    await rename(tmp, abs);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
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
export async function runEditFile(args: EditFileArgs, ctx: ToolContext): Promise<string> {
  const pairs = normalizePairs(args);
  const multi = pairs.length > 1;
  const dryRun = args.dry_run === true;

  if (pairs.length === 0) {
    return "edit_file: no replacement given — pass old_string/new_string (single) or replacements[] (batch).";
  }
  // Cluster G — see `unscopedWriteRefusal`. A dry run reads nothing on disk, so
  // it stays allowed; anything that would WRITE asks where first.
  if (ctx.workspaceUnscoped && !dryRun) return unscopedWriteRefusal('edit_file', args.path);
  const gated = await gateReal(ctx.cwd, args.path);
  if (!gated.ok) return failureResult('edit_file', gated.reason);

  let content: string;
  try {
    content = await readFile(gated.abs, 'utf-8');
  } catch (err) {
    // Same defect as read_file's: an edit whose read failed did not apply, so it
    // must not be counted as a call that succeeded.
    return failureResult('edit_file', `cannot read '${gated.rel}': ${(err as Error).message}`);
  }

  const { working, outcomes, failed } = applyPairs(content, pairs);

  if (failed) {
    const report = outcomes.map((o) =>
      o.ok
        ? `  ✓ #${o.index + 1}: would apply (line${o.startLine === o.endLine ? '' : `s`} ${o.startLine}${o.startLine === o.endLine ? '' : `–${o.endLine}`})`
        : `  ✗ #${o.index + 1}: ${o.reason}`,
    );
    return [
      `edit_file: NO changes applied — ${outcomes.filter((o) => !o.ok).length} of ${pairs.length} replacement(s) failed. All-or-nothing: nothing was written to '${gated.rel}'.`,
      ...report,
      `Re-read '${gated.rel}' and retry the whole batch with exact matches.`,
    ].join('\n');
  }

  // ── G16: decide the gate with EVIDENCE, and only after validating ────────
  // Two things were wrong with asking first. (1) The user was asked to approve
  // an edit whose `old_string` might not even match — the approval was spent on
  // a change that would then fail. (2) Every iteration of the verify loop this
  // design is built around (run → read the failure → edit → re-run) needed a
  // human. So: validate first (above), then decide with what the tool can
  // measure — does the request name this file, and is the edit surgical (small
  // relative to the file, which is what makes it recoverable)?
  let decidedAutonomously = false;
  let autonomyReason = '';
  if (!args.confirm && !dryRun) {
    const fileChars = content.length;
    const oldChars = pairs.reduce((n, p) => n + (p.old_string ?? '').length, 0);
    const newChars = pairs.reduce((n, p) => n + (p.new_string ?? '').length, 0);
    const touched = Math.max(oldChars, newChars);
    const share = fileChars > 0 ? Math.round((touched / fileChars) * 100) : 100;
    // The durable grant is consulted FIRST: inside an approved intent, the edit
    // is EXECUTION, not a new decision — which is the whole point of agreeing
    // the work once instead of confirming it per keystroke. When there is no
    // envelope, the original evidence-based judgment runs unchanged.
    const envVerdict = envelopeCoversAction(ctx.envelope, {
      tool: 'edit_file',
      path: gated.rel,
      changeClass: 'modify',
    });
    // The explicit SESSION grant — "allow all file writes for this session" — is
    // consulted next, and covers the modify class it names. It is the user's own
    // go-ahead, so unlike a request-derived envelope it does not need the file
    // named; that is the deliberate difference the grant exists for.
    const editGrant = grantCategoryOfTool('edit_file');
    const grantCovers = editGrant !== null && sessionGrantCovers(ctx.planStore, editGrant);
    const verdict = envVerdict.covered || grantCovers
      ? {
          action: 'proceed' as const,
          reason: envVerdict.covered ? envVerdict.reason : 'allowed for this session by the user',
        }
      : decideStateChange({
          tool: 'edit_file',
          action: `rewriting ${share}% of '${gated.rel}'`,
          changeClass: 'modify',
          namedByRequest: requestNamesPath(ctx.authorizationRequest ?? '', gated.rel),
          recoverable: isSurgicalEdit(fileChars, oldChars, newChars),
          authorizedByRequest: ctx.writesAuthorized?.authorized === true,
        });
    if (verdict.action !== 'proceed') {
      // Mark the confirmation so the ask reaches the user (not suppressed) and
      // can offer the session write grant.
      ctx.pendingConfirmation = { tool: 'edit_file', command: gated.rel, category: 'write' };
      const question = multi
        ? `Apply ${pairs.length} replacements to ${gated.rel}?`
        : `Apply this edit to ${gated.rel}? — replace "${abbrev(pairs[0].old_string)}" with "${abbrev(pairs[0].new_string)}"`;
      return (
        `edit_file: state-changing — NOT applied (${verdict.reason}). ` +
        `Ask the user first via ask_user ("${question}" with a one-line summary), ` +
        'then retry edit_file with confirm:true once they approve.'
      );
    }
    decidedAutonomously = true;
    autonomyReason = verdict.reason;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'edit_file',
      path: gated.rel,
      share,
      reason: verdict.reason,
      authorization: ctx.writesAuthorized?.reason,
    }, 'tool-loop');
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
  } catch (err) {
    return `edit_file: write failed on '${gated.rel}': ${(err as Error).message}`;
  }

  // Single-pair keeps its original, byte-compatible message.
  let result: string;
  if (!multi) {
    const o = outcomes[0];
    const what = o.occurrences! > 1 && pairs[0].allow_multiple
      ? `all ${o.occurrences} occurrences`
      : `lines ${o.startLine}${o.endLine !== o.startLine ? `–${o.endLine}` : ''}`;
    result = `edit_file: applied to '${gated.rel}' (${what}). Written ${pairs[0].new_string.length} chars. Re-read the file to verify the change.`;
  } else {
    const oldLineCount = logicalLineCount(content);
    const newLineCount = logicalLineCount(working);
    const delta = newLineCount - oldLineCount;
    result = [
      `edit_file: applied ${pairs.length} replacement(s) to '${gated.rel}' (${oldLineCount} → ${newLineCount} lines, ${delta >= 0 ? '+' : ''}${delta}).`,
      ...outcomes.map(formatOutcomeLine),
      diff ? `\n${diff}` : '\n(diff omitted — file too large to summarize inline)',
    ].join('\n');
  }
  if (!decidedAutonomously) return result;
  // Reported, never silent: a judgment call the user cannot see is
  // indistinguishable from a bug.
  return (
    `${result}\n💡 Applied without asking: ${autonomyReason}. State the change plainly in your answer — ` +
    'do not ask for permission to do work the user already asked for.'
  );
}

/** ─── write_file (create / overwrite / append, confirmation-gated) ────────── */

export interface WriteFileArgs {
  path: string;
  content: string;
  /**
   * `overwrite` (default) replaces the file; `append` adds to the end.
   *
   * WHY APPEND EXISTS (measured 2026-10-07). A dashboard turn asked to "deliver
   * complete document" emitted `write_file` 61 times and failed 59 of them: the
   * document was larger than a single model output, so the arguments arrived
   * empty and there was no way to build the file up in pieces — the tool could
   * only overwrite. The model kept re-sending the same impossible call until the
   * step bound. Append is that missing affordance: section one creates the file,
   * every later section appends, and the deliverable is still ONE file.
   */
  mode?: 'overwrite' | 'append';
  confirm?: boolean;
}

/**
 * Write the content of a file — create, overwrite, or APPEND (see
 * {@link WriteFileArgs.mode}). Parent dirs are created. Deny-first on the path —
 * the target may not exist yet, so the gate realpaths the nearest EXISTING
 * ancestor (catches symlinked-parent escapes) instead of the target itself.
 */
export async function runWriteFile(args: WriteFileArgs, ctx: ToolContext): Promise<string> {
  // Cluster G — the turn has no workspace of the user's, so `ctx.cwd` is the
  // dashboard process's own directory. Refuse, and tell the model to ASK where
  // the file should go (see `unscopedWriteRefusal`). Checked BEFORE the path
  // gate so the model gets the actionable message rather than a boundary denial
  // about a directory nobody chose.
  if (ctx.workspaceUnscoped) return unscopedWriteRefusal('write_file', args.path);
  const gated = await gateWrite(ctx.cwd, args.path);
  if (!gated.ok) return `write_file: ${gated.reason}`;

  const existed = existsSync(gated.abs);
  const append = args.mode === 'append';

  // ── G13: the gate needs to know WHAT the user asked for ────────────────────
  // The gate was binary — confirm or refuse — so a run whose ask was "write a
  // 12 page story" stopped to ask "Do you want me to create the files?". The
  // autonomy policy supplies the missing input: creating a file the request
  // asked for, where nothing exists yet, destroys nothing and is undone by
  // deleting it, so it proceeds and REPORTS the decision. Authorization is
  // absent without a loop context and overwriting stays gated either way.
  let decidedAutonomously = false;
  if (!args.confirm) {
    // Consult the durable grant first, then the per-request judgment.
    const envVerdict = envelopeCoversAction(ctx.envelope, {
      tool: 'write_file',
      path: gated.rel,
      changeClass: existed ? 'modify' : 'create',
    });
    // A whole-file REPLACE is inside the grant only when the envelope NAMES the
    // path. A project-wide grant (“fix the calculator”) must not authorize
    // clobbering a file the request never mentioned — a re-run cannot recover a
    // wholesale overwrite, so that stays the user’s call. CREATING a file the
    // intent covers is safe either way.
    const writeGrant = grantCategoryOfTool('write_file');
    const grantCovers = writeGrant !== null && sessionGrantCovers(ctx.planStore, writeGrant);
    const verdict =
      (envVerdict.covered && (!existed || envelopeNamesPath(ctx.envelope, gated.rel))) || grantCovers
        ? {
            action: 'proceed' as const,
            reason: envVerdict.covered ? envVerdict.reason : 'allowed for this session by the user',
          }
        : decideWriteConfirmation({
            tool: 'write_file',
            path: gated.rel,
            exists: existed,
            authorizedByRequest: ctx.writesAuthorized?.authorized === true,
          });
    if (verdict.action !== 'proceed') {
      ctx.pendingConfirmation = { tool: 'write_file', command: gated.rel, category: 'write' };
      return confirmFirst('write_file', args.path, `writing ${args.content.length} chars${abbrev(args.content) ? ` ("${abbrev(args.content)}")` : ''}`);
    }
    decidedAutonomously = true;
    ctx.emit?.('autonomy:write-applied', {
      tool: 'write_file',
      path: gated.rel,
      reason: verdict.reason,
      authorization: ctx.writesAuthorized?.reason,
    }, 'tool-loop');
  }

  try {
    await mkdir(dirname(gated.abs), { recursive: true });
    if (append) await appendFile(gated.abs, args.content, 'utf-8');
    else await writeFile(gated.abs, args.content, 'utf-8');
  } catch (err) {
    return `write_file: write failed on '${gated.rel}': ${(err as Error).message}`;
  }
  // I3 — a written file IS a deliverable. Record it on the session's artifact
  // store (when the surface has one) so the dashboard's Artifacts tab shows what
  // this turn actually produced instead of always reading 0. Best-effort by
  // construction: the sink is optional and `push` never throws.
  recordArtifact(ctx.artifacts, {
    kind: 'file',
    title: gated.rel,
    path: gated.abs,
    sizeBytes: Buffer.byteLength(args.content, 'utf-8'),
  });
  const outcome = append
    ? `write_file: appended to '${gated.rel}' (${args.content.length} chars added).`
    : `write_file: ${existed ? 'overwrote' : 'created'} '${gated.rel}' (${args.content.length} chars).`;
  if (!decidedAutonomously) return outcome;
  // Reported, never silent: the model must tell the user what it decided, or
  // the judgment call is indistinguishable from a bug.
  return (
    `${outcome}\n💡 Applied without asking: the request already authorized creating this file ` +
    'and nothing existed at that path. State plainly in your answer that you created it — do not ' +
    'ask for permission to do work the user already asked for.'
  );
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
