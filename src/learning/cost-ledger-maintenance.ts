/**
 * Cost-ledger maintenance — the EXPLICIT, dry-run-default way to repair the rows
 * already on disk. Nothing here runs on a read: the ledger is repaired only when
 * an operator asks for it, and every figure it changes is reported before and
 * after.
 *
 * WHY IT EXISTS. Two classes of row in a real profile are not what they look like,
 * and neither can be fixed by a read:
 *
 *  1. LEGACY PRICES. Rows written before `costSource` existed carry a `costUsd`
 *     computed from the retired hardcoded table (`cost-tracker.ts`'s five-entry
 *     `DEFAULT_PRICING` plus a `$0.00010/1K` generic fallback). Read-side
 *     classification already re-derives them for DISPLAY (`cost-classification.ts`
 *     counts them in `recomputedCalls`), and deliberately never rewrites the file
 *     — but `recordedTotalUsd` ("the ledger total as recorded") keeps showing the
 *     old number, and a reprice is what turns the file itself honest.
 *  2. TEST-ORIGIN ROWS. A row a test run wrote into a real profile. Rows written
 *     since `origin` was added say so (`origin: 'test'`); rows from before have no
 *     field at all, and the only sound evidence left in them is the model id — a
 *     fixture id (`wire-stub-model`: MEASURED 747 rows in a real
 *     `~/.nuvira/memory/cost-tracker.json`) could not have come from a real call.
 *
 * ─── WHAT IT REFUSES TO DO (read before changing either rule) ───────────────
 *
 *  - It does NOT re-derive a row that already carries `costSource`. That row was
 *    written by today's rules under the config in force at the time; re-pricing it
 *    with a config that has changed since would rewrite history to match the
 *    present — the exact dishonesty this whole change removes.
 *  - It does NOT pass a legacy row's stored `costUsd` back in as though the
 *    provider had reported it. The stored number is the old estimate; feeding it
 *    into `resolveCallCost` as `reportedCostUsd` would LAUNDER an estimate into an
 *    exact-looking figure. Only a row already flagged `costReported: true` keeps
 *    its number verbatim, because that flag was written by the old code and means
 *    the same thing.
 *  - It does NOT guess `origin`. A legacy row gets no origin field: we do not know
 *    which process wrote it, and stamping `live` would make it unprunable forever.
 *  - It NEVER writes without `apply`, and a write always leaves a `.bak` beside the
 *    file (the ledger is the user's billing history; a reprice is reversible).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CostEntry } from './cost-tracker.js';
import { costLedgerPath } from './cost-tracker.js';
import {
  classifyEntries,
  getPricingContext,
  type ClassifiableEntry,
  type PricingContext,
} from './cost-classification.js';
import { resolveCallCost } from './model-pricing.js';
import { isFixtureModelId } from './model-selection.js';

// ─── Input / output shapes ──────────────────────────────────────────────────

interface LedgerFile {
  entries: CostEntry[];
  version: number;
}

/** One grouped removal, so the report says WHAT is being dropped, not just how many. */
export interface RemovedRows {
  provider: string;
  model: string;
  count: number;
  /** True when the id itself is the evidence (a fixture id), not an `origin` tag. */
  fixtureId: boolean;
}

export interface LedgerMaintenanceReport {
  file: string;
  applied: boolean;
  backupPath?: string;
  rows: {
    total: number;
    /** Legacy rows re-derived by today's rules (they gained `costSource`). */
    repriced: number;
    /** Rows already written by these rules — left exactly as they were. */
    alreadyClassified: number;
    /** Rows flagged `origin: 'test'`. */
    testOriginRemoved: number;
    /** Rows whose model id could only be a test fixture (no `origin` field). */
    fixtureRemoved: number;
    kept: number;
  };
  /** The ledger's own recorded sum before and after — the number a reader sees. */
  before: { recordedUsd: number; tokens: number; unpricedCalls: number };
  /**
   * Re-priced totals, classified: `recordedUsd` is the new sum of the rows'
   * `costUsd` (the evidence-backed figure), and the rest is the honest split.
   */
  after: {
    recordedUsd: number;
    tokens: number;
    billedUsd: number;
    billedReportedUsd: number;
    billedListedUsd: number;
    unverifiedListedUsd: number;
    notBilledValueUsd: number;
    unpricedCalls: number;
  };
  removed: RemovedRows[];
  /** Plain-language notes: what changed and what still needs the operator. */
  notes: string[];
}

