/**
 * Cost reconciliation — the provider's OWN invoice vs this ledger.
 *
 * The point of the whole file: every other number this project reports is an
 * estimate of money owed (a price we can name a source for), and only an invoice
 * is "actual". These tests pin that the comparison
 *   1. never guesses an invoice and never adjusts the ledger to match,
 *   2. only compares a window and a provider (an all-time ledger against a monthly
 *      line is a meaningless subtraction),
 *   3. states what the invoice PROVES about the billing tier, and proves nothing
 *      when it proves nothing,
 *   4. excludes test-origin rows from every figure while reporting how many it hid.
 *
 * Prices are injected through a `PricingContext` (1 USD / 1K in, 2 USD / 1K out) so
 * the arithmetic is deterministic and independent of the provider catalog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatReconciliation,
  readReconciliations,
  reconcileEntries,
  recordReconciliation,
  reconciliationLedgerPath,
} from '../../src/learning/cost-reconcile.js';
import type { PricingContext } from '../../src/learning/cost-classification.js';

const WINDOW_START = Date.parse('2026-10-01T00:00:00Z');
const IN_WINDOW = Date.parse('2026-10-05T12:00:00Z');
const OUT_OF_WINDOW = Date.parse('2026-09-20T12:00:00Z');
const UNTIL = Date.parse('2026-11-01T00:00:00Z');

/** $1 / 1K in, $2 / 1K out — so 10 in + 10 out = $0.03. */
const FLAT_PRICE: PricingContext = {
  billingTierFor: (p) => (p === 'testprov' ? 'paid' : 'unknown'),
  configPricingFor: () => ({ inputPer1K: 1, outputPer1K: 2 }),
};

const FREE_TIER: PricingContext = {
  billingTierFor: () => 'unknown',
  configPricingFor: () => ({ inputPer1K: 1, outputPer1K: 2 }),
};

/** A row already written by the current classification rules. */
function classifiedRow(over: Record<string, unknown> = {}) {
  return {
    provider: 'testprov',
    model: 'testprov-model-a',
    timestamp: IN_WINDOW,
    inputTokens: 10,
    outputTokens: 10,
    totalTokens: 20,
    costUsd: 0.03,
    costSource: 'catalog' as const,
    listPriceUsd: 0.03,
    billingTier: 'paid' as const,
    pricingBasis: 'your config override (pricing.testprov) — account declared paid',
    ...over,
  };
}

const CLAIM = { provider: 'testprov', since: WINDOW_START, until: UNTIL };

describe('reconcileEntries — the comparison itself', () => {
  it('calls it a match when the invoice and the evidence agree', () => {
    const rec = reconcileEntries({ ...CLAIM, invoiceUsd: 0.03 }, [classifiedRow()], FLAT_PRICE);
    expect(rec.verdict).toBe('match');
    expect(rec.invoiceUsd).toBe(0.03);
    expect(rec.billedUsd).toBe(0.03);
    expect(rec.deltaUsd).toBe(0);
    expect(rec.requests).toBe(1);
  });

  it('reports UNDER-EVIDENCED when the provider charged more than the ledger can prove', () => {
    // Two rows priced at 0.03 each = 0.06 evidenced, invoice 0.10.
    const rec = reconcileEntries({ ...CLAIM, invoiceUsd: 0.1 }, [classifiedRow(), classifiedRow()], FLAT_PRICE);
    expect(rec.verdict).toBe('under-evidenced');
    expect(rec.billedUsd).toBe(0.06);
    expect(rec.deltaUsd).toBe(0.04);
    // The invoice is named as the actual figure — never the estimate.
    expect(rec.hints.join(' ')).toContain('the invoice is the "actual" figure');
  });

  it('reports OVER-RECORDED when the ledger claims more than the provider charged', () => {
    const rec = reconcileEntries({ ...CLAIM, invoiceUsd: 0.01 }, [classifiedRow()], FLAT_PRICE);
    expect(rec.verdict).toBe('over-recorded');
    expect(rec.deltaUsd).toBe(-0.02);
    expect(rec.hints.join(' ')).toContain('EXCEEDS the charge');
  });

  it('names the undeclared tier and the unpriced calls as what the gap consists of', () => {
    // A list-priced row whose account tier is undeclared: real tokens, no spend claim.
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.30 },
      [classifiedRow({ billingTier: 'unknown', costUsd: 0, pricingBasis: 'undeclared' })],
      FREE_TIER,
    );
    expect(rec.billedUsd).toBe(0);
    expect(rec.unverifiedListedUsd).toBe(0.03);
    expect(rec.hints.join(' ')).toContain('billingTier is undeclared');

    const noPrice = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.30 },
      [classifiedRow({ costSource: 'unknown', costUsd: 0, listPriceUsd: undefined, pricingBasis: 'none' })],
      FREE_TIER,
    );
    expect(noPrice.unpricedCalls).toBe(1);
    expect(noPrice.hints.join(' ')).toContain('NO price evidence');
  });

  it('compares ONE provider over ONE window — nothing else is in the numbers', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.03 },
      [
        classifiedRow(),
        classifiedRow({ timestamp: OUT_OF_WINDOW }),
        classifiedRow({ provider: 'otherprov' }),
      ],
      FLAT_PRICE,
    );
    expect(rec.requests).toBe(1);
    expect(rec.billedUsd).toBe(0.03);
  });

  it('excludes test-origin rows from every figure and says how many it hid', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.03 },
      [classifiedRow(), classifiedRow({ origin: 'test' as const, costUsd: 5 })],
      FLAT_PRICE,
    );
    expect(rec.requests).toBe(1);
    expect(rec.billedUsd).toBe(0.03);
    expect(rec.testOriginCalls).toBe(1);
    expect(rec.hints.join(' ')).toContain('1 test-origin row(s) were excluded');
  });

  it('says a return-to-empty window is missing rows rather than "you used nothing"', () => {
    const rec = reconcileEntries({ ...CLAIM, invoiceUsd: 4.5 }, [classifiedRow({ timestamp: OUT_OF_WINDOW })], FLAT_PRICE);
    expect(rec.requests).toBe(0);
    expect(rec.verdict).toBe('under-evidenced');
    expect(rec.hints.join(' ')).toContain('no ledger rows');
  });
});

