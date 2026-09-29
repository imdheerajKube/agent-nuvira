/**
 * WS7 (#29) — the seeded-bug benchmark.
 *
 * WHY THIS IS TEST INFRASTRUCTURE AND NOT A MATRIX ROW. `src/parity/matrix.ts`
 * says it in one line: the seeded-bug benchmark is not a capability a surface can
 * have, so it has no cells and no parity verdict of its own. What it has is a job —
 * measure whether the agent can FIND and FIX a defect it was not told about, which
 * is the thing a coding agent is for and the thing the M2b suite could only
 * approximate: M2b tasks are written by hand and graded by hidden tests, but
 * nothing proves the task was BROKEN before the agent ran, so a task that already
 * passed measured nothing.
 *
 * THE PROPERTY THAT MAKES THIS A BENCHMARK RATHER THAN A TASK LIST. Every seeded
 * bug is declared TWICE — the broken workspace the agent receives, and the same
 * workspace after a reference fix — and `verifySeededBug` runs the checks against
 * both. The checks must FAIL on the seed (and say so in their own words) and PASS
 * after the fix. A seed that already passes its checks, or a check that cannot
 * pass even when fixed, fails verification and is NOT scored: `runSeededSuite`
 * verifies every task before it runs a single model call. `nuvira eval
 * verify-seeds` exposes the same verification directly, so the ratchet is
 * runnable from a terminal and in CI without a provider.
 *
 * WHAT 'FAILING' HAS TO MEAN. A check that exits non-zero because it crashed —
 * a syntax error, a missing module — would satisfy a naive verification while
 * proving nothing about the bug. So a seed counts as genuinely broken only when
 * its check exits non-zero AND prints the failure marker its own assertions
 * print (`FAIL`). Combined with "the same check passes once the fix is applied",
 * that pins both ends: the check is well-formed, and it is the DEFECT that makes
 * it fail.
 *
 * PLAIN NODE, ON PURPOSE. Every seed is a CommonJS `.js` file with a `.js` test
 * script and no dependencies, so verification is deterministic, offline, and
 * needs nothing but the `node` already running the suite. (A future Python seed
 * would have to be gated on an interpreter actually being present rather than
 * assumed — the honest version of "we also test Python".)
 *
 * Deliberately NOT measured here: collateral damage to files the fix should not
 * touch is scored from a diff of the workspace against the seed
 * (`src/learning/seeded-benchmark.ts`), not from reference patterns, because
 * "this file still contains line X" is a weaker claim than "this file is
 * unchanged" and the benchmark should not make the weak one.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One file in a seeded workspace. */
export interface SeedFile {
  path: string;
  content: string;
}

/** One check that must fail on the seed and pass after the fix. */
export interface SeedCheck {
  /** The script to run, relative to the workspace root. */
  file: string;
  /** The command that runs it (cwd = workspace root). */
  command: string;
}

/** A deliberately seeded defect, with the workspace on both sides of the fix. */
export interface SeededBug {
  id: string;
  title: string;
  /** What kind of defect it is — the axis the benchmark reports on. */
  axis: string;
  difficulty: 'easy' | 'medium';
  /**
   * The defect, as GROUND TRUTH. Never shown to the agent: the whole measurement
   * is whether it can find this from the failing check alone.
   */
  bug: string;
  /** The workspace as the agent receives it: broken, and provably so. */
  files: readonly SeedFile[];
  /**
   * The files the reference fix rewrites. Every path here must also appear in
   * `files` — a fix that adds a file is a different shape and would make the
   * before/after diff meaningless.
   */
  fixedFiles: readonly SeedFile[];
  /** The file the fix belongs in. Everything else is collateral if it changes. */
  target: string;
  /** Checks that fail on the seed and pass after the reference fix. */
  checks: readonly SeedCheck[];
  /**
   * Substrings (case-insensitive) that count as the agent having IDENTIFIED the
   * defect in what it reported. Diagnostic vocabulary, not the fix: an agent that
   * rewrites the function correctly but reports "done" has fixed it without
   * finding it, and the two are scored apart.
   */
  detectionSignals: readonly string[];
  /** Token budget for the run, so cost is scored alongside correctness. */
  tokenBudget: number;
}

