/**
 * Cost reconciliation — the ONLY way the word "actual" can be earned.
 *
 * WHAT THIS REPLACES. Every figure the ledger reports is, at best, an ESTIMATE of
 * money owed: a provider-reported per-call cost is exact about the call, and a
 * list price on a declared-`paid` account is a guess at the bill. Neither is the
 * bill. The ledger cannot see one, so the honest headline is "billed by evidence
 * — $X" and never "you paid $X". This module closes that gap the only way it can
 * be closed: the operator reads the provider's OWN number off the invoice and
 * enters it, and everything else here is arithmetic on two figures that came from
 * outside this machine.
 *
 * WHAT IT IS NOT. It never guesses an invoice, never scales one, and never
 * "adjusts" the ledger to match. It reports the difference and what the
 * difference most likely consists of — unpriced calls, calls whose list price was
 * never claimed as spend (an undeclared billing tier), or rows the ledger is
 * missing.
 *
 * ─── THE BILLING FACT, EARNED (read before changing tierEvidence) ───────────
 *
 * `providers.<id>.billingTier` decides whether a list-priced call is money owed
 * (`paid`) or value absorbed (`free`/`subscription`), and it is the single fact
 * that moves the headline the most. Being user-declared, it is an assumption —
 * which is exactly what this change is here to remove. An invoice is evidence,
 * so this module states what the invoice PROVES, and the CLI refuses to record a
 * tier the invoice contradicts:
 *
 *   - $0 charged across N calls in the window, and nothing billed by evidence
 *     → the key is not being charged per call: `free` is EVIDENCED.
 *   - A charge that matches the per-call costs the provider itself reported
 *     → the key is metered and billed: `paid` is EVIDENCED.
 *   - Anything else (a flat fee, a discounted charge, a mismatch) proves only
 *     what it says: the key IS charged. `subscription` and `paid` cannot be told
 *     apart from one invoice line, so no tier is claimed — the operator picks,
 *     and the CLI says why it is asking rather than picking for them.
 *
 * A period that has not closed yet must not be reconciled against (`--days` on a
 * running month reads a partial invoice). The window is always printed with the
 * result so the comparison can be judged, and `--until` exists to pin it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { envBuff, resolveNuviraHome } from '../config/paths';
import { classifyEntries, type ClassifiableEntry, type PricingContext } from './cost-classification.js';
import type { BillingTier } from './model-pricing.js';

// ─── Input: the provider's own number ───────────────────────────────────────

/**
 * What the operator read off the provider's bill. Every field is REQUIRED except
 * `note`: a window is not optional, because comparing an all-time ledger to a
 * monthly invoice is a meaningless subtraction dressed up as a number.
 */
export interface InvoiceClaim {
  /** The provider id the invoice line belongs to (e.g. `deepseek`). */
  provider: string;
  /** The provider's own figure for the window, USD. */
  invoiceUsd: number;
  /** Inclusive window start (epoch ms) — normally the billing period's start. */
  since: number;
  /**
   * EXCLUSIVE window end (epoch ms) — normally the billing period's end. Half-open
   * so consecutive periods cannot count a boundary row twice.
   *
   * A caller whose end is a LIVE "now" must pass `now + 1`, not `now`: a ledger
   * row's timestamp is `Date.now()` and so is the caller's, in the same
   * millisecond resolution, so an exclusive `now` silently drops whatever was
   * recorded in the current millisecond (MEASURED — the CLI's default window did
   * exactly this and reported "no ledger rows for <provider> in this window").
   */
  until: number;
  /** Where the number came from, printed verbatim (e.g. "dashboard, Oct 2026"). */
  note?: string;
}

// ─── Output ─────────────────────────────────────────────────────────────────

/**
 * How the invoice and the ledger relate. Three values, because "off by $0.40"
 * and "off by $6.30 in the same direction" are different claims with different
 * remedies, and a boolean would flatten them.
 */
export type ReconciliationVerdict = 'match' | 'under-evidenced' | 'over-recorded';