describe('reconcileEntries — the billing fact, earned', () => {
  it('EVIDENCES `free` when the provider charged $0 across real calls', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0 },
      [classifiedRow({ billingTier: 'unknown', costUsd: 0 })],
      FREE_TIER,
    );
    expect(rec.verdict).toBe('match');
    expect(rec.tierEvidence?.tier).toBe('free');
    expect(rec.tierEvidence?.basis).toContain('charged $0');
  });

  it('EVIDENCES `paid` when the invoice matches the provider’s own per-call figures', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.03 },
      [classifiedRow({ costReported: true, costSource: 'reported' })],
      FREE_TIER,
    );
    expect(rec.tierEvidence?.tier).toBe('paid');
    expect(rec.tierEvidence?.basis).toContain('per-call costs the provider itself reported');
  });

  it('claims NO tier when the invoice cannot settle it (a flat fee is not a per-call fact)', () => {
    // $20 charged, but the ledger evidences nothing per call: paid and
    // subscription are indistinguishable from one invoice line, so no claim.
    const rec = reconcileEntries({ ...CLAIM, invoiceUsd: 20 }, [classifiedRow({ costUsd: 0 })], FREE_TIER);
    expect(rec.tierEvidence).toBeUndefined();
  });

  it('flags the contradiction when a charge exists but calls are classified not-billed', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 5 },
      [classifiedRow({ costSource: 'free' as const, costUsd: 0, listPriceUsd: 0.03, billingTier: 'free' as const })],
      FLAT_PRICE,
    );
    expect(rec.notBilledValueUsd).toBe(0.03);
    expect(rec.hints.join(' ')).toContain('re-check the tier or the window');
  });

  it('carries the invoice source note and prints the window', () => {
    const rec = reconcileEntries(
      { ...CLAIM, invoiceUsd: 0.03, note: 'provider dashboard, Oct 2026' },
      [classifiedRow()],
      FLAT_PRICE,
    );
    const text = formatReconciliation(rec);
    expect(text).toContain('provider dashboard, Oct 2026');
    expect(text).toContain('2026-10-01T00:00:00.000Z');
    // The word that started all this: no headline calls an estimate "spent".
    expect(text).not.toMatch(/total spent/i);
  });
});

describe('reconciliation records — the audit trail', () => {
  let memDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), 'nuvira-recon-'));
    prev = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = memDir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = prev;
    rmSync(memDir, { recursive: true, force: true });
  });

  it('stores under the resolved memory dir and appends newest first', () => {
    expect(reconciliationLedgerPath().startsWith(memDir)).toBe(true);

    const first = reconcileEntries({ ...CLAIM, invoiceUsd: 0.03 }, [classifiedRow()], FLAT_PRICE);
    recordReconciliation(first, { at: 1000 });
    const second = reconcileEntries({ ...CLAIM, invoiceUsd: 0.05 }, [classifiedRow()], FLAT_PRICE);
    recordReconciliation(second, { at: 2000 });

    const all = readReconciliations();
    expect(all).toHaveLength(2);
    expect(all[0].invoiceUsd).toBe(0.05);
    expect(all[0].recordedAt).toBe(2000);
    expect(all[1].invoiceUsd).toBe(0.03);
    expect(existsSync(reconciliationLedgerPath())).toBe(true);
  });

  it('reads a corrupt file as empty rather than taking the cost surfaces down', () => {
    writeFileSync(reconciliationLedgerPath(), '{ not json', 'utf-8');
    expect(readReconciliations()).toEqual([]);
  });
});
