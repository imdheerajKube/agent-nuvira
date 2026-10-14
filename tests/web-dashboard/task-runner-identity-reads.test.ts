/**
 * How many process-table reads a task costs, and whether it EVER costs one after
 * it is over.
 *
 * The identity read is the most expensive thing the task runner does: on Windows
 * it is a PowerShell/CIM snapshot, taken SYNCHRONOUSLY, so every read is time the
 * dashboard — and every task's output — is blocked for. Retrying it up to four
 * times PER TASK, including after the task had already exited, is what timed out
 * the 55-task history test at 150s on the release matrix (v3.5.2, with one retry,
 * passed the same test at the same budget).
 *
 * These tests pin the two rules that keep the cost bounded without weakening the
 * patience the retries exist for:
 *   - a task that has SETTLED is never read for again — and is not warned about an
 *     identity it no longer needs,
 *   - a task that is still RUNNING keeps every retry, records the identity from a
 *     later read, and still says so honestly when they all miss.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskRunner, type TaskEventPayload } from '../../src/web-dashboard/task-runner.js';
import { loadTasks } from '../../src/web-dashboard/task-registry.js';

/**
 * A read is counted and answered by the test, because the interesting question is
 * not what it returns but WHETHER IT HAPPENED. `answer` defaults to the real
 * platform read, so a test that does not care keeps the real behaviour.
 */
const liveness = vi.hoisted(() => ({
  reads: 0,
  answer: null as null | ((pid: number) => { found: boolean; command: string | null; startedAtText: string | null }),
}));

vi.mock('../../src/tools/process-liveness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/process-liveness.js')>();
  return {
    ...actual,
    lookupProcess: (pid: number) => {
      liveness.reads++;
      return liveness.answer ? liveness.answer(pid) : actual.lookupProcess(pid);
    },
  };
});

/** The Windows case this whole file is about: the pid is not in the snapshot yet. */
const NOT_FOUND = { found: false, command: null, startedAtText: null };

const FIXTURE = `
const mode = process.env.NUVIRA_TASK_FIXTURE_MODE || 'ok';
if (mode === 'ok') {
  console.log('fixture-ok');
  process.exit(0);
} else if (mode === 'sleep') {
  setTimeout(() => {}, 120000);
}
`;

let dir: string;
let entry: string;
let configDir: string;
let savedConfigDir: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-identity-reads-'));
  entry = join(dir, 'fixture.cjs');
  writeFileSync(entry, FIXTURE, 'utf-8');
  savedConfigDir = process.env.NUVIRA_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), 'buff-identity-reads-state-'));
  process.env.NUVIRA_CONFIG_DIR = configDir;
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = savedConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.NUVIRA_TASK_FIXTURE_MODE;
  liveness.answer = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRunner(): TaskRunner {
  return new TaskRunner({ execPath: process.execPath, cliEntry: entry, cwd: dir });
}

const logText = (runner: TaskRunner, id: string): string =>
  runner.get(id)!.logs.map((l) => l.text).join('\n');

function waitForStatus(
  runner: TaskRunner,
  id: string,
  timeoutMs = 15_000,
): Promise<TaskEventPayload['status'] | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for task status: ${id}`)), timeoutMs);
    const off = runner.onEvent((eid, payload) => {
      if (eid !== id || payload.kind !== 'status') return;
      clearTimeout(timer);
      off();
      resolve(payload.status);
    });
    const t = runner.get(id);
    if (t && t.status !== 'running') {
      clearTimeout(timer);
      off();
      resolve({ status: t.status, exitCode: t.exitCode, durationMs: t.durationMs });
    }
  });
}

/** The whole retry ladder is 250ms + 900ms + 2s after the read at spawn. */
const PAST_THE_LADDER_MS = 3_400;

describe('identity reads — one per spawn, and none for a task that is already over', () => {
  it('spends one read per spawn and NOT ONE MORE once the task has settled', async () => {
    liveness.answer = () => NOT_FOUND; // the read misses, so the retry ladder is armed
    liveness.reads = 0;
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok'; // exits at once: settled before the first retry is due
    const runner = makeRunner();
    const { task } = runner.start(['eval', 'run'], { timeoutMs: 10_000 });
    await waitForStatus(runner, task!.id);

    const afterSettle = liveness.reads;
    await sleep(PAST_THE_LADDER_MS);

    // The process is GONE: no read can say anything about it, so none is made.
    expect(liveness.reads).toBe(afterSettle);
    // One at spawn — plus at most one that raced the exit on a loaded runner.
    expect(afterSettle).toBeLessThanOrEqual(2);
    // …and nothing tells the operator that a FINISHED task can only be stopped by
    // hand, which is what the unfiltered ladder wrote into its log.
    expect(logText(runner, task!.id)).not.toContain('could not read this task');
  }, 20_000);

  it('keeps every retry while the task is RUNNING, and says so honestly when they all miss', async () => {
    liveness.answer = () => NOT_FOUND;
    liveness.reads = 0;
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep'; // still running through the whole ladder
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 0 });

    await sleep(PAST_THE_LADDER_MS);

    // The retries were not switched off wholesale: a live process keeps its patience.
    expect(liveness.reads).toBeGreaterThanOrEqual(3);
    // A task that is genuinely unidentifiable is still told the truth about it.
    expect(logText(runner, task!.id)).toContain('could not read this task');

    runner.cancel(task!.id);
    await waitForStatus(runner, task!.id);
  }, 20_000);

  it('records the identity from a LATER read — the patience exists for a reason', async () => {
    // First read misses (the fresh pid is not in the table yet), the retry finds it.
    liveness.answer = () =>
      liveness.reads === 1
        ? NOT_FOUND
        : { found: true, command: 'node fixture.cjs eval run', startedAtText: 'token-1' };
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    liveness.reads = 0; // hydrate() is done; count from here
    const { task } = runner.start(['sleep'], { timeoutMs: 0 });

    await sleep(1_200); // past the 250ms retry

    // Persisted — this is exactly what a restart reads back to re-verify the pid.
    const row = loadTasks().find((t) => t.id === task!.id);
    expect(row?.osCommand).toBe('node fixture.cjs eval run');
    expect(row?.osStartedAt).toBe('token-1');

    runner.cancel(task!.id);
    await waitForStatus(runner, task!.id);
  }, 20_000);
});