export interface CostReconciliation {
  provider: string;
  since: number;
  until: number;
  /** The provider's own figure — the ONE number here that is not ours. */
  invoiceUsd: number;
  note?: string;
  /** Ledger rows for this provider inside the window (test-origin excluded). */
  requests: number;
  tokens: number;
  /** Evidence-backed bill: provider-reported + list-priced with a declared paid account. */
  billedUsd: number;
  /** The exact part (provider stated each call's charge). */
  billedReportedUsd: number;
  /** The estimated part (list price, account declared `paid`). */
  billedListedUsd: number;
  /** List-priced but the tier is undeclared: real tokens, no claim of spend. */
  unverifiedListedUsd: number;
  /** List price of calls a free/subscription tier absorbed — never spend. */
  notBilledValueUsd: number;
  /** Calls with no price evidence at all (unknown provider or pass-through gateway). */
  unpricedCalls: number;
  /** Test-origin rows in the window — excluded from every figure above. */
  testOriginCalls: number;
  /** `invoiceUsd - billedUsd`. Positive = the provider charged more than we can evidence. */
  deltaUsd: number;
  /** The band inside which the two are called equal (see `toleranceFor`). */
  toleranceUsd: number;
  verdict: ReconciliationVerdict;
  /** One line naming exactly what was compared. Always printed. */
  basis: string;
  /** What the invoice PROVES about the key's billing tier, when it proves it. */
  tierEvidence?: { tier: BillingTier; basis: string };
  /** What could account for a non-zero delta — the actionable part. */
  hints: string[];
}

/**
 * How close is "the same money". An invoice rounds to cents and the ledger's
 * list prices are estimates, so exact equality would report `match` essentially
 * never — and a verdict that is always "mismatch" teaches the operator to ignore
 * it. The band is 1% of the larger figure, floored at one cent so a tiny account
 * is not judged on fractions of a cent.
 */
function toleranceFor(invoiceUsd: number, billedUsd: number): number {
  const base = Math.max(Math.abs(invoiceUsd), Math.abs(billedUsd));
  return Math.max(0.01, Math.round(base * 0.01 * 100000) / 100000);
}

const round6 = (n: number): number => Math.round(n * 100000) / 100000;

// ─── The comparison ─────────────────────────────────────────────────────────

/**
 * Reconcile a provider's invoice against the ledger rows in the same window.
 *
 * Pure with respect to the ledger: it reads rows and returns a report; nothing is
 * written and no row is modified. `provider` matching is exact — a per-provider
 * invoice must never be compared against a whole-profile total.
 *
 * Test-origin rows are excluded from EVERY figure (a fixture call is not a charge)
 * and counted in `testOriginCalls`, so a window can be checked for the rows that
 * were hidden rather than silently shrinking.
 */
