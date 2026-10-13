/**
 * Duty leases — one holder per named background duty, across processes, with no
 * daemon and no supervisor.
 *
 * THE PROBLEM. The background duties (the warmup sweep, the verify-next run,
 * session-start checks) are all "one of these should happen periodically", and
 * every process that starts is willing to do it. So two CLI runs, or a CLI run
 * plus the dashboard, or a long-lived gateway plus a manual `models warm`, each
 * spend the SAME free-tier budget on the SAME candidates — and a spot-check is a
 * real generation, so the waste is measured in a provider's rate limit, not in
 * CPU. In-process guards (`isRunning`) cannot see the other process at all.
 *
 * WHY A LEASE AND NOT A DAEMON. A daemon is the obvious shape and the wrong
 * first step: it needs a supervisor, a way to be started, restarted, discovered
 * and stopped, and it becomes a thing that can be RUNNING AND WRONG. A lease is
 * the smallest primitive that removes the actual waste: exactly one process
 * wins the exclusive create, everyone else steps aside, and the loser has a
 * perfectly good fallback (do nothing — the work is throttled anyway). It is
 * also the piece a daemon would need FIRST, so this is not throwaway work.
 *
 * HOW EXCLUSION WORKS. `open(path, 'wx')` is the atomic primitive: exactly one
 * caller anywhere can win it. That is the whole mechanism — no pid liveness
 * check, no registry service, no lock daemon.
 *
 * HOW CRASH RECOVERY WORKS, AND WHY IT IS THE mtime. A holder that is killed
 * mid-duty leaves its lease file behind, and a lease that can never be taken is
 * worse than no lease at all. So a lease whose mtime is older than `staleMs` is
 * STOLEN: the stealer removes it and takes it, and reports `stole: true` so the
 * event is visible rather than silent. `renewDutyLease` re-writes the file, which
 * bumps that mtime, which is how a legitimately long duty (a warmup cycle can
 * take minutes) keeps its lease while still being stealable if it dies.
 *
 * The pid is written for DIAGNOSTICS ONLY — "who held this" is the first
 * question when a duty mysteriously stops running, and it is a question the
 * user can answer from disk. It is deliberately NOT a correctness input: pid
 * reuse makes "is this pid alive" an unsafe test (a fresh, unrelated process can
 * hold the number), and the mtime is what actually decides.
 *
 * HONEST BOUNDS. Steal-after-stale means a crashed holder blocks its duty for at
 * most `staleMs` — hence the default is minutes, not hours. Clock skew between
 * two machines sharing a config dir shifts that window; it cannot make the
 * exclusion unsafe, only early or late. Nothing here is a distributed lock:
 * the config dir is one machine's, and the dashboard sidecar sharing it is the
 * case this exists for.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { envBuff, resolveNuviraHome } from '../config/paths.js';

/**
 * How long a lease may go un-renewed before it counts as a DEAD holder's and may
 * be stolen (ms).
 *
 * Minutes, not hours, on purpose: this is the worst-case delay before a duty
 * resumes after a crash, and the alternative — a lease that outlives its holder
 * by hours — silently switches the duty off for the rest of the afternoon.
 */
export const DEFAULT_DUTY_LEASE_STALE_MS = 5 * 60 * 1000;

/**
 * Env override for {@link DEFAULT_DUTY_LEASE_STALE_MS}
 * (`NUVIRA_DUTY_LEASE_STALE_MS`) — the same rule the warmup bounds follow: a
 * test or an operator tunes the window without a source edit, and nonsense is
 * ignored rather than arming a zero-second lease that would be stolen instantly.
 */
export function dutyLeaseStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NUVIRA_DUTY_LEASE_STALE_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DUTY_LEASE_STALE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DUTY_LEASE_STALE_MS;
}

/** What a lease file holds. Everything here is either an input (mtime) or diagnostics. */
export interface DutyLeaseInfo {
  /** The duty name, e.g. `model-warmup`. */
  name: string;
  /** The holder's process id — DIAGNOSTICS ONLY (see the module header). */
  pid: number;
  /** The holder's host, so a shared config dir can say "another machine". */
  host: string;
  /** When the holder first took the lease (ms). */
  startedAt: number;
  /** When the holder last renewed it (ms) — mirrors the file's mtime, for reading. */
  renewedAt: number;
  /** Free-text: what the holder is doing, for the diagnostic readout. */
  purpose?: string;
}

