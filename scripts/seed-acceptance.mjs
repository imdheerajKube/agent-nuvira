#!/usr/bin/env node
/**
 * Seed the acceptance corpus — the recipe from `docs/ACCEPTANCE.md` §Seeding, as a
 * script: report how far you are from a trainable fit, then list recent UNRATED
 * turns with the exact `nuvira rate` command for each.
 *
 * It does NOT rate anything. Rating is the user's job by design: the harness
 * fabricating a verdict is the defect the whole subsystem avoids.
 *
 * Usage:
 *   npm run build:cli                                  # once, so dist/ exists
 *   node scripts/seed-acceptance.mjs [count]           # default 10 recent turns
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const acceptanceModule = join(distDir, 'learning', 'acceptance-model.js');
const traceModule = join(distDir, 'learning', 'reasoning-trace.js');

for (const m of [acceptanceModule, traceModule]) {
  if (!existsSync(m)) {
    console.error('seed-acceptance: dist/ not built — run `npm run build:cli` first.');
    process.exit(1);
  }
}

const { acceptanceSummary, MIN_LABELS_FOR_FIT, MIN_PER_CLASS } = await import(pathToFileURL(acceptanceModule).href);
const { listTraces } = await import(pathToFileURL(traceModule).href);

const limit = Math.max(1, Math.min(100, Number(process.argv[2]) || 10));

const s = acceptanceSummary();
console.log(`acceptance corpus: ${s.labelled} labelled turn(s) — 👍 ${s.accepted} / 👎 ${s.rejected}`);

if (s.fit.ok) {
  console.log(`fit is TRAINED (n=${s.fit.model.n}). Nothing to seed — keep rating turns you care about.`);
  process.exit(0);
}

const needTurns = Math.max(0, MIN_LABELS_FOR_FIT - s.labelled);
const needClass = Math.max(0, MIN_PER_CLASS - Math.min(s.accepted, s.rejected));
const need = Math.max(needTurns, needClass);
console.log(`need ${need} more label(s): target ${MIN_LABELS_FOR_FIT} turns with ≥${MIN_PER_CLASS} of each class`);

const unrated = listTraces(500).filter((t) => !t.userVerdict).slice(0, limit);
if (unrated.length === 0) {
  console.log('\nNo unrated turns on disk — run a few chat turns, then rate them:');
  console.log('   nuvira chat "write me a short guide to X"      # then: nuvira rate good');
  process.exit(0);
}

console.log(`\nRecent UNRATED turns — open each, then rate it (the label is YOURS):\n`);
for (const t of unrated) {
  const pair = t.provider ? ` [${t.provider}${t.model ? '/' + t.model : ''}]` : '';
  console.log(`  ${t.id}${pair}`);
  console.log(`     ${(t.goal || '').slice(0, 110)}`);
  console.log(`     nuvira rate good -t ${t.id}     # or: nuvira rate bad -t ${t.id}`);
}
console.log(`\nWhen you have ${MIN_LABELS_FOR_FIT} with ≥${MIN_PER_CLASS} of each class, the fit trains:`);
console.log('   nuvira rate --stats      # or: nuvira model explain "<a task>"');