// ─── Row-level rules ────────────────────────────────────────────────────────

/** True when the row is test-origin by evidence we can actually read. */
export function testRowVerdict(entry: { origin?: string; model?: string }): 'test-origin' | 'fixture-id' | null {
  if (entry.origin === 'test') return 'test-origin';
  // An EXPLICIT `live` tag outranks the id heuristic — the same doctrine
  // `telemetryOrigin` applies (a stated fact beats an inferred one). A row the
  // recorder itself marked as real usage is not deleted for looking odd.
  if (entry.origin === 'live') return null;
  // A fixture id is evidence from the row itself, and it is the ONLY evidence a
  // legacy row can carry (no `origin` field existed when it was written).
  if (isFixtureModelId(entry.model ?? '')) return 'fixture-id';
  return null;
}

/**
 * Re-derive ONE legacy row. Returns the repaired row, or the SAME object when the
 * row already carries `costSource` (never re-derived — see the header).
 */
function repriceRow(entry: CostEntry, ctx: PricingContext): CostEntry {
  if (entry.costSource !== undefined) return entry;

  const reported = entry.costReported === true ? entry.costUsd : undefined;
  const resolved = resolveCallCost({
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    // Only a row ALREADY flagged as provider-reported keeps its figure verbatim.
    ...(reported !== undefined ? { reportedCostUsd: reported } : {}),
    billingTier: ctx.billingTierFor(entry.provider),
    configPricing: ctx.configPricingFor(entry.provider),
    catalogRow: ctx.catalogRowFor?.(entry.provider, entry.model),
  });

  return {
    ...entry,
    costUsd: resolved.billedUsd,
    costSource: resolved.costSource,
    ...(resolved.listUsd !== undefined ? { listPriceUsd: resolved.listUsd } : {}),
    billingTier: resolved.billingTier,
    pricingBasis: resolved.basis,
    // `origin` is deliberately NOT set: unknown is not `live`.
  };
}

// ─── The pass ───────────────────────────────────────────────────────────────

/**
 * Re-price a set of ledger rows and (optionally) drop the test rows among them.
 * Pure: takes rows, returns rows — the file is written by `maintainCostLedger`.
 */
