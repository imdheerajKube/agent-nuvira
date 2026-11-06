/**
 * ONE TURN, TWO SURFACES, ONE SENTENCE — the CLI and the dashboard must describe
 * the same turn's spend identically.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW. The two surfaces reach the number by
 * different routes: the CLI builds the report server-side (`buildTurnReport` →
 * `formatTurnReport`), serialises it, and the dashboard renders the card from the
 * JSON it received. A bucket that survives one route and not the other — dropped
 * in `JSON.stringify`, renamed in `types.ts`, or formatted by a local copy of the
 * rules — produces two defensible-looking sentences that disagree about money.
 * The failure mode is silent, so it is pinned here over a REAL ledger window: the
 * spend is classified by `costSinceSplit` from persisted rows, not hand-written.
 *
 * What "identical" means concretely: the dashboard card's line is the CLI's
 * `💰 cost: …` line minus its label. Same buckets, same marks, same remedy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CostTracker,
  costSinceSplit,
  resetPricingContextCache,
  setPricingContext,
} from '../../src/learning/cost-tracker.js';
import { buildTurnReport, formatTurnReport, type TurnReport } from '../../src/learning/turn-report.js';
// The dashboard's OWN formatter entry point — the module the turn card imports —
// so this compares what the two surfaces import, not two copies of one function.
import { formatSpendFull as dashboardSpendLine } from '../../src/web-dashboard/src/format.js';

let memDir: string;
let prevMemDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-spend-parity-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  prevCfgDir = process.env.NUVIRA_CONFIG_DIR;
  // The ledger resolves its location lazily, so this must be set before the first
  // write — and it keeps the developer's real ~/.nuvira out of the test.
  process.env.NUVIRA_MEMORY_DIR = memDir;
  process.env.NUVIRA_CONFIG_DIR = join(memDir, 'cfg');
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  resetPricingContextCache();
  rmSync(memDir, { recursive: true, force: true });
});

/** The turn as the server sends it: built, then JSON round-tripped like the API. */
function roundTrip(report: TurnReport): TurnReport {
  return JSON.parse(JSON.stringify(report)) as TurnReport;
}

/** The `💰` line the CLI prints for this turn, label and icon stripped. */
function cliSpendLine(report: TurnReport): string | undefined {
  const line = formatTurnReport(report)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('💰'));
  return line?.replace(/^💰\s*cost:\s*/, '');
}

function reportFor(cost: TurnReport['cost']): TurnReport {
  return buildTurnReport({
    goal: 'fix add in math.js',
    toolCalls: ['edit_file', 'run_terminal'],
    successfulToolCalls: ['edit_file', 'run_terminal'],
    mutations: 1,
    changedPaths: ['math.js'],
    cost,
  });
}

describe('turn spend — CLI and dashboard describe one turn identically', () => {
  it('prints the same breakdown for a window with every bucket populated', () => {
    // A declared-paid provider: list price is an ESTIMATE of money owed…
    // …and one of its calls carried the provider's own reported charge.
    // A provider whose tier nobody declared: priced, but not provably charged.
    // A local runtime: provably free. An unknown provider: no price evidence.
    setPricingContext({
      billingTierFor: (p) => (p === 'groq' ? 'paid' : p === 'local' ? 'free' : 'unknown'),
      configPricingFor: () => undefined,
    });
    const tracker = new CostTracker();
    tracker.recordCall('groq', 'llama-3.3-70b', 1000, 500, 'chat', false, 0.002);
    tracker.recordCall('groq', 'llama-3.3-70b', 1000, 500);
    tracker.recordCall('nim', 'llama-3.1-8b', 800, 200);
    tracker.recordCall('local', 'qwen2.5:0.5b', 300, 100);
    tracker.recordCall('mystery', 'm-1', 100, 50);

    const spend = costSinceSplit(0).spend;
    expect(spend.calls).toBe(5);
    expect(spend.reportedCalls).toBe(1);
    expect(spend.listedCalls).toBe(1);
    expect(spend.unverifiedCalls).toBe(1);
    expect(spend.freeCalls).toBe(1);
    expect(spend.unpricedCalls).toBe(1);

    const wire = roundTrip(reportFor(spend));

    // Serialisation keeps every bucket — a key the client needs cannot be lost
    // between the ledger and the card.
    expect(wire.cost).toEqual(spend);

    const cli = cliSpendLine(wire);
    const dashboard = dashboardSpendLine(wire.cost!);
    expect(cli).toBeDefined();
    expect(cli).toBe(dashboard);

    // …and the shared sentence names each bucket's evidence and the remedy, so
    // "same words" cannot be satisfied by being equally vague.
    expect(dashboard).toContain('$0.002000 exact');
    expect(dashboard).toContain('est.');
    expect(dashboard).toContain('unverified');
    expect(dashboard).toContain('1 unpriced');
    expect(dashboard).toContain('declare providers.nim.billingTier');
  });

  it('says "free" only when a free tier is ALL the window contained', () => {
    setPricingContext({
      billingTierFor: (p) => (p === 'local' ? 'free' : 'unknown'),
      configPricingFor: () => undefined,
    });
    new CostTracker().recordCall('local', 'qwen2.5:0.5b', 300, 100);

    const wire = roundTrip(reportFor(costSinceSplit(0).spend));
    const cli = cliSpendLine(wire);
    const dashboard = dashboardSpendLine(wire.cost!);

    expect(cli).toBe(dashboard);
    // The claim is true for a local runtime — and it must never be spelled as a
    // dollar amount, which is how a real $0 and an unpriced turn used to look
    // identical.
    expect(dashboard).toContain('$0 free');
    expect(dashboard).not.toContain('$0.000000');
  });

  it('prints no spend line at all when the ledger recorded nothing', () => {
    const wire = roundTrip(reportFor(undefined));

    // Absence is "not metered", not "free": neither surface may fill the gap.
    expect(wire.cost).toBeUndefined();
    expect(cliSpendLine(wire)).toBeUndefined();
    expect(formatTurnReport(wire)).not.toContain('💰');
  });
});
