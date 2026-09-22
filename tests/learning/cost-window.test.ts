/**
 * G27 — the per-batch economy window.
 *
 * An unattended run's cost report is only as good as its measurement. This
 * pins the property that makes it work across batches — and across a RESUME in
 * a new process: the window is read from the PERSISTED ledger, not from a
 * per-instance session counter (which would report zero for every batch after
 * the first, since each batch runs through a fresh orchestrator).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostTracker, costSince } from '../../src/learning/cost-tracker.js';

let memDir: string;
let prevMemDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-cost-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  prevCfgDir = process.env.NUVIRA_CONFIG_DIR;
  // The ledger resolves its location lazily through NUVIRA_MEMORY_DIR, so this
  // must be set before the first write — and it isolates the real profile.
  process.env.NUVIRA_MEMORY_DIR = memDir;
  process.env.NUVIRA_CONFIG_DIR = join(memDir, 'cfg');
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  rmSync(memDir, { recursive: true, force: true });
});

/** The 5ms gap keeps the window boundary unambiguous at ms resolution. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('costSince — measured, per-batch, process-independent', () => {
  it('counts only the entries recorded after the window opens', async () => {
    const tracker = new CostTracker();
    tracker.recordCall('groq', 'llama-3.3-70b', 1000, 1000);
    await tick();
    const windowStart = Date.now();
    await tick();
    tracker.recordCall('groq', 'llama-3.3-70b', 2000, 0);

    const inside = costSince(windowStart);
    expect(inside.requests).toBe(1);
    expect(inside.tokens).toBe(2000);

    const all = costSince(0);
    expect(all.requests).toBe(2);
    expect(all.tokens).toBe(4000);
  });

  it('reports a true zero — not an error — for a window with no calls', () => {
    expect(costSince(Date.now() + 60_000)).toEqual({ costUsd: 0, tokens: 0, requests: 0 });
  });

  it('sums the cost of the window', () => {
    const tracker = new CostTracker();
    const first = tracker.recordCall('groq', 'llama-3.3-70b', 1000, 1000);
    const second = tracker.recordCall('groq', 'llama-3.3-70b', 2000, 2000);
    const window = costSince(0);
    expect(window.costUsd).toBeCloseTo(first.costUsd + second.costUsd, 6);
    expect(window.costUsd).toBeGreaterThan(0);
  });

  it('reads the ledger, so a NEW process sees a prior batch’s spend', async () => {
    // Batch 1 in "process A".
    new CostTracker().recordCall('groq', 'llama-3.3-70b', 1000, 1000);
    await tick();
    const batch2Start = Date.now();
    // Batch 2 in "process B": a brand-new tracker with an empty session, yet the
    // window still sees only its own spend — which a session counter could not.
    new CostTracker().recordCall('groq', 'llama-3.3-70b', 500, 500);

    const batchTwo = costSince(batch2Start);
    expect(batchTwo.requests).toBe(1);
    expect(batchTwo.tokens).toBe(1000);
  });
});
