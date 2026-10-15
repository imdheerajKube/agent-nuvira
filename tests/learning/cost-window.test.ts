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

import {
  CostTracker,
  costSince,
  costSinceSplit,
  setPricingContext,
  resetPricingContextCache,
} from '../../src/learning/cost-tracker.js';

/**
 * A window's cost is the sum of its rows' `costUsd` — which is money we have
 * EVIDENCE was charged. A list price only becomes `costUsd` when the account is
 * declared `paid` (otherwise it is a labelled "unverified" figure), so these
 * fixtures declare the tier the way a user would:
 * `nuvira config set providers.groq.billingTier paid`.
 */
function paidGroq() {
  setPricingContext({
    billingTierFor: (p) => (p === 'groq' ? 'paid' : 'unknown'),
    configPricingFor: () => undefined,
  });
}

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
  paidGroq();
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  resetPricingContextCache();
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

  it('does NOT report a list price as cost while the billing tier is undeclared', () => {
    // The mirror of the rule above: with nothing declared, the window's cost is a
    // true 0 and the list-priced figure is offered separately, clearly labelled —
    // the ledger cannot know whether this key is a free tier or a paid one.
    resetPricingContextCache();
    const tracker = new CostTracker();
    const entry = tracker.recordCall('groq', 'llama-3.3-70b', 1000, 1000);
    expect(entry.costUsd).toBe(0);
    expect(entry.listPriceUsd).toBeGreaterThan(0);

    const split = costSinceSplit(0);
    expect(split.billedUsd).toBe(0);
    expect(split.unverifiedListedUsd).toBeGreaterThan(0);
    // …and the token accounting is unaffected either way.
    expect(split.attributed.tokens).toBe(2000);
  });
});
