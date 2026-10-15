#!/usr/bin/env node
/**
 * Remove TEST-ORIGIN rows from the cost ledger, and re-price the legacy rows.
 *
 * WHY THIS EXISTS. `~/.nuvira/memory/cost-tracker.json` is the user's BILLING
 * history, and two kinds of row in it are not what they claim to be:
 *
 *  1. TEST ROWS. The provider-WIRE harness and the mock-endpoint tests drove real
 *     accounting paths before `tests/setup/hermetic-env.ts` isolated
 *     `NUVIRA_MEMORY_DIR`. MEASURED on this machine: 747 rows of
 *     `local/wire-stub-model` in the real `~/.nuvira/memory/cost-tracker.json` —
 *     a model id that exists only in `src/parity/wire-fixtures.ts`. Rows written
 *     since carry `origin: 'test'` and every display surface excludes them
 *     (`cost-classification`), but nothing prunes the rows already on disk, and a
 *     `wire-stub-model` row can never be anything but a test artifact.
 *  2. LEGACY PRICES. Rows written before `costSource` existed carry a `costUsd`
 *     from the RETIRED hardcoded table in `cost-tracker.ts` (five providers plus a
 *     `$0.00010/1K` generic fallback for everything else). That fallback invented
 *     $0.40 of spend on a localhost gateway and under-priced the one provider the
 *     user actually pays for by ~3×. Reads re-derive those rows for display and
 *     never rewrite the file; this is the explicit way to repair the file itself.
 *
 * WHAT IT MATCHES (and what it deliberately does not):
 *   - `origin: 'test'` — the row says so.
 *   - a fixture model id — `wire-…`, `test-…`, `fixture-…`, `stub-…`, `…-stub`
 *     (the SAME predicate the router uses to keep stubs out of the pool:
 *     `isFixtureModelId`). NOT a substring match: a looser /test|…/ rule once
 *     flagged 25 real OpenRouter ids, and `gemini-flash-latest` /
 *     `deepseek-coder:latest` are real provider models.
 *
 * NO PRICING LOGIC LIVES HERE. This script is a thin wrapper over the BUILT
 * module (`dist/learning/cost-ledger-maintenance.js`) — the same function
 * `nuvira stats cost reprice` calls. Re-implementing a price table in a script is
 * precisely the defect this repair exists to undo (two tables that disagreed
 * 25×–100×), so the script imports the one authority instead. That means it needs
 * `npm run build:cli` first, the same convention `check-provider-wire.mjs` uses.
 *
 * NOTE ON RUNNING PROCESSES. A running dashboard or CLI holds no in-memory copy
 * that could rewrite these rows back: the tracker APPENDS to a fresh read on every
 * call, and the maintenance pass is the only writer of the file as a whole. Still,
 * a write changes figures a live process may be displaying, so re-open the
 * dashboard after applying.
 *
 * Usage:
 *   node scripts/prune-cost-ledger-rows.mjs                    # dry run (default)
 *   node scripts/prune-cost-ledger-rows.mjs --apply            # write, with a .bak
 *   node scripts/prune-cost-ledger-rows.mjs --file <path>      # a specific ledger
 *   node scripts/prune-cost-ledger-rows.mjs --keep-test-rows   # re-price only
 *   node scripts/prune-cost-ledger-rows.mjs --json             # machine-readable
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distModule = join(repoRoot, 'dist', 'learning', 'cost-ledger-maintenance.js');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const KEEP_TEST_ROWS = argv.includes('--keep-test-rows');
const JSON_OUT = argv.includes('--json');
const fileArgIndex = argv.indexOf('--file');
const FILE = fileArgIndex >= 0 ? argv[fileArgIndex + 1] : undefined;

if (!existsSync(distModule)) {
  console.error('✗ dist/learning/cost-ledger-maintenance.js not found — run `npm run build:cli` first.');
  process.exit(2);
}

const mod = await import(pathToFileURL(distModule).href);

let report;
try {
  report = mod.maintainCostLedger({
    ...(FILE ? { file: FILE } : {}),
    apply: APPLY,
    pruneTestRows: !KEEP_TEST_ROWS,
  });
} catch (err) {
  console.error(`✗ cost-ledger maintenance failed: ${err?.message ?? err}`);
  process.exit(1);
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n${mod.formatMaintenanceReport(report)}`);
  if (!APPLY) {
    console.log('   (dry run — nothing was written; pass --apply to write)\n');
  }
}

// A write that did not happen must not exit 0: the operator asked for a repair.
if (APPLY && !report.applied) process.exit(1);
