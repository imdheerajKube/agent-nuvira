#!/usr/bin/env node
/**
 * Measure GATE FRICTION — how much the harness speaks to the model in a turn.
 *
 * WHAT IT COUNTS. Every `gate` event (a bounded nudge: plan / verification /
 * deliverable / permission / repeat / action / promise / self-review / diagnosis
 * / malformed-call / prerequisite) and every `refusal` event (a tool declined a
 * call, optionally with its gate) in each reasoning trace, plus the per-turn
 * total. It is the number Bundle 37b ("deliver gate text as an acted-on
 * instruction") exists to reduce, and the number that makes "the agent narrates
 * its own harness" a measurement instead of an impression.
 *
 * WHY A MEASUREMENT AND NOT AN ASSERTION. The claim is about real turns, and a
 * real turn is only observable in the trace store. Run it once on a corpus
 * captured BEFORE a change and once AFTER, and pass BOTH files to see the delta:
 *
 *   node scripts/measure-gate-friction.mjs                       # the local store
 *   node scripts/measure-gate-friction.mjs before.json after.json
 *
 * The default path is `~/.nuvira/memory/reasoning-traces.json`; the store is
 * read-only here. No model, no network — deterministic.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadTraces(path) {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.traces) ? raw.traces : Object.values(raw);
  return arr.filter((t) => t && typeof t === 'object');
}

/** Count this trace's gate/refusal events into `into`, and total them. */
function countTrace(trace, into) {
  let total = 0;
  for (const e of trace.events ?? []) {
    if (e?.kind === 'gate') {
      const key = `gate:${e.gate || 'unknown'}`;
      into.byKey.set(key, (into.byKey.get(key) ?? 0) + 1);
      total += 1;
    } else if (e?.kind === 'refusal') {
      const key = `refusal:${e.gate || e.tool || 'unknown'}`;
      into.byKey.set(key, (into.byKey.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  into.perTurn.push(total);
  return total;
}

function analyze(path) {
  const traces = loadTraces(path);
  const into = { byKey: new Map(), perTurn: [] };
  for (const t of traces) countTrace(t, into);
  const totals = [...into.perTurn].sort((a, b) => a - b);
  const sum = totals.reduce((n, v) => n + v, 0);
  const at = (p) => (totals.length ? totals[Math.min(totals.length - 1, Math.floor(p * totals.length))] : 0);
  return {
    path,
    traces: traces.length,
    byKey: into.byKey,
    perTurn: into.perTurn,
    sum,
    mean: totals.length ? sum / totals.length : 0,
    median: at(0.5),
    p90: at(0.9),
    max: totals.length ? totals[totals.length - 1] : 0,
    turnsWithAny: into.perTurn.filter((n) => n > 0).length,
  };
}

function report(r) {
  console.log(`\nfile: ${r.path}`);
  console.log(`traces: ${r.traces} · gate+refusal events: ${r.sum}`);
  if (r.traces > 0) {
    console.log(
      `per turn — mean ${r.mean.toFixed(2)} · median ${r.median} · p90 ${r.p90} · max ${r.max} · turns with any: ${r.turnsWithAny}/${r.traces}`,
    );
  }
  const rows = [...r.byKey.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\nby gate:');
  for (const [key, n] of rows) console.log(`  ${String(n).padStart(4)}  ${key}`);
  return new Map(rows);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const paths = args.length > 0 ? args : [join(homedir(), '.nuvira', 'memory', 'reasoning-traces.json')];

const results = paths.map((p) => {
  try {
    return analyze(p);
  } catch (err) {
    console.error(`Could not read ${p}: ${err.message}`);
    process.exit(1);
  }
});

const maps = results.map(report);

if (maps.length === 2) {
  const [before, after] = maps;
  const keys = new Set([...before.keys(), ...after.keys()]);
  console.log('\n--- before → after (delta per gate) ---');
  let totalDelta = 0;
  for (const key of [...keys].sort()) {
    const b = before.get(key) ?? 0;
    const a = after.get(key) ?? 0;
    totalDelta += a - b;
    const sign = a - b > 0 ? '+' : '';
    console.log(`  ${sign}${a - b}  ${key}   (${b} → ${a})`);
  }
  console.log(`\n  total gate+refusal events: ${results[0].sum} → ${results[1].sum} (${totalDelta >= 0 ? '+' : ''}${totalDelta})`);
  console.log(`  per-turn mean: ${results[0].mean.toFixed(2)} → ${results[1].mean.toFixed(2)}`);
}
