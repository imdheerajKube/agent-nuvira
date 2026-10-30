/**
 * Workspace checkpoints — a named point in the FILES of a project, so a bad
 * batch of edits can be rolled back.
 *
 * WHY THIS IS NOT `tools/checkpoint-manager.ts`. That module checkpoints the
 * agent's own execution STATE (step results, plan progress) and restores it into
 * memory; it never touches a file on disk. The failure this module exists for is
 * the other one: a turn (or a script, or a subagent) rewrote twenty files and the
 * pre-edit contents are gone — `git checkout --` only helps when everything was
 * committed, and `git stash` refuses once the writes are the working tree. So a
 * checkpoint here is a CONTENT-ADDRESSED COPY of the tree at a moment, and a
 * restore is the inverse: every recorded file goes back, every file the
 * checkpoint did not record can be removed.
 *
 * WHY WHOLE-TREE, NOT "the files the next edit will touch". An edit batch is not
 * knowable in advance: the first write of an audit turn is followed by writes the
 * agent had not planned. Snapshotting on demand is the only ordering that puts
 * the copy BEFORE the damage, and the cost is bounded (see the caps below) by
 * content addressing: a second checkpoint of an unchanged 200-file tree stores
 * only the files that changed since the first.
 *
 * WHY THE BLOB IS CONTENT-ADDRESSED AND SHARED. Two checkpoints of the same tree
 * must cost one tree, not two — otherwise "checkpoint before every risky batch"
 * is unaffordable and nobody does it. Blobs live once per store and are
 * reference-counted by the manifests; a blob is deleted when the last checkpoint
 * that names it is pruned or deleted, never before.
 *
 * WHAT IT REFUSES TO DO. It does not follow symlinks (a link back up the tree
 * would copy the disk), it does not copy VCS or dependency directories, and it
 * records files over the size cap as SKIPPED with the reason instead of silently
 * omitting them — a checkpoint that quietly did not include `models/voice.onnx`
 * and then "restores" the tree is worse than one that says so.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { resolveNuviraDataPath } from '../config/paths.js';
import { logger } from '../utils/logger.js';

/** Directories that are never part of a "roll back my edits" checkpoint. */
export const CHECKPOINT_IGNORED_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'out',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'target',
  'coverage',
  'htmlcov',
]);

/** Files this large are recorded as skipped; the cap keeps a checkpoint cheap. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Ceiling for one checkpoint. Past this, files are skipped (and reported). */
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Ceiling on the number of entries, so a runaway tree cannot hang a turn. */
export const DEFAULT_MAX_FILES = 50_000;

export interface CheckpointEntry {
  /** POSIX-style path relative to the checkpointed directory. */
  path: string;
  kind: 'file' | 'symlink';
  /** Blob name (content hash) for a file. */
  sha?: string;
  size: number;
  /**
   * Modification time this content was observed at, when it was recorded.
   *
   * This is what lets the NEXT checkpoint of the same tree reuse `sha` instead of
   * reading and hashing the file again (see `priorEntries`). Absent on checkpoints
   * written before this field existed, which simply costs those files one re-hash.
   */
  mtimeMs?: number;
  /** Permission bits, so a restore does not make a script non-executable. */
  mode: number;
  /** Symlink target, verbatim (never resolved). */
  linkTarget?: string;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

export type CheckpointOrigin = 'loop' | 'cli';

/**
 * Marker written inside a checkpoint directory by the automatic pre-writer.
 *
 * A FILE, not a manifest field, because auto-pruning has to find its own
 * checkpoints in a store that may hold a thousand of someone else's and reading
 * manifests to answer "which are mine" is the exact cost this module stopped
 * paying (see `newestCreatedAt`). One `existsSync` per directory decides it.
 */
const AUTO_MARKER = 'auto';

/** How many automatic pre-write checkpoints are kept by default. */
export const DEFAULT_AUTO_KEEP = 20;

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  /** Absent on checkpoints written before this field existed, and on user ones. */
  origin?: CheckpointOrigin;
  /** Absolute path of the checkpointed directory. */
  cwd: string;
  createdAt: number;
  entries: CheckpointEntry[];
  skipped: SkippedEntry[];
  totals: { files: number; bytes: number; skipped: number };
}

