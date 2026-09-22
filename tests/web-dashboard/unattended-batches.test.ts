/**
 * G27 — the per-batch cost & latency report reaches the DASHBOARD, not only the
 * CLI.
 *
 * WHY. `nuvira execute` prints a per-batch table when an unattended run ends.
 * The dashboard's Run Timeline showed the same run as a percentage, so "what
 * did this cost" and "is it slowing down" were answerable only from a terminal.
 * `/api/unattended-jobs` now serves the SAME persisted `batchStats` rows, so
 * the two surfaces cannot disagree.
 *
 * The load-bearing assertion is the NEGATIVE one: a batch the surface never
 * metered must serialize with the fields ABSENT, never as 0 — otherwise an
 * unmetered batch renders as "free", which is the accounting lie the CLI's
 * dash exists to prevent.
 *
 * Real HTTP against a server on a random port, hermetic memory dir.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP_BASE = process.env.TMPDIR || process.env.TMP || '/tmp';
const testDir = mkdtempSync(join(TMP_BASE, 'buff-unattended-batches-'));
const memoryDir = join(testDir, '.nuvira', 'memory');
mkdirSync(memoryDir, { recursive: true });

// Env MUST be set before importing the server (values are read at import time).
process.env.NUVIRA_DASHBOARD_PORT = '0';
process.env.NUVIRA_DASHBOARD_HOST = '127.0.0.1';
process.env.NUVIRA_MEMORY_DIR = memoryDir;
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');
// HOME pin keeps homedir()-resolved stores off the developer's real ~/.nuvira.
process.env.HOME = testDir;

const { createDashboardServer, readUnattendedJobs } = await import(
  '../../src/web-dashboard/server.js'
);
const { startUnattendedJob, recordBatchOutcome, clearUnattendedJobs } = await import(
  '../../src/learning/unattended-job.js'
);

let server: ReturnType<typeof createDashboardServer>;
let baseUrl = '';

beforeAll(async () => {
  server = createDashboardServer();
  const addr = await new Promise<{ port: number }>((resolve) => {
    server.server.once('listening', () => resolve(server.server.address() as { port: number }));
    server.server.listen(0, '127.0.0.1');
  });
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  clearUnattendedJobs();
  await new Promise<void>((resolve) => server.server.close(() => resolve()));
  rmSync(testDir, { recursive: true, force: true });
});

describe('dashboard per-batch cost & latency (G27)', () => {
  it('serves every batch, including a failure and a batch that measured nothing', async () => {
    clearUnattendedJobs();
    const { job } = startUnattendedJob({
      kind: 'long-form',
      goal: 'write a 100 page book to /tmp/book.md',
      projectPath: testDir,
      surface: { platform: 'dashboard', channelId: 'test' },
    });

    // Batch 1 — fully measured.
    recordBatchOutcome(job.id, {
      progress: 12,
      progressLine: 'chapter 5/39',
      durationMs: 61_000,
      costUsd: 0.00412,
      tokens: 12_345,
    });
    // Batch 2 — FAILED and never metered. It must keep its row, and its
    // unmeasured cost must stay undefined rather than becoming 0.
    recordBatchOutcome(job.id, {
      progress: 24,
      progressLine: 'chapter 10/39',
      error: 'provider 429 rate limited',
    });

    const { total, jobs } = readUnattendedJobs();
    expect(total).toBe(1);

    const view = jobs[0];
    expect(view.batchStats).toHaveLength(2);

    expect(view.batchStats[0]).toMatchObject({
      index: 1,
      progress: 12,
      costUsd: 0.00412,
      tokens: 12_345,
      durationMs: 61_000,
    });

    // The failed batch keeps its row and its reason…
    expect(view.batchStats[1].index).toBe(2);
    expect(view.batchStats[1].error).toMatch(/429/);

    // …and its UNMEASURED economy is absent, not zero.
    expect(view.batchStats[1].costUsd).toBeUndefined();
    expect(view.batchStats[1].tokens).toBeUndefined();
    expect(view.batchStats[1].durationMs).toBeUndefined();
    expect('costUsd' in view.batchStats[1]).toBe(false);

    // Totals are the MEASURED sums, not a count of batches.
    expect(view.costUsd).toBeCloseTo(0.00412, 10);
    expect(view.tokens).toBe(12_345);
    expect(view.batches).toBe(2);
  });

  it('exposes the same rows over HTTP at /api/unattended-jobs', async () => {
    const res = await fetch(`${baseUrl}/api/unattended-jobs`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      total: number;
      jobs: Array<{ batchStats: Array<Record<string, unknown>> }>;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const rows = body.jobs[0].batchStats;
    expect(rows).toHaveLength(2);
    // JSON round-trip must not invent a 0 for the unmetered batch.
    expect(rows[1].costUsd).toBeUndefined();
  });

  it('renders without throwing when the store is empty', () => {
    clearUnattendedJobs();
    expect(readUnattendedJobs()).toEqual({ total: 0, jobs: [] });
  });
});
