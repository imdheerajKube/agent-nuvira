/**
 * Cost-ledger maintenance — re-pricing the rows already on disk, and dropping the
 * ones that were never the user's usage.
 *
 * These tests pin the three refusals that make a reprice trustworthy (see the
 * module header):
 *   - a row that already carries `costSource` is left EXACTLY as written (history
 *     is not rewritten to match a config that changed since),
 *   - a legacy row's stored figure is never fed back in as though the provider had
 *     reported it (that would launder an estimate into an exact figure),
 *   - nothing is written without `apply`, and an apply keeps a `.bak`.
 *
 * Prices are injected through a `PricingContext` ($1 / 1K in, $2 / 1K out) so a
 * 10-in/10-out row is $0.03 and the arithmetic does not depend on the catalog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatMaintenanceReport,
  maintainCostLedger,
  repriceLedgerEntries,
  testRowVerdict,
} from '../../src/learning/cost-ledger-maintenance.js';
import { isFixtureModelId } from '../../src/learning/model-selection.js';
import type { PricingContext } from '../../src/learning/cost-classification.js';

const PRICE: PricingContext = {
  billingTierFor: () => 'paid',
  configPricingFor: (p) => (p === 'testprov' ? { inputPer1K: 1, outputPer1K: 2 } : undefined),
};
const UNDECLARED: PricingContext = {
  billingTierFor: () => 'unknown',
  configPricingFor: (p) => (p === 'testprov' ? { inputPer1K: 1, outputPer1K: 2 } : undefined),
};

/** A row as the retired hardcoded table wrote it: a number, and no provenance. */
function legacyRow(over: Record<string, unknown> = {}) {
  return {
    provider: 'testprov',
    model: 'testprov-model-a',
    timestamp: 1_700_000_000_000,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    costUsd: 0.0001, // the old $0.00010/1K generic default
    measured: true,
    ...over,
  };
}

describe('testRowVerdict — what is provably not your usage', () => {
  it('takes an `origin: test` tag as the row saying so', () => {
    expect(testRowVerdict({ origin: 'test', model: 'llama-3.3-70b' })).toBe('test-origin');
  });

  it('takes a fixture model id as evidence when there is no origin field (legacy rows)', () => {
    expect(testRowVerdict({ model: 'wire-stub-model' })).toBe('fixture-id');
    expect(isFixtureModelId('wire-stub-model')).toBe(true);
  });

  it('lets an EXPLICIT `live` tag outrank the id heuristic', () => {
    // A stated fact beats an inferred one: a row the recorder marked as real usage
    // is not deleted for having an odd model id.
    expect(testRowVerdict({ origin: 'live', model: 'wire-stub-model' })).toBeNull();
  });

  it('leaves real models alone — including `-latest` aliases a looser rule would eat', () => {
    expect(testRowVerdict({ model: 'gemini-flash-latest' })).toBeNull();
    expect(testRowVerdict({ model: 'deepseek-coder:latest' })).toBeNull();
    expect(testRowVerdict({ model: 'llama-3.3-70b-versatile' })).toBeNull();
    expect(isFixtureModelId('gemini-flash-latest')).toBe(false);
  });
});

