/**
 * J2 — Cron scheduled-jobs tests (`src/gateway/cron.ts`).
 *
 * Plan acceptance: schedule parse + dry-run. Also covers persistence,
 * validation, and run-now via a registry tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate the cron store from the real ~/.buff/cron/jobs.json.
const homeHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-cron-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => homeHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import {
  addCronJob,
  listCronJobs,
  removeCronJob,
  dryRunCronJob,
  nextRunAt,
  runJobNow,
  type CronJob,
} from '../../src/gateway/cron.js';

beforeEach(() => {
  rmSync(join(homeHolder.value, '.buff', 'cron'), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(join(homeHolder.value, '.buff', 'cron'), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cron — schedule validation + dry-run', () => {
  it('accepts a valid 5-field cron expression', () => {
    expect(nextRunAt('0 3 * * *')).not.toBeNull();
    expect(nextRunAt('*/5 * * * *')).not.toBeNull();
  });

  it('rejects an invalid cron expression', () => {
    expect(nextRunAt('not a cron')).toBeNull();
    const result = addCronJob('bad', 'not a cron', 'build');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Invalid cron expression');
  });

  it('dry-run describes the job WITHOUT executing anything', () => {
    const dry = dryRunCronJob('nightly', '0 3 * * *', 'test', { goal: 'run tests' });
    expect(dry.ok).toBe(true);
    if (dry.ok) {
      expect(dry.description).toContain("tool 'test'");
      expect(dry.description).toContain('0 3 * * *');
      expect(dry.nextRun).not.toBe('never');
    }
  });

  it('dry-run rejects an unknown tool', () => {
    const dry = dryRunCronJob('x', '0 3 * * *', 'not_a_real_tool');
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.error).toContain('Unknown tool');
  });

  it('rejects args that violate the tool schema at add time (not at 3am)', () => {
    // 'build' requires an object; a non-object arg must fail fast.
    const bad = addCronJob('bad-args', '0 3 * * *', 'build', { goal: 42 } as unknown as Record<string, unknown>);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('Invalid args');
    expect(listCronJobs()).toHaveLength(0);
  });
});

describe('cron — persistence', () => {
  it('adds a job and persists it to ~/.buff/cron/jobs.json', () => {
    const result = addCronJob('nightly-build', '0 3 * * *', 'build', { goal: 'build all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.enabled).toBe(true);
    expect(result.job.lastRunAt).toBe(0);

    const path = join(homeHolder.value, '.buff', 'cron', 'jobs.json');
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0].name).toBe('nightly-build');
  });

  it('rejects a duplicate job name', () => {
    addCronJob('dup', '0 3 * * *', 'build');
    const second = addCronJob('dup', '0 4 * * *', 'test');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain('already exists');
  });

  it('rejects an invalid job name (sandbox)', () => {
    const bad = addCronJob('../evil', '0 3 * * *', 'build');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('Job name must be lowercase alphanumeric');
  });

  it('lists jobs sorted by name and removes by name', () => {
    addCronJob('beta', '0 3 * * *', 'build');
    addCronJob('alpha', '0 4 * * *', 'test');
    expect(listCronJobs().map((j) => j.name)).toEqual(['alpha', 'beta']);
    expect(removeCronJob('alpha')).toBe(true);
    expect(listCronJobs().map((j) => j.name)).toEqual(['beta']);
    expect(removeCronJob('nope')).toBe(false);
  });
});

describe('cron — run now', () => {
  it('invokes a registered tool and marks lastRunAt on success', async () => {
    const added = addCronJob('quick', '*/5 * * * *', 'build', { goal: 'x' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const { ok } = await runJobNow(added.job);
    expect(ok).toBe(true);

    const stored = listCronJobs().find((j) => j.name === 'quick') as CronJob;
    expect(stored.lastRunAt).toBeGreaterThan(0);
    // 'build' is a real pipeline tool (cold ESM start loads the orchestrator
    // + adapters) — Windows CI has measured ~7s, so budget well past vitest's
    // 5s default to keep the release pipeline green.
  }, 60_000);

  it('returns a clean error for an unknown tool (never throws)', async () => {
    const job: CronJob = {
      id: 'cron-x-1',
      name: 'broken',
      schedule: '0 3 * * *',
      tool: 'definitely_not_a_tool',
      args: {},
      createdAt: Date.now(),
      lastRunAt: 0,
      enabled: true,
    };
    const { ok, output } = await runJobNow(job);
    expect(ok).toBe(false);
    expect(output).toContain('Unknown tool');
  });

  it('persists a deliverTo channel on the job (J1 delivery wiring)', () => {
    const added = addCronJob('delivered', '0 3 * * *', 'code_search', {}, 'ops');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.job.deliverTo).toBe('ops');
    const stored = listCronJobs().find((j) => j.name === 'delivered');
    expect(stored?.deliverTo).toBe('ops');
  });

  it('run with an unknown deliverTo channel is best-effort (never throws)', async () => {
    // code_search is a fast local rg tool — the delivery path is what's tested.
    const added = addCronJob('deliver-unknown', '0 3 * * *', 'code_search', { pattern: 'vitest' }, 'missing-alias');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const { ok } = await runJobNow(added.job);
    // The run itself succeeds; only the delivery warns (best-effort).
    expect(ok).toBe(true);
    // Delivery builds the full adapter registry (baileys/twilio/irc/etc.) —
    // budget past the 5s default for slow CI runners.
  }, 60_000);
});
