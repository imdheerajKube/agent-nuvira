/**
 * P1 — TaskRunner unit tests.
 *
 * Spawns fixture scripts (node <entry> <args>) so the tests are hermetic —
 * no real CLI, no network. Covers: stdout/stderr capture, exit-code mapping,
 * args pass-through, cancel (SIGTERM), timeout (SIGTERM→SIGKILL), input
 * validation, history cap, and CLI-entry resolution.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskRunner, type TaskEventPayload } from '../../src/web-dashboard/task-runner.js';

const FIXTURE = `
const mode = process.env.BUFF_TASK_FIXTURE_MODE || 'ok';
if (mode === 'ok') {
  console.log('fixture-ok');
  console.error('fixture-err');
  process.exit(0);
} else if (mode === 'fail') {
  console.log('fixture-fail');
  process.exit(3);
} else if (mode === 'echo') {
  console.log('ARGV:' + process.argv.slice(2).join('|'));
  process.exit(0);
} else if (mode === 'sleep') {
  setTimeout(() => {}, 120000);
}
`;

let dir: string;
let entry: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-task-runner-'));
  entry = join(dir, 'fixture.cjs');
  writeFileSync(entry, FIXTURE, 'utf-8');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.BUFF_TASK_FIXTURE_MODE;
});

function makeRunner(): TaskRunner {
  return new TaskRunner({ execPath: process.execPath, cliEntry: entry, cwd: dir });
}

/** Resolve the terminal status event for a task (subscribes first, then checks state). */
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

describe('TaskRunner', () => {
  it('captures stdout+stderr and settles done on exit 0', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'ok';
    const runner = makeRunner();
    const { ok, task } = runner.start(['--whatever'], { timeoutMs: 10_000 });
    expect(ok).toBe(true);
    expect(task!.status).toBe('running');

    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('done');
    expect(status!.exitCode).toBe(0);
    expect(typeof status!.durationMs).toBe('number');

    const record = runner.get(task!.id)!;
    expect(record.status).toBe('done');
    const text = record.logs.map((l) => l.text).join('\n');
    expect(text).toContain('fixture-ok');
    expect(text).toContain('fixture-err');
  });

  it('marks failed with the exit code on non-zero exit', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'fail';
    const runner = makeRunner();
    const { task } = runner.start(['x'], { timeoutMs: 10_000 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('failed');
    expect(status!.exitCode).toBe(3);
  });

  it('passes args through to the CLI entry', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'echo';
    const runner = makeRunner();
    const { task } = runner.start(['eval', 'run', '--task', 'smoke-test'], { timeoutMs: 10_000 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('done');
    const text = runner.get(task!.id)!.logs.map((l) => l.text).join('\n');
    expect(text).toContain('ARGV:eval|run|--task|smoke-test');
  });

  it('cancel() terminates a long-running task → cancelled', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 60_000 });
    // Give the child a tick to spawn before SIGTERM.
    await new Promise((r) => setTimeout(r, 250));
    expect(runner.cancel(task!.id)).toBe(true);
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('cancelled');
  });

  it('timeout kills a long-running task → timeout', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 300 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('timeout');
  });

  it('timeoutMs 0 means NO timeout — the task keeps running until cancelled', async () => {
    // Regression: the dashboard's "Start gateway" preset used the default
    // 5-minute task timeout, so a foreground gateway was SIGTERM'd while the
    // user believed it was still running. timeoutMs 0 = run forever.
    process.env.BUFF_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 0 });
    // Well past the 300ms timeout of the test above: it must STILL be running.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(runner.get(task!.id)!.status).toBe('running');
    expect(runner.cancel(task!.id)).toBe(true);
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('cancelled');
  }, 15_000);

  it('rejects empty args, non-string args, and oversized arg lists', () => {
    const runner = makeRunner();
    expect(runner.start([]).ok).toBe(false);
    expect(runner.start(['x', 42 as unknown as string]).ok).toBe(false);
    expect(runner.start(Array.from({ length: 51 }, () => 'x')).ok).toBe(false);
    expect(runner.start(['a'.repeat(513)]).ok).toBe(false);
  });

  // Spawning 55 children SEQUENTIALLY (awaiting each) blew both vitest's
  // default and the per-task 15s wait on loaded Windows runners — spawn them
  // all (they're instant-exit 'ok' fixtures), then wait for the whole batch
  // with one generous deadline (Windows-CI hardening).
  it('list() returns newest first and caps history at 50', async () => {
    process.env.BUFF_TASK_FIXTURE_MODE = 'ok';
    const runner = makeRunner();
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const { task } = runner.start([`t${i}`], { timeoutMs: 30_000 });
      ids.push(task!.id);
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (runner.list().every((t) => t.status !== 'running')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const list = runner.list();
    expect(list.every((t) => t.status !== 'running')).toBe(true);
    expect(list.length).toBeLessThanOrEqual(50);
    expect(list[0].id).toBe(ids[ids.length - 1]); // newest first
  }, 150_000);

  it('reports a missing CLI entry as a validation error', () => {
    const r = new TaskRunner({ execPath: process.execPath, cliEntry: join(dir, 'nope.cjs') });
    const res = r.start(['x']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('resolves the real CLI entry for the default runner', () => {
    const r = new TaskRunner();
    expect(r.cliEntry().replace(/\\/g, '/')).toMatch(/dist\/index\.js$/);
  });
});
