/**
 * The shared mechanics for the memory-dir JSON stores (cross-process lock +
 * atomic write).
 *
 * Why these are unit-tested at all: both behaviours are invisible on a quiet
 * machine and only appear under two processes, which is where they were measured
 * (a strict-pin verdict reverting between two runs of one command). The pieces
 * that make them work — an exclusive create, a stale-lock break, a rename — are
 * each a single call, so the tests pin the CONTRACT the callers rely on rather
 * than the calls themselves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  releaseFileLock,
  stableJson,
  tryAcquireFileLock,
  withFileLockSync,
  writeFileAtomicSync,
} from '../../src/utils/atomic-store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomicSync', () => {
  it('writes the content and leaves no temp sibling behind', () => {
    const path = join(dir, 'store.json');
    writeFileAtomicSync(path, '{"a":1}');

    expect(readFileSync(path, 'utf-8')).toBe('{"a":1}');
    // The temp file is the mechanism; a leftover one would be litter in the
    // operator's memory dir on every single persist.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('creates the parent directory, and overwrites an existing file', () => {
    const path = join(dir, 'nested', 'deep', 'store.json');
    writeFileAtomicSync(path, 'first');
    writeFileAtomicSync(path, 'second');

    expect(readFileSync(path, 'utf-8')).toBe('second');
    expect(readdirSync(join(dir, 'nested', 'deep'))).toEqual(['store.json']);
  });

  it('replaces the file in one step, so a reader never sees a partial document', () => {
    const path = join(dir, 'store.json');
    writeFileAtomicSync(path, 'A'.repeat(4096));
    writeFileAtomicSync(path, 'B'.repeat(4096));

    // The published file is always one complete document — never a mix of the
    // two writes, which is what a plain `writeFileSync` can expose.
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toBe('B'.repeat(4096));
  });
});

describe('tryAcquireFileLock', () => {
  it('is exclusive: a second attempt fails while the first is held', () => {
    const lock = join(dir, 'store.json.lock');

    expect(tryAcquireFileLock(lock)).toBe(true);
    expect(tryAcquireFileLock(lock)).toBe(false);

    releaseFileLock(lock);
    expect(tryAcquireFileLock(lock)).toBe(true);
    releaseFileLock(lock);
  });

  it('breaks a lock older than staleMs, so a killed holder cannot wedge the store', () => {
    const lock = join(dir, 'store.json.lock');
    writeFileSync(lock, '999999\n');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);

    expect(tryAcquireFileLock(lock, 1_000)).toBe(true);
    releaseFileLock(lock);
  });

  it('does NOT break a fresh lock', () => {
    const lock = join(dir, 'store.json.lock');
    writeFileSync(lock, '1\n');

    expect(tryAcquireFileLock(lock, 60_000)).toBe(false);
  });
});

describe('withFileLockSync', () => {
  it('holds the lock for the section and releases it afterwards', () => {
    const lock = join(dir, 'store.json.lock');
    let sawHeld: boolean | undefined;
    let secondAttemptWhileHeld: boolean | undefined;

    const result = withFileLockSync(lock, () => {
      sawHeld = tryAcquireFileLock(lock); // must fail: WE hold it
      secondAttemptWhileHeld = existsSync(lock);
      return 42;
    });

    expect(result.value).toBe(42);
    expect(result.heldLock).toBe(true);
    expect(sawHeld).toBe(false);
    expect(secondAttemptWhileHeld).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('runs the section even when it cannot take the lock, and says so', () => {
    const lock = join(dir, 'store.json.lock');
    writeFileSync(lock, 'someone-else\n'); // a live peer holds it

    // The contract every caller depends on: a busy lock must DEGRADE to an
    // unlocked run, never to a skipped write — losing a learning is worse than
    // risking one lost update.
    const result = withFileLockSync(lock, () => 'ran-anyway', { timeoutMs: 30, retryMs: 5 });

    expect(result.value).toBe('ran-anyway');
    expect(result.heldLock).toBe(false);
    // ...and it must not have deleted the peer's lock.
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { force: true });
  });
});

describe('stableJson', () => {
  it('is order-independent, so a rebuilt entry is not mistaken for a changed one', () => {
    const a = { provider: 'groq', status: 'verified', nested: { x: 1, y: 2 } };
    const b = { status: 'verified', nested: { y: 2, x: 1 }, provider: 'groq' };

    expect(stableJson(a)).toBe(stableJson(b));
    // ...while a real difference still shows through.
    expect(stableJson(a)).not.toBe(stableJson({ ...b, status: 'unavailable' }));
  });
});