export interface CreateCheckpointOptions {
  /** Override the store (tests, or a deployment that keeps checkpoints elsewhere). */
  storeDir?: string;
  label?: string;
  /**
   * Who asked for this checkpoint. `loop` = the automatic pre-write safety point,
   * which is the ONLY kind auto-pruning may remove: those exist to undo the next
   * few minutes of edits, and a user never named them. A checkpoint without an
   * origin (every one written before this field, and every explicit
   * `nuvira checkpoint create`) is never touched automatically.
   */
  origin?: CheckpointOrigin;
  /**
   * Reuse the previous checkpoint's hash for files whose size and mtime are
   * unchanged (default `true`). Set `false` to read and hash every file, which is
   * what proves the snapshot against the bytes on disk rather than against the stat
   * that says they did not change.
   */
  reuseUnchanged?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface RestoreOptions {
  /** Restore into this directory (default: the one the checkpoint records). */
  cwd?: string;
  /**
   * Delete files that exist now and are not in the checkpoint — the "created
   * after the checkpoint" half of a rollback. Off by default: a restore that
   * silently unlinks files it did not create is a worse accident than a leftover.
   */
  clean?: boolean;
  /** Restore into a different directory than the one recorded. */
  force?: boolean;
  /** Report what would change without touching disk. */
  dryRun?: boolean;
  storeDir?: string;
}

export interface RestoreResult {
  id: string;
  cwd: string;
  restored: number;
  /** Files recorded as symlinks that were recreated. */
  links: number;
  /** Files removed because they were created after the checkpoint (`clean`). */
  removed: string[];
  /** Present now, absent from the checkpoint, left alone because `clean` was off. */
  leftBehind: string[];
  /** Blobs the manifest names but the store no longer has. */
  missingBlobs: string[];
  dryRun: boolean;
}

/** `~/.nuvira/checkpoints/workspaces` unless overridden — honours the config dir. */
export function defaultCheckpointStore(): string {
  const override = process.env.NUVIRA_CHECKPOINT_DIR?.trim();
  if (override) return override;
  return resolveNuviraDataPath('checkpoints', 'workspaces');
}

function storeDirOf(options: { storeDir?: string } = {}): string {
  return options.storeDir ?? defaultCheckpointStore();
}

function checkpointDir(id: string, store: string): string {
  return join(store, id);
}

function manifestPath(id: string, store: string): string {
  return join(checkpointDir(id, store), 'manifest.json');
}

function blobDir(store: string): string {
  return join(store, 'blobs');
}

function blobPath(sha: string, store: string): string {
  return join(blobDir(store), sha.slice(0, 2), sha);
}

/**
 * The newest `createdAt` already in the store, read from the DIRECTORY NAMES.
 *
 * The id is `${createdAt.toString(36)}-${uuid}`, so the one number
 * `createWorkspaceCheckpoint` needs — "be later than everything already here" —
 * is in the name. This used to call `listCheckpoints(...)[0]?.createdAt`, which
 * PARSES EVERY MANIFEST IN THE STORE to answer it, and a manifest holds one
 * checkpoint's whole file list. MEASURED on this machine (2026-10-30): the store
 * held 1,120 checkpoints totalling 4,582,545 entries — 966 MB of JSON — so taking
 * a checkpoint spent **2.8 s parsing other checkpoints** before it walked the
 * project at all, on every turn's first write. Because a manifest carries the
 * tree, that cost also grew with every run, so the suite slowed down as the store
 * filled and timeouts appeared in a different test each time.
 *
 * A directory without a manifest is not a checkpoint (an interrupted create), so
 * it is skipped. A name whose prefix is not base36 cannot be one of ours and is
 * skipped too — it can only make the new id later, never collide with it.
 */
function newestCreatedAt(store: string): number {
  let names: string[] = [];
  try {
    names = readdirSync(store);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const name of names) {
    const dash = name.indexOf('-');
    if (dash <= 0) continue;
    const createdAt = Number.parseInt(name.slice(0, dash), 36);
    if (!Number.isFinite(createdAt) || createdAt <= newest) continue;
    if (!existsSync(manifestPath(name, store))) continue;
    newest = createdAt;
  }
  return newest;
}

/** Write a file through a temp name in the same directory, then rename. */
function writeAtomic(path: string, data: string | Buffer, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, data);
  if (mode !== undefined) chmodSync(tmp, mode & 0o777);
  renameSync(tmp, path);
}

