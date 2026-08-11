/**
 * K1 + K2 — structured logging (correlation IDs + JSON mode) and runtime
 * metrics (counters/timers + persistence).
 *
 * Hermetic: BUFF_MEMORY_DIR + BUFF_ENV_FILE point at temp dirs so metrics
 * persistence never touches the real ~/.buff store.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  withLogCorrelation,
  getLogCorrelation,
  isJsonLogMode,
  jsonLogLine,
} from '../../src/enterprise/log.js';
import {
  getMetrics,
  resetMetrics,
  countMetric,
  recordMetricTime,
  type MetricsSnapshot,
} from '../../src/enterprise/metrics.js';

// ─── Hermetic dirs ──────────────────────────────────────────────────────────

let memDir: string;

beforeAll(() => {
  memDir = mkdtempSync(join(tmpdir(), 'buff-k1k2-test-'));
  process.env.BUFF_MEMORY_DIR = memDir;
});

afterAll(() => {
  delete process.env.BUFF_MEMORY_DIR;
  delete process.env.BUFF_LOG_JSON;
  rmSync(memDir, { recursive: true, force: true });
  resetMetrics();
});

// ─── K1: correlation carrier + JSON mode ────────────────────────────────────

describe('K1 structured logging', () => {
  it('threads correlation IDs through the async context', async () => {
    let seen: string | undefined;
    await withLogCorrelation({ sessionId: 'sess-1', taskId: 'task-9' }, async () => {
      // Simulate nested async work inside the correlated scope.
      await new Promise((r) => setTimeout(r, 5));
      seen = getLogCorrelation().sessionId;
    });
    expect(seen).toBe('sess-1');
    // Outside the scope: no correlation leaks.
    expect(getLogCorrelation().sessionId).toBeUndefined();
  });

  it('merges child correlation with the parent context', async () => {
    const seen: string[] = [];
    await withLogCorrelation({ sessionId: 'sess-2', runId: 'run-1' }, async () => {
      await withLogCorrelation({ taskId: 'task-3' }, async () => {
        const c = getLogCorrelation();
        seen.push(c.sessionId!, c.runId!, c.taskId!);
      });
    });
    expect(seen).toEqual(['sess-2', 'run-1', 'task-3']);
  });

  it('jsonLogLine includes correlation + primitive args, and is valid JSON', () => {
    const line = withLogCorrelation({ sessionId: 's', taskId: 't' }, () =>
      jsonLogLine('info', 'task done', [42, 'extra']),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('task done');
    expect(parsed.sessionId).toBe('s');
    expect(parsed.taskId).toBe('t');
    expect(parsed.arg0).toBe(42);
    expect(parsed.arg1).toBe('extra');
  });

  it('isJsonLogMode reads BUFF_LOG_JSON', () => {
    const prev = process.env.BUFF_LOG_JSON;
    process.env.BUFF_LOG_JSON = '1';
    expect(isJsonLogMode()).toBe(true);
    process.env.BUFF_LOG_JSON = '0';
    expect(isJsonLogMode()).toBe(false);
    if (prev === undefined) delete process.env.BUFF_LOG_JSON;
    else process.env.BUFF_LOG_JSON = prev;
  });
});

// ─── K2: metrics store ──────────────────────────────────────────────────────

describe('K2 runtime metrics', () => {
  it('counts, times, snapshots and persists', () => {
    resetMetrics();
    countMetric('memory.hits', 2);
    countMetric('memory.misses');
    recordMetricTime('rule.parse.ms', () => {
      const start = Date.now();
      // Busy-wait ~2ms so the timer records a real observation.
      while (Date.now() - start < 2) { /* spin */ }
    });

    const snap: MetricsSnapshot = getMetrics().snapshot();
    expect(snap.counters['memory.hits']).toBe(2);
    expect(snap.counters['memory.misses']).toBe(1);
    expect(snap.timers['rule.parse.ms'].count).toBe(1);
    expect(snap.timers['rule.parse.ms'].maxMs).toBeGreaterThanOrEqual(2);

    getMetrics().save();

    // A FRESH store (after reset) reloads the persisted file.
    resetMetrics();
    const reloaded = getMetrics().snapshot();
    expect(reloaded.counters['memory.hits']).toBe(2);
    expect(reloaded.timers['rule.parse.ms'].count).toBe(1);
  });

  it('recordMetricTime times async functions too', async () => {
    resetMetrics();
    await getMetrics().time('llm.answer.ms', async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const t = getMetrics().snapshot().timers['llm.answer.ms'];
    expect(t.count).toBe(1);
    expect(t.maxMs).toBeGreaterThanOrEqual(5);
  });
});
