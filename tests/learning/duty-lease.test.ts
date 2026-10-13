/**
 * Duty leases — one holder per duty, across processes, with crash recovery.
 *
 * WHAT THIS PINS. The lease exists because the background duties spend a real
 * generation per candidate on the user's free tier, and every process that
 * starts is willing to do them — so two CLI runs (or a CLI run plus the
 * dashboard) would spend the same budget on the same candidates. In-process
 * guards cannot see the other process at all.
 *
 * The two properties that make it usable rather than a foot-gun are both
 * asserted here:
 *   1. mutual exclusion — a FRESH lease held by someone else is respected;
 *   2. crash recovery — a lease older than the stale window is STOLEN, and the
 *      steal is REPORTED. Without (2) a killed process would switch the duty
 *      off permanently; without (1) there would be no point.
 *
 * Hermetic: every test points `NUVIRA_DUTY_DIR` at its own temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireDutyLease,
  releaseDutyLease,
  renewDutyLease,
  readDutyLease,
  dutyLeasePath,
  dutyLeaseStaleMs,
  withDutyLease,
  DEFAULT_DUTY_LEASE_STALE_MS,
} from '../../src/learning/duty-lease.js';

let dir = '';
let originalDutyDir: string | undefined;

const DUTY = 'test-duty';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-lease-'));
  originalDutyDir = process.env.NUVIRA_DUTY_DIR;
  process.env.NUVIRA_DUTY_DIR = dir;
});

afterEach(() => {
  if (originalDutyDir === undefined) delete process.env.NUVIRA_DUTY_DIR;
  else process.env.NUVIRA_DUTY_DIR = originalDutyDir;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Put a lease on disk as if ANOTHER process wrote it, aged by `ageMs`.
 * `utimesSync` is what sets the mtime the staleness rule actually reads.
 */
function writeForeignLease(name: string, ageMs: number, over: Record<string, unknown> = {}): void {
  const path = dutyLeasePath(name);
  mkdirSync(dirname(path), { recursive: true });
  const at = Date.now() - ageMs;
  writeFileSync(
    path,
    JSON.stringify({ name, pid: 999_999, host: 'another-machine', startedAt: at, renewedAt: at, ...over }),
  );
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
}

describe('acquireDutyLease — exactly one holder', () => {
  it('takes a free lease', () => {
    const r = acquireDutyLease(DUTY, { purpose: 'unit test' });
    expect(r.owned).toBe(true);
    expect(r.stole).toBe(false);
    expect(readDutyLease(DUTY)?.purpose).toBe('unit test');
    releaseDutyLease(DUTY);
  });

  it('respects a FRESH lease held by another process, and names the holder', () => {
    writeForeignLease(DUTY, 1_000);
    const r = acquireDutyLease(DUTY);
    expect(r.owned).toBe(false);
    expect(r.stole).toBe(false);
    expect(r.holder?.pid).toBe(999_999);
    expect(r.holder?.host).toBe('another-machine');
  });

  it('is idempotent within one process — asking twice is not a steal', () => {
    acquireDutyLease(DUTY);
    const second = acquireDutyLease(DUTY);
    // Reported as OWned but NOT stolen: a duty that runs twice in one process
    // must not look like a crash recovery in the logs.
    expect(second).toEqual({ owned: true, stole: false });
    releaseDutyLease(DUTY);
  });

  it('lets the next caller in after a release', () => {
    acquireDutyLease(DUTY);
    releaseDutyLease(DUTY);
    expect(readDutyLease(DUTY)).toBeUndefined();
    expect(acquireDutyLease(DUTY).owned).toBe(true);
    releaseDutyLease(DUTY);
  });
});

describe('steal-after-stale — a killed holder must not switch a duty off forever', () => {
  it('steals a lease older than the stale window, and says so', () => {
    writeForeignLease(DUTY, DEFAULT_DUTY_LEASE_STALE_MS + 60_000);
    const r = acquireDutyLease(DUTY);
    expect(r.owned).toBe(true);
    expect(r.stole).toBe(true);
    // The stealer OWNS it now — the dead holder's record is gone.
    expect(readDutyLease(DUTY)?.pid).toBe(process.pid);
    releaseDutyLease(DUTY);
  });

  it('does not steal one that is merely old-ish (inside the window)', () => {
    writeForeignLease(DUTY, DEFAULT_DUTY_LEASE_STALE_MS - 60_000);
    expect(acquireDutyLease(DUTY).owned).toBe(false);
  });

  it('honours a caller-supplied stale window', () => {
    writeForeignLease(DUTY, 1_000);
    // A one-second window makes a one-second-old lease stealable, which is the
    // seam a long-lived duty uses to keep a SHORT lease recoverable.
    expect(acquireDutyLease(DUTY, { staleMs: 500 }).owned).toBe(true);
    releaseDutyLease(DUTY);
  });

  it('steals a CORRUPT lease rather than wedging, and never throws', () => {
    const path = dutyLeasePath(DUTY);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    const old = (Date.now() - DEFAULT_DUTY_LEASE_STALE_MS - 60_000) / 1000;
    utimesSync(path, old, old);

    expect(readDutyLease(DUTY)).toBeUndefined();
    expect(acquireDutyLease(DUTY).owned).toBe(true);
    releaseDutyLease(DUTY);
  });

  it('treats a fresh-but-unreadable lease as HELD (the conservative direction)', () => {
    // The file exists and is recent, so someone wrote it just now. Refusing is
    // correct: the alternative is two processes sweeping the same candidates.
    const path = dutyLeasePath(DUTY);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json at all');
    expect(acquireDutyLease(DUTY).owned).toBe(false);
  });
});

