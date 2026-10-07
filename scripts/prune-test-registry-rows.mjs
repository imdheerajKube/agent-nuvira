#!/usr/bin/env node
/**
 * Remove TEST-ORIGIN rows from the model registry.
 *
 * WHY THIS EXISTS. The test suite drives the real Orchestrator with fixture model
 * names (`test-model`, `nonexistent-fast-fail`, …). Before
 * `tests/setup/hermetic-env.ts` isolated `NUVIRA_MEMORY_DIR`, those runs wrote
 * telemetry into the DEVELOPER'S REAL registry — the same file the router obeys.
 * MEASURED on one profile: `local/test-model` ended up `status: verified` with
 * `requests: 0`, and `local/nonexistent-fast-fail` (a deliberate fixture from
 * `tests/federation/a2a.test.ts`) was recorded as unavailable "model not found".
 *
 * The isolation is in place now, so new leaks should not happen. Nothing prunes
 * the rows already written, and the consequence is not cosmetic: `isUsable()`
 * only requires `status === 'verified'` plus a recent `lastVerifiedAt`, so
 * `local/test-model` sat in the local provider's routable pool — the second
 * newest of its verified models — waiting to be handed to an adapter as a model
 * that does not exist.
 *
 * WHAT IT MATCHES (all three, deliberately narrow):
 *   1. `source === 'telemetry'` — written by a RUN, never by a provider catalog
 *      probe. A row a provider actually listed is not touched.
 *   2. no recorded requests — the model never served one; a fixture that was
 *      genuinely used would keep its history.
 *   3. an exact fixture NAME from the list below. Not a substring match: an
 *      earlier diagnostic regex of /test|…/ matched every `-la-test` … every
 *      `-latest` alias in the registry, which is how 25 real OpenRouter ids got
 *      flagged as junk. Names only.
 *
 * A RUNNING DASHBOARD NO LONGER UNDOES THIS (Bundle 14, 2026-10-07). It used to:
 * each live process held the registry in memory and `persist()` wrote the WHOLE
 * map back, so it re-added these rows from its own copy moments after this script
 * removed them. Persist now merges against the boot snapshot, so a process ADOPTS
 * the file's absence for any row it has not changed itself — the removal sticks
 * without stopping anything first. (A process that has changed one of these rows
 * since it booted still wins for that row, on the honest grounds that its
 * knowledge is newer; that is not a reason to stop it, just to re-run this.)
 *
 * Usage:
 *   node scripts/prune-test-registry-rows.mjs                 # dry run (default)
 *   node scripts/prune-test-registry-rows.mjs --apply         # write, with a backup
 *   node scripts/prune-test-registry-rows.mjs --file <path>   # a specific registry
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Exact fixture model names used by the test suite. Kept explicit and short: a
 * name appears here only after it was seen in a test file.
 */
const FIXTURE_NAMES = [
  'test-model',
  'nonexistent-fast-fail',
  'test',
  'mock-model',
  'dummy-model',
];

function registryPath() {
  const fileFlag = process.argv.indexOf('--file');
  if (fileFlag !== -1 && process.argv[fileFlag + 1]) return process.argv[fileFlag + 1];
  return join(process.env.NUVIRA_MEMORY_DIR || join(homedir(), '.nuvira', 'memory'), 'model-registry.json');
}

function main() {
  const apply = process.argv.includes('--apply');
  const path = registryPath();

  if (!existsSync(path)) {
    console.log(`registry: ${path}`);
    console.log('nothing to do — no registry file at that path.');
    return 0;
  }

  const raw = readFileSync(path, 'utf-8');
  const data = JSON.parse(raw);
  const entries = data.entries ?? {};

  const matched = [];
  const telemetryRows = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (entry?.source !== 'telemetry') continue;
    telemetryRows.push(key);
    const name = String(entry.model ?? '');
    const requests = Number(entry.requests ?? 0);
    if (!FIXTURE_NAMES.includes(name)) continue;
    if (requests > 0) continue;
    matched.push({ key, entry });
  }

  console.log(`registry: ${path}`);
  console.log(`tracked models: ${Object.keys(entries).length}`);
  console.log(`telemetry-origin rows: ${telemetryRows.length}`);
  console.log('');

  if (matched.length === 0) {
    console.log('✅ no test-origin rows found — nothing to remove.');
    if (telemetryRows.length > 0) {
      console.log(
        `   (${telemetryRows.length} telemetry row(s) exist but none is an unused fixture name; left alone.)`,
      );
    }
    return 0;
  }

  console.log(`test-origin rows to remove (${matched.length}):`);
  for (const { key, entry } of matched) {
    const verified = entry.lastVerifiedAt
      ? `verified ${((Date.now() - entry.lastVerifiedAt) / 86400000).toFixed(2)}d ago`
      : 'never verified';
    console.log(
      `  ${key.padEnd(46)} status=${String(entry.status).padEnd(12)} requests=${entry.requests ?? 0}  ${verified}`,
    );
  }
  console.log('');

  if (!apply) {
    console.log('DRY RUN — nothing written. Re-run with --apply to remove these rows.');
    console.log('⚠️  Stop the dashboard and the gateway first: both hold the registry in');
    console.log('   memory and persist() writes the whole map back, which would re-add these');
    console.log('   rows from their own copy.');
    return 0;
  }

  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backup);
  for (const { key } of matched) delete entries[key];
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');

  console.log(`removed ${matched.length} row(s).`);
  console.log(`backup written: ${backup}`);
  console.log('Restore with: cp "<backup>" "<registry>"');
  console.log(
    'Note: the vector snapshot of the registry is rewritten the next time the ' +
      'registry persists, so no separate cleanup is needed there.',
  );
  return 0;
}

process.exit(main());
