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
 *   nuvira eval run                        — Run all eval tasks against default provider
 *   nuvira eval run --provider groq        — Run against a specific provider
 *   nuvira eval run --tasks js-fizzbuzz    — Run specific tasks
 *   nuvira eval list                       — List available eval tasks
 *   nuvira eval results                    — Show previous eval runs
 *   nuvira eval score                      — Show the scoring rules
 *
 * Results stored in: ~/.nuvira/memory/evals.json
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execSync } from 'node:child_process';

import type { InferenceProvider } from '../inference/interface.js';
import { ConfigManager } from '../config/manager.js';
import { getQuotaLedger } from './quota-ledger.js';
import { Orchestrator, type OrchestrationResult } from '../agents/orchestrator.js';
import { classifyFallbackError } from './provider-fallback.js';
import { logger } from '../utils/logger.js';

// ─── M2b Benchmark Suite ────────────────────────────────────────────────────

/**
 * M2b curated task IDs — the experience-parity benchmark suite that measures
 * agent-nuvira against the reference agents on the axes users actually feel:
 * completion rate, stuck states, rework turns, and time-to-done.
 *
 * Run with: `nuvira eval run --suite m2b`
 *
 * The suite includes:
 * - Bug-fix tasks (easy): measure quick-turnaround repair
 * - Feature tasks (easy/medium): measure greenfield creation
 * - Refactor tasks (medium): measure code understanding
 * - Continuation tasks (medium): measure session continuity (the Request
 *   Contract's visible understanding + follow-up recommendations)
 * - Project-analysis tasks (hard): measure cross-file reasoning
 */
export const M2B_TASK_IDS: string[] = [
  'js-fizzbuzz-fix',
  'js-closure-fix',
  'js-queue',
  'js-anagram',
  'js-refactor-async',
  'py-fibonacci',
  'dep-local-module',
  'js-continuation',
  'py-multi-file',
  'py-nvda-addon',
];