/** The exact request every seeded task makes — uniform, so the score compares competence. */
export function seededGoal(bug: SeededBug): string {
  const commands = bug.checks.map((c) => `\`${c.command}\``).join(' and ');
  return (
    `${commands} fails in this project. Diagnose the defect in the source and fix it so the ` +
    `check passes. Do not modify the check file, and do not change any file that is not ` +
    `responsible for the failure.`
  );
}

const RANGE_TEST = `const assert = require('node:assert');
const { range } = require('../src/range.js');
try {
  assert.deepStrictEqual(range(3), [0, 1, 2]);
  assert.deepStrictEqual(range(0), []);
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

const TOP_SCORES_TEST = `const assert = require('node:assert');
const { topScores } = require('../src/top-scores.js');
try {
  assert.deepStrictEqual(topScores([10, 9, 100], 2), [100, 10]);
  assert.deepStrictEqual(topScores([5, 5, 1], 2), [5, 5]);
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

const SUM_ASYNC_TEST = `const assert = require('node:assert');
const { sumAsync } = require('../src/sum-async.js');
(async () => {
  try {
    assert.strictEqual(await sumAsync([1, 2, 3]), 6);
    assert.strictEqual(await sumAsync([]), 0);
    console.log('ok');
  } catch (err) {
    console.error('FAIL: ' + err.message);
    process.exit(1);
  }
})();
`;

const FORMAT_AMOUNT_TEST = `const assert = require('node:assert');
const { formatAmount } = require('../src/format-amount.js');
try {
  assert.strictEqual(formatAmount(12.5), '$12.50');
  assert.strictEqual(formatAmount(0), '$0.00');
  assert.strictEqual(formatAmount(null), '—');
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

const CLONE_CONFIG_TEST = `const assert = require('node:assert');
const { cloneConfig } = require('../src/clone-config.js');
try {
  const original = { name: 'svc', limits: { max: 10 } };
  const copy = cloneConfig(original);
  copy.limits.max = 99;
  assert.strictEqual(original.limits.max, 10, 'the original object was mutated through the copy');
  assert.strictEqual(copy.name, 'svc');
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

const ADD_TAG_TEST = `const assert = require('node:assert');
const { addTag } = require('../src/add-tag.js');
try {
  const tags = ['a'];
  const next = addTag(tags, 'b');
  assert.deepStrictEqual(next, ['a', 'b']);
  assert.deepStrictEqual(tags, ['a'], 'addTag mutated the caller array');
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

const AVERAGE_TEST = `const assert = require('node:assert');
const { averageOf } = require('../src/average-of.js');
try {
  assert.strictEqual(averageOf([10, null, 20]), 15);
  assert.strictEqual(averageOf([null]), 0);
  console.log('ok');
} catch (err) {
  console.error('FAIL: ' + err.message);
  process.exit(1);
}
`;

/**
 * The suite.
 *
 * Each entry is a real defect with a real fix, small enough that a strong model
 * can find it from the failing check and that the reference fix is unambiguous.
 * The axes are the ones that actually bite in production code: an inclusive bound,
 * a comparator that was never given, an async callback in a synchronous-looking
 * call, a falsy guard that eats a legitimate zero, a copy that is only one level
 * deep, a helper that mutates its caller's data, and a denominator that was not
 * updated with the filter beside it.
 */
export const SEEDED_BUGS: readonly SeededBug[] = [
  {
    id: 'seed-range-off-by-one',
    title: 'Range helper returns one element too many',
    axis: 'boundary',
    difficulty: 'easy',
    bug: '`for (let i = 0; i <= n; i += 1)` makes `range(n)` produce n+1 elements; the bound must be exclusive.',
    files: [
      {
        path: 'src/range.js',
        content: `function range(n) {
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(i);
  return out;
}

module.exports = { range };
`,
      },
      { path: 'test/range.test.js', content: RANGE_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/range.js',
        content: `function range(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(i);
  return out;
}

module.exports = { range };
`,
      },
    ],
    target: 'src/range.js',
    checks: [{ file: 'test/range.test.js', command: 'node test/range.test.js' }],
    detectionSignals: ['off-by-one', 'off by one', 'inclusive', 'exclusive', '<='],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-top-scores-lexical-sort',
    title: 'Top scores sorted as strings',
    axis: 'comparator',
    difficulty: 'easy',
    bug: '`scores.sort()` sorts lexically without a comparator, so 100 ranks below 9. The fix must also stop mutating the caller array.',
    files: [
      {
        path: 'src/top-scores.js',
        content: `function topScores(scores, n) {
  return scores.sort().slice(0, n);
}

module.exports = { topScores };
`,
      },
      { path: 'test/top-scores.test.js', content: TOP_SCORES_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/top-scores.js',
        content: `function topScores(scores, n) {
  return [...scores].sort((a, b) => b - a).slice(0, n);
}

module.exports = { topScores };
`,
      },
    ],
    target: 'src/top-scores.js',
    checks: [{ file: 'test/top-scores.test.js', command: 'node test/top-scores.test.js' }],
    detectionSignals: ['lexicograph', 'string', 'comparator', 'numeric'],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-sum-async-for-each',
    title: 'Async callback in a synchronous-looking forEach',
    axis: 'async',
    difficulty: 'medium',
    bug: '`values.forEach(async …)` never awaits the callbacks, so the function resolves before the calls finish and returns the initial 0.',
    files: [
      {
        path: 'src/sum-async.js',
        content: `async function sumAsync(values) {
  let total = 0;
  values.forEach(async (value) => {
    total += await Promise.resolve(value);
  });
  return total;
}

module.exports = { sumAsync };
`,
      },
      { path: 'test/sum-async.test.js', content: SUM_ASYNC_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/sum-async.js',
        content: `async function sumAsync(values) {
  let total = 0;
  for (const value of values) {
    total += await Promise.resolve(value);
  }
  return total;
}

module.exports = { sumAsync };
`,
      },
    ],
    target: 'src/sum-async.js',
    checks: [{ file: 'test/sum-async.test.js', command: 'node test/sum-async.test.js' }],
    detectionSignals: ['forall', 'not awaited', 'await', 'race', 'synchronous'],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-format-amount-falsy-zero',
    title: 'A falsy guard swallows a legitimate zero',
    axis: 'truthiness',
    difficulty: 'easy',
    bug: 'A falsy guard (if (!amount)) treats 0 as missing; the guard must test for null/undefined instead, while null must still read as an em dash.',
    files: [
      {
        path: 'src/format-amount.js',
        content: `function formatAmount(amount) {
  if (!amount) return '—';
  return '$' + amount.toFixed(2);
}

module.exports = { formatAmount };
`,
      },
      { path: 'test/format-amount.test.js', content: FORMAT_AMOUNT_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/format-amount.js',
        content: `function formatAmount(amount) {
  if (amount === null || amount === undefined) return '—';
  return '$' + amount.toFixed(2);
}

module.exports = { formatAmount };
`,
      },
    ],
    target: 'src/format-amount.js',
    checks: [{ file: 'test/format-amount.test.js', command: 'node test/format-amount.test.js' }],
    detectionSignals: ['falsy', 'truthy', 'zero', '!amount', 'null'],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-clone-config-shallow',
    title: 'Config clone is only one level deep',
    axis: 'aliasing',
    difficulty: 'medium',
    bug: '`{ ...cfg }` copies the top level only, so `copy.limits` IS `original.limits` and mutating one changes the other.',
    files: [
      {
        path: 'src/clone-config.js',
        content: `function cloneConfig(config) {
  return { ...config };
}

module.exports = { cloneConfig };
`,
      },
      { path: 'test/clone-config.test.js', content: CLONE_CONFIG_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/clone-config.js',
        content: `function cloneConfig(config) {
  return structuredClone(config);
}

module.exports = { cloneConfig };
`,
      },
    ],
    target: 'src/clone-config.js',
    checks: [{ file: 'test/clone-config.test.js', command: 'node test/clone-config.test.js' }],
    detectionSignals: ['shallow', 'deep', 'nested', 'aliasing', 'reference'],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-add-tag-mutates-input',
    title: 'Helper mutates its caller array',
    axis: 'mutation',
    difficulty: 'easy',
    bug: '`tags.push(tag); return tags;` returns the caller\'s own array after mutating it; it must return a new array.',
    files: [
      {
        path: 'src/add-tag.js',
        content: `function addTag(tags, tag) {
  tags.push(tag);
  return tags;
}

module.exports = { addTag };
`,
      },
      { path: 'test/add-tag.test.js', content: ADD_TAG_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/add-tag.js',
        content: `function addTag(tags, tag) {
  return [...tags, tag];
}

module.exports = { addTag };
`,
      },
    ],
    target: 'src/add-tag.js',
    checks: [{ file: 'test/add-tag.test.js', command: 'node test/add-tag.test.js' }],
    detectionSignals: ['mutat', 'in place', 'copy', 'push'],
    tokenBudget: 20_000,
  },
  {
    id: 'seed-average-filtered-denominator',
    title: 'Denominator not updated with the filter',
    axis: 'aggregation',
    difficulty: 'medium',
    bug: 'Entries are filtered out of the SUM but not out of the DIVISOR, so a missing measurement drags every average down.',
    files: [
      {
        path: 'src/average-of.js',
        content: `function averageOf(measurements) {
  const real = measurements.filter((m) => m !== null);
  if (measurements.length === 0) return 0;
  const sum = real.reduce((total, value) => total + value, 0);
  return sum / measurements.length;
}

module.exports = { averageOf };
`,
      },
      { path: 'test/average-of.test.js', content: AVERAGE_TEST },
    ],
    fixedFiles: [
      {
        path: 'src/average-of.js',
        content: `function averageOf(measurements) {
  const real = measurements.filter((m) => m !== null);
  if (real.length === 0) return 0;
  const sum = real.reduce((total, value) => total + value, 0);
  return sum / real.length;
}

module.exports = { averageOf };
`,
      },
    ],
    target: 'src/average-of.js',
    checks: [{ file: 'test/average-of.test.js', command: 'node test/average-of.test.js' }],
    detectionSignals: ['denominator', 'divisor', 'length', 'filtered'],
    tokenBudget: 20_000,
  },
];

/** A bug by id, or undefined. */
export function seededBugById(id: string): SeededBug | undefined {
  return SEEDED_BUGS.find((bug) => bug.id === id);
}

/** Write a workspace to `dir`. `fixed` swaps in the reference fix. */
export function materializeSeededBug(bug: SeededBug, dir: string, fixed = false): string {
  const files = fixed
    ? [
        ...bug.files.filter((f) => !bug.fixedFiles.some((fixedFile) => fixedFile.path === f.path)),
        ...bug.fixedFiles,
      ]
    : bug.files;
  for (const file of files) {
    const abs = join(dir, file.path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, file.content, 'utf-8');
  }
  return dir;
}

/** One check's outcome in a workspace. */
export interface SeedCheckResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

/** Run one check in a workspace. Never throws — a failure IS the result. */
export function runSeedCheck(workspace: string, check: SeedCheck, timeoutMs = 30_000): SeedCheckResult {
  const start = Date.now();
  try {
    const output = execSync(check.command, {
      cwd: workspace,
      timeout: timeoutMs,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      maxBuffer: 2 * 1024 * 1024,
    });
    return { command: check.command, exitCode: 0, output: String(output).trim(), durationMs: Date.now() - start };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof e.stdout === 'string' ? e.stdout : String(e.stdout || '');
    const stderr = typeof e.stderr === 'string' ? e.stderr : String(e.stderr || '');
    return {
      command: check.command,
      // A killed check (timeout) reports no status; 1 keeps it a failure rather
      // than an accidental pass.
      exitCode: e.status ?? 1,
      output: `${stdout}\n${stderr}`.trim(),
      durationMs: Date.now() - start,
    };
  }
}

/** What verification found for one seed. */
export interface SeedVerification {
  id: string;
  title: string;
  /** The check FAILED on the seeded workspace, and said so in its own words. */
  seedFails: boolean;
  /** The same check PASSED once the reference fix was applied. */
  fixPasses: boolean;
  ok: boolean;
  /** Human-readable evidence, one line per side. */
  detail: string;
}

/**
 * Prove a seed is genuinely broken and genuinely fixable.
 *
 * Both halves are required, and the marker requirement is what stops a check that
 * merely CRASHED from counting as evidence of a bug: a syntax error also exits
 * non-zero, so "it failed" alone would verify nothing. The fix half is what proves
 * the check is well-formed; the marker half is what proves the failure is the
 * defect's.
 */
export function verifySeededBug(bug: SeededBug): SeedVerification {
  const seedDir = mkdtempSync(join(tmpdir(), `seed-verify-${bug.id}-`));
  const fixedDir = mkdtempSync(join(tmpdir(), `seed-verify-fixed-${bug.id}-`));
  try {
    materializeSeededBug(bug, seedDir, false);
    materializeSeededBug(bug, fixedDir, true);
    const details: string[] = [];
    let seedFails = true;
    let fixPasses = true;
    for (const check of bug.checks) {
      const seeded = runSeedCheck(seedDir, check);
      // The marker requirement: the check must fail BY ASSERTING, not by crashing.
      const failedByAsserting = seeded.exitCode !== 0 && /FAIL/.test(seeded.output);
      if (!failedByAsserting) seedFails = false;
      details.push(
        `    seed  ${check.command} → exit ${seeded.exitCode}` +
          (failedByAsserting ? '' : ` (no FAIL marker — ${firstLine(seeded.output) || 'no output'})`) +
          `\n          ${firstLine(seeded.output)}`,
      );
      const repaired = runSeedCheck(fixedDir, check);
      if (repaired.exitCode !== 0) fixPasses = false;
      details.push(
        `    fixed ${check.command} → exit ${repaired.exitCode}` +
          (repaired.exitCode === 0 ? '' : ` (${firstLine(repaired.output) || 'no output'})`),
      );
    }
    return {
      id: bug.id,
      title: bug.title,
      seedFails,
      fixPasses,
      ok: seedFails && fixPasses,
      detail: details.join('\n'),
    };
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
    rmSync(fixedDir, { recursive: true, force: true });
  }
}

/** The first non-empty line of output, for a one-line report. */
function firstLine(output: string): string {
  return (output || '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** A table of verifications, ready to print. */
export function formatSeedVerification(results: readonly SeedVerification[]): string {
  const lines = ['Seeded-bug verification (each seed must FAIL its checks, and PASS once fixed):', ''];
  for (const result of results) {
    lines.push(`  ${result.ok ? '✅' : '✗ '} ${result.id.padEnd(36)} ${result.title}`);
    if (!result.ok) {
      lines.push(
        `      seed fails: ${result.seedFails ? 'yes' : 'NO'} · fix passes: ${result.fixPasses ? 'yes' : 'NO'}`,
      );
      lines.push(result.detail);
    }
  }
  const bad = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(
    bad === 0
      ? `✓ all ${results.length} seeded bug(s) verified — every one is genuinely broken, and genuinely fixable.`
      : `✗ ${bad} of ${results.length} seeded bug(s) did not verify — a task that is not broken scores nothing.`,
  );
  return lines.join('\n');
}

/** Read a file from a workspace, or null. */
export function readWorkspaceFile(workspace: string, path: string): string | null {
  try {
    return readFileSync(join(workspace, path), 'utf-8');
  } catch {
    return null;
  }
}
