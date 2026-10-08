#!/usr/bin/env node
/**
 * Measure the in-turn DECISION RECALL (Bundle 36e): does a later ask that
 * re-opens a settled question actually get shown the standing answer, and does
 * an unrelated ask get NOTHING?
 *
 * WHY A MEASUREMENT AND NOT AN ASSERTION. The claim "the recall block is
 * bounded and only fires on a real token match" is deterministic — it is the
 * same read side `nuvira decisions --for` uses — so it can be measured offline,
 * on the REAL built `recallDecisionBlock`, rather than asserted by a comment.
 * What this script CANNOT measure is the real-world `ask_user` rate (how often a
 * live turn would have re-asked); that needs labelled sessions with and without
 * the feature, which no corpus here has. This reports the matching behaviour and
 * says so plainly.
 *
 * It writes to a throwaway temp project (never the user's `.nuvira/`), and needs
 * the CLI built first:
 *   npm run build:cli
 *   node scripts/measure-decision-recall.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let recordDecision, recallDecisionBlock;
try {
  ({ recordDecision, recallDecisionBlock } = await import('../dist/learning/decision-log.js'));
} catch {
  console.error('Could not import dist/learning/decision-log.js — run `npm run build:cli` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'nuvira-measure-recall-'));

// The decisions this project already settled.
const decided = [
  { question: 'Which database should the service use?', answer: 'Postgres' },
  { question: 'Which package manager should the repo use?', answer: 'pnpm' },
  { question: 'What should the API rate limit be?', answer: '100 requests per minute' },
  { question: 'Should the dashboard ship dark mode by default?', answer: 'yes' },
];
for (const d of decided) recordDecision({ ...d, source: 'ask_user', dir });

// Asks that should recall a decision (share a significant token), and asks that
// should not (no shared token of length >= 4).
const related = [
  'add an index to the service database',
  'switch the repo to a different package manager',
  'the API rate limit needs to change',
  'make dark mode the default on the dashboard',
];
const unrelated = [
  'write a haiku about the sea',
  'rename the logo asset',
  'explain how routing picks a model',
];

const LEN = (s) => s.length;
let injected = 0;
let inert = 0;

console.log('DECISION RECALL — what a later ask is shown (limit 3)\n');
console.log('related asks (expected: a block):');
for (const ask of related) {
  const block = recallDecisionBlock(dir, ask, 3);
  const ok = block.length > 0;
  if (ok) injected += 1;
  const lines = block ? block.split('\n').filter((l) => l.startsWith('- ')).length : 0;
  console.log(`  ${ok ? '✓' : '✗'} "${ask}"`);
  if (ok) console.log(`      → ${lines} decision(s) recalled, ${LEN(block)} chars`);
}

console.log('\nunrelated asks (expected: inert — byte-identical to no feature):');
for (const ask of unrelated) {
  const block = recallDecisionBlock(dir, ask, 3);
  const inertOk = block === '';
  if (inertOk) inert += 1;
  console.log(`  ${inertOk ? '✓' : '✗'} "${ask}" ${inertOk ? '(no block)' : `← UNEXPECTED: ${block.split('\n')[0]}`}`);
}

console.log('\n--- measurement ---');
console.log(`related asks recalled:  ${injected}/${related.length}`);
console.log(`unrelated asks inert:   ${inert}/${unrelated.length}`);
console.log('');
console.log('Bounded: the block lists at most 3 decisions per turn and is dropped EARLY');
console.log('under the context budget (dropPriority 28, before `recall` at 30).');
console.log('Advisory: it never suppresses an `ask_user` — that is asserted by');
console.log('tests/cli/chat-tool-loop.test.ts (the ask_user schema stays on the wire).');
console.log('NOT measured here: the real-world ask_user re-ask rate (needs labelled sessions).');

rmSync(dir, { recursive: true, force: true });