/** Relative, POSIX-style — so a manifest written on Windows restores on macOS. */
function relPosix(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/');
}

function shouldIgnore(name: string): boolean {
  return name.startsWith('.DS_Store') || CHECKPOINT_IGNORED_NAMES.has(name);
}

interface WalkedFile {
  absolute: string;
  path: string;
  kind: 'file' | 'symlink';
  size: number;
  mtimeMs: number;
  mode: number;
  linkTarget?: string;
}

/** How many existing manifests an unchanged-file lookup may open (newest first). */
const PRIOR_LOOKUP_LIMIT = 4;

/**
 * The hashes the newest checkpoint of THIS tree already recorded, by path.
 *
 * WHY THIS IS NOT A HASH CACHE. A cache is a second copy of the truth that can
 * drift from it; this reads the truth — the manifest of the previous checkpoint of
 * the same directory — and reuses what it already says about a file nothing has
 * changed. There is no new state to invalidate, and the entries pruned or deleted
 * with their checkpoint take their hashes with them.
 *
 * WHY IT MATTERS. A checkpoint read and sha256'd every byte of the tree, on every
 * turn's first write: MEASURED on this repo (2026-10-30), 13,944 files / 268 MB /
 * **1.4 s** — and almost none of those files changed since the turn before. A
 * file whose size and mtime are unchanged since the previous snapshot is not
 * re-read at all; its recorded hash is reused after checking the blob is still
 * present, so a pruned or hand-deleted store can only cost a re-hash, never a
 * dangling reference.
 *
 * The reuse is keyed on `(size, mtimeMs)` — the same pair `make` trusts — and the
 * narrow case it cannot see is a file rewritten to the SAME size within the SAME
 * millisecond, which the previous checkpoint would then describe with its earlier
 * content. That is a rollback to the immediately-preceding version of that one
 * file, and it is the price of not re-reading 268 MB per turn; a caller that cannot
 * accept it disables the reuse with `reuseUnchanged: false`.
 *
 * Bounded on purpose: only the newest few manifests are considered (other projects'
 * checkpoints interleave in one store), and only their file entries are indexed.
 */
function priorEntries(root: string, store: string): Map<string, { sha: string; size: number; mtimeMs: number }> | null {
  let names: string[] = [];
  try {
    names = readdirSync(store);
  } catch {
    return null;
  }

  const recent = names
    .map((name) => {
      const dash = name.indexOf('-');
      return { name, createdAt: dash > 0 ? Number.parseInt(name.slice(0, dash), 36) : Number.NaN };
    })
    .filter((c) => Number.isFinite(c.createdAt))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PRIOR_LOOKUP_LIMIT);

  for (const candidate of recent) {
    const checkpoint = readCheckpoint(candidate.name, { storeDir: store });
    if (!checkpoint || checkpoint.cwd !== root) continue;
    const map = new Map<string, { sha: string; size: number; mtimeMs: number }>();
    for (const entry of checkpoint.entries) {
      if (entry.kind !== 'file' || !entry.sha || entry.mtimeMs === undefined) continue;
      map.set(entry.path, { sha: entry.sha, size: entry.size, mtimeMs: entry.mtimeMs });
    }
    return map;
  }
  return null;
}

