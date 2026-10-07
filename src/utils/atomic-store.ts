/**
 * Shared mechanics for the JSON stores under `~/.nuvira/memory`: an advisory
 * CROSS-PROCESS lock and an atomic write.
 *
 * WHY THIS EXISTS (measured, 2026-10-07). Several long-lived processes share one
 * memory dir — the dashboard, the gateway, the warmup daemon and any CLI run —
 * and each holds a JSON store in memory and flushes the WHOLE map back on
 * persist. Two consequences, both measured, neither theoretical:
 *
 *  1. LOST UPDATES. Two processes read the file, each learns something, each
 *     writes its own snapshot. The second write wins entirely, so the first
 *     process's learning is gone — on the registry this flipped a strict-pin
 *     verdict from `credit-exhausted` back to `unverified` between two runs of
 *     the same command.
 *  2. TORN READS. A plain `writeFileSync` is not atomic, so a reader that
 *     catches the file mid-write parses a truncated document. Every store here
 *     catches that and returns an EMPTY state, which the next persist then
 *     writes back — turning one unlucky read into a wiped file.
 *
 * The lock closes (1) for whatever critical section the caller wraps; the atomic
 * write closes (2) outright, and that one needs no cooperation from other
 * processes. Both are deliberately synchronous, because every caller here is on
 * a synchronous path that must never throw.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface FileLockOptions {
  /** How long to wait for a held lock before running the section WITHOUT it. */
  timeoutMs?: number;
  /** A lock file older than this is presumed abandoned (its holder died). */
  staleMs?: number;
  /** Pause between attempts. */
  retryMs?: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
export const DEFAULT_LOCK_STALE_MS = 10_000;
export const DEFAULT_LOCK_RETRY_MS = 10;

/**
 * Sleep without spinning. `Atomics.wait` is permitted on the Node main thread
 * (unlike a browser's), so a contended lock costs no CPU; the busy loop is only
 * a fallback for an engine without `SharedArrayBuffer`.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* last resort */
    }
  }
}

/**
 * Try ONCE to take the lock. An exclusive create (`wx`) is the atomic primitive:
 * exactly one caller can win it, everywhere, without a daemon.
 *
 * A lock older than `staleMs` is broken, because the alternative is a store that
 * can never be written again after one process is killed mid-section. The
 * holder's pid is written for diagnosis, not for correctness — pid reuse makes
 * pid liveness an unsafe test, and the mtime is what decides.
 */
export function tryAcquireFileLock(lockPath: string, staleMs = DEFAULT_LOCK_STALE_MS): boolean {
  const take = (): boolean => {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } catch {
        /* the pid is diagnostics only */
      }
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (take()) return true;
  // Someone holds it — break it only if it is too old to belong to a live call.
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      rmSync(lockPath, { force: true });
      return take();
    }
  } catch {
    /* lost the race to break it, or it vanished — either way, do not own it */
  }
  return false;
}

/** Release a lock this process holds. Best-effort: never throws. */
export function releaseFileLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* a lock left behind expires by `staleMs` */
  }
}

/**
 * Run `fn` while holding `lockPath`, or — if the lock cannot be taken within
 * `timeoutMs` — run it anyway and report `heldLock: false`.
 *
 * RUNNING ANYWAY IS THE POINT. Every caller here is a best-effort write on a
 * routing path: refusing to persist because a lock is busy would trade a rare
 * lost update for a certain lost learning. A contention timeout is a signal to
 * the caller, not a failure.
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): { value: T; heldLock: boolean } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    /* the write itself will fail loudly enough if the dir is truly unusable */
  }

  const deadline = Date.now() + timeoutMs;
  let heldLock = tryAcquireFileLock(lockPath, staleMs);
  while (!heldLock && Date.now() < deadline) {
    sleepSync(retryMs);
    heldLock = tryAcquireFileLock(lockPath, staleMs);
  }

  try {
    return { value: fn(), heldLock };
  } finally {
    if (heldLock) releaseFileLock(lockPath);
  }
}

let atomicWriteSeq = 0;

/**
 * Write `content` to `path` so that no reader can ever see a partial document:
 * write a uniquely-named sibling, then `rename`.
 *
 * The unique name matters — a fixed `.tmp` lets two writers race on the temp
 * file itself and publish each other's bytes. `rename` over an existing path is
 * atomic on POSIX and on Windows (`MoveFileEx` with replace).
 */
export function writeFileAtomicSync(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${(atomicWriteSeq += 1)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

/** Recursively sort object keys so two structurally equal values stringify identically. */
function sortForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForComparison);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const src = value as Record<string, unknown>;
    for (const key of Object.keys(src).sort()) out[key] = sortForComparison(src[key]);
    return out;
  }
  return value;
}

/**
 * Order-independent JSON for comparing two records. `JSON.stringify` depends on
 * key insertion order, so two entries built by different code paths can be
 * semantically identical and compare unequal — which would make a merge treat an
 * untouched entry as a change and clobber a peer's learning.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortForComparison(value));
}