export interface DutyLeaseAcquireResult {
  /** True when THIS process holds the lease on return. */
  owned: boolean;
  /** True when a stale lease had to be broken to get it — never silent. */
  stole: boolean;
  /** The lease that was in the way, when it was fresh and therefore respected. */
  holder?: DutyLeaseInfo;
}

export interface DutyLeaseOptions {
  /** Override the staleness window (ms). Defaults to {@link dutyLeaseStaleMs}. */
  staleMs?: number;
  /** Recorded in the lease, for the diagnostic readout. */
  purpose?: string;
  /** Clock seam (tests). */
  now?: number;
}

/**
 * Where leases live: `<memory dir>/duties/`.
 *
 * THE MEMORY DIR, NOT THE CONFIG DIR, and not by accident:
 *
 *   1. **The lease travels with the state it protects.** The duties this guards
 *      (warmup, verify-next, session checks) mutate the model registry and the
 *      verified pool, and those live in the memory dir. An isolated profile — a
 *      test, a CI run, a sandbox — therefore gets its OWN leases instead of
 *      contending with the developer's real CLI over one file in `~/.nuvira`.
 *   2. **It cannot leak into a real profile from a test.**
 *      `tests/setup/hermetic-env.ts` gives every test file a throwaway
 *      `NUVIRA_MEMORY_DIR` and deliberately does NOT isolate the config dir (a
 *      test that needs real credentials must keep working). A lease under the
 *      memory dir is isolated by construction; one under the config dir would
 *      have let `chat.ts`'s warmup start write `~/.nuvira/duties/*.lease` on
 *      every chat test, which is exactly the leak class that harness exists to
 *      stop — and worse, a real CLI holding that lease would have made the
 *      test's daemon silently skip.
 *
 * `NUVIRA_DUTY_DIR` overrides it for a caller that wants its own namespace.
 */
export function dutyLeaseDir(): string {
  return envBuff('DUTY_DIR') || join(envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory'), 'duties');
}

/** `<duty dir>/<name>.lease`. */
export function dutyLeasePath(name: string): string {
  return join(dutyLeaseDir(), `${safeName(name)}.lease`);
}

/**
 * Keep a duty name path-safe. The names are internal constants, but a lease
 * whose path was derived from an arbitrary string could be pointed anywhere.
 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function leaseDir(name: string): string {
  return dirname(dutyLeasePath(name));
}

/**
 * This machine's label, defensively.
 *
 * `hostname()` is diagnostics, so it must never be able to fail an acquisition —
 * and it CAN be absent: a test that mocks `node:os` for `homedir()` (the duties
 * suite does exactly that) replaces the whole module, and a bare `hostname()`
 * then throws inside the take and reads as "someone else holds it". The lease
 * would go silently unused, which is the failure mode this module exists to
 * prevent. A missing host therefore degrades to a shared label, and same-process
 * detection still works off the pid.
 */
function hostLabel(): string {
  try {
    return hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Read the lease without taking it (diagnostics/dashboard). Never throws. */
export function readDutyLease(name: string): DutyLeaseInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(dutyLeasePath(name), 'utf-8')) as DutyLeaseInfo;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    // Absent or corrupt: from a reader's point of view both mean "no lease".
    return undefined;
  }
}

/** Age of a lease file (ms), or `undefined` when there is no readable file. */
function leaseAgeMs(name: string, now: number): number | undefined {
  try {
    return Math.max(0, now - statSync(dutyLeasePath(name)).mtimeMs);
  } catch {
    return undefined;
  }
}

/**
 * Try to take a duty lease. Returns `owned: false` (with the holder, when it
 * could be read) rather than throwing or waiting: every caller's correct
 * response to a busy lease is "someone else has this", and waiting would make a
 * background duty block a foreground command.
 *
 * Re-acquiring a lease THIS process already holds is idempotent and does NOT
 * steal — a duty that runs twice in one process must not look like a crash
 * recovery in the logs.
 */
