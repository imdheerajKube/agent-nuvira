#!/usr/bin/env node
/**
 * Remove REDUNDANT routing-history rows, and clear the `score: 0` sentinel.
 *
 * Two things are wrong in the rows already on disk, and neither is cosmetic:
 *
 *  1. A PAIRED `complexity: "unknown"` ROW. Two writers record the same decision:
 *     `route-resolver` writes "a route resolved to provider/model" (a synthetic
 *     task string, `complexity: "unknown"`), and the chat/orchestrator path writes
 *     the real decision for the same pair moments later. The result is one
 *     decision recorded twice, and the pair makes the file read as if two
 *     decisions happened. A row is removed only when a companion row with a REAL
 *     complexity exists for the same pair — see WHY THE TWIN RULE IS MEASURED.
 *  2. A BARE `score: 0` WITH NO `scoreBasis` (pre-B2-a). `cli/chat.ts` used to
 *     copy the walk's `decision.score` onto every row, and `route-resolver` wrote
 *     a literal `0` sentinel for "never ranked". B2-a stopped both new writes and
 *     made `score` OPTIONAL, so a `0` that did not decide anything is exactly the
 *     number the field is now documented never to hold. The row is KEPT — it is a
 *     real routing decision — and the number is dropped.
 *
 * WHY THE TWIN RULE IS MEASURED (not "drop every unknown row"). On this profile
 * 23 of 500 rows are `complexity: "unknown"`: 19 have a companion row with a real
 * complexity, and **4 do not** — they are the ONLY record of that decision, so
 * deleting them would delete audit information. The measurement is
 * window-independent (19/4 at 60s and again at 24h), so the wide window below is
 * chosen for safety, not to make the count look better.
 *
 * Nothing is guessed and nothing is invented: a row is either provably redundant
 * or it stays.
 *
 * STOPPING THE DASHBOARD IS NOT REQUIRED (Bundle 14, 2026-10-07). This store's
 * writer APPENDS, so a running process cannot rewrite the file from a stale copy.
 *
 * Usage:
 *   node scripts/prune-routing-history-rows.mjs                 # dry run (default)
 *   node scripts/prune-routing-history-rows.mjs --apply         # write, with a backup
 *   node scripts/prune-routing-history-rows.mjs --file <path>   # a specific history
 *   node scripts/prune-routing-history-rows.mjs --window <secs> # twin window (default 300)
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TWIN_WINDOW_MS = 300_000;

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function historyPath() {
  return (
    flagValue('--file') ||
    join(process.env.NUVIRA_MEMORY_DIR || join(homedir(), '.nuvira', 'memory'), 'routing-history.json')
  );
}

function main() {
  const apply = process.argv.includes('--apply');
  const windowMs = Number(flagValue('--window') ?? 0) * 1000 || DEFAULT_TWIN_WINDOW_MS;
  const path = historyPath();

  if (!existsSync(path)) {
    console.log(`routing-history: ${path}`);
    console.log('nothing to do — no history file at that path.');
    return 0;
  }

  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const unknown = entries.filter((r) => r.complexity === 'unknown');
  const resolved = entries.filter((r) => r.complexity !== 'unknown');

  // A row is redundant only when the SAME pair was recorded, with a real
  // complexity, within the window. Anything else is the only record it has.
  const redundant = [];
  const kept = [];
  for (const row of unknown) {
    const twin = resolved.find(
      (k) =>
        k.provider === row.provider &&
        k.model === row.model &&
        Math.abs((k.timestamp ?? 0) - (row.timestamp ?? 0)) <= windowMs,
    );
    if (twin) redundant.push({ row, twin });
    else kept.push(row);
  }

  const sentinel = entries.filter((r) => r.score === 0 && !r.scoreBasis);

  console.log(`routing-history: ${path}`);
  console.log(`rows: ${entries.length}  (${resolved.length} resolved, ${unknown.length} unknown)`);
  console.log(`twin window: ${windowMs / 1000}s`);
  console.log('');

  console.log(`redundant unknown rows to remove (${redundant.length}):`);
  for (const { row, twin } of redundant) {
    console.log(
      `  ${String(row.provider).padEnd(11)} ${String(row.model).padEnd(38)} ` +
        `twin: ${twin.complexity} @ ${new Date(twin.timestamp).toISOString()}`,
    );
  }
  console.log('');
  console.log(`unknown rows KEPT — no companion row exists, so they are the only record (${kept.length}):`);
  for (const row of kept) {
    console.log(
      `  ${String(row.provider).padEnd(11)} ${String(row.model).padEnd(38)} ` +
        `${new Date(row.timestamp).toISOString()}`,
    );
  }
  console.log('');
  console.log(`bare \`score: 0\` with no basis to clear — the row stays (${sentinel.length}):`);
  console.log(`  ${sentinel.length} row(s), across ${new Set(sentinel.map((r) => r.source)).size} source(s)`);
  console.log('');

  if (redundant.length === 0 && sentinel.length === 0) {
    console.log('✅ nothing to do — no redundant rows and no sentinel scores.');
    return 0;
  }

  if (!apply) {
    console.log('DRY RUN — nothing written. Re-run with --apply to make these changes.');
    return 0;
  }

  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backup);

  const removeIds = new Set(redundant.map(({ row }) => row.id));
  data.entries = entries
    .filter((r) => !removeIds.has(r.id))
    .map((r) => {
      if (r.score === 0 && !r.scoreBasis) {
        const { score, ...rest } = r;
        return rest; // `score` is OPTIONAL (B2-a): absent means "never ranked".
      }
      return r;
    });

  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');

  console.log(`removed ${redundant.length} redundant row(s); cleared ${sentinel.length} sentinel score(s).`);
  console.log(`backup written: ${backup}`);
  console.log(`Restore with: cp "<backup>" "${path}"`);
  return 0;
}

process.exit(main());
