/**
 * Evaluation Framework — Measures whether Agent-Nuvira is actually improving.
 *
 * Unlike `benchmark.ts` (which only measures prompt-response quality), this
 * framework runs REAL end-to-end coding tasks through the full multi-agent
 * pipeline (plan → write → run → test → repair) inside an isolated temp
 * workspace, then grades the result across eight reliability metrics:
 *
 *   1. task completion rate      — did the pipeline finish without failures?
 *   2. test pass rate            — did hidden tests pass after execution?
 *   3. time-to-fix               — how long until the first green run?
 *   4. accuracy of edits         — did the final files match the reference?
 *   5. token efficiency          — tokens used vs. the task token budget
 *   6. rollback frequency        — how many file changes were reverted?
 *   7. dependency install        — was the agent able to install deps?
 *   8. recovery / new ideas      — did it try alternative approaches instead
 *                                  of just reporting "planner/runner failed"?
 *
 * Usage:
 *   buff eval run                        — Run all eval tasks against default provider
 *   buff eval run --provider groq        — Run against a specific provider
 *   buff eval run --tasks js-fizzbuzz    — Run specific tasks
 *   buff eval list                       — List available eval tasks
 *   buff eval results                    — Show previous eval runs
 *   buff eval score                      — Show the scoring rules
 *
 * Results stored in: ~/.buff/memory/evals.json
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';

import type { InferenceProvider } from '../inference/interface.js';
import { ConfigManager } from '../config/manager.js';
import { Orchestrator, type OrchestrationResult } from '../agents/orchestrator.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Category of an evaluation task */
export type EvalCategory =
  | 'bug-fix'
  | 'feature'
  | 'refactor'
  | 'test-writing'
  | 'dependency-setup'
  | 'algorithm';

/** A single end-to-end evaluation task */
export interface EvalTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable title */
  title: string;
  /** Category */
  category: EvalCategory;
  /** Difficulty */
  difficulty: 'easy' | 'medium' | 'hard';
  /** The goal handed to the agent pipeline */
  goal: string;
  /** Files scaffolded into the temp workspace before the agent runs */
  setupFiles: Array<{ path: string; content: string }>;
  /** Hidden tests run AFTER the agent finishes (in the workspace dir) */
  hiddenTests: Array<{
    /** Test file written into the workspace */
    file: string;
    /** Command to run (cwd = workspace). Exit code 0 = pass */
    command: string;
    /** Expected exit code (default 0) */
    expectExitCode?: number;
  }>;
  /** Reference solution patterns for edit-accuracy scoring */
  referencePatterns?: Array<{
    /** File in the workspace to check */
    file: string;
    /** All of these substrings must be present */
    mustContain: string[];
    /** None of these substrings may be present */
    mustNotContain?: string[];
  }>;
  /** Token budget for token-efficiency scoring */
  tokenBudget: number;
  /** Time estimate */
  timeEstimate: 'quick' | 'medium' | 'slow';
  /** Per-task wall-clock timeout in ms (default 10 min) */
  timeoutMs?: number;
}

/** The eight metrics measured for a single task run */
export interface EvalMetrics {
  /** Task completion rate — pipeline finished without failed tasks */
  completed: boolean;
  /** Hidden tests passed */
  testPassed: boolean;
  /** Fraction of hidden tests that passed (0-1) */
  testPassRate: number;
  /** Time from run start to first green test (ms). Infinity if never green */
  timeToFixMs: number;
  /** Edit accuracy vs. reference (0-1) */
  editAccuracy: number;
  /** Token efficiency (0-1) — budget / used, capped at 1 */
  tokenEfficiency: number;
  /** Number of file changes reverted to their original content */
  rollbackCount: number;
  /** Whether the runner attempted a dependency install */
  dependencyInstallAttempted: boolean;
  /** Whether the dependency install succeeded */
  dependencyInstallSucceeded: boolean;
  /** Total repair attempts triggered by the ErrorRepairEngine */
  recoveryAttempts: number;
  /** Number of 'alternative-approach' strategies tried (new ideas) */
  alternativeApproaches: number;
  /** Task failed on first attempt but succeeded after repair */
  recovered: boolean;
  /** Total agent executions for this task */
  attempts: number;
  /** Estimated cost in USD */
  costUsd: number;
  /** Total latency in ms */
  latencyMs: number;
  /** Error message if the pipeline itself crashed */
  error?: string;
}

/** Result of running one eval task */
export interface EvalResult {
  taskId: string;
  provider: string;
  model: string;
  metrics: EvalMetrics;
  /** Composite score (0-1) from the weighted scoring rules */
  compositeScore: number;
  /** Agent's final summary */
  summary: string;
  timestamp: number;
}

/** A complete eval run across multiple tasks */
export interface EvalRun {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  results: EvalResult[];
  summary: EvalSummary;
}

/** Summary statistics for an eval run */
export interface EvalSummary {
  totalTasks: number;
  tasksPassed: number;
  completionRate: number;
  testPassRate: number;
  avgTimeToFixMs: number;
  avgEditAccuracy: number;
  avgTokenEfficiency: number;
  totalRollbacks: number;
  dependencyInstallRate: number;
  recoveryRate: number;
  avgCompositeScore: number;
  totalCostUsd: number;
}