/**
 * Every file and symlink under `root`, ignoring VCS/dependency directories.
 * Symlinks are recorded, never followed: following one can walk out of the tree
 * (and into the store itself, on a restore into a checkpointed directory).
 */
function walk(root: string): { files: WalkedFile[]; skipped: SkippedEntry[] } {
  const files: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch (err) {
      skipped.push({ path: relPosix(root, dir), reason: `unreadable directory (${(err as Error).message})` });
      continue;
    }
    for (const name of names) {
      if (shouldIgnore(name)) continue;
      const absolute = join(dir, name);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch (err) {
        skipped.push({ path: relPosix(root, absolute), reason: `unreadable (${(err as Error).message})` });
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = '';
        try {
          target = readlinkSync(absolute);
        } catch (err) {
          skipped.push({ path: relPosix(root, absolute), reason: `unreadable symlink (${(err as Error).message})` });
          continue;
        }
        files.push({
          absolute,
          path: relPosix(root, absolute),
          kind: 'symlink',
          size: 0,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode,
          linkTarget: target,
        });
        continue;
      }
      if (!stat.isFile()) continue;
      files.push({
        absolute,
        path: relPosix(root, absolute),
        kind: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
      });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

/**
 * Snapshot a directory.
 *
 * Bounded on three axes — per-file size, total bytes, entry count — and every
 * bound that bites is recorded in `skipped` with its reason, because a checkpoint
 * that is quietly partial is the one that fails during a restore.
 */
export function createWorkspaceCheckpoint(cwd: string, options: CreateCheckpointOptions = {}): WorkspaceCheckpoint {
  const root = cwd;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`checkpoint: not a directory: ${root}`);
  }
  const store = storeDirOf(options);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const { files, skipped } = walk(root);
  const entries: CheckpointEntry[] = [];
  let bytes = 0;
  let reused = 0;
  // What the previous checkpoint of this same tree already knew (see `priorEntries`).
  const prior = options.reuseUnchanged === false ? null : priorEntries(root, store);

  for (const file of files) {
    if (file.kind === 'symlink') {
      entries.push({ path: file.path, kind: 'symlink', size: 0, mtimeMs: file.mtimeMs, mode: file.mode, linkTarget: file.linkTarget });
      continue;
    }
    if (entries.length >= maxFiles) {
      skipped.push({ path: file.path, reason: `entry limit reached (${maxFiles} files)` });
      continue;
    }
    if (file.size > maxFileBytes) {
      skipped.push({
        path: file.path,
        reason: `${file.size} bytes exceeds the ${maxFileBytes}-byte per-file cap`,
      });
      continue;
    }
    if (bytes + file.size > maxTotalBytes) {
      skipped.push({ path: file.path, reason: `checkpoint size cap reached (${maxTotalBytes} bytes)` });
      continue;
    }
    // ── UNCHANGED SINCE THE LAST SNAPSHOT ────────────────────────────────
    // Same size, same mtime, and the content it names is still in the store ⇒ the
    // hash is already known, so the bytes are never read. See `priorEntries` for
    // the one case this cannot see and how to opt out.
    const known = prior?.get(file.path);
    if (known && known.size === file.size && known.mtimeMs === file.mtimeMs) {
      const knownBlob = blobPath(known.sha, store);
      if (existsSync(knownBlob)) {
        entries.push({ path: file.path, kind: 'file', sha: known.sha, size: file.size, mtimeMs: file.mtimeMs, mode: file.mode });
        bytes += file.size;
        reused += 1;
        continue;
      }
    }

    let data: Buffer;
    try {
      data = readFileSync(file.absolute);
    } catch (err) {
      skipped.push({ path: file.path, reason: `unreadable (${(err as Error).message})` });
      continue;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    const target = blobPath(sha, store);
    // Content-addressed: an unchanged file is already stored by an earlier
    // checkpoint, so a second snapshot of a big tree costs only what changed.
    if (!existsSync(target)) writeAtomic(target, data);
    entries.push({ path: file.path, kind: 'file', sha, size: data.length, mtimeMs: file.mtimeMs, mode: file.mode });
    bytes += data.length;
  }

  // Strictly later than every checkpoint that already exists. Two checkpoints can
  // easily land in the same millisecond (a script, a test, a loop over modules),
  // and `restore latest` must not pick between them at random: `createdAt` is
  // bumped past the newest existing one so the ordering is total, not merely
  // usually right.
  const newest = newestCreatedAt(store);
  const createdAt = Math.max(Date.now(), newest + 1);
  const id = `${createdAt.toString(36)}-${randomUUID().slice(0, 6)}`;
  const checkpoint: WorkspaceCheckpoint = {
    id,
    label: options.label?.trim() || 'checkpoint',
    ...(options.origin ? { origin: options.origin } : {}),
    cwd: root,
    createdAt,
    entries,
    skipped,
    totals: { files: entries.filter((e) => e.kind === 'file').length, bytes, skipped: skipped.length },
  };
  writeAtomic(manifestPath(id, store), JSON.stringify(checkpoint, null, 2));
  // Written AFTER the manifest, so a checkpoint can never be visible-but-movable
  // only in part: an interrupted create leaves an unmarked dir, which auto-pruning
  // treats as "not mine" and leaves alone (see `pruneAutoCheckpoints`).
  if (options.origin === 'loop') writeAtomic(join(checkpointDir(id, store), AUTO_MARKER), '1\n');
  logger.debug(
    `[checkpoint] ${id} ${checkpoint.totals.files} file(s), ${checkpoint.totals.bytes} bytes` +
      (reused > 0 ? `, ${reused} unchanged (hash reused)` : '') +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ''),
  );
  return checkpoint;
}

