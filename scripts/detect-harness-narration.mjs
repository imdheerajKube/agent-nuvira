#!/usr/bin/env node
/**
 * Report turns where the model NARRATED the harness back at the user — the
 * verification for Bundle 37b's one-voice change, run over LIVE traces.
 *
 * For each reasoning trace it collects the harness's OWN strings (every `refusal`
 * event's summary/result and every `gate` event's summary), takes the turn's
 * final assistant `responsePreview`, and asks whether the answer reuses a
 * DISTINCTIVE token from the harness (a hyphenated compound or a ≥10-char word).
 * No hand-written phrase list — the vocabulary is derived from what the harness
 * actually said, so it tracks the harness rather than a list of user phrasings.
 *
 * `[harness]` directives themselves are marked, so an answer that echoes the
 * marker verbatim is reported too.
 *
 *   node scripts/detect-harness-narration.mjs                  # the local store
 *   node scripts/detect-harness-narration.mjs path.json        # a specific file
 *
 * Needs the CLI built (`npm run build:cli`) — it imports the real detector.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let detectHarnessNarration;
try {
  ({ detectHarnessNarration } = await import('../dist/learning/harness-narration.js'));
} catch {
  console.error('Could not import dist/learning/harness-narration.js — run `npm run build:cli` first.');
  process.exit(1);
}

const HARNESS_MARKER = '[harness]';

function loadTraces(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.traces) ? raw.traces : Object.values(raw);
  return arr.filter((t) => t && typeof t === 'object');
}

/** The harness's own strings for a trace: refusal results/summaries, gate summaries. */
function harnessTexts(trace) {
  const out = [];
  for (const e of trace.events ?? []) {
    if (!e) continue;
    if (e.kind === 'refusal') {
      if (e.summary) out.push(e.summary);
      if (e.result) out.push(e.result);
    } else if (e.kind === 'gate') {
      if (e.summary) out.push(e.summary);
    }
  }
  return out;
}

/** The turn's final assistant text (the trace stores a preview per step). */
function finalText(trace) {
  const steps = trace.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]?.responsePreview;
    if (t && String(t).trim()) return String(t);
  }
  return '';
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const path = args[0] ?? join(homedir(), '.nuvira', 'memory', 'reasoning-traces.json');

let traces;
try {
  traces = loadTraces(path);
} catch (err) {
  console.error(`Could not read ${path}: ${err.message}`);
  process.exit(1);
}

let withHarness = 0;
let narrated = 0;
let echoMarker = 0;
const examples = [];

for (const tr of traces) {
  const harness = harnessTexts(tr);
  if (harness.length === 0) continue;
  withHarness += 1;
  const text = finalText(tr);
  const verdict = detectHarnessNarration(text, harness);
  const echoed = text.includes(HARNESS_MARKER);
  if (echoed) echoMarker += 1;
  if (verdict.narrated || echoed) {
    narrated += 1;
    examples.push({
      id: tr.id ?? '(no id)',
      matches: verdict.matches,
      echoed,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 160),
    });
  }
}

console.log('HARNESS NARRATION — did the model talk ABOUT the harness?');
console.log(`\nfile: ${path}`);
console.log(`traces: ${traces.length} · turns with a harness event: ${withHarness}`);
console.log(`turns narrating the harness: ${narrated} (echoed [harness] marker: ${echoMarker})`);

if (examples.length > 0) {
  console.log('\nexamples:');
  for (const ex of examples.slice(0, 10)) {
    console.log(`  ${ex.id}  [${ex.matches.join(', ') || 'marker echo'}]`);
    console.log(`      "${ex.excerpt}…"`);
  }
}

console.log(
  '\nDistinctive-token overlap only: an answer that shares a hyphenated compound or a',
);
console.log(
  '≥10-char word with the harness text is flagged. Lower is better; the target is 0.',
);
