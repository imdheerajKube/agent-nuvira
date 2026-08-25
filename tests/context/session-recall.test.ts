/**
 * D1 — Session recall: unit tests for src/context/session-recall.ts.
 *
 * Covers:
 * 1. textRangeToEpoch — deterministic temporal parsing ("yesterday" / ranges)
 *    with a fixed reference date (no clock dependence).
 * 2. autoRecall with no prior work — empty result, graceful card.
 * 3. autoRecall composing workspace row + sessions + facts + checkpoint into
 *    the recall card and the injected context block.
 * 4. Temporal scoping of sessions (explicit epoch range) — the "continue last
 *    week's plan" filter path.
 *
 * Facts are spied (retrieveFacts) so no embedding/vector I/O happens. History
 * + checkpoints run against a temp homedir / BUFF_MEMORY_DIR (module-level
 * constants are evaluated once at import, so homedir is mocked at hoist time).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Mock } from 'vitest';

const testDirHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-recall-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testDirHolder.value,
}));

vi.mock('../../src/memory/embedder.js', () => ({
  embed: vi.fn(),
  EMBEDDING_DIM: 384,
  clearEmbeddingCache: vi.fn(),
  embeddingCacheSize: vi.fn().mockReturnValue(0),
  resetEmbeddingTierCache: vi.fn(),
  setForceLLM: vi.fn(),
  isXenovaAvailable: vi.fn().mockResolvedValue(false),
  isPythonAvailable: vi.fn().mockResolvedValue(false),
  getActiveEmbeddingTier: vi.fn().mockResolvedValue('llm (fallback, 384-dim)'),
}));

import {
  autoRecall,
  maybeAutoRecall,
  recallCard,
  recallContextBlock,
  readRecallHits,
  recordRecallHit,
  resetRecallHitDedupe,
  textRangeToEpoch,
} from '../../src/context/session-recall.js';
import { getChatHistory } from '../../src/context/history.js';
import { getFactStore, resetFactStore } from '../../src/memory/fact-store.js';
import {
  WorkspaceStore,
  deriveProjectId,
  resetWorkspaceStore,
} from '../../src/config/workspace.js';
import { saveCheckpoint } from '../../src/agents/checkpoint-store.js';

const ORIGINAL_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeAll(() => {
  process.env.NUVIRA_MEMORY_DIR = join(testDirHolder.value, 'memory');
});

afterAll(() => {
  if (ORIGINAL_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIGINAL_MEMORY_DIR;
  rmSync(testDirHolder.value, { recursive: true, force: true });
});

let workspace: WorkspaceStore;
let cwd: string;
let projectId: string;

beforeEach(() => {
  resetWorkspaceStore();
  // Wipe the per-test config dir so each test starts with an EMPTY project
  // registry (the store re-reads its on-disk DB/JSON on construction).
  const configDir = join(testDirHolder.value, 'config');
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch { /* noop */ }
  workspace = new WorkspaceStore(configDir);
  getChatHistory().clear();
  cwd = join(testDirHolder.value, 'repo');
  projectId = deriveProjectId(cwd).id;
  // The temp BUFF_MEMORY_DIR also persists — clear checkpoints written by
  // earlier tests so each test starts clean.
  try {
    rmSync(join(process.env.NUVIRA_MEMORY_DIR!, 'checkpoints'), { recursive: true, force: true });
  } catch { /* noop */ }
});

afterEach(() => {
  getChatHistory().clear();
  resetFactStore();
  resetWorkspaceStore();
});

describe('textRangeToEpoch', () => {
  it('resolves "yesterday" to the previous calendar day (24h window) at a fixed reference date', () => {
    const ref = new Date('2026-08-09T12:00:00.000Z');
    const range = textRangeToEpoch('continue yesterday', ref);
    expect(range).toBeDefined();
    expect(range!.start).toBe(Date.parse('2026-08-08'));
    expect(range!.end).toBe(range!.start! + 24 * 60 * 60 * 1000 - 1);
  });

  it('resolves a date range ("last week") to start + end', () => {
    const ref = new Date('2026-08-09T12:00:00.000Z');
    const range = textRangeToEpoch('continue last week', ref);
    expect(range).toBeDefined();
    expect(range!.start).toBeDefined();
    expect(range!.end).toBeDefined();
    expect(range!.end!).toBeGreaterThan(range!.start!);
  });

  it('returns undefined for text with no temporal reference', () => {
    const range = textRangeToEpoch('continue the checkout work', new Date('2026-08-09T12:00:00.000Z'));
    expect(range).toBeUndefined();
  });
});

