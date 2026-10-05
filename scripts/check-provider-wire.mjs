#!/usr/bin/env node
/**
 * Golden provider-wire fixtures — record and check.
 *
 * The provider wire (the exact request body the core loop sends) is a contract
 * that nothing else in this repo pins: every other test asserts on a response.
 * This script runs the REAL loop against a loopback recorder and compares the
 * captured requests to committed fixtures, so a tool schema, a message-ordering
 * rule, or a serialization detail that changes shape fails loudly here instead
 * of shipping silently.
 *
 * Usage:
 *   node scripts/check-provider-wire.mjs            check (exit 1 on drift)
 *   node scripts/check-provider-wire.mjs --update   rewrite the fixtures
 *
 * It imports the BUILT module (dist/parity/wire-fixtures.js), so run
 * `npm run build:cli` first — the same convention `docs:commands` uses.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distModule = join(repoRoot, 'dist', 'parity', 'wire-fixtures.js');
const UPDATE = process.argv.includes('--update');

process.env.NUVIRA_SKIP_DISCOVERY = '1';
process.env.NUVIRA_NO_DASHBOARD = '1';

if (!existsSync(distModule)) {
  console.error('✗ dist/parity/wire-fixtures.js not found — run `npm run build:cli` first.');
  process.exit(2);
}

const mod = await import(pathToFileURL(distModule).href);

async function main() {
  const captured = await mod.captureCoreLoopRequests();

  if (UPDATE) {
    for (const fixture of captured) mod.writeWireFixture(fixture.case, fixture);
    console.log(`✓ Wrote ${captured.length} provider-wire fixture(s) to tests/fixtures/provider-wire/.`);
    return 0;
  }

  let failed = 0;
  for (const actual of captured) {
    const golden = mod.readWireFixture(actual.case);
    if (!golden) {
      console.error(`✗ ${actual.case}: no committed fixture — run with --update.`);
      failed += 1;
      continue;
    }
    const diffs = mod.wireDiff(golden.requests, actual.requests);
    if (diffs.length === 0) {
      console.log(`  ✓ ${actual.case} (${actual.requests.length} request(s))`);
      continue;
    }
    failed += 1;
    console.error(`  ✗ ${actual.case}: ${diffs.length} wire difference(s):`);
    for (const d of diffs.slice(0, 10)) {
      console.error(`      ${d.path}`);
      console.error(`        golden: ${JSON.stringify(d.golden)}`);
      console.error(`        actual: ${JSON.stringify(d.actual)}`);
    }
  }

  if (failed > 0) {
    console.error('');
    console.error(`✗ ${failed} provider-wire fixture(s) drifted.`);
    console.error('  If the change is intended, run: node scripts/check-provider-wire.mjs --update');
    console.error('  and review the diff — that review is the guard.');
    return 1;
  }
  console.log(`\n✓ All ${captured.length} provider-wire fixture(s) match the live loop.`);
  return 0;
}

// Use exitCode, not process.exit(): on Windows a forced exit races libuv's
// async-handle teardown and crashes with `UV_HANDLE_CLOSING` AFTER the check has
// already passed (observed as exit 127 on a green run). Letting the loop drain
// exits cleanly on every platform.
process.exitCode = await main();
