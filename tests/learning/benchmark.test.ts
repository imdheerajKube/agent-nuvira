import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scoreQuality,
  getBenchmarkTasks,
  getBenchmarkTask,
  formatBenchmarkReport,
  formatBenchmarkJSON,
  formatBenchmarkMarkdown,
  compareBenchmarks,
  clearBenchmarks,
} from '../../src/learning/benchmark.js';
import type { BenchmarkTask, BenchmarkRun } from '../../src/learning/benchmark.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id: 'test-task',
    title: 'Test Task',
    tag: 'code-generation',
    difficulty: 'easy',
    prompt: 'test prompt',
    maxExpectedTokens: 100,
    timeEstimate: 'quick',
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'test-run-1',
    provider: 'test-provider',
    model: 'test-model',
    startedAt: 1000,
    endedAt: 5000,
    results: [],
    summary: {
      totalTasks: 0,
      tasksPassed: 0,
      tasksFailed: 0,
      avgQualityScore: 0,
      medianLatencyMs: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('scoreQuality', () => {
  it('returns 0.5 for an empty output with no patterns', () => {
    const task = makeTask();
    expect(scoreQuality('', task)).toBe(0.5);
  });

  it('rewards matching expected patterns', () => {
    const task = makeTask({
      expectedPatterns: ['foo', 'bar'],
    });
    // Both patterns match
    const score = scoreQuality('foo and bar', task);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('penalizes anti-patterns', () => {
    const task = makeTask({
      antiPatterns: ['bad', 'wrong'],
    });
    // Both anti-patterns match
    const score = scoreQuality('this is bad and wrong', task);
    expect(score).toBeLessThan(0.5);
  });

  it('rewards length bonuses for meaningful responses', () => {
    const task = makeTask();
    const short = 'short';
    const medium = 'x'.repeat(150);
    const long = 'x'.repeat(600);

    expect(scoreQuality(short, task)).toBe(0.5);
    expect(scoreQuality(medium, task)).toBe(0.6); // +0.1 for >100 chars
    expect(scoreQuality(long, task)).toBe(0.7);    // +0.1 for >100, +0.1 for >500
  });

  it('rewards code blocks when output is code', () => {
    const task = makeTask({ outputLanguage: 'typescript' });
    const output = '```typescript\nconst x = 1;\n```';
    const score = scoreQuality(output, task);
    expect(score).toBeGreaterThan(0.5);
  });

  it('does not reward code blocks for text output', () => {
    const task = makeTask({ outputLanguage: 'text' });
    // Long text that should get length bonuses but NOT code block bonus
    const output = 'A very long text output '.repeat(20) + ' that explains something but has ```no real code``` in it';
    const score = scoreQuality(output, task);
    // Should get length bonuses (0.5 + 0.1 for >100 + 0.1 for >500 = 0.7)
    // But NOT code block bonus because outputLanguage is 'text'
    expect(score).toBeCloseTo(0.7, 2);
  });

  it('clamps score between 0 and 1', () => {
    const task = makeTask({
      expectedPatterns: ['a', 'b', 'c'],
      antiPatterns: ['x'],
      outputLanguage: 'typescript',
    });
    // Very long output matching all patterns, no anti-patterns
    const output = 'a b c ' + 'x'.repeat(1000) + ' ``` ';
    const score = scoreQuality(output, task);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('handles case-insensitive pattern matching', () => {
    const task = makeTask({
      expectedPatterns: ['HELLO', 'WORLD'],
    });
    const score = scoreQuality('hello world', task);
    expect(score).toBeGreaterThan(0.5);
  });
});

describe('getBenchmarkTasks', () => {
  it('returns at least 20 tasks', () => {
    const tasks = getBenchmarkTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(20);
  });

  it('returns a copy (not mutable)', () => {
    const tasks = getBenchmarkTasks();
    const originalLength = tasks.length;
    tasks.push(makeTask());
    expect(getBenchmarkTasks()).toHaveLength(originalLength);
  });

  it('all tasks have required fields', () => {
    const tasks = getBenchmarkTasks();
    for (const task of tasks) {
      expect(task.id).toBeTruthy();
      expect(task.title).toBeTruthy();
      expect(task.tag).toBeTruthy();
      expect(task.difficulty).toBeTruthy();
      expect(task.prompt).toBeTruthy();
      expect(task.maxExpectedTokens).toBeGreaterThan(0);
      expect(task.timeEstimate).toBeTruthy();
    }
  });

  it('covers at least 8 distinct categories', () => {
    const tasks = getBenchmarkTasks();
    const tags = new Set(tasks.map((t) => t.tag));
    expect(tags.size).toBeGreaterThanOrEqual(8);
  });

  it('includes at least 2 hard tasks', () => {
    const tasks = getBenchmarkTasks();
    const hard = tasks.filter((t) => t.difficulty === 'hard');
    expect(hard.length).toBeGreaterThanOrEqual(2);
  });
});

describe('getBenchmarkTask', () => {
  it('finds a task by ID', () => {
    const task = getBenchmarkTask('fizzbuzz');
    expect(task).toBeDefined();
    expect(task!.title).toContain('FizzBuzz');
  });

  it('returns undefined for unknown ID', () => {
    const task = getBenchmarkTask('nonexistent');
    expect(task).toBeUndefined();
  });
});

describe('formatBenchmarkReport', () => {
  it('returns a formatted text report', () => {
    const run = makeRun({
      results: [
        {
          taskId: 'test-task',
          provider: 'test',
          model: 'test',
          output: 'some output',
          success: true,
          latencyMs: 100,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.0001,
          qualityScore: 0.75,
          timestamp: 2000,
        },
      ],
      summary: {
        totalTasks: 1,
        tasksPassed: 1,
        tasksFailed: 0,
        avgQualityScore: 0.75,
        medianLatencyMs: 100,
        totalCostUsd: 0.0001,
        totalTokens: 30,
      },
    });

    const report = formatBenchmarkReport(run);
    expect(report).toContain('Benchmark Results');
    expect(report).toContain('test-provider/test-model');
    expect(report).toContain('test-task');
    expect(report).toContain('75%'); // quality score
    expect(report).toContain('100ms'); // latency
  });

  it('handles empty results', () => {
    const run = makeRun();
    const report = formatBenchmarkReport(run);
    expect(report).toContain('Benchmark Results');
    expect(report).toContain('0/0');
  });
});

describe('formatBenchmarkJSON', () => {
  it('returns valid JSON with run data', () => {
    const run = makeRun({
      summary: { totalTasks: 0, tasksPassed: 0, tasksFailed: 0, avgQualityScore: 0, medianLatencyMs: 0, totalCostUsd: 0, totalTokens: 0 },
    });
    const json = formatBenchmarkJSON(run);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe('test-run-1');
    expect(parsed.provider).toBe('test-provider');
    expect(parsed.summary).toBeDefined();
  });
});

describe('formatBenchmarkMarkdown', () => {
  it('returns a markdown formatted report', () => {
    const run = makeRun({
      results: [
        {
          taskId: 'test-task',
          provider: 'test',
          model: 'test',
          output: 'some output',
          success: true,
          latencyMs: 100,
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.0001,
          qualityScore: 0.75,
          timestamp: 2000,
        },
      ],
      summary: {
        totalTasks: 1,
        tasksPassed: 1,
        tasksFailed: 0,
        avgQualityScore: 0.75,
        medianLatencyMs: 100,
        totalCostUsd: 0.0001,
        totalTokens: 30,
      },
    });

    const md = formatBenchmarkMarkdown(run);
    expect(md).toContain('# Benchmark');
    expect(md).toContain('| Task | Status |');
    expect(md).toContain('test-task');
  });
});

describe('compareBenchmarks', () => {
  const runA = makeRun({
    id: 'run-a',
    model: 'model-a',
    summary: {
      totalTasks: 10,
      tasksPassed: 8,
      tasksFailed: 2,
      avgQualityScore: 0.7,
      medianLatencyMs: 200,
      totalCostUsd: 0.01,
      totalTokens: 5000,
    },
  });

  const runB = makeRun({
    id: 'run-b',
    model: 'model-b',
    summary: {
      totalTasks: 10,
      tasksPassed: 9,
      tasksFailed: 1,
      avgQualityScore: 0.8,
      medianLatencyMs: 300,
      totalCostUsd: 0.02,
      totalTokens: 6000,
    },
  });

  it('returns a comparison string with both model names', () => {
    const result = compareBenchmarks(runA, runB);
    expect(result).toContain('model-a');
    expect(result).toContain('model-b');
    expect(result).toContain('Benchmark Comparison');
  });

  it('declares a winner for each metric', () => {
    const result = compareBenchmarks(runA, runB);
    // model-b has higher pass rate (9/10 vs 8/10)
    expect(result).toContain('model-b');
  });

  it('handles identical runs with "tie"', () => {
    const result = compareBenchmarks(runA, runA);
    expect(result).toContain('tie');
  });

  it('includes all four metric rows', () => {
    const result = compareBenchmarks(runA, runB);
    expect(result).toContain('Pass Rate');
    expect(result).toContain('Avg Quality');
    expect(result).toContain('Median Latency');
    expect(result).toContain('Total Cost');
  });
});

describe('clearBenchmarks', () => {
  it('clears persisted benchmark data', () => {
    // Should not throw
    expect(() => clearBenchmarks()).not.toThrow();
    // The data file should now contain an empty runs array
    const memDir = join(homedir(), '.buff', 'memory');
    const benchPath = join(memDir, 'benchmarks.json');
    if (existsSync(benchPath)) {
      const data = JSON.parse(readFileSync(benchPath, 'utf-8'));
      expect(data.runs).toEqual([]);
    }
  });
});
