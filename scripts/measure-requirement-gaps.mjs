#!/usr/bin/env node
/**
 * Measure the requirement pre-flight: what is missing HERE, and how often a turn
 * hit a requirement wall before this existed.
 *
 * Two parts, no hand-written phrase list:
 *
 *   A. READINESS on THIS machine — the curated install / publish / deploy / push
 *      verbs, probed from their own declarations. This is the readout an operator
 *      actually wants: "of the high-level things the agent can do, which are
 *      ready and which need a tool or a token?".
 *
 *   B. BASELINE from live traces — how many turns hit a REFUSAL that looks like a
 *      missing requirement. Keyed on `tool-refusal.ts`'s OWN code set
 *      (`not_configured` / `unavailable` / `no_data` / `unsupported_format`), not
 *      on user phrasing, so it tracks the harness rather than a list of sentences.
 *      This is the number the pre-flight is meant to move.
 *
 *   node scripts/measure-requirement-gaps.mjs               # the local store
 *   node scripts/measure-requirement-gaps.mjs path.json     # a specific file
 *
 * Needs the CLI built (`npm run build:cli`).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let actionCapabilities;
let probeRequirements;
let describeGap;
try {
  ({ actionCapabilities } = await import('../dist/tools/capability-registry.js'));
  ({ probeRequirements, describeGap } = await import('../dist/learning/requirement-probe.js'));
} catch {
  console.error('Could not import the capability layer from dist/ — run `npm run build:cli` first.');
  process.exit(1);
}

/** The harness's OWN refusal codes (see src/tools/tool-refusal.ts). */
const REFUSAL_CODES = ['not_configured', 'unavailable', 'no_data', 'unsupported_format'];

// ─── A. Readiness on this machine ────────────────────────────────────────────

console.log('REQUIREMENT PRE-FLIGHT — what is missing before a run starts?');
console.log('\n— A. readiness of the curated verbs on THIS machine —');

const actions = actionCapabilities();
let readyCount = 0;
const blockedNames = [];

for (const cap of actions) {
  const readiness = probeRequirements(cap.requires);
  if (readiness.ready) readyCount += 1;
  else blockedNames.push(cap.ref);

  const mark = readiness.ready ? '✔' : '✖';
  const advisory = readiness.gaps.filter((g) => g.kind === 'credential');
  console.log(`  ${mark} ${cap.ref}`);
  for (const gap of readiness.gaps) console.log(`      ${gap.kind === 'binary' ? 'BLOCKS' : 'advisory'}: ${describeGap(gap)}`);
  if (advisory.length > 0 && readiness.ready) {
    // Worth stating plainly: this is NOT a blocker, and saying otherwise would be
    // the false claim the module avoids.
    console.log('      (a credential not in the environment may still be in the vault — this does not block)');
  }
  if (readiness.ask.length > 0) console.log(`      ask the user: ${readiness.ask.join(', ')}`);
}

console.log(
  `\n  ${readyCount}/${actions.length} verbs are ready${blockedNames.length ? `; blocked: ${blockedNames.join(', ')}` : ''}`,
);

// ─── B. Baseline from live traces ────────────────────────────────────────────

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const path = args[0] ?? join(homedir(), '.nuvira', 'memory', 'reasoning-traces.json');

let traces = [];
try {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  traces = (Array.isArray(raw) ? raw : raw.traces ? raw.traces : Object.values(raw)).filter(
    (t) => t && typeof t === 'object',
  );
} catch (err) {
  console.log(`\n— B. live traces: could not read ${path} (${err.message}) — skipped —`);
  process.exit(0);
}

console.log('\n— B. baseline: turns that hit a requirement wall —');
console.log(`file: ${path}  (${traces.length} traces)`);

let turnsWithWall = 0;
const byCode = new Map();
const examples = [];

for (const tr of traces) {
  let hit = false;
  for (const e of tr.events ?? []) {
    if (!e || e.kind !== 'refusal') continue;
    const text = `${e.summary ?? ''} ${e.result ?? ''}`;
    for (const code of REFUSAL_CODES) {
      if (!text.includes(code)) continue;
      hit = true;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
      if (examples.length < 6) {
        examples.push(`${e.tool ?? '?'} [${code}] ${String(e.summary ?? '').slice(0, 80)}`);
      }
    }
  }
  if (hit) turnsWithWall += 1;
}

console.log(`turns hitting a requirement wall: ${turnsWithWall}/${traces.length}`);
if (byCode.size > 0) {
  console.log('by code: ' + [...byCode.entries()].map(([c, n]) => `${c} ${n}`).join(' · '));
  console.log('\nexamples:');
  for (const ex of examples) console.log(`  ${ex}`);
} else {
  console.log('no requirement-wall refusals found in this store');
}

console.log(
  '\nA is probed from the capabilities\' OWN declarations (no phrase list). B keys on',
);
console.log(
  "the harness's own refusal codes, so it tracks the harness rather than a list of",
);
console.log('user sentences. The pre-flight exists to move B toward zero.');
