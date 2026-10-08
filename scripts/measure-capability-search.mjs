#!/usr/bin/env node
/**
 * Measure the capability layer's DISCOVERY quality.
 *
 * Two independent probes, neither of which uses a hand-written phrase list:
 *
 *   A. SELF-RETRIEVAL (deterministic) — query the index with each capability's
 *      own name/one-liner and check it comes back. A search engine that cannot
 *      find a thing from its own words is broken; this needs no external data.
 *
 *   B. CONSEQUENTIAL RECALL over LIVE traces — ground truth is what the model
 *      ACTUALLY DID. For each reasoning trace we take the turn's `goal` and the
 *      tools it invoked, and ask whether the index surfaces the ones that MATTER
 *      (effectClass local-write / external — the actions that touch the
 *      workspace or leave the machine). Plumbing (`suggest_followups`,
 *      `read_file`, `plan_todo`) is deliberately NOT graded: a user's goal should
 *      not name it, so counting it would manufacture a fake miss. The same run
 *      reports a precision proxy — turns that touched nothing yet still rank an
 *      off-machine action.
 *
 *   node scripts/measure-capability-search.mjs               # the local store
 *   node scripts/measure-capability-search.mjs path.json     # a specific file
 *   K=25 node scripts/measure-capability-search.mjs          # widen the window
 *
 * Needs the CLI built (`npm run build:cli`).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let capabilityIndex;
let searchCapabilities;
let listTools;
try {
  ({ capabilityIndex, searchCapabilities } = await import('../dist/tools/capability-registry.js'));
  ({ listTools } = await import('../dist/tools/registry.js'));
} catch {
  console.error('Could not import the capability registry from dist/ — run `npm run build:cli` first.');
  process.exit(1);
}

const K = Number(process.env.K ?? 10);
/** The effect classes discovery must get right: touches the workspace, or leaves the machine. */
const CONSEQUENTIAL = new Set(['local-write', 'external', 'destructive']);

function loadTraces(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.traces) ? raw.traces : Object.values(raw);
  return arr.filter((t) => t && typeof t === 'object');
}

/** Distinct tools the model actually invoked in a trace, in first-use order. */
function toolsUsed(trace) {
  const seen = [];
  for (const e of trace.events ?? []) {
    if (e && e.kind === 'tool' && typeof e.tool === 'string' && !seen.includes(e.tool)) seen.push(e.tool);
  }
  return seen;
}

/**
 * The model's OWN words just before a tool call, at event seq `seq`: the
 * `responsePreview` of the last step that ran before it. This is the query the
 * model would actually issue — it already narrated what it is about to do — so
 * grading against it asks "if it had searched, would it have found this?" rather
 * than the unfair question of whether the raw user goal names a low-level tool.
 */