describe('repriceLedgerEntries — the row-level rules', () => {
  it('re-prices a legacy row from the ONE price source and gives it provenance', () => {
    const { entries, report } = repriceLedgerEntries([legacyRow()], { ctx: PRICE });
    const row = entries[0];
    expect(row.costUsd).toBe(0.03); // 10/1K×$1 + 10/1K×$2 — the injected price
    expect(row.costSource).toBe('catalog');
    expect(row.listPriceUsd).toBe(0.03);
    expect(row.billingTier).toBe('paid');
    expect(row.pricingBasis).toContain('config override');
    // Unknown is not `live`: we cannot know which process wrote a legacy row.
    expect(row.origin).toBeUndefined();
    expect(report.rows.repriced).toBe(1);
    expect(report.before.recordedUsd).toBe(0.0001);
    expect(report.after.recordedUsd).toBe(0.03);
  });

  it('leaves a row that already carries a classification EXACTLY as written', () => {
    const classified = legacyRow({
      costSource: 'free',
      costUsd: 0,
      listPriceUsd: 0.5,
      billingTier: 'free',
      pricingBasis: 'your account is declared a free tier',
    });
    const { entries, report } = repriceLedgerEntries([classified], { ctx: PRICE });
    expect(entries[0]).toBe(classified); // same object: untouched
    expect(report.rows.alreadyClassified).toBe(1);
    expect(report.rows.repriced).toBe(0);
  });

  it('never launders an old estimate into a provider-reported figure', () => {
    // No `costReported` flag → the stored number was an estimate and is replaced.
    const { entries } = repriceLedgerEntries([legacyRow({ costUsd: 99 })], { ctx: PRICE });
    expect(entries[0].costUsd).toBe(0.03);
    expect(entries[0].costSource).toBe('catalog');
  });

  it('keeps a provider-reported legacy figure verbatim', () => {
    const { entries } = repriceLedgerEntries([legacyRow({ costUsd: 0.0042, costReported: true })], { ctx: PRICE });
    expect(entries[0].costUsd).toBe(0.0042);
    expect(entries[0].costSource).toBe('reported');
  });

  it('prices an unknown provider as UNPRICED — the generic fallback is gone', () => {
    const { entries } = repriceLedgerEntries(
      [legacyRow({ provider: 'mystery-provider', model: 'mystery-model' })],
      { ctx: PRICE },
    );
    expect(entries[0].costUsd).toBe(0);
    expect(entries[0].costSource).toBe('unknown');
    expect(entries[0].listPriceUsd).toBeUndefined();
  });

  it('moves an undeclared account’s list-priced rows to unverified, never to spend', () => {
    const { report } = repriceLedgerEntries([legacyRow()], { ctx: UNDECLARED });
    expect(report.after.billedUsd).toBe(0);
    expect(report.after.unverifiedListedUsd).toBe(0.03);
    expect(report.notes.join(' ')).toContain('NOT counted as spend');
  });

  it('removes test-origin and fixture-id rows and itemises them', () => {
    const { entries, report } = repriceLedgerEntries(
      [
        legacyRow(),
        legacyRow({ origin: 'test', costUsd: 7 }),
        legacyRow({ model: 'wire-stub-model', provider: 'local', costUsd: 0.4 }),
      ],
      { ctx: PRICE },
    );
    expect(entries).toHaveLength(1);
    expect(report.rows.kept).toBe(1);
    expect(report.rows.testOriginRemoved).toBe(1);
    expect(report.rows.fixtureRemoved).toBe(1);
    const byPair = Object.fromEntries(report.removed.map((r) => [`${r.provider}/${r.model}`, r]));
    expect(byPair['local/wire-stub-model'].fixtureId).toBe(true);
    expect(byPair['testprov/testprov-model-a'].fixtureId).toBe(false);
  });

  it('keeps test rows when pruning is switched off', () => {
    const { entries, report } = repriceLedgerEntries([legacyRow({ origin: 'test' })], {
      ctx: PRICE,
      pruneTestRows: false,
    });
    expect(entries).toHaveLength(1);
    expect(report.rows.testOriginRemoved).toBe(0);
  });
});

describe('maintainCostLedger — the file pass', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-ledger-maint-'));
    file = join(dir, 'cost-tracker.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          entries: [legacyRow(), legacyRow({ origin: 'test' }), legacyRow({ model: 'wire-stub-model', provider: 'local' })],
        },
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('DRY RUN by default: reports the repair and writes nothing', () => {
    const before = readFileSync(file, 'utf-8');
    const report = maintainCostLedger({ file, ctx: PRICE });
    expect(report.applied).toBe(false);
    expect(report.rows.repriced).toBe(1);
    expect(report.rows.testOriginRemoved).toBe(1);
    expect(report.rows.fixtureRemoved).toBe(1);
    expect(readFileSync(file, 'utf-8')).toBe(before);

    const text = formatMaintenanceReport(report);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('Nothing was written.');
  });

  it('--apply writes the repaired rows and keeps a .bak of the previous ledger', () => {
    const before = readFileSync(file, 'utf-8');
    const report = maintainCostLedger({ file, ctx: PRICE, apply: true });

    expect(report.applied).toBe(true);
    expect(report.backupPath).toBe(`${file}.bak`);
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(readFileSync(`${file}.bak`, 'utf-8')).toBe(before);

    const written = JSON.parse(readFileSync(file, 'utf-8')) as { entries: Array<{ model: string; costUsd: number; costSource: string }> };
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].costSource).toBe('catalog');
    expect(written.entries[0].costUsd).toBe(0.03);
    expect(report.after.recordedUsd).toBe(0.03);
  });

  it('is idempotent: a second apply changes nothing', () => {
    maintainCostLedger({ file, ctx: PRICE, apply: true });
    const once = readFileSync(file, 'utf-8');
    const report = maintainCostLedger({ file, ctx: PRICE, apply: true });
    expect(report.rows.repriced).toBe(0);
    expect(report.rows.alreadyClassified).toBe(1);
    expect(readFileSync(file, 'utf-8')).toBe(once);
  });

  it('treats a missing ledger as an empty one rather than crashing', () => {
    const report = maintainCostLedger({ file: join(dir, 'nope.json'), ctx: PRICE });
    expect(report.rows.total).toBe(0);
    expect(report.after.recordedUsd).toBe(0);
  });
});
