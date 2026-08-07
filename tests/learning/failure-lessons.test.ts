/**
 * FailureLessonStore Tests — episodic memory of "what didn't work" (assessment P1).
 *
 * Covers:
 * - recordFailure: captures failed runs, prunes beyond the cap, skips runs
 *   with no failed-agent signal, honors BUFF_MEMORY_DIR
 * - extractLessons: LLM-distills lessons from recent failures, dedupes by
 *   title, caps at MAX_LESSONS, never throws on bad LLM output
 * - formatAsPrompt: domain-matched + fallback formatting, marks lessons used
 * - getStats / getFailedRuns / getLessons / clear
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFailureLessonStore, FailureLessonStore } from '../../src/learning/failure-lessons.js';
import type { TaskStep } from '../../src/agents/agent.js';

// ─── Hermetic memory dir ────────────────────────────────────────────────────

let memDir: string;
const ORIGINAL_MEMORY_DIR = process.env.BUFF_MEMORY_DIR;

beforeAll(() => {
  memDir = mkdtempSync(join(tmpdir(), 'failure-lessons-test-'));
  process.env.BUFF_MEMORY_DIR = memDir;
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(memDir, { recursive: true, force: true });
});

// ─── Fresh store per test ───────────────────────────────────────────────────

let store: FailureLessonStore;

beforeEach(() => {
  store = new FailureLessonStore();
  store.clear();
});

afterEach(() => {
  store.clear();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTaskPlan(): TaskStep[] {
  return [
    { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
    { id: 'step-2', description: 'Write auth middleware', agentType: 'writer', dependsOn: ['step-1'], status: 'failed' },
    { id: 'step-3', description: 'Run tests', agentType: 'tester', dependsOn: ['step-2'], status: 'failed' },
  ];
}

function makeFailure(overrides: Partial<Parameters<FailureLessonStore['recordFailure']>[0]> = {}) {
  return {
    goal: 'add JWT auth to the API',
    error: 'Writer failed: LLM returned malformed output',
    agentResults: [
      { agent: 'Planner', success: true, summary: 'Created 3 steps' },
      { agent: 'Writer', success: false, summary: 'LLM returned malformed output' },
      { agent: 'Tester', success: false, summary: 'No tests to run — build broken' },
    ],
    taskPlan: makeTaskPlan(),
    fileChanges: '  📄 src/routes/auth.ts (created)\n  ✏️ src/middleware/jwt.ts (modified)',
    tasksCompleted: 1,
    tasksTotal: 3,
    ...overrides,
  };
}

const goodLessonLLM = async (): Promise<string> => JSON.stringify([
  {
    title: 'Long pipelines exhaust free-tier quota mid-run',
    applicableDomains: ['typescript', 'node'],
    description: 'Early steps burn the quota; later steps fail with rate limits. Route cheap steps to free tier and checkpoint after each batch.',
  },
]);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('FailureLessonStore — recordFailure', () => {
  it('captures a failed run with goal, failed agents, plan, and files', () => {
    const id = store.recordFailure(makeFailure());
    expect(id.startsWith('fail-')).toBe(true);

    const runs = store.getFailedRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].goal).toBe('add JWT auth to the API');
    expect(runs[0].failedAgents).toHaveLength(2);
    expect(runs[0].failedAgents.map((a) => a.agent)).toEqual(['Writer', 'Tester']);
    expect(runs[0].taskPlan).toHaveLength(3);
    expect(runs[0].fileChanges).toHaveLength(2);
    expect(runs[0].tasksCompleted).toBe(1);
    expect(runs[0].tasksTotal).toBe(3);
  });

  it('skips runs with no failed-agent signal (nothing to learn from)', () => {
    const id = store.recordFailure(makeFailure({
      agentResults: [{ agent: 'Planner', success: true, summary: 'ok' }],
    }));
    expect(id).toBe('');
    expect(store.getFailedRuns()).toHaveLength(0);
  });

  it('persists across instances (same file)', () => {
    store.recordFailure(makeFailure({ goal: 'persist me' }));
    const second = new FailureLessonStore();
    expect(second.getFailedRuns()).toHaveLength(1);
    expect(second.getFailedRuns()[0].goal).toBe('persist me');
  });

  it('returns empty array when no failures recorded', () => {
    expect(store.getFailedRuns()).toEqual([]);
  });
});

describe('FailureLessonStore — extractLessons', () => {
  it('distills lessons from recorded failures', async () => {
    store.recordFailure(makeFailure());
    const count = await store.extractLessons(goodLessonLLM);
    expect(count).toBe(1);

    const lessons = store.getLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].title).toBe('Long pipelines exhaust free-tier quota mid-run');
    expect(lessons[0].sourceCount).toBe(1);
    expect(lessons[0].usageCount).toBe(0);
    expect(lessons[0].applicableDomains).toEqual(['typescript', 'node']);
  });

  it('returns 0 and does not throw when no failures exist', async () => {
    const count = await store.extractLessons(goodLessonLLM);
    expect(count).toBe(0);
    expect(store.getLessons()).toEqual([]);
  });

  it('only distills NEW failures past the cursor (no re-extraction waste)', async () => {
    // First failure → distilled → lesson extracted.
    store.recordFailure(makeFailure({ goal: 'first failure' }));
    let count = await store.extractLessons(goodLessonLLM);
    expect(count).toBe(1);

    // Same failure again — no new runs past the cursor → no LLM call, no new lessons.
    let calls = 0;
    const countingLLM = async (): Promise<string> => {
      calls++;
      return JSON.stringify([
        { title: 'Should never be called', applicableDomains: ['x'], description: 'x' },
      ]);
    };
    count = await store.extractLessons(countingLLM);
    expect(count).toBe(0);
    expect(calls).toBe(0); // cursor blocked the wasted call

    // A NEW failure is distilled (a different lesson title this time).
    store.recordFailure(makeFailure({ goal: 'second failure' }));
    const secondLessonLLM = async (): Promise<string> => JSON.stringify([
      {
        title: 'Writer output parsing fails on malformed JSON',
        applicableDomains: ['typescript'],
        description: 'Validate JSON before applying edits.',
      },
    ]);
    count = await store.extractLessons(secondLessonLLM);
    expect(count).toBe(1);
    expect(store.getLessons()).toHaveLength(2);
  });

  it('dedupes lessons by title (case-insensitive), updating in place', async () => {
    store.recordFailure(makeFailure({ goal: 'first failure' }));
    await store.extractLessons(goodLessonLLM);

    // A NEW failure run must be recorded for the cursor to pass it to the
    // next extraction; the LLM returns the same title (different case), which
    // dedupes and updates in place instead of adding.
    store.recordFailure(makeFailure({ goal: 'second failure' }));
    const updatedLLM = async (): Promise<string> => JSON.stringify([
      {
        title: 'LONG PIPELINES EXHAUST FREE-TIER QUOTA MID-RUN',
        applicableDomains: ['typescript', 'node'],
        description: 'Updated description.',
      },
    ]);
    const count = await store.extractLessons(updatedLLM);
    expect(count).toBe(0); // deduped, not added

    const lessons = store.getLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0].description).toBe('Updated description.');
  });

  it('never throws on malformed LLM output', async () => {
    store.recordFailure(makeFailure());
    const badLLM = async (): Promise<string> => 'This is not JSON at all';
    const count = await store.extractLessons(badLLM);
    expect(count).toBe(0);
    expect(store.getLessons()).toEqual([]);
  });

  it('handles lessons wrapped in a ```json code block', async () => {
    store.recordFailure(makeFailure());
    const blockLLM = async (): Promise<string> =>
      'Here you go:\n```json\n' + JSON.stringify([
        { title: 'From code block', applicableDomains: ['go'], description: 'A lesson from a code block.' },
      ]) + '\n```';
    const count = await store.extractLessons(blockLLM);
    expect(count).toBe(1);
    expect(store.getLessons()[0].title).toBe('From code block');
  });

  it('filters entries missing required fields', async () => {
    store.recordFailure(makeFailure());
    const partialLLM = async (): Promise<string> => JSON.stringify([
      { title: 'No domains or description here' },
      { title: 'Good lesson', applicableDomains: ['rust'], description: 'A complete lesson.' },
    ]);
    const count = await store.extractLessons(partialLLM);
    expect(count).toBe(1);
    expect(store.getLessons()[0].title).toBe('Good lesson');
  });
});

describe('FailureLessonStore — formatAsPrompt', () => {
  it('returns empty string when no lessons exist', () => {
    expect(store.formatAsPrompt()).toBe('');
  });

  it('formats lessons and marks them used', async () => {
    store.recordFailure(makeFailure());
    await store.extractLessons(goodLessonLLM);

    const prompt = store.formatAsPrompt(['typescript']);
    expect(prompt).toContain('LESSONS learned from past FAILED executions');
    expect(prompt).toContain('Long pipelines exhaust free-tier quota mid-run');

    // markUsed increments usageCount
    const lessons = store.getLessons();
    expect(lessons[0].usageCount).toBeGreaterThan(0);
  });

  it('prefers domain-matched lessons and falls back to recent when no tags', async () => {
    store.recordFailure(makeFailure());
    await store.extractLessons(goodLessonLLM);

    expect(store.formatAsPrompt(['typescript'])).toContain('Long pipelines');
    // No tags → falls back to recent lessons
    expect(store.formatAsPrompt(undefined)).toContain('Long pipelines');
  });
});

describe('FailureLessonStore — stats & clear', () => {
  it('reports accurate stats', async () => {
    store.recordFailure(makeFailure());
    store.recordFailure(makeFailure({ goal: 'second failure' }));
    await store.extractLessons(goodLessonLLM);

    const stats = store.getStats();
    expect(stats.totalFailures).toBe(2);
    expect(stats.totalLessons).toBe(1);
    expect(stats.domainsCovered).toContain('typescript');
  });

  it('clear removes both failed runs and lessons', async () => {
    store.recordFailure(makeFailure());
    await store.extractLessons(goodLessonLLM);
    expect(store.getFailedRuns()).toHaveLength(1);
    expect(store.getLessons()).toHaveLength(1);

    store.clear();
    expect(store.getFailedRuns()).toHaveLength(0);
    expect(store.getLessons()).toHaveLength(0);
  });

  it('singleton getFailureLessonStore returns a stable instance', () => {
    expect(getFailureLessonStore()).toBe(getFailureLessonStore());
  });
});
