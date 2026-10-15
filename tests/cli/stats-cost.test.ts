/**
 * `nuvira stats cost reconcile` / `reprice` — the CLI surface of the two
 * commands that make the cost picture ACTUAL instead of merely estimated.
 *
 * These run the real commander tree (so option parsing is the shipped one) against
 * an isolated memory dir, with ConfigManager mocked so nothing touches a real
 * profile. What they pin:
 *   - the invoice figure reaches the report, and the report says which two numbers
 *     were compared;
 *   - a typo'd provider id FAILS LOUDLY instead of reading as "no usage";
 *   - a tier declaration the invoice contradicts is REFUSED (that is the whole
 *     point: the tier is a fact to be evidenced, not an assumption to be typed);
 *   - a declaration the invoice proves is written through ConfigManager;
 *   - `reprice` writes nothing without --apply, and keeps a .bak when it does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { StatsCommand, parseAmount } from '../../src/cli/stats.js';
import { resetPricingContextCache } from '../../src/learning/cost-tracker.js';
import type { BuffConfig } from '../../src/config/types.js';

let memDir: string;
let prevMemDir: string | undefined;
let prevCfgDir: string | undefined;
let saved: Array<Record<string, unknown>>;
let stdout: string[];

const LEDGER = (): string => join(memDir, 'cost-tracker.json');

/** A row as the ledger writes it today: provider-reported, exact. */
function reportedRow(over: Record<string, unknown> = {}) {
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    timestamp: Date.now(),
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.25,
    measured: true,
    costReported: true,
    costSource: 'reported',
    billingTier: 'paid',
    pricingBasis: 'provider-reported cost for this call (exact)',
    ...over,
  };
}

function writeLedger(entries: Array<Record<string, unknown>>): void {
  writeFileSync(LEDGER(), JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
}

/** The production command shape: root program → stats → cost → <sub>. */
function runStats(argv: string[]): void {
  const cmd = new StatsCommand();
  (cmd as unknown as { configManager: unknown }).configManager = {
    getAll: vi.fn(
      (): BuffConfig =>
        ({
          defaultProvider: 'local',
          providers: { deepseek: { model: 'deepseek-v4-pro' } },
        }) as BuffConfig,
    ),
    save: vi.fn((patch: Record<string, unknown>) => {
      saved.push(patch);
    }),
  };
  const cli = new Command();
  cli.addCommand(cmd.create());
  cli.parse(['node', 'nuvira', 'stats', 'cost', ...argv]);
}

const output = (): string => stdout.join('\n');

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-stats-cost-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  prevCfgDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
  process.env.NUVIRA_CONFIG_DIR = join(memDir, 'cfg');
  resetPricingContextCache();
  saved = [];
  stdout = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPricingContextCache();
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  rmSync(memDir, { recursive: true, force: true });
});

