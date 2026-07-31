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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  clearEvals,
  EVAL_SCORE_WEIGHTS,
  IDEAL_TIME_TO_FIX_MS,
} from '../../src/learning/eval-framework.js';
import type { EvalMetrics, EvalResult, EvalTask } from '../../src/learning/eval-framework.js';
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
    const evalPath = join(homedir(), '.buff', 'memory', 'evals.json');
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
    const evalPath = join(homedir(), '.buff', 'memory', 'evals.json');
    if (existsSync(evalPath)) {
      const data = JSON.parse(readFileSync(evalPath, 'utf-8'));
      expect(data.runs).toEqual([]);
    }
  });
});
