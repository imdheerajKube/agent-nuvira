/**
 * ModelRegistry — CROSS-PROCESS safety of the JSON mirror.
 *
 * The defect these pin (measured 2026-10-07, then reproduced here): the registry
 * loads the mirror once at construction and `persist()` writes its WHOLE entry
 * map back, so a long-lived process flushes a snapshot of every model it never
 * touched. On this machine the dashboard, the gateway and a CLI run share one
 * memory dir, and the visible symptom was a strict-pin verdict flipping from
 * `credit-exhausted` back to `unverified` between two runs of one command —
 * re-arming the very pre-flight F6 had just closed.
 *
 * Two `new ModelRegistry()` instances in one process are an honest stand-in for
 * two processes: each holds its own in-memory snapshot and writes the same file,
 * which is the whole mechanism under test. No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry, mergeRegistryMirror, resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import {
  resetVectorBackendSelection,
  setVectorBackendOverride,
} from '../../src/memory/vector-store.js';

let tempDir: string;
let originalMemoryDir: string | undefined;

function mirrorPath(): string {
  return join(tempDir, 'model-registry.json');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-registry-xproc-'));
  originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  setVectorBackendOverride('json'); // hermetic: force the JSON backend
  resetModelRegistry();
  resetQuotaLedger();
});

afterEach(() => {
  resetModelRegistry();
  resetQuotaLedger();
  resetVectorBackendSelection();
  if (originalMemoryDir === undefined) {
    delete process.env.NUVIRA_MEMORY_DIR;
  } else {
    process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ModelRegistry — a peer process cannot clobber what it never saw', () => {
  it('keeps a row a SECOND process booted without (it would have been dropped)', () => {
    const a = new ModelRegistry();
    const b = new ModelRegistry(); // both boot from the same (empty) file

    a.markVerified('openrouter', 'deepseek/deepseek-v4.1-flash', 'probe');
    // `b` has never heard of that pair. Its persist must not be a whole-map
    // overwrite of its own two-entry snapshot.
    b.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    const reread = new ModelRegistry();
    expect(reread.getEntry('openrouter', 'deepseek/deepseek-v4.1-flash')?.status).toBe('verified');
    expect(reread.getEntry('groq', 'llama-3.3-70b-versatile')?.status).toBe('verified');
  });

  it('does not REVERT a demotion a stale peer booted without — the measured symptom', () => {
    const a = new ModelRegistry();
    a.markVerified('openrouter', 'deepseek/deepseek-v4.1-flash', 'probe');

    // `b` boots here, so its snapshot says this pair is VERIFIED.
    const b = new ModelRegistry();

    // The account is proven unfunded (an F6 verdict: definitive, no timer).
    a.recordCall('openrouter', 'deepseek/deepseek-v4.1-flash', false, 'credit-exhausted', 'chat');
    expect(a.getEntry('openrouter', 'deepseek/deepseek-v4.1-flash')?.status).toBe('unavailable');

    // Any unrelated persist from the stale process used to write `verified`
    // back over it.
    b.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    const entry = new ModelRegistry().getEntry('openrouter', 'deepseek/deepseek-v4.1-flash');
    expect(entry?.status).toBe('unavailable');
    expect(entry?.lastError).toContain('credit-exhausted');
  });

  it('adopts a peer row that appeared AFTER this process booted', () => {
    const b = new ModelRegistry(); // boots empty
    const a = new ModelRegistry();
    a.markVerified('gemini', 'gemini-3.1-flash-lite', 'probe');

    // b learns something of its own; the merge should also pick up a's row.
    b.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    expect(b.getEntry('gemini', 'gemini-3.1-flash-lite')?.status).toBe('verified');
  });

  it("honours a peer's DELETION instead of resurrecting the row from its boot copy", () => {
    const a = new ModelRegistry();
    a.markListed('local', ['ghost:latest']); // unverified

    const b = new ModelRegistry(); // boots WITH the row present
    a.pruneAbsentModels('local', []); // removes the unverified key

    b.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    expect(new ModelRegistry().getEntry('local', 'ghost:latest')).toBeUndefined();
  });

  it('lets a process’s OWN change beat the file’s copy of that same entry', () => {
    const a = new ModelRegistry();
    const b = new ModelRegistry();
    a.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    // b changes the very same pair after reading it — its measurement is later,
    // so it must win rather than be discarded as "unchanged".
    b.markUnavailable('groq', 'llama-3.3-70b-versatile', '403 permission denied', 'probe');

    expect(new ModelRegistry().getEntry('groq', 'llama-3.3-70b-versatile')?.lastError).toBe(
      '403 permission denied',
    );
  });

  it('leaves no lock or temp litter in the memory dir', () => {
    const a = new ModelRegistry();
    a.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    const litter = readdirSync(tempDir).filter((f) => f.includes('.lock') || f.includes('.tmp-'));
    expect(litter).toEqual([]);
  });

  it('never publishes a partial document, so a reader cannot parse an empty one', () => {
    const a = new ModelRegistry();
    a.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    // A torn read is what makes a loader return an EMPTY state, which the next
    // persist then writes back as a wiped registry.
    const raw = readFileSync(mirrorPath(), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(Object.keys(JSON.parse(raw).entries).length).toBe(1);
  });
});

describe('mergeRegistryMirror — the resolution in the abstract', () => {
  const entry = (provider: string, model: string, status: string, extra: Record<string, unknown> = {}) => ({
    provider,
    model,
    status,
    lastVerifiedAt: 1,
    lastProbedAt: 1,
    lastUsedAt: 0,
    errorRate: 0,
    quotaParkedUntil: 0,
    source: 'probe',
    ...extra,
  }) as never;
  const data = (entries: Record<string, unknown>) =>
    ({ version: 1, entries, updatedAt: 0 }) as never;

  it('changed-here wins, unchanged adopts disk, deletion wins, new rows are adopted', () => {
    const boot = data({ k1: entry('p', 'changed-here', 'verified'), k2: entry('p', 'untouched', 'unverified'), k3: entry('p', 'deleted', 'unverified') });
    const memory = data({ k1: entry('p', 'changed-here', 'unavailable'), k2: entry('p', 'untouched', 'unverified') });
    const disk = data({ k1: entry('p', 'changed-here', 'verified'), k2: entry('p', 'untouched', 'verified'), k4: entry('p', 'peer-new', 'verified') });

    const merged = mergeRegistryMirror(boot, memory, disk);

    expect(merged.entries.k1.status).toBe('unavailable'); // ours
    expect(merged.entries.k2.status).toBe('verified'); // theirs
    expect(merged.entries.k3).toBeUndefined(); // deletion wins
    expect(merged.entries.k4.status).toBe('verified'); // adopted
  });

  it('treats a key-order-only difference as UNCHANGED (so it cannot clobber a peer)', () => {
    const boot = data({ k1: entry('p', 'm', 'unverified') });
    const memory = data({
      k1: { ...entry('p', 'm', 'unverified'), extraField: undefined } as never,
    });
    const disk = data({ k1: entry('p', 'm', 'verified') });

    // `stableJson` ignores key order and drops nothing that `JSON.stringify`
    // would keep, so the entry reads as untouched and the peer's value survives.
    expect(mergeRegistryMirror(boot, memory, disk).entries.k1.status).toBe('verified');
  });
});

describe('reset() stays a deliberate wipe', () => {
  it('empties the mirror even when a peer row is on disk', () => {
    const a = new ModelRegistry();
    a.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');

    const b = new ModelRegistry();
    b.reset();

    // A wipe is user-invoked: it must not "adopt" a concurrent row, or
    // `nuvira models reset` would silently do nothing under a live dashboard.
    const onDisk = JSON.parse(readFileSync(mirrorPath(), 'utf-8'));
    expect(Object.keys(onDisk.entries)).toEqual([]);
    expect(new ModelRegistry().getEntry('groq', 'llama-3.3-70b-versatile')).toBeUndefined();
    expect(existsSync(mirrorPath())).toBe(true);
  });

  it('survives a corrupt mirror instead of throwing', () => {
    writeFileSync(mirrorPath(), '{broken');
    const registry = new ModelRegistry();
    expect(registry.getEntry('groq', 'anything')).toBeUndefined();
    // ...and can still persist over it.
    registry.markVerified('groq', 'llama-3.3-70b-versatile', 'probe');
    expect(JSON.parse(readFileSync(mirrorPath(), 'utf-8')).entries).toBeTruthy();
  });
});