export function repriceLedgerEntries(
  entries: readonly CostEntry[],
  opts: { ctx?: PricingContext; pruneTestRows?: boolean } = {},
): { entries: CostEntry[]; report: Omit<LedgerMaintenanceReport, 'file' | 'applied' | 'backupPath'> } {
  const ctx = opts.ctx ?? getPricingContext();
  const prune = opts.pruneTestRows !== false;

  const kept: CostEntry[] = [];
  const removedCounts = new Map<string, RemovedRows>();
  let repriced = 0;
  let alreadyClassified = 0;
  let testOriginRemoved = 0;
  let fixtureRemoved = 0;

  for (const entry of entries) {
    const verdict = prune ? testRowVerdict(entry) : null;
    if (verdict) {
      if (verdict === 'test-origin') testOriginRemoved += 1;
      else fixtureRemoved += 1;
      const key = `${entry.provider}\u0000${entry.model}`;
      const existing = removedCounts.get(key);
      if (existing) existing.count += 1;
      else
        removedCounts.set(key, {
          provider: entry.provider,
          model: entry.model,
          count: 1,
          fixtureId: verdict === 'fixture-id',
        });
      continue;
    }

    const repaired = repriceRow(entry, ctx);
    if (repaired !== entry) repriced += 1;
    else alreadyClassified += 1;
    kept.push(repaired);
  }

  const beforeTotals = classifyEntries(entries as ClassifiableEntry[], { ctx, excludeTestOrigin: false });
  const afterTotals = classifyEntries(kept as ClassifiableEntry[], { ctx, excludeTestOrigin: false });

  const sumRecorded = (rows: readonly CostEntry[]): number =>
    Math.round(rows.reduce((s, r) => s + (r.costUsd || 0), 0) * 100000) / 100000;
  const sumTokens = (rows: readonly CostEntry[]): number =>
    rows.reduce((s, r) => s + (r.totalTokens || 0), 0);
  const unpricedCalls = (rows: readonly CostEntry[]): number =>
    classifyEntries(rows as ClassifiableEntry[], { ctx, excludeTestOrigin: false }).unpricedCalls;

  const removed = [...removedCounts.values()].sort((a, b) => b.count - a.count);

  const notes: string[] = [];
  if (repriced > 0) {
    notes.push(
      `${repriced} legacy row(s) re-priced from the ONE price source (provider catalog + declared model prices + your overrides) — no hardcoded table, no generic fallback.`,
    );
  }
  if (alreadyClassified > 0) {
    notes.push(`${alreadyClassified} row(s) already carried a cost classification and were left exactly as written.`);
  }
  if (testOriginRemoved + fixtureRemoved > 0) {
    notes.push(
      `${testOriginRemoved} row(s) tagged \`origin: test\` and ${fixtureRemoved} row(s) with a test-fixture model id were removed — a test run is not your usage.`,
    );
  }
  if (afterTotals.unverifiedListedUsd > 0) {
    notes.push(
      `$${afterTotals.unverifiedListedUsd.toFixed(6)} of list-priced calls are still NOT counted as spend because the billing tier is undeclared: nuvira config set providers.<id>.billingTier paid|free|subscription`,
    );
  }
  if (afterTotals.unpricedCalls > 0) {
    notes.push(
      `${afterTotals.unpricedCalls} row(s) have no price evidence (an unknown provider, a pass-through gateway, or a model with no price source) — they contribute no dollars, which is honest but incomplete: set pricing.<provider>.inputPer1K/outputPer1K to price them.`,
    );
  }
  if (prune && testOriginRemoved + fixtureRemoved === 0) {
    notes.push('No test-origin rows found — new writes are tagged at record time, so this should stay at zero.');
  }

  return {
    entries: kept,
    report: {
      rows: {
        total: entries.length,
        repriced,
        alreadyClassified,
        testOriginRemoved,
        fixtureRemoved,
        kept: kept.length,
      },
      before: {
        recordedUsd: sumRecorded(entries),
        tokens: sumTokens(entries),
        unpricedCalls: unpricedCalls(entries),
      },
      after: {
        recordedUsd: sumRecorded(kept),
        tokens: sumTokens(kept),
        billedUsd: afterTotals.billedUsd,
        billedReportedUsd: afterTotals.billedReportedUsd,
        billedListedUsd: afterTotals.billedListedUsd,
        unverifiedListedUsd: afterTotals.unverifiedListedUsd,
        notBilledValueUsd: afterTotals.notBilledValueUsd,
        unpricedCalls: afterTotals.unpricedCalls,
      },
      removed,
      notes,
    },
  };
}

// ─── File-level pass ────────────────────────────────────────────────────────

/** Read the ledger file, tolerating absence and corruption the way the tracker does. */
function readLedger(file: string): LedgerFile {
  try {
    if (!existsSync(file)) return { entries: [], version: 1 };
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as LedgerFile;
    return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [], version: parsed?.version ?? 1 };
  } catch {
    return { entries: [], version: 1 };
  }
}

/**
 * The whole pass against a FILE. `apply: false` (the default) reads and reports
 * only — the dry run is the default because the ledger is billing history.
 *
 * On `apply` the previous file is copied to `<file>.bak` first (a fixed name, so
 * the backup is the state immediately before THIS run and cannot itself grow a
 * chain), and the rewrite goes through a temp-free single write.
 */