/** Stored eval data on disk */
interface EvalData {
  runs: EvalRun[];
  version: number;
}

// ─── Scoring Rules ──────────────────────────────────────────────────────────

/**
 * Weights for the composite score. Higher = more important.
 * Weighted toward correctness (test pass) and completion, with meaningful
 * credit for speed (time-to-fix), efficiency (tokens), and — crucially —
 * recovery behavior (trying new approaches instead of giving up).
 */
export const EVAL_SCORE_WEIGHTS = {
  /** Hidden tests pass (correctness) — 30% */
  testPass: 0.30,
  /** Task completion rate — 20% */
  completion: 0.20,
  /** Accuracy of edits vs. reference — 15% */
  editAccuracy: 0.15,
  /** Token efficiency — 10% */
  tokenEfficiency: 0.10,
  /** Speed: time-to-fix — 10% */
  timeToFix: 0.10,
  /** Recovery: tried new approaches & recovered — 10% */
  recovery: 0.10,
  /** Reliability: low rollback frequency — 5% */
  rollbackPenalty: 0.05,
} as const;

/** Reference "ideal" time-to-fix in ms used to normalize the speed score */
export const IDEAL_TIME_TO_FIX_MS = 120_000; // 2 minutes

/**
 * Score a single task's metrics into a composite 0-1 score.
 */