export function reconcileEntries(
  claim: InvoiceClaim,
  entries: readonly ClassifiableEntry[],
  ctx?: PricingContext,
): CostReconciliation {
  const since = claim.since;
  const until = claim.until;
  // Half-open [since, until) — see `InvoiceClaim.until` for why a live `now`
  // must arrive as `now + 1`.
  const inWindow = entries.filter(
    (e) =>
      e.provider === claim.provider &&
      typeof e.timestamp === 'number' &&
      e.timestamp >= since &&
      e.timestamp < until,
  );

  const totals = classifyEntries(inWindow, { ctx, excludeTestOrigin: true });
  const invoiceUsd = round6(Math.max(0, claim.invoiceUsd));
  const billedUsd = totals.billedUsd;
  const deltaUsd = round6(invoiceUsd - billedUsd);
  const toleranceUsd = toleranceFor(invoiceUsd, billedUsd);

  const verdict: ReconciliationVerdict =
    Math.abs(deltaUsd) <= toleranceUsd ? 'match' : deltaUsd > 0 ? 'under-evidenced' : 'over-recorded';

  const windowText = `${new Date(since).toISOString()} → ${new Date(until).toISOString()}`;
  const basis =
    `${claim.provider}: invoice $${invoiceUsd.toFixed(6)} vs ledger evidence $${billedUsd.toFixed(6)} ` +
    `over ${totals.requests} call(s) in ${windowText}` +
    `${claim.note ? ` (invoice source: ${claim.note})` : ''}`;

  // ── What the invoice proves about the account ────────────────────────────
  let tierEvidence: { tier: BillingTier; basis: string } | undefined;
  if (invoiceUsd === 0 && totals.requests > 0 && billedUsd === 0) {
    tierEvidence = {
      tier: 'free',
      basis: `the provider charged $0 for ${totals.requests} call(s) in this window — the key is not billed per call`,
    };
  } else if (
    invoiceUsd > 0 &&
    billedUsd > 0 &&
    totals.billedReportedUsd > 0 &&
    Math.abs(invoiceUsd - totals.billedReportedUsd) <= toleranceUsd
  ) {
    tierEvidence = {
      tier: 'paid',
      basis: `the invoice matches the per-call costs the provider itself reported ($${totals.billedReportedUsd.toFixed(6)}) — the key is metered and billed`,
    };
  }

  // ── What could explain the delta (never a silent adjustment) ─────────────
  const hints: string[] = [];
  if (totals.requests === 0) {
    hints.push(
      `no ledger rows for ${claim.provider} in this window — if calls were made, the ledger is missing them (a different NUVIRA_MEMORY_DIR, a profile that was cleared, or a provider recorded under another id)`,
    );
  }
  if (verdict === 'under-evidenced') {
    if (totals.unpricedCalls > 0) {
      hints.push(
        `${totals.unpricedCalls} call(s) in this window have NO price evidence (configure pricing.${claim.provider}.inputPer1K/outputPer1K) — they may be part of the $${deltaUsd.toFixed(6)}`,
      );
    }
    if (totals.unverifiedListedUsd > 0) {
      hints.push(
        `$${totals.unverifiedListedUsd.toFixed(6)} of list-priced calls are not counted as spend because providers.${claim.provider}.billingTier is undeclared`,
      );
    }
    hints.push(
      `the invoice is the "actual" figure here: money the provider charged that this ledger cannot evidence`,
    );
  }
  if (verdict === 'over-recorded') {
    hints.push(
      `the ledger's evidence ($${billedUsd.toFixed(6)}) EXCEEDS the charge ($${invoiceUsd.toFixed(6)}) — either list prices are above what this account is really charged (a discount, credits, or a flat plan that the "paid" tier is metering per call), or rows were double-recorded`,
    );
    if (totals.billedListedUsd > 0) {
      hints.push(
        `$${totals.billedListedUsd.toFixed(6)} of the ledger figure is list-priced on an account declared "paid", i.e. an estimate — the invoice is the truth`,
      );
    }
  }
  if (invoiceUsd > 0 && totals.notBilledValueUsd > 0) {
    hints.push(
      `the invoice shows a charge while $${totals.notBilledValueUsd.toFixed(6)} of list value is classified not-billed (free/subscription) — re-check the tier or the window`,
    );
  }
  if (totals.testOriginCalls > 0) {
    hints.push(`${totals.testOriginCalls} test-origin row(s) were excluded from this comparison`);
  }

  return {
    provider: claim.provider,
    since,
    until,
    invoiceUsd,
    ...(claim.note ? { note: claim.note } : {}),
    requests: totals.requests,
    tokens: totals.tokens,
    billedUsd,
    billedReportedUsd: totals.billedReportedUsd,
    billedListedUsd: totals.billedListedUsd,
    unverifiedListedUsd: totals.unverifiedListedUsd,
    notBilledValueUsd: totals.notBilledValueUsd,
    unpricedCalls: totals.unpricedCalls,
    testOriginCalls: totals.testOriginCalls,
    deltaUsd,
    toleranceUsd,
    verdict,
    basis,
    ...(tierEvidence ? { tierEvidence } : {}),
    hints,
  };
}

// ─── The durable record ─────────────────────────────────────────────────────

/**
 * A reconciliation as stored. `recordedAt` is when the operator entered the
 * invoice figure — a reconciliation is a statement about a moment, and a stored
 * one without a date invites being read as current.
 */
export interface StoredReconciliation extends CostReconciliation {
  recordedAt: number;
}

/** Where the reconciliation records live, resolved lazily (see cost-tracker). */
export function reconciliationLedgerPath(): string {
  const dir = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
  return join(dir, 'cost-reconciliations.json');
}