describe('renewDutyLease — a long duty keeps its lease', () => {
  it('bumps the recorded renewal and the mtime, so the window moves', () => {
    acquireDutyLease(DUTY);
    const path = dutyLeasePath(DUTY);
    const stale = Date.now() - DEFAULT_DUTY_LEASE_STALE_MS - 60_000;
    const seconds = stale / 1000;
    utimesSync(path, seconds, seconds);

    // Aged artificially — without a renewal the next caller would steal it.
    expect(renewDutyLease(DUTY, { now: Date.now() })).toBe(true);
    const after = readDutyLease(DUTY);
    expect(after?.renewedAt).toBeGreaterThan(stale);
    expect(acquireDutyLease(DUTY).stole).toBe(false);
    releaseDutyLease(DUTY);
  });

  it('REFUSES to renew a lease this process does not hold', () => {
    // Renewing a lease we do not own would be a lie, and would let a stolen-from
    // process keep working as if nothing had happened.
    writeForeignLease(DUTY, 1_000);
    expect(renewDutyLease(DUTY)).toBe(false);
  });

  it('refuses when there is no lease at all', () => {
    expect(renewDutyLease(DUTY)).toBe(false);
  });
});

describe('releaseDutyLease — never delete someone else’s lease', () => {
  it('releases our own', () => {
    acquireDutyLease(DUTY);
    releaseDutyLease(DUTY);
    expect(readDutyLease(DUTY)).toBeUndefined();
  });

  it('leaves a foreign lease alone', () => {
    // Otherwise a process whose lease was stolen (because it hung) would, on
    // finishing, delete the NEW holder's lease and two duties would run at once.
    writeForeignLease(DUTY, 1_000);
    releaseDutyLease(DUTY);
    expect(readDutyLease(DUTY)?.host).toBe('another-machine');
  });

  it('never throws when nothing is held', () => {
    expect(() => releaseDutyLease('never-taken')).not.toThrow();
  });
});

describe('withDutyLease — run-or-step-aside', () => {
  it('runs the work and releases afterwards', async () => {
    const r = await withDutyLease(DUTY, async () => 'done');
    expect(r).toBe('done');
    expect(readDutyLease(DUTY)).toBeUndefined();
  });

  it('releases even when the work throws (a failing duty must not wedge)', async () => {
    await expect(
      withDutyLease(DUTY, async () => {
        throw new Error('duty exploded');
      }),
    ).rejects.toThrow('duty exploded');
    expect(readDutyLease(DUTY)).toBeUndefined();
  });

  it('runs nothing when someone else holds it, and reports the holder', async () => {
    writeForeignLease(DUTY, 1_000);
    let ran = false;
    const seen: Array<unknown> = [];
    const r = await withDutyLease(
      DUTY,
      async () => {
        ran = true;
        return 'should not happen';
      },
      { onWait: (holder) => seen.push(holder) },
    );
    expect(r).toBeUndefined();
    expect(ran).toBe(false);
    expect((seen[0] as { pid: number }).pid).toBe(999_999);
  });
});

describe('dutyLeaseStaleMs — the window is configuration', () => {
  it('defaults when nothing is set, and ignores nonsense', () => {
    expect(dutyLeaseStaleMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DUTY_LEASE_STALE_MS);
    // A ZERO window would be stolen instantly — i.e. no exclusion at all — so it
    // is rejected rather than honoured.
    expect(dutyLeaseStaleMs({ NUVIRA_DUTY_LEASE_STALE_MS: '0' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DUTY_LEASE_STALE_MS,
    );
    expect(dutyLeaseStaleMs({ NUVIRA_DUTY_LEASE_STALE_MS: 'soon' } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_DUTY_LEASE_STALE_MS,
    );
  });

  it('honours a positive override', () => {
    expect(dutyLeaseStaleMs({ NUVIRA_DUTY_LEASE_STALE_MS: '1500' } as NodeJS.ProcessEnv)).toBe(1500);
  });
});

describe('the lease file is what a user can inspect', () => {
  it('is readable JSON naming the holder, its host and what it is doing', () => {
    acquireDutyLease(DUTY, { purpose: 'unit test sweep' });
    const raw = JSON.parse(readFileSync(dutyLeasePath(DUTY), 'utf-8')) as Record<string, unknown>;
    expect(raw.name).toBe(DUTY);
    expect(raw.pid).toBe(process.pid);
    expect(raw.purpose).toBe('unit test sweep');
    expect(typeof raw.startedAt).toBe('number');
    expect(typeof raw.host).toBe('string');
    releaseDutyLease(DUTY);
  });
});
