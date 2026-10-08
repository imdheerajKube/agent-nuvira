#!/usr/bin/env node
/**
 * Offline acceptance fitter — fit `P(accepted | features)` from an EXPORTED corpus
 * without the live trace store.
 *
 * WHY. `nuvira rate --export` produces a portable file; this reads it back and runs
 * the SAME deterministic fit the harness runs in-process (`fitLabelledTurns`), so a
 * corpus shipped from another machine yields the identical model here. It needs no
 * `~/.nuvira` state, no network and no model — just a file.
 *
 * It fits nothing else and routes nothing; it prints a model for review.
 *
 * Usage:
 *   npm run build:cli                                    # once, so dist/ exists
 *   node scripts/fit-acceptance.mjs corpus.json
 *   node scripts/fit-acceptance.mjs corpus.csv
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distModule = join(here, '..', 'dist', 'learning', 'acceptance-model.js');

if (!existsSync(distModule)) {
  console.error('fit-acceptance: dist/ not built — run `npm run build:cli` first.');
  process.exit(1);
}

const { parseCorpusText, detectCorpusFormat, fitLabelledTurns, MIN_LABELS_FOR_FIT, MIN_PER_CLASS } =
  await import(pathToFileURL(distModule).href);

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/fit-acceptance.mjs <corpus.json|corpus.csv>');
  process.exit(1);
}

let text;
try {
  text = readFileSync(file, 'utf-8');
} catch (err) {
  console.error(`fit-acceptance: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const rows = parseCorpusText(text, detectCorpusFormat(file, text));
if (rows.length === 0) {
  console.error(`fit-acceptance: no labelled turns found in ${file} — is it an exported corpus (JSON or CSV)?`);
  process.exit(1);
}

const fit = fitLabelledTurns(rows);
console.log(`corpus: ${file} — ${rows.length} labelled turn(s)`);

if (!fit.ok) {
  console.log(`fit: NOT trained — ${fit.reason}`);
  console.log(`   (needs ${MIN_LABELS_FOR_FIT} labelled turns with ≥${MIN_PER_CLASS} of each class)`);
  process.exit(0);
}

console.log(`fit: P(accepted | features) n=${fit.model.n} (${fit.model.positives}👍/${fit.model.negatives}👎)`);
fit.model.featureNames.forEach((f, j) => {
  const w = fit.model.weights[j];
  console.log(`   ${f.padEnd(10)} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`);
});
console.log(`   ${'bias'.padEnd(10)} ${fit.model.bias >= 0 ? '+' : ''}${fit.model.bias.toFixed(2)}`);