function intentBefore(trace, seq) {
  let out = '';
  for (const s of trace.steps ?? []) {
    if (s && typeof s.seq === 'number' && s.seq < seq && s.responsePreview) out = String(s.responsePreview);
  }
  return out;
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`);

// ── The index the model would search ─────────────────────────────────────────
let tools = [];
try {
  tools = listTools().map((t) => ({ name: t.name, description: t.description, category: t.category }));
} catch (err) {
  console.error(`listTools() failed: ${err.message}`);
  process.exit(1);
}
const index = await capabilityIndex(tools);
const refs = new Set(index.map((c) => c.ref));
const effectOf = new Map(index.map((c) => [c.ref, c.effectClass]));

const byKind = {};
for (const c of index) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;

console.log('CAPABILITY DISCOVERY');
console.log(`\nindex: ${index.length} capabilities — ${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(' + ')} · top-K = ${K}`);

// ── A. Self-retrieval ────────────────────────────────────────────────────────
console.log('\n— A. self-retrieval (query each capability with its own words) —');
const rankOf = (query, ref) => {
  const hits = searchCapabilities(index, query, index.length);
  return hits.findIndex((h) => h.capability.ref === ref) + 1; // 0 = not found
};

const perKind = {};
for (const c of index) {
  const query = c.name.replace(/[_-]+/g, ' ');
  const rank = rankOf(query, c.ref);
  const bucket = (perKind[c.kind] ??= { total: 0, top1: 0, top5: 0, miss: 0 });
  bucket.total += 1;
  if (rank === 1) bucket.top1 += 1;
  if (rank >= 1 && rank <= 5) bucket.top5 += 1;
  if (rank === 0) bucket.miss += 1;
}
for (const [kind, b] of Object.entries(perKind)) {
  console.log(
    `  ${kind.padEnd(6)}  rank-1 ${pct(b.top1, b.total)} · top-5 ${pct(b.top5, b.total)} · not-found ${b.miss}/${b.total}`,
  );
}

// ── B. Consequential recall over live traces ─────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const path = args[0] ?? join(homedir(), '.nuvira', 'memory', 'reasoning-traces.json');

let traces;
try {
  traces = loadTraces(path);
} catch (err) {
  console.error(`\nCould not read ${path}: ${err.message}`);
  process.exit(1);
}
const turns = traces.filter((t) => toolsUsed(t).length > 0);

console.log(`\n— B. consequential recall over live traces —`);
console.log(`file: ${path}  (${traces.length} traces · ${turns.length} turns that used a tool)`);

let pairs = 0;
let pairsHit = 0;
let turnsConsequential = 0;
let turnsFullyCovered = 0;
let falseAlarms = 0;
let turnsQuiet = 0;
const gaps = new Map();

for (const tr of turns) {
  const used = toolsUsed(tr);
  const goalHits = searchCapabilities(index, String(tr.goal ?? ''), K);
  const goalRefs = new Set(goalHits.map((h) => h.capability.ref));
  const externalAction = goalHits.find((h) => h.capability.kind === 'action' && h.capability.effectClass === 'external');

  const needs = used.filter((t) => !refs.has(t) || CONSEQUENTIAL.has(effectOf.get(t)));
  for (const t of used) if (!refs.has(t)) gaps.set(t, (gaps.get(t) ?? 0) + 1);

  if (needs.length === 0) {
    turnsQuiet += 1;
    if (externalAction) falseAlarms += 1;
    continue;
  }

  turnsConsequential += 1;
  let covered = 0;
  for (const t of needs) {
    pairs += 1;
    // Grade the model's OWN pre-call narration first; fall back to the goal text
    // only when the trace has no step prose before the call.
    const seq = (tr.events ?? []).find((e) => e && e.kind === 'tool' && e.tool === t)?.seq;
    const intent = intentBefore(tr, typeof seq === 'number' ? seq : Infinity) || String(tr.goal ?? '');
    const hitRefs = new Set(searchCapabilities(index, intent, K).map((h) => h.capability.ref));
    // A hit on the raw goal also counts — it is the weaker but valid path.
    if (hitRefs.has(t) || goalRefs.has(t)) { covered += 1; pairsHit += 1; }
  }
  if (covered === needs.length) turnsFullyCovered += 1;
}

console.log(`  consequential (trace, tool) pairs surfaced: ${pairsHit}/${pairs} (${pct(pairsHit, pairs)})`);
console.log(`  turns where every consequential tool is surfaced: ${turnsFullyCovered}/${turnsConsequential} (${pct(turnsFullyCovered, turnsConsequential)})`);
console.log(`  precision proxy — turns that touched nothing yet rank an off-machine action: ${falseAlarms}/${turnsQuiet} (${pct(falseAlarms, turnsQuiet)})`);

if (gaps.size > 0) {
  console.log('\n— gaps: tools used but absent from the index —');
  for (const [name, n] of [...gaps.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${name}  (${n} turn${n === 1 ? '' : 's'})`);
} else {
  console.log('\n— gaps: none — every tool the model used exists in the index —');
}

console.log('\nGround truth is the model\'s ACTUAL behaviour read from live traces — no');
console.log('hand-written phrase list. Plumbing is not graded on purpose: a goal should');
console.log('not name `suggest_followups`, so counting it would fabricate a miss.');