describe('autoRecall', () => {
  it('returns an empty result when there is no prior work', async () => {
    const r = await autoRecall({ cwd, store: workspace });
    expect(r.projectId).toBe(projectId);
    expect(r.project).toBeNull();
    expect(r.sessionCount).toBe(0);
    expect(r.factCount).toBe(0);
    expect(r.resumedStep).toBeNull();
    expect(recallCard(r)).toContain('0 session(s)');
  });

  it('composes project row + sessions + facts + checkpoint into card and context block', async () => {
    workspace.recordRun({
      cwd,
      goal: 'build the ecommerce checkout',
      summary: 'checkout flow implemented',
      sessionId: 'session-1',
      success: true,
    });
    getChatHistory().storeSession(
      [{ role: 'user', content: 'build the ecommerce checkout', timestamp: Date.now() - 60_000 }],
      'groq', 'model', false, projectId,
    );

    // Spy facts so no embedding/vector I/O is needed.
    const factStore = getFactStore();
    const spy = vi.spyOn(factStore, 'retrieveFacts') as Mock;
    spy.mockResolvedValue([
      {
        id: 'f1',
        text: 'the app uses stripe for payments',
        projectId,
        agentRole: 'planner',
        tags: [],
        source: 'session-end',
        timestamp: Date.now(),
      },
    ] as any);

    // Checkpoint for this cwd: 2 of 8 steps done → resume at step 3.
    saveCheckpoint(
      {
        goal: 'build the ecommerce checkout',
        workingDirectory: cwd,
        taskPlan: Array.from({ length: 8 }, (_, i) => ({
          title: `step ${i}`,
          status: i < 2 ? 'completed' : 'pending',
        })),
      } as any,
      'cp-test',
    );

    const r = await autoRecall({ cwd, store: workspace, maxSessions: 8, maxFacts: 5 });
    expect(r.project).not.toBeNull();
    expect(r.project!.lastGoal).toContain('checkout');
    expect(r.sessionCount).toBe(1);
    expect(r.factCount).toBe(1);
    expect(r.resumedStep).toBe('step 3/8');

    const card = recallCard(r);
    expect(card).toContain('1 session(s)');
    expect(card).toContain('1 fact(s)');
    expect(card).toContain('step 3/8');

    const block = recallContextBlock(r);
    expect(block).toContain('Last goal: build the ecommerce checkout');
    expect(block).toContain('stripe for payments');

    spy.mockRestore();
  });

  it('returns null from maybeAutoRecall when there is nothing to recall', async () => {
    const r = await maybeAutoRecall(cwd, workspace);
    expect(r).toBeNull();
  });

  it('returns a result from maybeAutoRecall when prior work exists', async () => {
    workspace.recordRun({ cwd, goal: 'build the checkout', summary: 'done', success: true });
    getChatHistory().storeSession(
      [{ role: 'user', content: 'build the checkout', timestamp: Date.now() }],
      'groq', 'model', false, projectId,
    );
    const r = await maybeAutoRecall(cwd, workspace);
    expect(r).not.toBeNull();
    expect(r!.sessionCount).toBe(1);
  });

  it('scopes sessions by an explicit epoch range (temporal recall)', async () => {
    const history = getChatHistory();
    const now = Date.now();
    const weekAgo = now - 8 * 24 * 60 * 60 * 1000;
    history.storeSession(
      [{ role: 'user', content: 'old plan from weeks ago', timestamp: weekAgo }],
      'groq', 'model', false, projectId,
    );
    history.storeSession(
      [{ role: 'user', content: 'current plan this week', timestamp: now }],
      'groq', 'model', false, projectId,
    );

    const r = await autoRecall({
      cwd,
      store: workspace,
      timeRange: { start: now - 24 * 60 * 60 * 1000 },
    });
    expect(r.sessions.some((s) => s.summary.includes('current plan'))).toBe(true);
    expect(r.sessions.some((s) => s.summary.includes('weeks ago'))).toBe(false);
  });
});

describe('recall-hit telemetry (G2)', () => {
  beforeEach(() => {
    // The production code skips recording under VITEST (test-env guard); these
    // dedicated tests temporarily disable it to exercise the real write path.
    delete process.env.VITEST;
    resetRecallHitDedupe();
    // Fresh telemetry file per test.
    try {
      rmSync(join(process.env.NUVIRA_MEMORY_DIR!, 'recall-hits.jsonl'), { force: true });
    } catch { /* noop */ }
  });

  afterEach(() => {
    process.env.VITEST = 'true';
  });

  it('records a hit and reads it back with totals', () => {
    // BUFF_MEMORY_DIR is the temp dir from beforeAll — the JSONL lands there.
    recordRecallHit(projectId);
    recordRecallHit(projectId);
    recordRecallHit('repo:other');

    const hits = readRecallHits();
    expect(hits.total).toBeGreaterThanOrEqual(2);
    expect(hits.today).toBeGreaterThanOrEqual(2);
    expect(hits.last7d).toBeGreaterThanOrEqual(2);
    expect(hits.byProject[projectId]).toBeGreaterThanOrEqual(1);
    expect(hits.byProject['repo:other']).toBeGreaterThanOrEqual(1);
  });

  it('dedupes consecutive hits for the same project within the window', () => {
    recordRecallHit(projectId);
    recordRecallHit(projectId); // same project, immediate → deduped
    recordRecallHit(projectId);
    const hits = readRecallHits();
    expect(hits.byProject[projectId]).toBe(1);
  });

  it('autoRecall records a hit only when it returns something', async () => {
    // Nothing to recall → no hit recorded.
    await autoRecall({ cwd, store: workspace });
    expect(readRecallHits().total).toBe(0);

    // Prior work → hit recorded.
    workspace.recordRun({ cwd, goal: 'build the checkout', summary: 'done', success: true });
    getChatHistory().storeSession(
      [{ role: 'user', content: 'build the checkout', timestamp: Date.now() }],
      'groq', 'model', false, projectId,
    );
    await autoRecall({ cwd, store: workspace });
    expect(readRecallHits().total).toBeGreaterThanOrEqual(1);
  });

  it('never throws on a missing or corrupt file', () => {
    expect(readRecallHits().total).toBe(0);
    expect(() => recordRecallHit('x')).not.toThrow();
  });
});