/**
 * Every recorded reconciliation, newest first. Never throws — a corrupt file
 * reads as empty, because this is display/audit data and a broken history must
 * not take down the cost page.
 */
export function readReconciliations(opts: { file?: string } = {}): StoredReconciliation[] {
  const path = opts.file ?? reconciliationLedgerPath();
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { reconciliations?: StoredReconciliation[] };
    const list = Array.isArray(parsed?.reconciliations) ? parsed.reconciliations : [];
    return list.filter((r) => r && typeof r.provider === 'string' && typeof r.invoiceUsd === 'number');
  } catch {
    return [];
  }
}

/** Keep the file small: a reconciliation is a checkpoint, not a stream. */
const MAX_RECONCILIATIONS = 200;

/**
 * Persist a reconciliation. Appending rather than replacing on purpose: the
 * HISTORY is the audit trail ("this was checked against the October invoice, and
 * the delta was 3 cents"), and a later check must not erase what an earlier one
 * established.
 */
export function recordReconciliation(
  rec: CostReconciliation,
  opts: { file?: string; at?: number } = {},
): StoredReconciliation {
  const stored: StoredReconciliation = { ...rec, recordedAt: opts.at ?? Date.now() };
  const path = opts.file ?? reconciliationLedgerPath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const all = [stored, ...readReconciliations({ file: path })].slice(0, MAX_RECONCILIATIONS);
    writeFileSync(path, JSON.stringify({ version: 1, reconciliations: all }, null, 2), 'utf-8');
  } catch {
    // Best-effort: the report was already produced and returned to the caller.
  }
  return stored;
}

/** The most recent record for a provider, or undefined. */
export function lastReconciliationFor(
  provider: string,
  opts: { file?: string } = {},
): StoredReconciliation | undefined {
  return readReconciliations(opts).find((r) => r.provider === provider);
}

// ─── Display ────────────────────────────────────────────────────────────────

const usd = (n: number): string => `$${n.toFixed(6)}`;

/** The reconciliation, as text — shared by the CLI and any surface that prints it. */
export function formatReconciliation(rec: StoredReconciliation | CostReconciliation): string {
  const lines: string[] = [
    '🧾 Cost Reconciliation — the provider’s own figure vs this ledger',
    '',
    `   Provider:  ${rec.provider}`,
    `   Window:    ${new Date(rec.since).toISOString()} → ${new Date(rec.until).toISOString()}`,
    `   Invoice:   ${usd(rec.invoiceUsd)}${rec.note ? `   (${rec.note})` : ''}`,
    `   Ledger:    ${usd(rec.billedUsd)}  evidence-backed` +
      ` (🧾 exact ${usd(rec.billedReportedUsd)} + 📋 list-estimated ${usd(rec.billedListedUsd)})`,
    `   Calls:     ${rec.requests}  (${rec.tokens} tokens)` +
      `${rec.testOriginCalls > 0 ? `, ${rec.testOriginCalls} test-origin excluded` : ''}`,
    '',
  ];

  const verdict =
    rec.verdict === 'match'
      ? `✅ MATCH — within ${usd(rec.toleranceUsd)} (delta ${rec.deltaUsd >= 0 ? '+' : ''}${usd(rec.deltaUsd)})`
      : rec.verdict === 'under-evidenced'
        ? `⚠️  UNDER-EVIDENCED — the provider charged ${usd(rec.deltaUsd)} more than this ledger can prove`
        : `⚠️  OVER-RECORDED — this ledger claims ${usd(-rec.deltaUsd)} more than the provider charged`;
  lines.push(`   ${verdict}`, '');

  if (rec.tierEvidence) {
    lines.push(
      `   🔑 Billing tier EVIDENCED by the invoice: ${rec.tierEvidence.tier}`,
      `      ${rec.tierEvidence.basis}`,
      '',
    );
  }
  if (rec.hints.length > 0) {
    lines.push('   What this means:');
    for (const h of rec.hints) lines.push(`     • ${h}`);
    lines.push('');
  }
  lines.push(`   ${rec.basis}`, '');
  return lines.join('\n');
}