export function scoreEvalMetrics(metrics: EvalMetrics): number {
  // 1. Correctness — hidden tests
  const testPassScore = metrics.testPassed ? 1 : metrics.testPassRate;

  // 2. Completion
  const completionScore = metrics.completed ? 1 : 0;

  // 3. Edit accuracy
  const editScore = clamp01(metrics.editAccuracy);

  // 4. Token efficiency
  const tokenScore = clamp01(metrics.tokenEfficiency);

  // 5. Speed — time to first green run. Infinity/never fixed => 0.
  const timeScore = metrics.testPassed && isFinite(metrics.timeToFixMs)
    ? clamp01(IDEAL_TIME_TO_FIX_MS / Math.max(metrics.timeToFixMs, 1))
    : 0;

  // 6. Recovery — tried new approaches and got back on track.
  //    Full credit if it recovered; partial credit if it at least tried
  //    alternatives (even if the task ultimately failed).
  const recoveryScore = metrics.recovered
    ? 1
    : metrics.recoveryAttempts > 0
      ? 0.5
      : 0;

  // 7. Rollback frequency — each rollback costs 25% of this component.
  const rollbackScore = clamp01(1 - metrics.rollbackCount * 0.25);

  return (
    EVAL_SCORE_WEIGHTS.testPass * testPassScore +
    EVAL_SCORE_WEIGHTS.completion * completionScore +
    EVAL_SCORE_WEIGHTS.editAccuracy * editScore +
    EVAL_SCORE_WEIGHTS.tokenEfficiency * tokenScore +
    EVAL_SCORE_WEIGHTS.timeToFix * timeScore +
    EVAL_SCORE_WEIGHTS.recovery * recoveryScore +
    EVAL_SCORE_WEIGHTS.rollbackPenalty * rollbackScore
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ─── Evaluation Task Dataset ────────────────────────────────────────────────

const EVAL_TASKS: EvalTask[] = [
  // ── Bug fix: JavaScript FizzBuzz (off-by-one) ────────────────────────
  {
    id: 'js-fizzbuzz-fix',
    title: 'Fix FizzBuzz Off-By-One',
    category: 'bug-fix',
    difficulty: 'easy',
    goal: 'Fix the bug in fizzbuzz.js so that `getFizzBuzz(3)` returns ["1","2","Fizz"] and `getFizzBuzz(15)` returns the correct FizzBuzz sequence ending in "FizzBuzz". Do not change the function name or signature. Verify by running the tests.',
    setupFiles: [
      {
        path: 'fizzbuzz.js',
        content: [
          '// BUG: the loop starts at 1 but should include the limit',
          'function getFizzBuzz(n) {',
          '  const out = [];',
          '  for (let i = 1; i < n; i++) {',
          '    if (i % 15 === 0) out.push("FizzBuzz");',
          '    else if (i % 3 === 0) out.push("Fizz");',
          '    else if (i % 5 === 0) out.push("Buzz");',
          '    else out.push(String(i));',
          '  }',
          '  return out;',
          '}',
          'module.exports = { getFizzBuzz };',
          '',
        ].join('\n'),
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'fizzbuzz-task',
          version: '1.0.0',
          scripts: { test: 'node test.js' },
        }, null, 2),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'fizzbuzz.js',
        mustContain: ['i <= n', 'i < n + 1', 'FizzBuzz'],
        mustNotContain: ['i < n'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'quick',
    timeoutMs: 180_000,
  },

  // ── Bug fix: JavaScript closure (var → let) ──────────────────────────
  {
    id: 'js-closure-fix',
    title: 'Fix Closure Bug',
    category: 'bug-fix',
    difficulty: 'easy',
    goal: 'Fix the closure bug in closure.js. The `createCounters` function should return an array of functions where each function returns its own index (0, 1, 2). The bug is that `var` is shared across all closures. Do not change the function name. Verify by running the tests.',
    setupFiles: [
      {
        path: 'closure.js',
        content: [
          '// BUG: var creates a shared binding across all closures',
          'function createCounters() {',
          '  const fns = [];',
          '  for (var i = 0; i < 3; i++) {',
          '    fns.push(function () { return i; });',
          '  }',
          '  return fns;',
          '}',
          'module.exports = { createCounters };',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'closure.js',
        mustContain: ['let i'],
        mustNotContain: ['var i'],
      },
    ],
    tokenBudget: 6000,
    timeEstimate: 'quick',
    timeoutMs: 180_000,
  },

  // ── Feature: Python Fibonacci (memoized) ─────────────────────────────
  {
    id: 'py-fibonacci',
    title: 'Implement Memoized Fibonacci',
    category: 'feature',
    difficulty: 'medium',
    goal: 'Implement `fib(n)` in fib.py that returns the nth Fibonacci number (fib(0)=0, fib(1)=1) using memoization so it completes instantly for n up to 100. Do not use functools.lru_cache — implement an explicit dict cache. Verify by running the tests.',
    setupFiles: [
      {
        path: 'fib.py',
        content: [
          '# TODO: implement memoized fibonacci',
          'def fib(n):',
          '    # your implementation here',
          '    pass',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test_fib.py',
        command: 'python3 test_fib.py',
      },
    ],
    referencePatterns: [
      {
        file: 'fib.py',
        mustContain: ['cache', 'def fib'],
        mustNotContain: ['lru_cache'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'medium',
    timeoutMs: 240_000,
  },

  // ── Feature: JavaScript Queue ─────────────────────────────────────────
  {
    id: 'js-queue',
    title: 'Implement a Queue',
    category: 'feature',
    difficulty: 'easy',
    goal: 'Implement a `Queue` class in queue.js with `enqueue(item)`, `dequeue()` (returns the oldest item or undefined when empty), `peek()`, and `get length()`. Do not use Array.prototype.shift (it is O(n)) — use two stacks or head/tail pointers. Verify by running the tests.',
    setupFiles: [
      {
        path: 'queue.js',
        content: [
          '// TODO: implement an efficient Queue',
          'class Queue {',
          '  // your implementation here',
          '}',
          'module.exports = { Queue };',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'queue.js',
        mustContain: ['enqueue', 'dequeue', 'peek', 'class Queue'],
        mustNotContain: ['.shift()'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'medium',
    timeoutMs: 240_000,
  },

  // ── Dependency setup: local file dependency ──────────────────────────
  {
    id: 'dep-local-module',
    title: 'Install Local Module Dependency',
    category: 'dependency-setup',
    difficulty: 'medium',
    goal: 'The project has a package.json that depends on a local module "math-utils" (a file: dependency). Run the appropriate command to install dependencies, then verify the program runs by executing the tests. The program imports { add } from "math-utils".',
    setupFiles: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'dep-task',
          version: '1.0.0',
          dependencies: {
            'math-utils': 'file:./math-utils',
          },
          scripts: { test: 'node test.js' },
        }, null, 2),
      },
      {
        path: 'index.js',
        content: [
          'const { add } = require("math-utils");',
          'module.exports = { run: () => add(2, 3) };',
          '',
        ].join('\n'),
      },
      {
        path: 'math-utils/package.json',
        content: JSON.stringify({
          name: 'math-utils',
          version: '1.0.0',
          main: 'index.js',
        }, null, 2),
      },
      {
        path: 'math-utils/index.js',
        content: [
          'function add(a, b) { return a + b; }',
          'module.exports = { add };',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'index.js',
        mustContain: ['math-utils'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'medium',
    timeoutMs: 240_000,
  },

  // ── Algorithm: JavaScript anagram checker ─────────────────────────────
  {
    id: 'js-anagram',
    title: 'Implement Anagram Checker',
    category: 'algorithm',
    difficulty: 'easy',
    goal: 'Implement `isAnagram(a, b)` in anagram.js that returns true if the two strings are anagrams (ignoring case and spaces) and false otherwise. Empty strings are anagrams of each other. Verify by running the tests.',
    setupFiles: [
      {
        path: 'anagram.js',
        content: [
          '// TODO: implement isAnagram',
          'function isAnagram(a, b) {',
          '  // your implementation here',
          '  return false;',
          '}',
          'module.exports = { isAnagram };',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'anagram.js',
        mustContain: ['function isAnagram'],
      },
    ],
    tokenBudget: 6000,
    timeEstimate: 'quick',
    timeoutMs: 180_000,
  },

  // ── Refactor: callback → async/await ─────────────────────────────────
  {
    id: 'js-refactor-async',
    title: 'Refactor Callbacks to Async/Await',
    category: 'refactor',
    difficulty: 'medium',
    goal: 'Refactor fetchUser.js so `getUserData(userId)` returns a Promise using async/await instead of callback nesting. It should fetch a user, then their posts, then the first post\'s comments — each helper returns a Promise. Do not change the exported function name. Verify by running the tests.',
    setupFiles: [
      {
        path: 'fetchUser.js',
        content: [
          '// Callback hell — refactor to async/await',
          'function getUser(userId) {',
          '  return Promise.resolve({ id: userId, name: "Alice" });',
          '}',
          'function getPosts(userId) {',
          '  return Promise.resolve([{ id: 1, title: "Post 1" }]);',
          '}',
          'function getComments(postId) {',
          '  return Promise.resolve([{ id: 1, text: "Nice!" }]);',
          '}',
          '',
          'function getUserData(userId) {',
          '  // TODO: refactor to async/await',
          '  return getUser(userId).then(function (user) {',
          '    return getPosts(user.id).then(function (posts) {',
          '      return getComments(posts[0].id).then(function (comments) {',
          '        return { user: user, posts: posts, comments: comments };',
          '      });',
          '    });',
          '  });',
          '}',
          '',
          'module.exports = { getUserData };',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test.js',
        command: 'node test.js',
      },
    ],
    referencePatterns: [
      {
        file: 'fetchUser.js',
        mustContain: ['async', 'await'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'medium',
    timeoutMs: 240_000,
  },
];

// ─── Hidden Test Files ──────────────────────────────────────────────────────
// The `content` field of hiddenTests is filled in at scaffold time via these
// templates (kept separately so the dataset stays readable above).

const HIDDEN_TEST_FILES: Record<string, string> = {
  'js-fizzbuzz-fix': [
    'const assert = require("assert");',
    'const { getFizzBuzz } = require("./fizzbuzz");',
    '',
    'assert.deepStrictEqual(getFizzBuzz(3), ["1", "2", "Fizz"]);',
    'const seq = getFizzBuzz(15);',
    'assert.strictEqual(seq.length, 15, "should include the limit");',
    'assert.strictEqual(seq[14], "FizzBuzz");',
    'assert.strictEqual(seq[2], "Fizz");',
    'assert.strictEqual(seq[4], "Buzz");',
    'console.log("ALL TESTS PASSED");',
    '',
  ].join('\n'),
  'js-closure-fix': [
    'const assert = require("assert");',
    'const { createCounters } = require("./closure");',
    '',
    'const counters = createCounters();',
    'assert.strictEqual(counters[0](), 0);',
    'assert.strictEqual(counters[1](), 1);',
    'assert.strictEqual(counters[2](), 2);',
    'console.log("ALL TESTS PASSED");',
    '',
  ].join('\n'),
  'py-fibonacci': [
    'from fib import fib',
    '',
    'assert fib(0) == 0',
    'assert fib(1) == 1',
    'assert fib(10) == 55',
    'assert fib(100) == 354224848179261915075',
    'print("ALL TESTS PASSED")',
    '',
  ].join('\n'),
  'js-queue': [
    'const assert = require("assert");',
    'const { Queue } = require("./queue");',
    '',
    'const q = new Queue();',
    'assert.strictEqual(q.length, 0);',
    'assert.strictEqual(q.dequeue(), undefined);',
    'q.enqueue("a"); q.enqueue("b"); q.enqueue("c");',
    'assert.strictEqual(q.length, 3);',
    'assert.strictEqual(q.peek(), "a");',
    'assert.strictEqual(q.dequeue(), "a");',
    'assert.strictEqual(q.dequeue(), "b");',
    'assert.strictEqual(q.dequeue(), "c");',
    'assert.strictEqual(q.length, 0);',
    'console.log("ALL TESTS PASSED");',
    '',
  ].join('\n'),
  'dep-local-module': [
    'const assert = require("assert");',
    'const { run } = require("./index");',
    '',
    'assert.strictEqual(run(), 5);',
    'console.log("ALL TESTS PASSED");',
    '',
  ].join('\n'),
  'js-anagram': [
    'const assert = require("assert");',
    'const { isAnagram } = require("./anagram");',
    '',
    'assert.strictEqual(isAnagram("listen", "silent"), true);',
    'assert.strictEqual(isAnagram("Hello World", "hello world"), true);',
    'assert.strictEqual(isAnagram("rat", "car"), false);',
    'assert.strictEqual(isAnagram("", ""), true);',
    'console.log("ALL TESTS PASSED");',
    '',
  ].join('\n'),
  'js-refactor-async': [
    'const assert = require("assert");',
    'const { getUserData } = require("./fetchUser");',
    '',
    '(async () => {',
    '  const data = await getUserData(42);',
    '  assert.strictEqual(data.user.id, 42);',
    '  assert.strictEqual(data.posts.length, 1);',
    '  assert.strictEqual(data.comments[0].text, "Nice!");',
    '  console.log("ALL TESTS PASSED");',
    '})().catch((err) => { console.error(err); process.exit(1); });',
    '',
  ].join('\n'),
};

// ─── Persistence ────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const EVAL_PATH = join(MEMORY_DIR, 'evals.json');
const CURRENT_VERSION = 1;
const MAX_EVAL_RUNS = 50;

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readEvalData(): EvalData {
  try {
    ensureDir();
    if (!existsSync(EVAL_PATH)) return { runs: [], version: CURRENT_VERSION };
    return JSON.parse(readFileSync(EVAL_PATH, 'utf-8')) as EvalData;
  } catch {
    return { runs: [], version: CURRENT_VERSION };
  }
}

function writeEvalData(data: EvalData): void {
  ensureDir();
  writeFileSync(EVAL_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Workspace Scaffolding & Hidden Tests ──────────────────────────────────

/** Create a temp workspace, scaffold setup files + hidden tests. Returns dir. */
export function scaffoldWorkspace(task: EvalTask): string {
  const dir = mkdtempSync(join(tmpdir(), 'buff-eval-'));
  for (const file of task.setupFiles) {
    const abs = join(dir, file.path);
    const parent = abs.slice(0, abs.lastIndexOf('/'));
    if (parent && parent !== abs) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(abs, file.content, 'utf-8');
  }
  // Write hidden test files (content filled from templates)
  for (const test of task.hiddenTests) {
    const abs = join(dir, test.file);
    const parent = abs.slice(0, abs.lastIndexOf('/'));
    if (parent && parent !== abs) {
      mkdirSync(parent, { recursive: true });
    }
    const template = HIDDEN_TEST_FILES[task.id];
    if (template !== undefined) {
      writeFileSync(abs, template, 'utf-8');
    }
  }
  return dir;
}

/** Run a hidden test command in the workspace. Returns exit code + duration. */
export function runHiddenTest(
  workspace: string,
  command: string,
  timeoutMs = 60_000,
): { exitCode: number; durationMs: number; output: string } {
  const start = Date.now();
  try {
    const output = execSync(command, {
      cwd: workspace,
      timeout: timeoutMs,
      stdio: 'pipe',
      encoding: 'utf-8',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      maxBuffer: 2 * 1024 * 1024,
    });
    return { exitCode: 0, durationMs: Date.now() - start, output: String(output).trim() };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = typeof e.stdout === 'string' ? e.stdout : String(e.stdout || '');
    const stderr = typeof e.stderr === 'string' ? e.stderr : String(e.stderr || '');
    return {
      exitCode: e.status ?? 1,
      durationMs: Date.now() - start,
      output: `${stdout}\n${stderr}`.trim(),
    };
  }
}

/** Compute edit accuracy (0-1) by checking reference patterns in workspace files. */
export function computeEditAccuracy(task: EvalTask, workspace: string): number {
  const refs = task.referencePatterns ?? [];
  if (refs.length === 0) return 0; // no reference — no credit (conservative)
  let matched = 0;
  let total = 0;
  for (const ref of refs) {
    const abs = join(workspace, ref.file);
    if (!existsSync(abs)) {
      total += ref.mustContain.length + (ref.mustNotContain?.length ?? 0);
      continue;
    }
    const content = readFileSync(abs, 'utf-8');
    for (const pattern of ref.mustContain) {
      total += 1;
      if (content.includes(pattern)) matched += 1;
    }
    for (const anti of ref.mustNotContain ?? []) {
      total += 1;
      if (!content.includes(anti)) matched += 1;
    }
  }
  return total === 0 ? 0 : matched / total;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/** Options for runEvalSuite */
export interface RunEvalOptions {
  /** Only run tasks with these IDs */
  taskIds?: string[];
  /** Only run tasks matching this time estimate */
  timeEstimate?: 'quick' | 'medium' | 'slow';
  /** Maximum cost in USD before stopping */
  budget?: number;
  /** Progress callback */
  onProgress?: (current: number, total: number, task: EvalTask) => void;
  /** Config manager (for provider config) */
  configManager?: ConfigManager;
  /** Keep temp workspaces after the run (debugging) */
  keepWorkspaces?: boolean;
  /** Injectable goal executor — used by tests to stub the orchestrator */
  executeGoal?: (goal: string, workspace: string) => Promise<OrchestrationResult>;
}

/**
 * Run a single eval task through the full agent pipeline.
 */
export async function runEvalTask(
  task: EvalTask,
  _provider: InferenceProvider,
  providerName: string,
  model: string,
  options: RunEvalOptions = {},
): Promise<EvalResult> {
  const workspace = scaffoldWorkspace(task);
  const taskStart = Date.now();
  const timeoutMs = task.timeoutMs ?? 600_000;
  let result: OrchestrationResult;
  let crashed = false;
  let crashError: string | undefined;

  try {
    if (options.executeGoal) {
      result = await options.executeGoal(task.goal, workspace);
    } else {
      // Run the full pipeline in the workspace (chdir for the orchestrator,
      // which resolves relative paths against process.cwd()).
      const cwd = process.cwd();
      process.chdir(workspace);
      try {
        const orchestrator = new Orchestrator(options.configManager);
        result = await Promise.race([
          orchestrator.execute(task.goal, { provider: providerName, model, useMemory: false }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs / 1000}s`)), timeoutMs),
          ),
        ]);
      } finally {
        process.chdir(cwd);
      }
    }
  } catch (err) {
    crashed = true;
    crashError = err instanceof Error ? err.message : String(err);
    result = {
      success: false,
      goal: task.goal,
      summary: `Pipeline crashed: ${crashError}`,
      tasksCompleted: 0,
      tasksTotal: 0,
      agentResults: [],
      fileChanges: '',
      error: crashError,
    };
  }

  // ── Run hidden tests after the pipeline ─────────────────────────────
  let testsPassed = 0;
  let firstGreenAt: number | null = null;
  let testRunCount = 0;
  const perTestResults = task.hiddenTests.map((test) => {
    testRunCount += 1;
    const { exitCode, durationMs } = runHiddenTest(workspace, test.command);
    const passed = exitCode === (test.expectExitCode ?? 0);
    if (passed) {
      testsPassed += 1;
      if (firstGreenAt === null) firstGreenAt = Date.now() - taskStart;
    }
    return { command: test.command, passed, durationMs };
  });

  const stats = result.stats;
  const testPassed = testsPassed === task.hiddenTests.length && task.hiddenTests.length > 0;
  const elapsedMs = Date.now() - taskStart;
  const editAccuracy = computeEditAccuracy(task, workspace);
  const totalTokens = (stats?.inputTokens ?? 0) + (stats?.outputTokens ?? 0);
  const tokenEfficiency = totalTokens > 0
    ? clamp01(task.tokenBudget / totalTokens)
    : 0;

  const metrics: EvalMetrics = {
    completed: result.success,
    testPassed,
    testPassRate: task.hiddenTests.length > 0 ? testsPassed / task.hiddenTests.length : 0,
    timeToFixMs: firstGreenAt ?? (testPassed ? elapsedMs : Number.POSITIVE_INFINITY),
    editAccuracy,
    tokenEfficiency,
    rollbackCount: stats?.rollbackCount ?? 0,
    dependencyInstallAttempted: stats?.dependencyInstallAttempted ?? false,
    dependencyInstallSucceeded: stats?.dependencyInstallSucceeded ?? false,
    recoveryAttempts: stats?.repairAttempts ?? 0,
    alternativeApproaches: stats?.alternativeApproaches ?? 0,
    recovered: (stats?.taskFailures ?? 0) > 0 && (stats?.recoveredFailures ?? 0) > 0,
    attempts: (stats?.llmCalls ?? 0) + 1,
    costUsd: 0,
    latencyMs: elapsedMs,
    error: crashError ?? (result.success ? undefined : result.error),
  };

  // Estimate cost from token usage (reuse the cost-tracker pricing model)
  try {
    const { calculateCost } = await import('./cost-tracker.js');
    metrics.costUsd = calculateCost(
      providerName,
      model,
      stats?.inputTokens ?? 0,
      stats?.outputTokens ?? 0,
    );
  } catch {
    // cost estimation is best-effort
  }

  if (!options.keepWorkspaces) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return {
    taskId: task.id,
    provider: providerName,
    model,
    metrics,
    compositeScore: scoreEvalMetrics(metrics),
    summary: result.summary || result.error || 'No summary',
    timestamp: Date.now(),
  };
}

/**
 * Run the full evaluation suite against a provider/model.
 */
export async function runEvalSuite(
  provider: InferenceProvider,
  providerName: string,
  model: string,
  options: RunEvalOptions = {},
): Promise<EvalRun> {
  // Filter tasks
  let tasks = [...EVAL_TASKS];
  if (options.taskIds && options.taskIds.length > 0) {
    tasks = tasks.filter((t) => options.taskIds!.includes(t.id));
  }
  if (options.timeEstimate) {
    tasks = tasks.filter((t) => t.timeEstimate === options.timeEstimate);
  }

  const runId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const results: EvalResult[] = [];
  let totalCost = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (options.budget && totalCost >= options.budget) {
      logger.info(`Budget of $${options.budget.toFixed(2)} reached. Stopping evaluation.`);
      break;
    }
    options.onProgress?.(i + 1, tasks.length, task);
    const res = await runEvalTask(task, provider, providerName, model, options);
    totalCost += res.metrics.costUsd;
    results.push(res);
  }

  const endedAt = Date.now();
  const run: EvalRun = {
    id: runId,
    provider: providerName,
    model,
    startedAt,
    endedAt,
    results,
    summary: computeEvalSummary(results),
  };

  // Persist
  const data = readEvalData();
  data.runs.push(run);
  if (data.runs.length > MAX_EVAL_RUNS) {
    data.runs = data.runs.slice(-MAX_EVAL_RUNS);
  }
  writeEvalData(data);

  return run;
}

/** Compute the aggregate summary from a list of eval results. */
export function computeEvalSummary(results: EvalResult[]): EvalSummary {
  if (results.length === 0) {
    return {
      totalTasks: 0,
      tasksPassed: 0,
      completionRate: 0,
      testPassRate: 0,
      avgTimeToFixMs: 0,
      avgEditAccuracy: 0,
      avgTokenEfficiency: 0,
      totalRollbacks: 0,
      dependencyInstallRate: 0,
      recoveryRate: 0,
      avgCompositeScore: 0,
      totalCostUsd: 0,
    };
  }

  const passed = results.filter((r) => r.metrics.testPassed);
  const completed = results.filter((r) => r.metrics.completed);
  const depAttempted = results.filter((r) => r.metrics.dependencyInstallAttempted);
  const depSucceeded = depAttempted.filter((r) => r.metrics.dependencyInstallSucceeded);
  const hadFailures = results.filter((r) => r.metrics.recoveryAttempts > 0 || !r.metrics.completed);
  const recovered = results.filter((r) => r.metrics.recovered);
  const finiteFixTimes = passed
    .map((r) => r.metrics.timeToFixMs)
    .filter((t) => isFinite(t));

  return {
    totalTasks: results.length,
    tasksPassed: passed.length,
    completionRate: completed.length / results.length,
    testPassRate: passed.length / results.length,
    avgTimeToFixMs: finiteFixTimes.length > 0
      ? finiteFixTimes.reduce((a, b) => a + b, 0) / finiteFixTimes.length
      : 0,
    avgEditAccuracy: results.reduce((a, r) => a + r.metrics.editAccuracy, 0) / results.length,
    avgTokenEfficiency: results.reduce((a, r) => a + r.metrics.tokenEfficiency, 0) / results.length,
    totalRollbacks: results.reduce((a, r) => a + r.metrics.rollbackCount, 0),
    dependencyInstallRate: depAttempted.length > 0 ? depSucceeded.length / depAttempted.length : 0,
    recoveryRate: hadFailures.length > 0 ? recovered.length / hadFailures.length : 1,
    avgCompositeScore: results.reduce((a, r) => a + r.compositeScore, 0) / results.length,
    totalCostUsd: results.reduce((a, r) => a + r.metrics.costUsd, 0),
  };
}

// ─── Report Formatting ──────────────────────────────────────────────────────

/** Format an eval run as a human-readable text report. */
export function formatEvalReport(run: EvalRun): string {
  const s = run.summary;
  const lines: string[] = [];
  const elapsed = ((run.endedAt - run.startedAt) / 1000).toFixed(1);

  lines.push('═'.repeat(64));
  lines.push(`  🎯  Evaluation Results: ${run.provider}/${run.model}`);
  lines.push('═'.repeat(64));
  lines.push('');
  lines.push(`  Run ID: ${run.id}`);
  lines.push(`  Duration: ${elapsed}s`);
  lines.push(`  Composite score: ${(s.avgCompositeScore * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('  ── Reliability Metrics ──');
  lines.push(`  ✅ Task completion rate:  ${(s.completionRate * 100).toFixed(0)}%`);
  lines.push(`  🧪 Test pass rate:        ${(s.testPassRate * 100).toFixed(0)}%  (${s.tasksPassed}/${s.totalTasks})`);
  lines.push(`  ⏱️  Avg time-to-fix:       ${s.avgTimeToFixMs > 0 ? (s.avgTimeToFixMs / 1000).toFixed(1) + 's' : 'n/a'}`);
  lines.push(`  ✏️  Edit accuracy:         ${(s.avgEditAccuracy * 100).toFixed(0)}%`);
  lines.push(`  ⚡ Token efficiency:      ${(s.avgTokenEfficiency * 100).toFixed(0)}%`);
  lines.push(`  ↩️  Rollbacks:             ${s.totalRollbacks}`);
  lines.push(`  📦 Dependency install:    ${(s.dependencyInstallRate * 100).toFixed(0)}% success`);
  lines.push(`  💡 Recovery rate:         ${(s.recoveryRate * 100).toFixed(0)}%  (tried new approaches)`);
  lines.push(`  💰 Total cost:            $${s.totalCostUsd.toFixed(6)}`);
  lines.push('');
  lines.push('  ── Per-Task Results ──');
  lines.push(`  ${'─'.repeat(62)}`);
  lines.push(`  ${'Task'.padEnd(26)} ${'Status'.padEnd(9)} ${'Score'.padEnd(8)} ${'FixTime'.padEnd(9)} ${'Deps'.padEnd(6)} ${'NewIdeas'}`);
  lines.push(`  ${'─'.repeat(62)}`);
  for (const r of run.results) {
    const status = r.metrics.testPassed ? '✅' : '❌';
    const score = `${(r.compositeScore * 100).toFixed(0)}%`;
    const fix = isFinite(r.metrics.timeToFixMs)
      ? `${(r.metrics.timeToFixMs / 1000).toFixed(1)}s`
      : 'never';
    const deps = r.metrics.dependencyInstallAttempted
      ? (r.metrics.dependencyInstallSucceeded ? '✓' : '✗')
      : '—';
    const ideas = r.metrics.alternativeApproaches > 0 ? `${r.metrics.alternativeApproaches}x` : '—';
    lines.push(`  ${r.taskId.padEnd(26)} ${status.padEnd(9)} ${score.padEnd(8)} ${fix.padEnd(9)} ${deps.padEnd(6)} ${ideas}`);
  }
  lines.push(`  ${'─'.repeat(62)}`);
  lines.push('');
  return lines.join('\n');
}

/** Format an eval run as JSON. */
export function formatEvalJSON(run: EvalRun): string {
  return JSON.stringify(run, null, 2);
}

/** Format an eval run as Markdown. */
export function formatEvalMarkdown(run: EvalRun): string {
  const s = run.summary;
  const lines: string[] = [
    `# Agent-Nuvira Evaluation: ${run.provider}/${run.model}`,
    '',
    `- **Run ID:** ${run.id}`,
    `- **Duration:** ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`,
    `- **Composite score:** ${(s.avgCompositeScore * 100).toFixed(1)}%`,
    '',
    '## Reliability Metrics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Task completion rate | ${(s.completionRate * 100).toFixed(0)}% |`,
    `| Test pass rate | ${(s.testPassRate * 100).toFixed(0)}% (${s.tasksPassed}/${s.totalTasks}) |`,
    `| Avg time-to-fix | ${s.avgTimeToFixMs > 0 ? (s.avgTimeToFixMs / 1000).toFixed(1) + 's' : 'n/a'} |`,
    `| Edit accuracy | ${(s.avgEditAccuracy * 100).toFixed(0)}% |`,
    `| Token efficiency | ${(s.avgTokenEfficiency * 100).toFixed(0)}% |`,
    `| Rollbacks | ${s.totalRollbacks} |`,
    `| Dependency install success | ${(s.dependencyInstallRate * 100).toFixed(0)}% |`,
    `| Recovery rate (new approaches) | ${(s.recoveryRate * 100).toFixed(0)}% |`,
    `| Total cost | $${s.totalCostUsd.toFixed(6)} |`,
    '',
    '## Per-Task Results',
    '',
    '| Task | Status | Score | Time-to-fix | Deps | New ideas |',
    '|------|--------|-------|-------------|------|-----------|',
  ];
  for (const r of run.results) {
    const status = r.metrics.testPassed ? '✅ Pass' : '❌ Fail';
    const fix = isFinite(r.metrics.timeToFixMs)
      ? `${(r.metrics.timeToFixMs / 1000).toFixed(1)}s`
      : 'never';
    const deps = r.metrics.dependencyInstallAttempted
      ? (r.metrics.dependencyInstallSucceeded ? '✓' : '✗')
      : '—';
    const ideas = r.metrics.alternativeApproaches > 0 ? `${r.metrics.alternativeApproaches}x` : '—';
    lines.push(`| ${r.taskId} | ${status} | ${(r.compositeScore * 100).toFixed(0)}% | ${fix} | ${deps} | ${ideas} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Describe the scoring rules for the `buff eval score` command. */
export function formatEvalScoreRules(): string {
  const lines: string[] = [
    '🎯  Evaluation Scoring Rules',
    '═'.repeat(60),
    '',
    'Each task is graded 0-1 (composite), weighted across 8 metrics:',
    '',
    `  ${(EVAL_SCORE_WEIGHTS.testPass * 100).toFixed(0).padStart(3)}%  🧪 Test pass rate        — hidden tests pass after execution`,
    `  ${(EVAL_SCORE_WEIGHTS.completion * 100).toFixed(0).padStart(3)}%  ✅ Task completion      — pipeline finished with no failed tasks`,
    `  ${(EVAL_SCORE_WEIGHTS.editAccuracy * 100).toFixed(0).padStart(3)}%  ✏️  Edit accuracy         — final files match reference patterns`,
    `  ${(EVAL_SCORE_WEIGHTS.tokenEfficiency * 100).toFixed(0).padStart(3)}%  ⚡ Token efficiency      — token budget vs. actual tokens used`,
    `  ${(EVAL_SCORE_WEIGHTS.timeToFix * 100).toFixed(0).padStart(3)}%  ⏱️  Time-to-fix           — speed to first green run (ideal: 2 min)`,
    `  ${(EVAL_SCORE_WEIGHTS.recovery * 100).toFixed(0).padStart(3)}%  💡 Recovery / new ideas  — tried alternative approaches & recovered`,
    `  ${(EVAL_SCORE_WEIGHTS.rollbackPenalty * 100).toFixed(0).padStart(3)}%  ↩️  Low rollback freq     — each file revert costs 25% of this component`,
    '',
    'Recovery scoring:',
    '  - Full credit (1.0): task failed initially but recovered via repair.',
    '  - Partial credit (0.5): repair attempts were made even if the task failed.',
    '  - No credit (0): no repair attempts at all.',
    '',
    'Time-to-fix scoring:',
    `  - score = ${IDEAL_TIME_TO_FIX_MS / 1000}s / actual time (capped at 1).`,
    '  - 0 if the tests never passed.',
    '',
  ];
  return lines.join('\n');
}

// ─── Query Functions ────────────────────────────────────────────────────────

/** Get all available eval tasks. */
export function getEvalTasks(): EvalTask[] {
  return [...EVAL_TASKS];
}

/** Get a specific eval task by ID. */
export function getEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((t) => t.id === id);
}

/** Get all past eval runs (most recent first). */
export function getEvalRuns(): EvalRun[] {
  const data = readEvalData();
  return [...data.runs].reverse();
}

/** Get the most recent eval run for a provider/model. */
export function getLatestEvalRun(provider: string, model: string): EvalRun | null {
  const data = readEvalData();
  const runs = data.runs
    .filter((r) => r.provider === provider && r.model === model)
    .sort((a, b) => b.startedAt - a.startedAt);
  return runs[0] || null;
}

/** Clear all eval data. */
export function clearEvals(): void {
  writeEvalData({ runs: [], version: CURRENT_VERSION });
}