export function maintainCostLedger(
  opts: { file?: string; apply?: boolean; pruneTestRows?: boolean; ctx?: PricingContext } = {},
): LedgerMaintenanceReport {
  const file = opts.file ?? costLedgerPath();
  const ledger = readLedger(file);
  const { entries, report } = repriceLedgerEntries(ledger.entries, {
    ctx: opts.ctx,
    pruneTestRows: opts.pruneTestRows,
  });

  let backupPath: string | undefined;
  if (opts.apply) {
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (existsSync(file)) {
        backupPath = `${file}.bak`;
        copyFileSync(file, backupPath);
      }
      writeFileSync(file, JSON.stringify({ version: ledger.version, entries }, null, 2), 'utf-8');
    } catch (err) {
      // A failed write is reported, never silently swallowed: the operator asked
      // for a repair and must know it did not happen.
      return {
        file,
        applied: false,
        ...report,
        notes: [...report.notes, `✗ write failed: ${(err as Error).message} — the ledger is unchanged.`],
      };
    }
  }

  return { file, applied: opts.apply === true, ...(backupPath ? { backupPath } : {}), ...report };
}

/** The report as text — shared by the CLI and the scripts wrapper. */
export function formatMaintenanceReport(rep: LedgerMaintenanceReport): string {
  const usd = (n: number): string => `$${n.toFixed(6)}`;
  const lines: string[] = [
    rep.applied ? '🛠️  Cost Ledger Repriced (written)' : '🛠️  Cost Ledger Reprice — DRY RUN (nothing written)',
    '',
    `   File:  ${rep.file}${rep.backupPath ? `\n   Backup: ${rep.backupPath}` : ''}`,
    '',
    '── Rows ──',
    `   total:              ${rep.rows.total}`,
    `   re-priced:          ${rep.rows.repriced}  (legacy rows re-derived by today's rules)`,
    `   already classified: ${rep.rows.alreadyClassified}  (left exactly as written)`,
    `   removed (origin):   ${rep.rows.testOriginRemoved}  (tagged origin: test)`,
    `   removed (fixture):  ${rep.rows.fixtureRemoved}  (model id could only be a fixture)`,
    `   kept:               ${rep.rows.kept}`,
    '',
    '── Recorded total ──',
    `   before: ${usd(rep.before.recordedUsd)}  (${rep.before.tokens} tokens, ${rep.before.unpricedCalls} unpriced calls)`,
    `   after:  ${usd(rep.after.recordedUsd)}  (${rep.after.tokens} tokens, ${rep.after.unpricedCalls} unpriced calls)`,
    '',
    '── After re-pricing, by evidence ──',
    `   🧾 provider-reported (exact):          ${usd(rep.after.billedReportedUsd)}`,
    `   📋 list-priced, account paid:          ${usd(rep.after.billedListedUsd)}`,
    `   = billed:                              ${usd(rep.after.billedUsd)}`,
    `   ❓ list-priced, tier undeclared:        ${usd(rep.after.unverifiedListedUsd)}  (not counted as spend)`,
    `   🎁 free/subscription value at list:    ${usd(rep.after.notBilledValueUsd)}`,
    '',
  ];

  if (rep.removed.length > 0) {
    lines.push('── Rows that would be removed ──');
    for (const r of rep.removed.slice(0, 20)) {
      lines.push(
        `   ${String(r.count).padStart(6)} × ${(r.provider + '/' + r.model).slice(0, 60)}${r.fixtureId ? '  (fixture id)' : '  (origin: test)'}`,
      );
    }
    if (rep.removed.length > 20) lines.push(`   … and ${rep.removed.length - 20} more pair(s)`);
    lines.push('');
  }

  if (rep.notes.length > 0) {
    lines.push('── Notes ──');
    for (const n of rep.notes) lines.push(`   • ${n}`);
    lines.push('');
  }
  if (!rep.applied) {
    lines.push('   Nothing was written. Re-run with --apply to write (a .bak is kept).', '');
  }
  return lines.join('\n');
}