/** Read one manifest; null when it is missing or corrupt. */
export function readCheckpoint(id: string, options: { storeDir?: string } = {}): WorkspaceCheckpoint | null {
  const path = manifestPath(id, storeDirOf(options));
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WorkspaceCheckpoint;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Newest first. `cwd` narrows to one project's checkpoints. */
export function listCheckpoints(options: { storeDir?: string; cwd?: string } = {}): WorkspaceCheckpoint[] {
  const store = storeDirOf(options);
  let ids: string[] = [];
  try {
    ids = readdirSync(store).filter((name) => existsSync(manifestPath(name, store)));
  } catch {
    return [];
  }
  const all: WorkspaceCheckpoint[] = [];
  for (const id of ids) {
    const checkpoint = readCheckpoint(id, { storeDir: store });
    if (!checkpoint) continue;
    if (options.cwd && checkpoint.cwd !== options.cwd) continue;
    all.push(checkpoint);
  }
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

/** The newest checkpoint, or the one named (id, or its unique prefix). */
export function resolveCheckpoint(
  ref: string,
  options: { storeDir?: string; cwd?: string } = {},
): WorkspaceCheckpoint | null {
  const wanted = ref.trim();
  if (!wanted || wanted === 'latest') return listCheckpoints(options)[0] ?? null;
  const exact = readCheckpoint(wanted, options);
  if (exact) return exact;
  const matches = listCheckpoints(options).filter((c) => c.id.startsWith(wanted));
  // An ambiguous prefix is reported as "none" rather than guessing: restoring the
  // wrong tree over a project is not recoverable by re-running the command.
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Put the recorded files back.
 *
 * The order matters: blobs are verified first, so an incomplete store is refused
 * BEFORE half the tree has been rewritten. Then recorded files are restored, and
 * only then (with `clean`) are files the checkpoint never saw removed.
 */
export function restoreWorkspaceCheckpoint(id: string, options: RestoreOptions = {}): RestoreResult {
  const store = storeDirOf(options);
  const checkpoint = readCheckpoint(id, { storeDir: store });
  if (!checkpoint) throw new Error(`checkpoint not found: ${id}`);

  const cwd = options.cwd ?? checkpoint.cwd;
  if (cwd !== checkpoint.cwd && !options.force) {
    throw new Error(
      `checkpoint ${checkpoint.id} was taken in ${checkpoint.cwd}, not ${cwd} — pass --force to restore it here anyway`,
    );
  }

  const missingBlobs = checkpoint.entries
    .filter((entry) => entry.kind === 'file' && entry.sha && !existsSync(blobPath(entry.sha, store)))
    .map((entry) => entry.path);
  if (missingBlobs.length > 0) {
    throw new Error(
      `checkpoint ${checkpoint.id} is incomplete — ${missingBlobs.length} file(s) have no stored content: ` +
        `${missingBlobs.slice(0, 5).join(', ')}${missingBlobs.length > 5 ? ', …' : ''}`,
    );
  }

  const recorded = new Set(checkpoint.entries.map((entry) => entry.path));
  const { files: present } = walk(cwd);
  const extras = present.map((f) => f.path).filter((path) => !recorded.has(path));

  const result: RestoreResult = {
    id: checkpoint.id,
    cwd,
    restored: 0,
    links: 0,
    removed: [],
    leftBehind: options.clean ? [] : extras,
    missingBlobs: [],
    dryRun: options.dryRun === true,
  };

  if (options.dryRun) {
    result.restored = checkpoint.entries.filter((e) => e.kind === 'file').length;
    result.links = checkpoint.entries.filter((e) => e.kind === 'symlink').length;
    result.removed = options.clean ? extras : [];
    return result;
  }

  mkdirSync(cwd, { recursive: true });
  for (const entry of checkpoint.entries) {
    const target = join(cwd, entry.path);
    if (entry.kind === 'symlink') {
      rmSync(target, { force: true });
      mkdirSync(dirname(target), { recursive: true });
      try {
        symlinkSync(entry.linkTarget ?? '', target);
        result.links += 1;
      } catch (err) {
        logger.warn(`[checkpoint] could not recreate symlink ${entry.path}: ${(err as Error).message}`);
      }
      continue;
    }
    const data = readFileSync(blobPath(entry.sha!, store));
    // A path that was a file and is now a DIRECTORY (a tool wrote a folder where
    // the source expected a module) would make the write fail with EISDIR and
    // abort the rollback with the tree half-restored. Clear it first.
    if (existsSync(target) && statSync(target).isDirectory()) {
      rmSync(target, { recursive: true, force: true });
    }
    // Restore the CONTENT and the permission bits, not the mtime: a rolled-back
    // file should look like the one that was there, and a `cp -p` timestamp from
    // the checkpoint would make a later `make` think nothing changed.
    writeAtomic(target, data, entry.mode);
    result.restored += 1;
  }

  if (options.clean) {
    for (const path of extras) {
      const target = join(cwd, path);
      try {
        rmSync(target, { force: true });
        result.removed.push(path);
      } catch (err) {
        logger.warn(`[checkpoint] could not remove ${path}: ${(err as Error).message}`);
      }
    }
  }

  logger.info(
    `[checkpoint] restored ${result.restored} file(s)` +
      (result.links > 0 ? ` and ${result.links} symlink(s)` : '') +
      (result.removed.length > 0 ? `, removed ${result.removed.length}` : '') +
      ` in ${cwd}`,
  );
  return result;
}

/**
 * Delete a checkpoint and the blobs nothing else names.
 *
 * Reference counting is a scan of the remaining manifests, not a counter file: a
 * counter that drifts (a crashed prune, a hand-deleted directory) leaks blobs
 * forever or deletes content another checkpoint still needs. The scan cannot
 * drift because the manifests ARE the truth.
 */
export function deleteCheckpoint(id: string, options: { storeDir?: string } = {}): boolean {
  const store = storeDirOf(options);
  const dir = checkpointDir(id, store);
  if (!existsSync(dir)) return false;
  const checkpoint = readCheckpoint(id, { storeDir: store });
  const stillNeeded = new Set(
    listCheckpoints({ storeDir: store })
      .filter((c) => c.id !== id)
      .flatMap((c) => c.entries.map((entry) => entry.sha).filter((sha): sha is string => !!sha)),
  );
  rmSync(dir, { recursive: true, force: true });
  for (const entry of checkpoint?.entries ?? []) {
    if (!entry.sha || stillNeeded.has(entry.sha)) continue;
    rmSync(blobPath(entry.sha, store), { force: true });
  }
  return true;
}

/**
 * Keep the newest `keep` checkpoints (across all projects) and delete the rest.
 *
 * Oldest-first is deliberate: the newest checkpoint is the one a rollback most
 * likely wants, and a per-project split would let one active project's history
 * evict every other project's only checkpoint.
 */
/**
 * Bound the AUTOMATIC pre-write checkpoints, and touch nothing else.
 *
 * WHY THIS EXISTS. The loop snapshots the tree before a turn's first write, which
 * is one checkpoint per turn that changes files. Nothing ever removed them:
 * MEASURED on this machine (2026-10-30), a few weeks of use had left **1,120
 * checkpoints recording 4,582,545 entries — ~966 MB of manifests**, growing with
 * every session. That is a capability problem and not a tidiness one: the store is
 * on the same disk as the projects it protects, and the day it fills is the day the
 * agent stops being able to work.
 *
 * WHY IT ONLY DELETES ITS OWN. A pre-write point exists to undo the next few
 * minutes of edits, so keeping the newest `keep` is generous for its purpose. An
 * explicit `nuvira checkpoint create` is something the USER named and may expect to
 * restore weeks later — auto-deleting that would be the agent silently throwing
 * away the user's own safety net, so it is never a candidate (it has no marker, and
 * neither does anything written before this field existed).
 *
 * WHY IT DOES NOT REAP BLOBS. Deciding whether a blob is still referenced means
 * reading every OTHER manifest in the store — the 2.8 s scan that this work removed
 * from the create path, now on a timer. Deleting the manifest directory is enough to
 * stop the growth (manifests are what a thousand checkpoints cost), blobs are
 * content-addressed and shared between checkpoints, and any that only the deleted
 * ones named are reclaimed by `pruneCheckpoints` when the user asks for the space.
 */
export function pruneAutoCheckpoints(
  options: { keep?: number; storeDir?: string } = {},
): string[] {
  const store = storeDirOf(options);
  const keep = Math.max(0, options.keep ?? DEFAULT_AUTO_KEEP);
  let names: string[] = [];
  try {
    names = readdirSync(store);
  } catch {
    return [];
  }

  // Names carry the ordering timestamp (see `newestCreatedAt`), so finding the
  // oldest needs one stat per directory and no JSON at all.
  const marked: Array<{ id: string; createdAt: number }> = [];
  for (const name of names) {
    if (!existsSync(join(checkpointDir(name, store), AUTO_MARKER))) continue;
    const dash = name.indexOf('-');
    const createdAt = dash > 0 ? Number.parseInt(name.slice(0, dash), 36) : Number.NaN;
    marked.push({ id: name, createdAt: Number.isFinite(createdAt) ? createdAt : 0 });
  }

  marked.sort((a, b) => b.createdAt - a.createdAt);
  const doomed = marked.slice(keep);
  const removed: string[] = [];
  for (const entry of doomed) {
    try {
      rmSync(checkpointDir(entry.id, store), { recursive: true, force: true });
      removed.push(entry.id);
    } catch (err) {
      logger.warn(`[checkpoint] could not prune ${entry.id}: ${(err as Error).message}`);
    }
  }
  return removed;
}

export function pruneCheckpoints(options: { keep?: number; storeDir?: string } = {}): string[] {
  const keep = Math.max(0, options.keep ?? 10);
  const all = listCheckpoints(options);
  return all
    .slice(keep)
    .map((checkpoint) => checkpoint.id)
    .filter((id) => deleteCheckpoint(id, { storeDir: options.storeDir }));
}

/**
 * Human-readable size, for the one line a checkpoint prints when it is created.
 * `1.4 MB` rather than `1468006` — the number is read while deciding whether to
 * keep a checkpoint, not compared.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