/** Get the M2b curated task suite. */
export function getM2bTasks(): EvalTask[] {
  return EVAL_TASKS.filter((t) => M2B_TASK_IDS.includes(t.id));
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Category of an evaluation task */
export type EvalCategory =
  | 'bug-fix'
  | 'feature'
  | 'refactor'
  | 'test-writing'
  | 'dependency-setup'
  | 'algorithm'
  /**
   * Assessment Addendum v4 Phase 0: non-coding tasks (research-and-summarize,
   * image-gen composition, gateway delivery) — the assessment proved these
   * are loop-only (the pipeline's writer cannot call tools), so the eval set
   * must include them to measure the loop's EXPANDED reach, not just parity.
   */
  | 'non-coding';

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
  /**
   * Assessment Addendum v4 Phase 0: tasks tagged loop-only (non-coding) are
   * EXPECTED to fail on the pipeline arm — arm-comparison treats their
   * pipeline-arm failure as the baseline, not a regression signal.
   */
  loopOnly?: boolean;
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
  /** Total input+output tokens consumed by this task (Session 37 — pacing). */
  totalTokens: number;
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
  // ── Assessment Addendum v4 Phase 0 arm-comparison metrics ──────────────
  /** Which engine arm produced this result ('pipeline' | 'loop' | 'writer-tc'). */
  engine?: 'pipeline' | 'loop' | 'writer-tc';
  /** Tool calls executed (loop arm: from runToolLoop telemetry; pipeline: 0). */
  toolCallCount?: number;
  /** Tools that errored (repair-engine-invocation proxy on the loop arm). */
  erroredToolCount?: number;
  /** Per-turn tool-schema character size (the v3 tiering metric). */
  toolSchemaChars?: number;
  /** Loop hit its step bound before an end turn (bounded-ness signal). */
  bounded?: boolean;
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

  // ── Continuation: multi-step task with follow-up ───────────────────────
  {
    id: 'js-continuation',
    title: 'Add Validation + Tests (Continuation)',
    category: 'feature',
    difficulty: 'medium',
    goal: 'Add input validation to `processOrder(order)` in order.js so that empty string items, negative quantities, and missing fields are rejected with a clear error message. Then add comprehensive tests to test.js. The function signature must not change. Verify by running the tests.',
    setupFiles: [
      {
        path: 'order.js',
        content: [
          '// Accepts an order object with items array (each item has name, qty, price)',
          'function processOrder(order) {',
          '  // No validation currently — just sums prices',
          '  return order.items.reduce((total, item) => total + (item.qty || 0) * (item.price || 0), 0);',
          '}',
          'module.exports = { processOrder };',
          '',
        ].join('\n'),
      },
      {
        path: 'test.js',
        content: [
          '// TODO: add tests for processOrder',
          'const assert = require("assert");',
          'const { processOrder } = require("./order");',
          '',
          '// Basic case (should work)',
          'const result = processOrder({"items":[{"name":"widget","qty":2,"price":10}]});',
          'assert.strictEqual(result, 20);',
          'console.log("BASIC TEST PASSED");',
          '',
        ].join('\n'),
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'order-task',
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
        file: 'order.js',
        mustContain: ['throw', 'error', 'valid'],
        mustNotContain: ['TODO'],
      },
    ],
    tokenBudget: 8000,
    timeEstimate: 'medium',
    timeoutMs: 300_000,
  },

  // ── Multi-file: Python data pipeline ────────────────────────────────────
  {
    id: 'py-multi-file',
    title: 'Implement Multi-File Data Pipeline',
    category: 'feature',
    difficulty: 'hard',
    goal: 'Implement a simple data pipeline in Python. Create `pipeline.py` with `read_csv(path)`, `filter_rows(data, column, min_val)`, and `summarize(data)` functions. Create `config.py` with a `PipelineConfig` class that stores a source path and column name. The pipeline should read CSV lines, filter rows where the given column\'s numeric value ≥ min_val, and return a summary dict with count and total. Then edit `main.py` to use PipelineConfig and run the pipeline. Verify by running the tests.',
    setupFiles: [
      {
        path: 'pipeline.py',
        content: [
          'def read_csv(path):',
          '    # TODO: implement',
          '    return []',
          '',
          'def filter_rows(data, column, min_val):',
          '    # TODO: implement',
          '    return []',
          '',
          'def summarize(data):',
          '    # TODO: implement',
          '    return {}',
          '',
        ].join('\n'),
      },
      {
        path: 'config.py',
        content: [
          '# TODO: implement PipelineConfig class',
          'class PipelineConfig:',
          '    pass',
          '',
        ].join('\n'),
      },
      {
        path: 'main.py',
        content: [
          '# TODO: import and run the pipeline',
          'def run():',
          '    # Implement using PipelineConfig and pipeline functions',
          '    pass',
          '',
          'if __name__ == "__main__":',
          '    run()',
          '',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'test_pipeline.py',
        command: 'python3 test_pipeline.py',
      },
    ],
    referencePatterns: [
      {
        file: 'pipeline.py',
        mustContain: ['def read_csv', 'def filter_rows', 'def summarize'],
      },
      {
        file: 'config.py',
        mustContain: ['class PipelineConfig', 'source_path', 'column'],
      },
    ],
    tokenBudget: 10000,
    timeEstimate: 'slow',
    timeoutMs: 360_000,
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

  // ── Feature: NVDA addon (reference-docs injection target) ──────────────
  {
    id: 'py-nvda-addon',
    title: 'Create an NVDA addon with a keyboard shortcut',
    category: 'feature',
    difficulty: 'hard',
    goal: 'Create an NVDA addon compatible with NVDA 2026.1. When the user presses NVDA+Alt+1 the addon should speak "Hello Ria Mote". The addon source tree must contain a manifest.ini at its root and a globalPlugins/ module. Use the real NVDA APIs (globalPluginHandler, scriptHandler, addonHandler, ui).',
    setupFiles: [
      {
        path: 'README.md',
        content: 'Scratch workspace for an NVDA addon. Create the addon source tree here.',
      },
    ],
    hiddenTests: [
      {
        // Shell-based, self-contained (no template file needed): manifest.ini
        // exists AND a globalPlugins module uses the REAL APIs AND does NOT
        // contain the hallucinated APIs observed in the live NVDA run.
        file: 'verify.sh',
        command: 'test -f manifest.ini && ls globalPlugins/*.py >/dev/null 2>&1 && grep -rl "globalPluginHandler" globalPlugins/*.py >/dev/null && grep -rl "@scriptHandler.script\|scriptHandler.script" globalPlugins/*.py >/dev/null && grep -rq "ui.message" globalPlugins/*.py && grep -q "kb:NVDA+alt+1\|kb:nvda+alt+1" globalPlugins/*.py && ! grep -rq "register_key_handler\|from nvda import" globalPlugins/*.py',
      },
    ],
    referencePatterns: [
      {
        // Directory-based patterns can't be read as files by computeEditAccuracy
        // — the shell hidden test above is the authoritative check; this entry
        // is kept for edit-accuracy scoring on the manifest file only.
        file: 'manifest.ini',
        mustContain: ['[addon]'],
      },
    ],
    tokenBudget: 9000,
    timeEstimate: 'slow',
    timeoutMs: 300_000,
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
  'js-continuation': [
    'const assert = require("assert");',
    'const { processOrder } = require("./order");',
    '',
    '// Validation tests — all should throw or return 0 with bad input',
    'assert.throws(() => processOrder({ items: [{ name: "", qty: 1, price: 10 }] }), /error/i);',
    'assert.throws(() => processOrder({ items: [{ name: "x", qty: -1, price: 10 }] }), /error/i);',
    'assert.throws(() => processOrder({}), /error/i);',
    'assert.throws(() => processOrder(null), /error/i);',
    'console.log("VALIDATION TESTS PASSED");',
    '',
  ].join('\n'),
  'py-multi-file': [
    'from pipeline import read_csv, filter_rows, summarize',
    'from config import PipelineConfig',
    '',
    '# Test 1: pipeline functions exist and handle missing file gracefully',
    'try:',
    '    data = read_csv("nonexistent.csv")',
    '    assert isinstance(data, list)',
    'except FileNotFoundError:',
    '    pass',
    '',
    '# Test 2: PipelineConfig has required attributes',
    'config = PipelineConfig("data.csv", "sales")',
    'assert hasattr(config, \'source_path\'), "missing source_path"',
    'assert hasattr(config, \'column\'), "missing column"',
    '',
    '# Test 3: filter_rows with sample data',
    'sample = [{"name": "a", "val": "10"}, {"name": "b", "val": "5"}]',
    'filtered = filter_rows(sample, "val", 7)',
    'assert len(filtered) == 1, f"expected 1 filtered row, got {len(filtered)}"',
    'assert filtered[0]["name"] == "a"',
    'print("ALL PIPELINE TESTS PASSED")',
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

// NUVIRA_MEMORY_DIR override keeps test suites out of the real ~/.nuvira store
// (same convention as session-recall.ts / history.ts).
const MEMORY_DIR = envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
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
  /**
   * Session 37 — pace the run under the user-declared DAILY token budget
   * (routing.quota.<provider>.tokensPerWindow, resolved by the CLI): the run
   * stops once paceUsedBefore + this run's tokens reaches paceTokens, so a
   * free-tier TPD cap can't invalidate the measurement mid-run.
   */
  paceTokens?: number;
  /** Tokens this provider already consumed today per the quota ledger. */
  paceUsedBefore?: number;
  /** Progress callback */
  onProgress?: (current: number, total: number, task: EvalTask) => void;
  /** Config manager (for provider config) */
  configManager?: ConfigManager;
  /** Keep temp workspaces after the run (debugging) */
  keepWorkspaces?: boolean;
  /** Injectable goal executor — used by tests to stub the orchestrator */
  executeGoal?: (goal: string, workspace: string) => Promise<OrchestrationResult>;
  /**
   * Assessment Addendum v4 Phase 0 — the engine ARM to run:
   * - 'pipeline' (default): the orchestrator (unchanged behavior).
   * - 'loop': runLoopExecutor (the single agentic loop) — Phase 1.1 arm.
   * - 'writer-tc': the orchestrator with useToolCalling (writer-tc arm).
   * Recorded per result (`metrics.engine`) so `nuvira eval results` and the
   * dashboard can compare arms side-by-side.
   */
  engine?: 'pipeline' | 'loop' | 'writer-tc';
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
  const engine = options.engine ?? 'pipeline';
  let result: OrchestrationResult;
  let crashed = false;
  let crashError: string | undefined;
  // Loop-arm telemetry (zeros on the pipeline arms).
  let toolCallCount = 0;
  let erroredToolCount = 0;
  let bounded = false;

  try {
    if (options.executeGoal) {
      result = await options.executeGoal(task.goal, workspace);
    } else if (engine === 'loop') {
      // ── LOOP ARM (Addendum v4 Phase 1.1/Phase 0) ──
      // One agentic turn over runToolLoop inside the scaffolded workspace —
      // the same engine chat uses, pointed at the eval workspace. Telemetry
      // (tool calls, errored tools, bounded) feeds the arm comparison.
      const cwd = process.cwd();
      process.chdir(workspace);
      try {
        const { runLoopExecutor } = await import('../cli/loop-executor.js');
        const loopResult = await Promise.race([
          runLoopExecutor(task.goal, options.configManager ?? new ConfigManager(), {
            provider: providerName === 'auto' ? undefined : providerName,
            model,
            quiet: true,
            skipProjectContext: true, // the eval workspace IS the project
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task timed out after ${timeoutMs / 1000}s`)), timeoutMs),
          ),
        ]);
        toolCallCount = loopResult.toolCalls.length;
        erroredToolCount = loopResult.erroredTools.length;
        bounded = loopResult.bounded;
        result = {
          success: !loopResult.generationFailed,
          goal: task.goal,
          summary: loopResult.content,
          tasksCompleted: loopResult.generationFailed ? 0 : 1,
          tasksTotal: 1,
          agentResults: [],
          fileChanges: '',
          error: loopResult.generationFailed ? loopResult.content : undefined,
        } as OrchestrationResult;
      } finally {
        process.chdir(cwd);
      }
    } else {
      // ── PIPELINE / WRITER-TC ARMS (unchanged orchestrator path) ──
      // Run the full pipeline in the workspace (chdir for the orchestrator,
      // which resolves relative paths against process.cwd()).
      const cwd = process.cwd();
      process.chdir(workspace);
      try {
        const orchestrator = new Orchestrator(options.configManager);
        result = await Promise.race([
          orchestrator.execute(task.goal, {
            provider: providerName,
            model,
            useMemory: false,
            // writer-tc arm: the iterative tool-calling writer/reviewer path.
            // Passed EXPLICITLY (never undefined): the orchestrator default is
            // now tool-calling ON (audit W3), so `undefined` would silently
            // collapse the 'pipeline' arm into the 'writer-tc' arm and the
            // comparison would measure nothing.
            useToolCalling: engine === 'writer-tc',
          }),
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
    totalTokens,
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
    // Arm-comparison metrics (zeros/undefined on the pipeline arms).
    engine,
    toolCallCount,
    erroredToolCount,
    bounded,
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
  // Filter tasks — plus the non-coding (loop-only) set when the env gate is
  // on (Addendum v4 Phase 0: the eval must PROVE the loop's expanded reach,
  // not assume it; gated so a plain run stays deterministic/offline).
  let tasks = [...EVAL_TASKS, ...getNonCodingEvalTasks()];
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
  let totalTokens = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (options.budget && totalCost >= options.budget) {
      logger.info(`Budget of $${options.budget.toFixed(2)} reached. Stopping evaluation.`);
      break;
    }
    // Session 37 — daily-token pacing (Decision 21): stop BEFORE a task that
    // would cross the user-declared cap, so free-tier TPD exhaustion can't
    // invalidate the measurement mid-run. Note: we can't know a task's token
    // cost until it runs, so a single oversized task may still cross the cap
    // (same limitation as the --budget cost gate) — that's inherent, not a bug.
    if (options.paceTokens !== undefined && (options.paceUsedBefore ?? 0) + totalTokens >= options.paceTokens) {
      logger.warn(`Daily token budget of ${options.paceTokens.toLocaleString()} reached (${((options.paceUsedBefore ?? 0) + totalTokens).toLocaleString()} tokens today). Stopping evaluation — raise it with \`nuvira model quota set ${providerName} --tokens N\` or resume after the window rolls.`);
      break;
    }
    options.onProgress?.(i + 1, tasks.length, task);
    const res = await runEvalTask(task, provider, providerName, model, options);
    totalCost += res.metrics.costUsd;
    totalTokens += res.metrics.totalTokens;
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
/**
 * Session 37 — resolve the `--pace` budget for a provider: the user-declared
 * DAILY cap (routing.quota.<provider>.tokensPerWindow) + tokens this provider
 * already consumed today per the quota ledger (best-effort). Returns
 * `paceTokens: undefined` when no budget is declared (run unpaced).
 */
export function resolvePaceBudget(
  configManager: ConfigManager | undefined,
  providerName: string,
): { paceTokens?: number; usedBefore: number } {
  const limit = configManager?.getAll().routing?.quota?.[providerName];
  const paceTokens = limit?.tokensPerWindow;
  if (paceTokens === undefined) return { paceTokens: undefined, usedBefore: 0 };
  let usedBefore = 0;
  try {
    usedBefore = getQuotaLedger()
      .getStatus(configManager)
      .filter((s) => s.provider === providerName)
      .reduce((sum, s) => sum + (s.tokensConsumed || 0), 0);
  } catch {
    // Best-effort — a ledger read failure must never break a run.
  }
  return { paceTokens, usedBefore };
}

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
  // JSON round-trip turns Infinity (never green) into null — exclude both
  // so a re-rendered persisted run doesn't count null as a 0ms fix.
  const finiteFixTimes = passed
    .map((r) => r.metrics.timeToFixMs)
    .filter((t) => t !== null && isFinite(t));

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

// ─── Experience-Parity Breakdown (M2b) ─────────────────────────────────────

/**
 * Rework turns for one task — repair-engine retries, alternative-approach
 * attempts, and file rollbacks. This is the user-visible "the agent had to
 * try again" count.
 *
 * NOTE: `attempts` (llmCalls + 1) is deliberately NOT counted — the standard
 * multi-agent pipeline (planner → context-gatherer → writer → runner →
 * reviewer) makes ~4-5 LLM calls BY DESIGN, so llmCalls would inflate the
 * metric to ~4x on every smooth task. Only explicit try-again events count.
 */
export function computeReworkTurns(metrics: EvalMetrics): number {
  return (
    metrics.recoveryAttempts +
    metrics.alternativeApproaches +
    metrics.rollbackCount
  );
}

/**
 * A task is user-visible STUCK when it produced NO working outcome (hidden
 * tests not green) AND either the pipeline crashed/timed out (error set) or
 * it thrashed (3+ rework turns without reaching done).
 *
 * A task that PASSED tests is never flagged stuck, even if the pipeline
 * reported a failure — e.g. a transient provider 429 during repair that the
 * reliability stack recovered from: the user got working code, so it is
 * provider interference, not user-visible stuckness. Measured from the run's
 * own data — never agent-declared done.
 *
 * Session 44 — a task whose TERMINAL failure is provider infrastructure
 * (rate-limit / server / network, e.g. a free-tier 429 that opened the circuit
 * breaker) is also NOT stuck: the pipeline never got a chance to do the work
 * (attempts=1 in the S44 run), so the failure is interference, not agent
 * stuckness. Such tasks are surfaced separately on the 'Provider
 * interference' report line instead of inflating the stuck count. Design
 * decision: even when rework turns accumulated before the provider gave out,
 * the terminal cause is infra — the rework was spent retrying a throttled
 * provider, so interference wins by design (documented in tracker S45).
 */
export function computeStuckStates(results: EvalResult[]): EvalResult[] {
  return results.filter(
    (r) =>
      !r.metrics.testPassed &&
      // Derive interference from the error text (not the stored flag) so
      // persisted runs from BEFORE Session 44 also get the corrected count
      // when re-analyzed.
      !isProviderInterferenceError(r.metrics.error) &&
      (r.metrics.error !== undefined || computeReworkTurns(r.metrics) >= 3),
  );
}

/**
 * True when a terminal error string is provider infrastructure failure
 * (rate-limit / server / network) rather than agent stuckness. Reuses the
 * canonical `classifyFallbackError` classifier — a 429/500/network failure
 * means the provider throttled or dropped the request, not that the agent
 * spun without progress. Auth is NOT interference (wrong key is a config
 * problem, and would recur on every provider), and timeout is NOT
 * interference (a slow agent is still the agent's problem).
 */
export function isProviderInterferenceError(error: string | undefined): boolean {
  if (!error) return false;
  const type = classifyFallbackError(new Error(error));
  return type === 'rate-limit' || type === 'server' || type === 'network';
}

/**
 * Compare two eval runs side by side across the M2b experience-parity axes —
 * the Part 1.9 gate: after a phase lands, re-run the suite and confirm a
 * metric moved. Composite / test-pass / completion are HIGHER-better;
 * stuck / rework / time / cost are LOWER-better. Mirrors compareBenchmarks().
 */
export function compareEvalRuns(runA: EvalRun, runB: EvalRun): string {
  const aModel = `${runA.model}`.slice(0, 22).padEnd(22);
  const bModel = `${runB.model}`.slice(0, 22).padEnd(22);
  const higher = (a: number, b: number): string =>
    a === b ? 'tie' : a > b ? `← ${runA.model}` : `${runB.model} →`;
  const lower = (a: number, b: number): string =>
    a === b ? 'tie' : a < b ? `← ${runA.model}` : `${runB.model} →`;

  const a = runA.summary;
  const b = runB.summary;
  const stuckA = computeStuckStates(runA.results).map((r) => r.taskId);
  const stuckB = computeStuckStates(runB.results).map((r) => r.taskId);
  const reworkA = runA.results.reduce((s, r) => s + computeReworkTurns(r.metrics), 0);
  const reworkB = runB.results.reduce((s, r) => s + computeReworkTurns(r.metrics), 0);
  const perTask = (n: number, total: number): string =>
    n === 0 ? '0' : `${n}${total > 0 ? ` (${(n / total).toFixed(1)}/task)` : ''}`;
  const stuckText = (ids: string[]): string => {
    if (ids.length === 0) return '0';
    const joined = ids.join(', ');
    return `${ids.length}${joined.length > 48 ? ` (${joined.slice(0, 48)}…)` : ` (${joined})`}`;
  };
  const durA = ((runA.endedAt - runA.startedAt) / 1000).toFixed(1) + 's';
  const durB = ((runB.endedAt - runB.startedAt) / 1000).toFixed(1) + 's';
  const fixA = a.avgTimeToFixMs > 0 ? (a.avgTimeToFixMs / 1000).toFixed(1) + 's' : 'n/a';
  const fixB = b.avgTimeToFixMs > 0 ? (b.avgTimeToFixMs / 1000).toFixed(1) + 's' : 'n/a';

  const rows: Array<[string, string, string, string]> = [
    ['Composite score', `${(a.avgCompositeScore * 100).toFixed(1)}%`, `${(b.avgCompositeScore * 100).toFixed(1)}%`, higher(a.avgCompositeScore, b.avgCompositeScore)],
    ['Test pass rate', `${(a.testPassRate * 100).toFixed(0)}% (${a.tasksPassed}/${a.totalTasks})`, `${(b.testPassRate * 100).toFixed(0)}% (${b.tasksPassed}/${b.totalTasks})`, higher(a.testPassRate, b.testPassRate)],
    ['Completion rate', `${(a.completionRate * 100).toFixed(0)}%`, `${(b.completionRate * 100).toFixed(0)}%`, higher(a.completionRate, b.completionRate)],
    ['Stuck states', stuckText(stuckA), stuckText(stuckB), lower(stuckA.length, stuckB.length)],
    ['Rework turns', perTask(reworkA, a.totalTasks), perTask(reworkB, b.totalTasks), lower(reworkA, reworkB)],
    ['Time-to-done', durA, durB, lower(runA.endedAt - runA.startedAt, runB.endedAt - runB.startedAt)],
    // n/a (no passing task → avg 0) must never WIN the lower-better axis.
    ['Avg time-to-fix', fixA, fixB, lower(a.avgTimeToFixMs > 0 ? a.avgTimeToFixMs : Number.POSITIVE_INFINITY, b.avgTimeToFixMs > 0 ? b.avgTimeToFixMs : Number.POSITIVE_INFINITY)],
    ['Total cost', `$${a.totalCostUsd.toFixed(4)}`, `$${b.totalCostUsd.toFixed(4)}`, lower(a.totalCostUsd, b.totalCostUsd)],
  ];

  const lines: string[] = [
    '═'.repeat(64),
    `  ⚔️  Eval Comparison: ${runA.provider}/${runA.model} vs ${runB.provider}/${runB.model}`,
    '═'.repeat(64),
    '',
    `  ${'Metric'.padEnd(24)} ${aModel} ${bModel} Winner`,
    `  ${'─'.repeat(72)}`,
  ];
  for (const [metric, va, vb, w] of rows) {
    lines.push(`  ${metric.padEnd(24)} ${va.padEnd(22)} ${vb.padEnd(22)} ${w}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Pick the two runs to compare for the Part 1.9 gate: the newest run, then the
 * most recent run with the SAME provider+model (so a phase's metric movement
 * is never confounded by a model/provider switch), falling back to the previous
 * run. Assumes newest-first ordering (as returned by getEvalRuns()).
 */
export function selectCompareRuns(runs: EvalRun[]): [EvalRun, EvalRun] | null {
  if (runs.length < 2) return null;
  const newest = runs[0];
  const sameSetup = runs
    .slice(1)
    .find((r) => r.provider === newest.provider && r.model === newest.model);
  return [newest, sameSetup ?? runs[1]];
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
  // Addendum v4 Phase 0 — which engine arm(s) produced these results
  // ('pipeline' | 'loop' | 'writer-tc'); results persisted before the arm
  // split have no engine stamp and are shown as the default 'pipeline'.
  const arms = [...new Set(run.results.map((r) => r.metrics.engine ?? 'pipeline'))];
  lines.push(`  Engine: ${arms.join(' + ')}`);
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
  const stuckIds = new Set(computeStuckStates(run.results).map((r) => r.taskId));
  const totalRework = run.results.reduce((a, r) => a + computeReworkTurns(r.metrics), 0);
  lines.push(`  🔁 Rework turns:         ${totalRework} total  (${run.results.length > 0 ? (totalRework / run.results.length).toFixed(1) : '0.0'}/task)`);
  lines.push(`  🚧 Stuck states:         ${stuckIds.size}  ${stuckIds.size > 0 ? '(' + [...stuckIds].join(', ') + ')' : ''}`);
  // Derive from the error text so persisted runs saved before Session 44 also
  // show the corrected interference breakdown. Only non-passing tasks are
  // listed — a task that PASSED despite touching a 429 is a success, not
  // interference worth flagging next to 'Stuck states'.
  const interferenceIds = run.results
    .filter((r) => !r.metrics.testPassed && isProviderInterferenceError(r.metrics.error))
    .map((r) => r.taskId);
  lines.push(`  🌩️ Provider interference: ${interferenceIds.length}  ${interferenceIds.length > 0 ? '(' + interferenceIds.join(', ') + ')' : ''}  — not agent stuckness (429/5xx/network)`);
  lines.push(`  💰 Total cost:            $${s.totalCostUsd.toFixed(6)}`);
  lines.push('');
  lines.push('  ── Per-Task Results ──');
  lines.push(`  ${'─'.repeat(74)}`);
  lines.push(`  ${'Task'.padEnd(26)} ${'Status'.padEnd(9)} ${'Score'.padEnd(8)} ${'FixTime'.padEnd(9)} ${'Deps'.padEnd(6)} ${'Rework'.padEnd(8)} ${'NewIdeas'.padEnd(9)} ${'Engine'.padEnd(9)} Stuck`);
  lines.push(`  ${'─'.repeat(84)}`);
  for (const r of run.results) {
    const status = r.metrics.testPassed ? '✅' : '❌';
    const score = `${(r.compositeScore * 100).toFixed(0)}%`;
    const fix = r.metrics.timeToFixMs !== null && isFinite(r.metrics.timeToFixMs)
      ? `${(r.metrics.timeToFixMs / 1000).toFixed(1)}s`
      : 'never';
    const deps = r.metrics.dependencyInstallAttempted
      ? (r.metrics.dependencyInstallSucceeded ? '✓' : '✗')
      : '—';
    const rework = computeReworkTurns(r.metrics) > 0 ? `${computeReworkTurns(r.metrics)}x` : '—';
    const ideas = r.metrics.alternativeApproaches > 0 ? `${r.metrics.alternativeApproaches}x` : '—';
    const engine = (r.metrics.engine ?? 'pipeline').padEnd(9);
    const stuckMark = stuckIds.has(r.taskId) ? '🚧' : '—';
    lines.push(`  ${r.taskId.padEnd(26)} ${status.padEnd(9)} ${score.padEnd(8)} ${fix.padEnd(9)} ${deps.padEnd(6)} ${rework.padEnd(8)} ${ideas.padEnd(9)} ${engine} ${stuckMark}`);
  }
  lines.push(`  ${'─'.repeat(84)}`);
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
    '| Task | Status | Score | Time-to-fix | Deps | New ideas | Rework | Stuck |',
    '|------|--------|-------|-------------|------|-----------|--------|-------|',
  ];
  const stuckIds = new Set(computeStuckStates(run.results).map((r) => r.taskId));
  for (const r of run.results) {
    const status = r.metrics.testPassed ? '✅ Pass' : '❌ Fail';
    const fix = r.metrics.timeToFixMs !== null && isFinite(r.metrics.timeToFixMs)
      ? `${(r.metrics.timeToFixMs / 1000).toFixed(1)}s`
      : 'never';
    const deps = r.metrics.dependencyInstallAttempted
      ? (r.metrics.dependencyInstallSucceeded ? '✓' : '✗')
      : '—';
    const rework = computeReworkTurns(r.metrics) > 0 ? `${computeReworkTurns(r.metrics)}` : '—';
    const ideas = r.metrics.alternativeApproaches > 0 ? `${r.metrics.alternativeApproaches}x` : '—';
    const stuckMark = stuckIds.has(r.taskId) ? '🚧' : '—';
    lines.push(`| ${r.taskId} | ${status} | ${(r.compositeScore * 100).toFixed(0)}% | ${fix} | ${deps} | ${ideas} | ${rework} | ${stuckMark} |`);
  }
  const totalRework = run.results.reduce((a, r) => a + computeReworkTurns(r.metrics), 0);
  lines.push('');
  lines.push('## Experience Parity (stuck / rework)');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total rework turns | ${totalRework} |`);
  lines.push(`| Avg rework turns / task | ${run.results.length > 0 ? (totalRework / run.results.length).toFixed(1) : '0.0'} |`);
  lines.push(`| Stuck states | ${stuckIds.size}${stuckIds.size > 0 ? ' (' + [...stuckIds].join(', ') + ')' : ''} |`);
  const interferenceIds = run.results
    .filter((r) => !r.metrics.testPassed && isProviderInterferenceError(r.metrics.error))
    .map((r) => r.taskId);
  lines.push(`| Provider interference (429/5xx/network — not stuck) | ${interferenceIds.length}${interferenceIds.length > 0 ? ' (' + interferenceIds.join(', ') + ')' : ''} |`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write an M2b benchmark report to docs/benchmarks/.
 * Creates the directory if it doesn't exist. The report uses the same markdown
 * format as formatEvalMarkdown but prefixed with metadata for the benchmark
 * index, and includes a per-task stuck/rework breakdown.
 */
export function writeBenchmarkReport(run: EvalRun, outputDir: string): string {
  const md = formatEvalMarkdown(run);
  const header = [
    '---',
    `benchmark_run: ${run.id}`,
    `provider: ${run.provider}`,
    `model: ${run.model}`,
    `date: ${new Date(run.startedAt).toISOString()}`,
    `suite: m2b`,
    '---',
    '',
  ].join('\n');
  const report = header + md;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const filePath = join(outputDir, `m2b-${run.provider}-${run.model.replace(/[/:]/g, '-')}.md`);
  writeFileSync(filePath, report, 'utf-8');
  return filePath;
}

/** Describe the scoring rules for the `nuvira eval score` command. */
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

/**
 * Non-coding (loop-only) tasks — assessment Addendum v4 Phase 0: "Include
 * non-coding tasks in the eval set (image-gen composition,
 * research-and-summarize, gateway delivery) — v2/v3 found these are
 * loop-only; the eval must prove it, not assume it." Gated behind an env
 * flag by default so a plain `nuvira eval run` stays deterministic/offline;
 * `NUVIRA_EVAL_NONCODING=true nuvira eval run --engine loop` exercises them.
 */
export function getNonCodingEvalTasks(): EvalTask[] {
  if (process.env.NUVIRA_EVAL_NONCODING !== 'true') return [];
  return NON_CODING_EVAL_TASKS.filter((t) => !EVAL_TASKS.some((e) => e.id === t.id));
}

/**
 * The two non-coding (loop-only) eval tasks. Both are deliberately
 * environment-free (no network, no API keys): they measure the loop's
 * ability to COMPOSE PRIMITIVES — write a script with write_file, run it
 * with run_terminal, verify the output — which is the assessment's Tier-1
 * long-tail thesis (v3 §C). The pipeline arm cannot express either task
 * (its writer is not a tool caller), which is exactly the claim Phase 0
 * must demonstrate rather than assume.
 */
const NON_CODING_EVAL_TASKS: EvalTask[] = [
  {
    id: 'nc-csv-pivot',
    title: 'Summarize a CSV into a report (compose primitives)',
    category: 'non-coding',
    difficulty: 'medium',
    goal:
      'Read sales.csv in this directory and write a file report.md containing a markdown table of revenue per region (regions sorted alphabetically, revenue as a plain integer). Do it by writing a small script with write_file and running it with run_terminal — not by hand-editing report.md.',
    setupFiles: [
      {
        path: 'sales.csv',
        content: [
          'region,revenue',
          'west,4100',
          'east,6200',
          'north,5300',
          'south,4700',
          'east,800',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'check.js',
        command: 'node check.js',
      },
    ],
    referencePatterns: [
      {
        file: 'report.md',
        mustContain: ['east', '7000', 'north', '5300'],
      },
    ],
    tokenBudget: 12_000,
    timeEstimate: 'quick',
    loopOnly: true,
  },
  {
    id: 'nc-log-analyze',
    title: 'Analyze a log file and extract failures (compose primitives)',
    category: 'non-coding',
    difficulty: 'medium',
    goal:
      'Analyze app.log and write failures.json — a JSON array of objects {"line": <number>, "level": "ERROR"} for every line starting with "ERROR" (line numbers 1-based, ascending). Use write_file + run_terminal (a script), not manual editing.',
    setupFiles: [
      {
        path: 'app.log',
        content: [
          'INFO boot',
          'ERROR db timeout',
          'INFO retry',
          'ERROR cache miss critical',
          'WARN slow query',
          'ERROR disk almost full',
        ].join('\n'),
      },
    ],
    hiddenTests: [
      {
        file: 'check.js',
        command: 'node check.js',
      },
    ],
    referencePatterns: [
      {
        file: 'failures.json',
        mustContain: ['"line": 2', '"line": 4', '"line": 6'],
      },
    ],
    tokenBudget: 10_000,
    timeEstimate: 'quick',
    loopOnly: true,
  },
];

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
