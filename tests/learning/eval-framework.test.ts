/**
 * Evaluation Framework — Unit tests.
 *
 * Coverage goals:
 * - scoreEvalMetrics() — weighted composite scoring, perfect/worst cases, recovery, rollbacks
 * - getEvalTasks() / getEvalTask() — dataset integrity, unique IDs, valid hidden tests
 * - scaffoldWorkspace() — setup files + hidden test templates written
 * - runHiddenTest() — exit-code capture for passing and failing commands
 * - computeEditAccuracy() — pattern/anti-pattern matching, missing files
 * - computeEvalSummary() — aggregate metrics across results
 * - runEvalSuite() — end-to-end with a stubbed executeGoal (pass + fail paths), persistence
 * - formatEvalReport() / formatEvalMarkdown() / formatEvalScoreRules()
 * - clearEvals()
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Isolate persistence from the real ~/.buff store: eval-framework's EVAL_PATH
// is computed at module load, so homedir is mocked at hoist time (same pattern
// as session-recall.test.ts). Without this, runEvalSuite/clearEvals in tests
// WROTE TO AND WIPED the user's real ~/.buff/memory/evals.json.
const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-evaltest-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import {
  scoreEvalMetrics,
  getEvalTasks,
  getEvalTask,
  scaffoldWorkspace,
  runHiddenTest,
  computeEditAccuracy,
  computeEvalSummary,
  runEvalSuite,
  formatEvalReport,
  formatEvalMarkdown,
  formatEvalScoreRules,
  computeReworkTurns,
  computeStuckStates,
  isProviderInterferenceError,
  compareEvalRuns,
  selectCompareRuns,
  clearEvals,
  resolvePaceBudget,
  EVAL_SCORE_WEIGHTS,
  IDEAL_TIME_TO_FIX_MS,
} from '../../src/learning/eval-framework.js';
import type { EvalMetrics, EvalResult, EvalTask } from '../../src/learning/eval-framework.js';
import type { ConfigManager } from '../../src/config/manager.js';
import type { OrchestrationResult } from '../../src/agents/orchestrator.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    completed: true,
    testPassed: true,
    testPassRate: 1,
    timeToFixMs: 60_000,
    editAccuracy: 1,
    tokenEfficiency: 1,
    totalTokens: 7000,
    rollbackCount: 0,
    dependencyInstallAttempted: false,
    dependencyInstallSucceeded: false,
    recoveryAttempts: 0,
    alternativeApproaches: 0,
    recovered: false,
    attempts: 10,
    costUsd: 0,
    latencyMs: 120_000,
    ...overrides,
  };
}

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    taskId: 'js-anagram',
    provider: 'test-provider',
    model: 'test-model',
    metrics: makeMetrics(),
    compositeScore: 1,
    summary: 'Task completed',
    timestamp: 2000,
    ...overrides,
  };
}

function makeSuccessOrchestration(stats?: Partial<NonNullable<OrchestrationResult['stats']>>): OrchestrationResult {
  return {
    success: true,
    goal: 'test goal',
    summary: 'All tasks completed successfully',
    tasksCompleted: 2,
    tasksTotal: 2,
    agentResults: [{ agent: 'writer', success: true, summary: 'Wrote files' }],
    fileChanges: '',
    stats: {
      llmCalls: 10,
      inputTokens: 5000,
      outputTokens: 2000,
      repairAttempts: 0,
      alternativeApproaches: 0,
      recoveredFailures: 0,
      taskFailures: 0,
      dependencyInstallAttempted: false,
      dependencyInstallSucceeded: false,
      rollbackCount: 0,
      ...stats,
    },
  };
}

// ─── scoreEvalMetrics ───────────────────────────────────────────────────────

afterAll(() => {
  try { rmSync(testDirHolder.value, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('scoreEvalMetrics', () => {
  it('awards a perfect score for all-passing metrics', () => {
    const metrics = makeMetrics({ recovered: true });
    const score = scoreEvalMetrics(metrics);
    // 0.30 + 0.20 + 0.15 + 0.10 + 0.10 + 0.10 + 0.05 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('awards 0.05 minimum when everything fails but there are no rollbacks', () => {
    const metrics = makeMetrics({
      completed: false,
      testPassed: false,
      testPassRate: 0,
      timeToFixMs: Number.POSITIVE_INFINITY,
      editAccuracy: 0,
      tokenEfficiency: 0,
      recoveryAttempts: 0,
      recovered: false,
    });
    const score = scoreEvalMetrics(metrics);
    // Only the rollback component (no rollbacks = 1.0) contributes: 0.05
    expect(score).toBeCloseTo(0.05, 5);
  });

  it('scores zero when everything fails AND rollbacks exist', () => {
    const metrics = makeMetrics({
      completed: false,
      testPassed: false,
      testPassRate: 0,
      timeToFixMs: Number.POSITIVE_INFINITY,
      editAccuracy: 0,
      tokenEfficiency: 0,
      rollbackCount: 4, // 1 - 4*0.25 = 0
      recoveryAttempts: 0,
      recovered: false,
    });
    const score = scoreEvalMetrics(metrics);
    expect(score).toBe(0);
  });

  it('gives partial recovery credit when attempts were made but task failed', () => {
    const withAttempts = scoreEvalMetrics(makeMetrics({
      testPassed: false,
      testPassRate: 0,
      completed: false,
      recoveryAttempts: 3,
      recovered: false,
      timeToFixMs: Number.POSITIVE_INFINITY,
    }));
    const withoutAttempts = scoreEvalMetrics(makeMetrics({
      testPassed: false,
      testPassRate: 0,
      completed: false,
      recoveryAttempts: 0,
      recovered: false,
      timeToFixMs: Number.POSITIVE_INFINITY,
    }));
    expect(withAttempts).toBeGreaterThan(withoutAttempts);
  });

  it('gives full recovery credit only when the task recovered', () => {
    const recovered = scoreEvalMetrics(makeMetrics({ recovered: true }));
    const triedOnly = scoreEvalMetrics(makeMetrics({
      recovered: false,
      recoveryAttempts: 2,
    }));
    expect(recovered).toBeGreaterThan(triedOnly);
  });

  it('caps token efficiency and time-to-fix scores at 1', () => {
    // tokenEfficiency=2 and timeToFixMs=1 both clamp to 1; recovered gives full
    // recovery credit so the composite reaches 1.0
    const score = scoreEvalMetrics(makeMetrics({
      tokenEfficiency: 2, // would be > 1 if not clamped
      timeToFixMs: 1,
      recovered: true,
    }));
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('scores zero for time-to-fix when tests never passed', () => {
    const metrics = makeMetrics({
      testPassed: false,
      testPassRate: 0,
      timeToFixMs: Number.POSITIVE_INFINITY,
    });
    const score = scoreEvalMetrics(metrics);
    expect(score).toBeLessThan(1);
  });

  it('uses testPassRate when not fully passed', () => {
    const partial = scoreEvalMetrics(makeMetrics({ testPassed: false, testPassRate: 0.5 }));
    const failed = scoreEvalMetrics(makeMetrics({ testPassed: false, testPassRate: 0 }));
    expect(partial).toBeGreaterThan(failed);
  });
});

// ─── Dataset integrity ──────────────────────────────────────────────────────

describe('getEvalTasks', () => {
  it('returns at least 6 tasks', () => {
    const tasks = getEvalTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(6);
  });

  it('returns tasks with unique IDs', () => {
    const tasks = getEvalTasks();
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(tasks.length);
  });

  it('all tasks have required fields and valid hidden tests', () => {
    for (const task of getEvalTasks()) {
      expect(task.id).toBeTruthy();
      expect(task.title).toBeTruthy();
      expect(task.goal).toBeTruthy();
      expect(task.tokenBudget).toBeGreaterThan(0);
      expect(task.setupFiles.length).toBeGreaterThan(0);
      expect(task.hiddenTests.length).toBeGreaterThan(0);
      for (const test of task.hiddenTests) {
        expect(test.command).toBeTruthy();
        expect(test.file).toBeTruthy();
      }
    }
  });

  it('covers multiple categories including dependency-setup', () => {
    const tasks = getEvalTasks();
    const categories = new Set(tasks.map((t) => t.category));
    expect(categories.has('bug-fix')).toBe(true);
    expect(categories.has('dependency-setup')).toBe(true);
    expect(categories.has('refactor')).toBe(true);
  });
});

describe('getEvalTask', () => {
  it('finds a task by ID', () => {
    expect(getEvalTask('js-anagram')).toBeDefined();
    expect(getEvalTask('js-anagram')!.title).toContain('Anagram');
  });

  it('returns undefined for unknown ID', () => {
    expect(getEvalTask('nonexistent')).toBeUndefined();
  });
});

// ─── scaffoldWorkspace ──────────────────────────────────────────────────────

describe('scaffoldWorkspace', () => {
  it('writes setup files and hidden test templates to a temp dir', () => {
    const task = getEvalTask('js-anagram')!;
    const dir = scaffoldWorkspace(task);

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'anagram.js'))).toBe(true);
    // Hidden test written from the template map
    expect(existsSync(join(dir, 'test.js'))).toBe(true);
    const testContent = readFileSync(join(dir, 'test.js'), 'utf-8');
    expect(testContent).toContain('isAnagram');

    // Cleanup
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  it('scaffolds nested directories for setup files', () => {
    const task = getEvalTask('dep-local-module')!;
    const dir = scaffoldWorkspace(task);
    expect(existsSync(join(dir, 'math-utils', 'index.js'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── runHiddenTest ──────────────────────────────────────────────────────────

describe('runHiddenTest', () => {
  it('returns exit code 0 for a passing command', () => {
    const { exitCode } = runHiddenTest(process.cwd(), 'node -e "console.log(1)"');
    expect(exitCode).toBe(0);
  });

  it('returns non-zero exit code for a failing command', () => {
    const { exitCode } = runHiddenTest(process.cwd(), 'node -e "process.exit(3)"');
    expect(exitCode).toBe(3);
  });

  it('captures output from the command', () => {
    const { output } = runHiddenTest(process.cwd(), 'node -e "console.log(\'hello-eval\')"');
    expect(output).toContain('hello-eval');
  });
});

// ─── computeEditAccuracy ────────────────────────────────────────────────────

describe('computeEditAccuracy', () => {
  it('returns 1.0 when all reference patterns match', () => {
    const task: EvalTask = {
      id: 'test',
      title: 'test',
      category: 'bug-fix',
      difficulty: 'easy',
      goal: 'test',
      setupFiles: [],
      hiddenTests: [],
      tokenBudget: 1000,
      timeEstimate: 'quick',
      referencePatterns: [
        { file: 'solution.js', mustContain: ['function solve', 'return 42'] },
      ],
    };
    const dir = scaffoldWorkspace(task);
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(dir, 'solution.js'), 'function solve() { return 42; }', 'utf-8');
    expect(computeEditAccuracy(task, dir)).toBe(1);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 when the reference file is missing', () => {
    const task: EvalTask = {
      id: 'test',
      title: 'test',
      category: 'bug-fix',
      difficulty: 'easy',
      goal: 'test',
      setupFiles: [],
      hiddenTests: [],
      tokenBudget: 1000,
      timeEstimate: 'quick',
      referencePatterns: [
        { file: 'missing.js', mustContain: ['anything'] },
      ],
    };
    const dir = scaffoldWorkspace(task);
    expect(computeEditAccuracy(task, dir)).toBe(0);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  it('penalizes anti-patterns that are present', () => {
    const task: EvalTask = {
      id: 'test',
      title: 'test',
      category: 'bug-fix',
      difficulty: 'easy',
      goal: 'test',
      setupFiles: [],
      hiddenTests: [],
      tokenBudget: 1000,
      timeEstimate: 'quick',
      referencePatterns: [
        { file: 'a.js', mustContain: ['good'], mustNotContain: ['bad'] },
      ],
    };
    const dir = scaffoldWorkspace(task);
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(dir, 'a.js'), 'good and bad', 'utf-8');
    // 1 matched (good) / 2 total (good + bad) = 0.5
    expect(computeEditAccuracy(task, dir)).toBe(0.5);
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── computeEvalSummary ─────────────────────────────────────────────────────

describe('computeEvalSummary', () => {
  it('returns zeroed summary for empty results', () => {
    const s = computeEvalSummary([]);
    expect(s.totalTasks).toBe(0);
    expect(s.avgCompositeScore).toBe(0);
  });

  it('aggregates pass rates, rollbacks, and recovery across results', () => {
    const results = [
      makeResult({
        taskId: 't1',
        metrics: makeMetrics({
          testPassed: true,
          completed: true,
          rollbackCount: 1,
          recovered: true,
          recoveryAttempts: 2,
          dependencyInstallAttempted: true,
          dependencyInstallSucceeded: true,
        }),
      }),
      makeResult({
        taskId: 't2',
        metrics: makeMetrics({
          testPassed: false,
          testPassRate: 0,
          completed: false,
          timeToFixMs: Number.POSITIVE_INFINITY,
          rollbackCount: 0,
          recoveryAttempts: 1,
          recovered: false,
          dependencyInstallAttempted: true,
          dependencyInstallSucceeded: false,
        }),
      }),
    ];

    const s = computeEvalSummary(results);
    expect(s.totalTasks).toBe(2);
    expect(s.tasksPassed).toBe(1);
    expect(s.testPassRate).toBe(0.5);
    expect(s.completionRate).toBe(0.5);
    expect(s.totalRollbacks).toBe(1);
    expect(s.dependencyInstallRate).toBe(0.5); // 1 of 2 installs succeeded
    // One task had failures and recovered → recoveryRate 0.5
    expect(s.recoveryRate).toBe(0.5);
    expect(s.avgCompositeScore).toBe((results[0].compositeScore + results[1].compositeScore) / 2);
  });
});

// ─── runEvalSuite (stubbed executor) ────────────────────────────────────────

describe('runEvalSuite', () => {
  const dummyProvider = {} as never;

  beforeEach(() => {
    clearEvals();
  });

  afterEach(() => {
    clearEvals();
    vi.restoreAllMocks();
  });

  it('records a passing task when the agent writes a correct solution', async () => {
    // The stub receives the workspace dir and writes a correct anagram.js so
    // the hidden test (run with cwd=workspace) passes.
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration();
    };

    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      taskIds: ['js-anagram'],
      executeGoal,
    });

    expect(run.results).toHaveLength(1);
    expect(run.results[0].metrics.testPassed).toBe(true);
    expect(run.results[0].metrics.completed).toBe(true);
    expect(run.results[0].compositeScore).toBeGreaterThan(0.5);
    expect(run.summary.tasksPassed).toBe(1);
    expect(run.summary.testPassRate).toBe(1);
  });

  it('records a failing task when the solution is wrong', async () => {
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  return false;',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration();
    };

    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      taskIds: ['js-anagram'],
      executeGoal,
    });

    expect(run.results[0].metrics.testPassed).toBe(false);
    expect(run.results[0].metrics.testPassRate).toBe(0);
    expect(run.results[0].metrics.timeToFixMs).toBe(Number.POSITIVE_INFINITY);
    expect(run.summary.tasksPassed).toBe(0);
  });

  it('propagates recovery telemetry from the orchestrator stats', async () => {
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      // Correct solution so the hidden test actually passes
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration({
        repairAttempts: 3,
        alternativeApproaches: 2,
        taskFailures: 1,
        recoveredFailures: 1,
        dependencyInstallAttempted: true,
        dependencyInstallSucceeded: true,
        rollbackCount: 1,
      });
    };

    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      taskIds: ['js-anagram'],
      executeGoal,
    });

    const m = run.results[0].metrics;
    expect(m.recoveryAttempts).toBe(3);
    expect(m.alternativeApproaches).toBe(2);
    expect(m.recovered).toBe(true);
    expect(m.rollbackCount).toBe(1);
    expect(m.dependencyInstallAttempted).toBe(true);
    expect(m.dependencyInstallSucceeded).toBe(true);
  });

  it('persists runs to disk and retrieves them via getEvalRuns', async () => {
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration();
    };

    await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      taskIds: ['js-anagram'],
      executeGoal,
    });

    const runs = (await import('../../src/learning/eval-framework.js')).getEvalRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].provider).toBe('test-provider');
    // Verify persisted to disk
    const evalPath = join(testDirHolder.value, '.buff', 'memory', 'evals.json');
    expect(existsSync(evalPath)).toBe(true);
    const data = JSON.parse(readFileSync(evalPath, 'utf-8'));
    expect(data.runs.length).toBeGreaterThanOrEqual(1);
  });

  it('respects task filtering by time estimate', async () => {
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration();
    };

    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      timeEstimate: 'quick',
      executeGoal,
    });
    for (const r of run.results) {
      const task = getEvalTask(r.taskId)!;
      expect(task.timeEstimate).toBe('quick');
    }
  });

  // ─── Session 37 — daily-token pacing (Design Decision 21) ────────────────

  it('runs zero tasks when the pace budget is already exhausted before the run', async () => {
    const executeGoal = vi.fn(async (): Promise<OrchestrationResult> => makeSuccessOrchestration());
    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      taskIds: ['js-anagram'],
      paceTokens: 10_000,
      paceUsedBefore: 10_000, // budget already met today
      executeGoal,
    });
    expect(run.results).toHaveLength(0);
    expect(executeGoal).not.toHaveBeenCalled();
    // Persistence still records the (empty) run — no crash
    expect(run.summary.tasksPassed).toBe(0);
  });

  it('stops BEFORE a task that would cross the declared daily cap', async () => {
    let calls = 0;
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      calls += 1;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      // Each task consumes 7,000 tokens (input 5000 + output 2000)
      return makeSuccessOrchestration();
    };

    // Two quick tasks selected; cap allows only the first (7,000 tokens).
    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      timeEstimate: 'quick',
      paceTokens: 7_000,
      paceUsedBefore: 0,
      executeGoal,
    });

    expect(calls).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].metrics.totalTokens).toBe(7_000);
  });

  it('runs all tasks when the pace budget comfortably covers the run', async () => {
    const executeGoal = async (_goal: string, workspace: string): Promise<OrchestrationResult> => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(workspace, 'anagram.js'), [
        'function isAnagram(a, b) {',
        '  const norm = (s) => s.replace(/\\s/g, "").toLowerCase().split("").sort().join("");',
        '  return norm(a) === norm(b);',
        '}',
        'module.exports = { isAnagram };',
        '',
      ].join('\n'), 'utf-8');
      return makeSuccessOrchestration();
    };

    const run = await runEvalSuite(dummyProvider, 'test-provider', 'test-model', {
      timeEstimate: 'quick',
      paceTokens: 1_000_000,
      paceUsedBefore: 0,
      executeGoal,
    });
    expect(run.results.length).toBeGreaterThan(0);
    for (const r of run.results) {
      expect(r.metrics.totalTokens).toBe(7_000);
    }
  });
});

// ─── Session 37 — resolvePaceBudget ────────────────────────────────────────

describe('resolvePaceBudget', () => {
  it('returns an unpaced budget when no quota is declared for the provider', () => {
    const { paceTokens, usedBefore } = resolvePaceBudget(undefined, 'groq');
    expect(paceTokens).toBeUndefined();
    expect(usedBefore).toBe(0);
  });

  it('reads the declared tokensPerWindow cap and ledger consumption', () => {
    const stub = {
      getAll: () => ({
        routing: { quota: { groq: { tokensPerWindow: 12_000 } } },
      }),
    } as unknown as ConfigManager;
    const { paceTokens, usedBefore } = resolvePaceBudget(stub, 'groq');
    expect(paceTokens).toBe(12_000);
    expect(typeof usedBefore).toBe('number');
    expect(usedBefore).toBeGreaterThanOrEqual(0);
  });

  it('ignores quotas declared for other providers', () => {
    const stub = {
      getAll: () => ({
        routing: { quota: { gemini: { tokensPerWindow: 12_000 } } },
      }),
    } as unknown as ConfigManager;
    const { paceTokens } = resolvePaceBudget(stub, 'groq');
    expect(paceTokens).toBeUndefined();
  });
});

// ─── Report formatting ──────────────────────────────────────────────────────

describe('formatEvalReport', () => {
  it('includes metrics, score, and per-task table', () => {
    const run = {
      id: 'eval-test',
      provider: 'p',
      model: 'm',
      startedAt: 1000,
      endedAt: 5000,
      results: [makeResult()],
      summary: computeEvalSummary([makeResult()]),
    };
    const report = formatEvalReport(run);
    expect(report).toContain('Evaluation Results');
    expect(report).toContain('p/m');
    expect(report).toContain('Task completion rate');
    expect(report).toContain('js-anagram');
  });
});

describe('computeReworkTurns', () => {
  it('counts ONLY explicit try-again events (repairs + ideas + rollbacks)', () => {
    // A smooth multi-agent run makes ~4-5 LLM calls by design — that is NOT
    // rework, so high attempts with no repairs/ideas/rollbacks = 0 rework.
    expect(computeReworkTurns(makeMetrics({ attempts: 1 }))).toBe(0);
    expect(computeReworkTurns(makeMetrics({ attempts: 6 }))).toBe(0);
    expect(computeReworkTurns(makeMetrics({
      attempts: 6,
      recoveryAttempts: 1,
      alternativeApproaches: 2,
      rollbackCount: 1,
    }))).toBe(4);
    expect(computeReworkTurns(makeMetrics({ attempts: 0 }))).toBe(0);
  });
});

describe('computeStuckStates', () => {
  it('flags a crashed/timed-out task that produced no working outcome', () => {
    const r = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, attempts: 1, error: 'Task timed out after 240s' }) });
    const stuck = computeStuckStates([r]);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].taskId).toBe('js-anagram');
  });

  it('flags a task that thrashed (3+ rework turns) without a working outcome', () => {
    const r = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, recoveryAttempts: 3 }) });
    expect(computeStuckStates([r])).toHaveLength(1);
  });

  it('does NOT flag a task whose tests PASSED even after provider interference', () => {
    // e.g. a transient 429 during repair that the reliability stack recovered
    // from — the user got working code, so it is not user-visible stuckness.
    const r = makeResult({ metrics: makeMetrics({ completed: false, testPassed: true, recoveryAttempts: 3, error: 'Groq API error (429)' }) });
    expect(computeStuckStates([r])).toHaveLength(0);
  });

  it('does NOT flag a completed, passing task even with many executions', () => {
    const r = makeResult({ metrics: makeMetrics({ completed: true, testPassed: true, attempts: 12 }) });
    expect(computeStuckStates([r])).toHaveLength(0);
  });

  it('does NOT flag a task whose terminal failure is provider interference (429 rate limit)', () => {
    // Session 44 — a free-tier 429 that opened the circuit breaker: the
    // pipeline never got to work (attempts=1), so it is interference, not
    // user-visible stuckness.
    const r = makeResult({
      metrics: makeMetrics({
        completed: false,
        testPassed: false,
        attempts: 1,
        error: 'Groq API error (429): Rate limit reached for model llama-3.3-70b-versatile',
      }),
    });
    expect(computeStuckStates([r])).toHaveLength(0);
    expect(isProviderInterferenceError(r.metrics.error)).toBe(true);
  });

  it('does NOT flag server/network terminal failures as stuck (interference)', () => {
    const server = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, error: 'Provider 503 Service Unavailable' }) });
    const network = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, error: 'fetch failed: ECONNREFUSED' }) });
    expect(computeStuckStates([server, network])).toHaveLength(0);
  });

  it('STILL flags a task that crashed on a NON-interference error (timeout, auth)', () => {
    const timeout = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, error: 'Task timed out after 240s' }) });
    const auth = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, error: '401 unauthorized: invalid API key' }) });
    expect(computeStuckStates([timeout, auth])).toHaveLength(2);
  });

  it('does NOT flag an incomplete task with little rework and no error', () => {
    const r = makeResult({ metrics: makeMetrics({ completed: false, testPassed: false, attempts: 2, error: undefined }) });
    expect(computeStuckStates([r])).toHaveLength(0);
  });
});

describe('compareEvalRuns', () => {
  function makeRun(
    id: string,
    model: string,
    startedAt: number,
    endedAt: number,
    results: EvalResult[],
  ): Parameters<typeof compareEvalRuns>[0] {
    return { id, provider: 'groq', model, startedAt, endedAt, results, summary: computeEvalSummary(results) };
  }

  it('points the winner arrow at the better run on every axis', () => {
    // Older run: 1 stuck task (3 repairs, tests red), 3 rework, slower, costlier.
    const older = makeRun(
      'eval-old',
      'llama-old',
      1000,
      100_000,
      [makeResult({ taskId: 'a', compositeScore: 0.4, metrics: makeMetrics({ completed: false, testPassed: false, recoveryAttempts: 3 }) })],
    );
    // Newer run: all green, 0 rework, faster, cheaper.
    const newer = makeRun(
      'eval-new',
      'llama-new',
      2000,
      50_000,
      [makeResult({ taskId: 'b', compositeScore: 0.9, metrics: makeMetrics({ testPassed: true }) })],
    );
    const out = compareEvalRuns(older, newer);
    expect(out).toContain('⚔️  Eval Comparison');
    expect(out).toContain('Composite score');
    expect(out).toContain('Test pass rate');
    expect(out).toContain('Stuck states');
    expect(out).toContain('Rework turns');
    expect(out).toContain('Time-to-done');
    // Newer wins every axis (composite/test higher; stuck/rework/time lower).
    expect((out.match(/llama-new →/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(out).not.toContain('← llama-old');
    expect(out).toContain('n/a'); // older has no passing task — must never win avg-fix
  });

  it('prefers a same provider+model baseline so the gate is not confounded', () => {
    const groqNewest = makeRun('r3', 'llama-3.3', 3000, 9000, [makeResult({ taskId: 'c' })]);
    const groqOlder = makeRun('r2', 'llama-3.3', 2000, 8000, [makeResult({ taskId: 'b' })]);
    const gemini = makeRun('r1', 'gemini-2', 1000, 7000, [makeResult({ taskId: 'a' })]);
    // Newest-first: groq(r3), groq(r2), gemini(r1). The gate must compare r3 vs
    // the same-setup r2, NOT the adjacent gemini run.
    const [newest, baseline] = selectCompareRuns([groqNewest, gemini, groqOlder])!;
    expect(newest.id).toBe('r3');
    expect(baseline.id).toBe('r2');
    // Falls back to the previous run when no same-setup older run exists.
    const [n2, b2] = selectCompareRuns([groqNewest, gemini])!;
    expect(n2.id).toBe('r3');
    expect(b2.id).toBe('r1');
    // Returns null with fewer than two runs.
    expect(selectCompareRuns([groqNewest])).toBeNull();
  });

  it('marks a tie when values are equal', () => {
    const same = makeRun(
      'eval-tie-a',
      'llama-a',
      1000,
      10_000,
      [makeResult({ taskId: 'a', metrics: makeMetrics() })],
    );
    const same2 = makeRun(
      'eval-tie-b',
      'llama-b',
      2000,
      11_000,
      [makeResult({ taskId: 'b', metrics: makeMetrics() })],
    );
    const out = compareEvalRuns(same, same2);
    expect(out).toContain('tie');
  });
});

describe('formatEvalMarkdown', () => {
  it('produces markdown tables', () => {
    const run = {
      id: 'eval-test',
      provider: 'p',
      model: 'm',
      startedAt: 1000,
      endedAt: 5000,
      results: [makeResult()],
      summary: computeEvalSummary([makeResult()]),
    };
    const md = formatEvalMarkdown(run);
    expect(md).toContain('# Agent-Nuvira Evaluation');
    expect(md).toContain('| Metric | Value |');
    expect(md).toContain('| Task | Status |');
  });

  it('includes the experience-parity stuck/rework breakdown', () => {
    const run = {
      id: 'eval-test-2',
      provider: 'p',
      model: 'm',
      startedAt: 1000,
      endedAt: 5000,
      results: [
        makeResult({ taskId: 'js-fizzbuzz-fix', metrics: makeMetrics({ attempts: 3, recoveryAttempts: 1 }) }),
        makeResult({ taskId: 'js-closure-fix', metrics: makeMetrics({ completed: false, testPassed: false, attempts: 1, error: 'crashed' }) }),
        makeResult({ taskId: 'js-queue', metrics: makeMetrics({ completed: false, testPassed: true, recoveryAttempts: 3, error: '429' }) }),
      ],
      summary: computeEvalSummary([
        makeResult({ taskId: 'js-fizzbuzz-fix', metrics: makeMetrics({ attempts: 3, recoveryAttempts: 1 }) }),
        makeResult({ taskId: 'js-closure-fix', metrics: makeMetrics({ completed: false, testPassed: false, attempts: 1, error: 'crashed' }) }),
        makeResult({ taskId: 'js-queue', metrics: makeMetrics({ completed: false, testPassed: true, recoveryAttempts: 3, error: '429' }) }),
      ]),
    };
    const md = formatEvalMarkdown(run);
    expect(md).toContain('## Experience Parity (stuck / rework)');
    expect(md).toContain('| Total rework turns | 4 |'); // fizzbuzz 1 repair + queue 3 repairs
    expect(md).toContain('| Stuck states | 1 (js-closure-fix) |');
    expect(md).toContain('| Rework | Stuck |');
    expect(md).toContain('🚧');
  });

  it('renders never-green tasks as "never" after a JSON round-trip (Infinity → null)', () => {
    const run = {
      id: 'eval-test-3',
      provider: 'p',
      model: 'm',
      startedAt: 1000,
      endedAt: 5000,
      results: [makeResult({ metrics: makeMetrics({ timeToFixMs: null as unknown as number, testPassed: false }) })],
      summary: computeEvalSummary([makeResult({ metrics: makeMetrics({ timeToFixMs: null as unknown as number, testPassed: false }) })]),
    };
    const md = formatEvalMarkdown(run);
    expect(md).toContain('| never |');
    expect(md).not.toContain('| 0.0s |');
  });
});

describe('formatEvalScoreRules', () => {
  it('documents all seven weighted metrics', () => {
    const rules = formatEvalScoreRules();
    expect(rules).toContain('Evaluation Scoring Rules');
    expect(rules).toContain('Test pass rate');
    expect(rules).toContain('Task completion');
    expect(rules).toContain('Edit accuracy');
    expect(rules).toContain('Token efficiency');
    expect(rules).toContain('Time-to-fix');
    expect(rules).toContain('Recovery / new ideas');
    expect(rules).toContain('Low rollback freq');
  });

  it('weights sum to 1.0', () => {
    const total = Object.values(EVAL_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it('references the ideal time-to-fix constant', () => {
    expect(IDEAL_TIME_TO_FIX_MS).toBe(120_000);
  });
});

// ─── clearEvals ─────────────────────────────────────────────────────────────

describe('clearEvals', () => {
  it('clears persisted eval data without throwing', () => {
    expect(() => clearEvals()).not.toThrow();
    const evalPath = join(testDirHolder.value, '.buff', 'memory', 'evals.json');
    if (existsSync(evalPath)) {
      const data = JSON.parse(readFileSync(evalPath, 'utf-8'));
      expect(data.runs).toEqual([]);
    }
  });
});
