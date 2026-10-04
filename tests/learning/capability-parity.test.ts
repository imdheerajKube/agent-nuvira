/**
 * Capability parity — the measurement harness for the gap-narrowing claim.
 *
 * These tests pin the PURE layer (summarize / compare / format) and the mode
 * plumbing (the run applies NUVIRA_CAPABILITY_MODE and restores it). The real
 * run itself needs a provider and is invoked on demand — it is not here.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  PARITY_TASK_IDS,
  compareCapabilityRuns,
  formatCapabilityParity,
  runCapabilityParity,
  summarizeCapabilityRun,
} from '../../src/learning/capability-parity.js';
import { getEvalTasks } from '../../src/learning/eval-framework.js';
import type { EvalResult, EvalRun } from '../../src/learning/eval-framework.js';

function mkResult(overrides: Partial<EvalResult> & { metrics?: Partial<EvalResult['metrics']> } = {}): EvalResult {
  const { metrics, ...rest } = overrides;
  return {
    taskId: 't',
    provider: 'p',
    model: 'm',
    compositeScore: 0.5,
    summary: '',
    timestamp: 0,
    metrics: {
      completed: true,
      testPassed: true,
      testPassRate: 1,
      timeToFixMs: 1000,
      editAccuracy: 1,
      tokenEfficiency: 1,
      totalTokens: 100,
      rollbackCount: 0,
      dependencyInstallAttempted: false,
      dependencyInstallSucceeded: false,
      recoveryAttempts: 0,
      alternativeApproaches: 0,
      recovered: false,
      attempts: 1,
      costUsd: 0.01,
      latencyMs: 1000,
      ...(metrics ?? {}),
    },
    ...rest,
  };
}

function mkRun(results: EvalResult[]): EvalRun {
  return {
    id: 'run',
    provider: 'p',
    model: 'm',
    startedAt: 0,
    endedAt: 1,
    results,
    summary: {} as EvalRun['summary'],
  };
}

afterEach(() => {
  delete process.env.NUVIRA_CAPABILITY_MODE;
});

describe('PARITY_TASK_IDS — the default suite must exist', () => {
  it('names real eval tasks (no dangling ids)', () => {
    const ids = new Set(getEvalTasks().map((t) => t.id));
    for (const id of PARITY_TASK_IDS) {
      expect(ids.has(id), `parity task '${id}' is not in the eval task set`).toBe(true);
    }
  });

  it('is non-empty and unique', () => {
    expect(PARITY_TASK_IDS.length).toBeGreaterThan(0);
    expect(new Set(PARITY_TASK_IDS).size).toBe(PARITY_TASK_IDS.length);
  });
});

describe('summarizeCapabilityRun', () => {
  it('aggregates the metrics that describe the gap', () => {
    const s = summarizeCapabilityRun('max', mkRun([
      mkResult({ compositeScore: 1, metrics: { completed: true, testPassed: true, bounded: true, permissionAsks: 2, totalTokens: 100, costUsd: 0.02 } }),
      mkResult({ compositeScore: 0, metrics: { completed: false, testPassed: false, bounded: false, permissionAsks: 0, totalTokens: 300, costUsd: 0.04 } }),
    ]));
    expect(s.tasks).toBe(2);
    expect(s.avgComposite).toBe(0.5);
    expect(s.testPassRate).toBe(0.5);
    expect(s.completedRate).toBe(0.5);
    expect(s.boundedRate).toBe(0.5);
    expect(s.avgPermissionAsks).toBe(1);
    expect(s.totalTokens).toBe(400);
    expect(s.totalCostUsd).toBeCloseTo(0.06, 6);
  });

  it('reports 0 interruptions when the arm cannot observe them (never fabricates)', () => {
    const s = summarizeCapabilityRun('balanced', mkRun([mkResult()]));
    expect(s.avgPermissionAsks).toBe(0);
  });

  it('handles an empty run without dividing by zero', () => {
    const s = summarizeCapabilityRun('balanced', mkRun([]));
    expect(s.tasks).toBe(0);
    expect(s.avgComposite).toBe(0);
    expect(s.boundedRate).toBe(0);
  });
});

describe('compareCapabilityRuns — positive delta means max is higher', () => {
  it('computes max minus balanced on every metric', () => {
    const balanced = mkRun([mkResult({ compositeScore: 0.4, metrics: { testPassed: false, bounded: true, totalTokens: 100 } })]);
    const max = mkRun([mkResult({ compositeScore: 0.9, metrics: { testPassed: true, bounded: false, totalTokens: 260 } })]);
    const report = compareCapabilityRuns(balanced, max);
    expect(report.delta.avgComposite).toBeCloseTo(0.5, 6);
    expect(report.delta.testPassRate).toBeCloseTo(1, 6);
    // Lower bounded rate under max is a NEGATIVE delta — the good direction.
    expect(report.delta.boundedRate).toBeCloseTo(-1, 6);
    expect(report.delta.totalTokens).toBe(160);
  });

  it('renders a readable table naming both modes and the delta', () => {
    const text = formatCapabilityParity(compareCapabilityRuns(mkRun([mkResult()]), mkRun([mkResult()])));
    expect(text).toContain('balanced');
    expect(text).toContain('max');
    expect(text).toContain('delta');
  });
});

describe('runCapabilityParity — exercises the REAL mode switch and restores it', () => {
  it('sets NUVIRA_CAPABILITY_MODE around each run, balanced then max, and restores', async () => {
    delete process.env.NUVIRA_CAPABILITY_MODE;
    const seen: Array<string | undefined> = [];
    const report = await runCapabilityParity({
      runSuite: async (mode) => {
        seen.push(process.env.NUVIRA_CAPABILITY_MODE);
        return mkRun([mkResult({ compositeScore: mode === 'max' ? 0.8 : 0.3 })]);
      },
    });
    expect(seen).toEqual(['balanced', 'max']);
    // Restored to the pre-run state (unset here).
    expect(process.env.NUVIRA_CAPABILITY_MODE).toBeUndefined();
    expect(report.max.avgComposite).toBeGreaterThan(report.balanced.avgComposite);
  });

  it('restores a PRE-EXISTING mode value even when a run throws', async () => {
    process.env.NUVIRA_CAPABILITY_MODE = 'balanced';
    await expect(
      runCapabilityParity({
        runSuite: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(process.env.NUVIRA_CAPABILITY_MODE).toBe('balanced');
  });
});