export function acquireDutyLease(name: string, opts: DutyLeaseOptions = {}): DutyLeaseAcquireResult {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? dutyLeaseStaleMs();

  // 1. The atomic take: exactly one caller can win an exclusive create.
  if (tryCreate(name, opts.purpose, now)) return { owned: true, stole: false };

  // 2. Someone holds it. Is it the SAME process? Then this is not a contention,
  //    it is us asking twice.
  const existing = readDutyLease(name);
  if (existing && existing.host === hostLabel() && existing.pid === process.pid) {
    return { owned: true, stole: false };
  }

  // 3. Is it too old to belong to a live call? Then it is a dead holder's, and
  //    a lease nobody can take would switch the duty off forever.
  const age = leaseAgeMs(name, now);
  if (age !== undefined && age > staleMs) {
    try {
      rmSync(dutyLeasePath(name), { force: true });
    } catch {
      // Lost the race to break it — fall through to the retry and let the
      // exclusive create decide the winner.
    }
    if (tryCreate(name, opts.purpose, now)) return { owned: true, stole: true };
    // Another process re-took it between the break and our retry: respect it.
    return { owned: false, stole: false, holder: readDutyLease(name) };
  }

  return { owned: false, stole: false, holder: existing };
}

/** The exclusive-create step, in one place so both callers share it. */
function tryCreate(name: string, purpose: string | undefined, now: number): boolean {
  try {
    mkdirSync(leaseDir(name), { recursive: true });
  } catch {
    // A failing mkdir surfaces as a failing create below, which is the honest
    // "we do not own the lease" answer.
  }
  try {
    const fd = openSync(dutyLeasePath(name), 'wx');
    try {
      const info: DutyLeaseInfo = {
        name,
        pid: process.pid,
        host: hostLabel(),
        startedAt: now,
        renewedAt: now,
        ...(purpose ? { purpose } : {}),
      };
      writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    // EEXIST (someone else won it) or an unusable directory — either way, not ours.
    return false;
  }
}

/**
 * Push a held lease's staleness window out. In-place write (NOT an atomic
 * rename), so the file never blinks out of existence for a competing stealer,
 * and the mtime bump is what a stealer actually reads.
 *
 * Returns false when this process does not hold the lease — a renewed lease it
 * does not own would be a lie, and a long duty that quietly continued after
 * being stolen would defeat the exclusion.
 */
export function renewDutyLease(name: string, opts: { now?: number } = {}): boolean {
  const existing = readDutyLease(name);
  if (!existing || existing.host !== hostLabel() || existing.pid !== process.pid) return false;
  try {
    const renewed: DutyLeaseInfo = { ...existing, renewedAt: opts.now ?? Date.now() };
    writeFileInPlace(dutyLeasePath(name), `${JSON.stringify(renewed, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Truncate-and-write in place, so the path is never absent mid-renewal. */
function writeFileInPlace(path: string, content: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * Give the lease up. Best-effort and never throws — a lease left behind expires
 * by `staleMs`, which is exactly why that window exists.
 *
 * Refuses to release a lease this process does NOT hold: otherwise a process
 * whose lease was stolen (because it hung) could finish and delete the new
 * holder's lease, and two processes would then run the duty at once.
 */
export function releaseDutyLease(name: string): void {
  const existing = readDutyLease(name);
  if (existing && !(existing.host === hostLabel() && existing.pid === process.pid)) return;
  try {
    rmSync(dutyLeasePath(name), { force: true });
  } catch {
    /* a lock left behind expires by `staleMs` */
  }
}

/**
 * Run `fn` while holding `name`, or return `undefined` and run nothing when
 * someone else holds it.
 *
 * The lease is released in a `finally`, so a throwing duty does not block the
 * next one; a duty that CRASHES the process leaves the file behind, which is the
 * case `staleMs` covers.
 */
export async function withDutyLease<T>(
  name: string,
  fn: () => Promise<T>,
  opts: DutyLeaseOptions & { onWait?: (holder: DutyLeaseInfo | undefined) => void } = {},
): Promise<T | undefined> {
  const taken = acquireDutyLease(name, opts);
  if (!taken.owned) {
    try {
      opts.onWait?.(taken.holder);
    } catch {
      // Diagnostics must never break the caller.
    }
    return undefined;
  }
  try {
    return await fn();
  } finally {
    releaseDutyLease(name);
  }
}