describe('stats cost reconcile', () => {
  it('compares the provider’s invoice to the ledger and names both figures', () => {
    writeLedger([reportedRow(), reportedRow()]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '0.50', '--days', '30']);

    expect(output()).toContain('Cost Reconciliation');
    expect(output()).toContain('$0.500000'); // the invoice — the actual figure
    expect(output()).toContain('$0.500000'); // the ledger's evidence
    expect(output()).toMatch(/MATCH/);
  });

  it('reports the gap when the invoice is larger than the evidence', () => {
    writeLedger([reportedRow()]);
    runStats(['reconcile', '-p', 'deepseek', '-a', '0.90', '--days', '30']);
    expect(output()).toContain('UNDER-EVIDENCED');
    expect(output()).toContain('the invoice is the "actual" figure');
  });

  it('emits a machine-readable report with --json', () => {
    writeLedger([reportedRow()]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '0.25', '--days', '30', '--json']);
    const parsed = JSON.parse(output()) as { invoiceUsd: number; billedUsd: number; verdict: string };
    expect(parsed.invoiceUsd).toBe(0.25);
    expect(parsed.billedUsd).toBe(0.25);
    expect(parsed.verdict).toBe('match');
  });

  it('rejects a provider id the ledger has never seen, instead of reporting zero usage', () => {
    writeLedger([reportedRow()]);
    runStats(['reconcile', '--provider', 'deepsek', '--amount', '5', '--days', '30']);
    expect(output()).toContain('Unknown provider "deepsek"');
    expect(output()).toContain('Known ids:');
    // No report at all — a typo must not produce a confident-looking delta.
    expect(output()).not.toContain('Cost Reconciliation');
  });

  it('rejects a malformed amount', () => {
    writeLedger([reportedRow()]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', 'twelve', '--days', '30']);
    expect(output()).toContain('Invalid --amount');
    expect(output()).not.toContain('Cost Reconciliation');
  });

  it('REFUSES to declare a free tier while holding an invoice that charged money', () => {
    writeLedger([reportedRow({ costUsd: 0, costReported: true })]);
    runStats([
      'reconcile',
      '--provider',
      'deepseek',
      '--amount',
      '18.40',
      '--days',
      '30',
      '--declare-tier',
      'free',
    ]);
    expect(output()).toContain('Refusing to declare "free"');
    expect(saved).toHaveLength(0);
  });

  it('refuses to declare `paid` when the invoice charged nothing', () => {
    writeLedger([reportedRow({ costUsd: 0, costReported: true })]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '0', '--days', '30', '--declare-tier', 'paid']);
    expect(output()).toContain('Refusing to declare "paid"');
    expect(saved).toHaveLength(0);
  });

  it('declares the tier the invoice EVIDENCES when asked without a value', () => {
    // $0 charged across real calls, nothing billed by evidence → `free` is proven.
    writeLedger([reportedRow({ costUsd: 0, costReported: true })]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '0', '--days', '30', '--declare-tier']);

    expect(output()).toContain('Billing tier EVIDENCED by the invoice: free');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ providers: { deepseek: { billingTier: 'free' } } });
  });

  it('will not guess a tier when the invoice proves none', () => {
    writeLedger([reportedRow({ costUsd: 0, costReported: true })]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '20', '--days', '30', '--declare-tier']);
    expect(output()).toContain('does not prove a billing tier');
    expect(saved).toHaveLength(0);
  });

  it('rejects a contradictory window rather than picking one', () => {
    writeLedger([reportedRow()]);
    runStats(['reconcile', '--provider', 'deepseek', '--amount', '1', '--days', '3', '--since', '2026-10-01']);
    expect(output()).toContain('Use either --since or --days');
  });
});

describe('stats cost reprice', () => {
  const legacy = () => ({
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    timestamp: 1_700_000_000_000,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.0001, // the retired generic fallback
  });

  it('is a dry run unless --apply is passed', () => {
    writeLedger([legacy()]);
    const before = readFileSync(LEDGER(), 'utf-8');
    runStats(['reprice']);
    expect(output()).toContain('DRY RUN');
    expect(readFileSync(LEDGER(), 'utf-8')).toBe(before);
    expect(existsSync(`${LEDGER()}.bak`)).toBe(false);
  });

  it('writes on --apply, keeping a backup', () => {
    writeLedger([legacy()]);
    const before = readFileSync(LEDGER(), 'utf-8');
    runStats(['reprice', '--apply']);
    expect(output()).toContain('Repriced (written)');
    expect(readFileSync(`${LEDGER()}.bak`, 'utf-8')).toBe(before);
    const written = JSON.parse(readFileSync(LEDGER(), 'utf-8')) as {
      entries: Array<{ costSource?: string; billingTier?: string }>;
    };
    expect(written.entries[0].costSource).toBe('catalog');
    expect(written.entries[0].billingTier).toBe('unknown');
  });

  it('--json emits the report for scripts', () => {
    writeLedger([legacy()]);
    runStats(['reprice', '--json']);
    const parsed = JSON.parse(output()) as { applied: boolean; rows: { repriced: number } };
    expect(parsed.applied).toBe(false);
    expect(parsed.rows.repriced).toBe(1);
  });
});

describe('parseAmount — the operator copies a figure off a dashboard', () => {
  it('accepts $, thousands separators and whitespace', () => {
    expect(parseAmount('$12.34')).toBe(12.34);
    expect(parseAmount(' 1,234.56 ')).toBe(1234.56);
  });

  it('treats 0 as a valid invoice (nothing was charged)', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('$0.00')).toBe(0);
  });

  it('rejects everything that is not a non-negative finite amount', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('twelve')).toBeNull();
    expect(parseAmount('-3')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });
});
