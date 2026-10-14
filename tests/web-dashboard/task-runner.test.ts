/**
 * P1 — TaskRunner unit tests.
 *
 * Spawns fixture scripts (node <entry> <args>) so the tests are hermetic —
 * no real CLI, no network. Covers: stdout/stderr capture, exit-code mapping,
 * args pass-through, cancel (SIGTERM), timeout (SIGTERM→SIGKILL), input
 * validation, history cap, and CLI-entry resolution.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { killProcessTree, lookupProcess } from '../../src/tools/process-liveness.js';
import { saveTask } from '../../src/web-dashboard/task-registry.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TaskRunner,
  isLongLivedCommand,
  type TaskEventPayload,
} from '../../src/web-dashboard/task-runner.js';

const FIXTURE = `
const mode = process.env.NUVIRA_TASK_FIXTURE_MODE || 'ok';
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
} else if (mode === 'tick') {
  setInterval(() => console.log('tick'), 80);
}
`;

let dir: string;
let entry: string;
let savedConfigDir: string | undefined;
let configDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-task-runner-'));
  entry = join(dir, 'fixture.cjs');
  writeFileSync(entry, FIXTURE, 'utf-8');
  // The runner now persists its tasks (that is P0), so the tests have to point
  // that state at a throwaway dir — otherwise they write the developer's real
  // ~/.nuvira/dashboard-tasks and read back whatever a previous run left there.
  savedConfigDir = process.env.NUVIRA_CONFIG_DIR;
  configDir = mkdtempSync(join(tmpdir(), 'buff-task-runner-state-'));
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
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok';
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
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'fail';
    const runner = makeRunner();
    const { task } = runner.start(['x'], { timeoutMs: 10_000 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('failed');
    expect(status!.exitCode).toBe(3);
  });

  it('passes args through to the CLI entry', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'echo';
    const runner = makeRunner();
    const { task } = runner.start(['eval', 'run', '--task', 'smoke-test'], { timeoutMs: 10_000 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('done');
    const text = runner.get(task!.id)!.logs.map((l) => l.text).join('\n');
    expect(text).toContain('ARGV:eval|run|--task|smoke-test');
  });

  it('cancel() terminates a long-running task → cancelled', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 60_000 });
    // Give the child a tick to spawn before SIGTERM.
    await new Promise((r) => setTimeout(r, 250));
    expect(runner.cancel(task!.id)).toBe(true);
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('cancelled');
  });

  it('timeout kills a long-running task → timeout', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    const runner = makeRunner();
    const { task } = runner.start(['sleep'], { timeoutMs: 300 });
    const status = await waitForStatus(runner, task!.id);
    expect(status!.status).toBe('timeout');
  });

  it('timeoutMs 0 means NO timeout — the task keeps running until cancelled', async () => {
    // Regression: the dashboard's "Start gateway" preset used the default
    // 5-minute task timeout, so a foreground gateway was SIGTERM'd while the
    // user believed it was still running. timeoutMs 0 = run forever.
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
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
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok';
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

/**
 * P0 — the task outlives the dashboard.
 *
 * The defect: restarting the dashboard left the child running with nothing in the
 * world that knew its pid. The console came back empty, so live work could not be
 * seen, collected or stopped. These tests pin the three answers that matter — the
 * list and log pane come back, a live task is RE-ATTACHED, and a task that is
 * gone is settled honestly instead of being reported as still running forever.
 */
describe('P0 — a task outlives the dashboard that started it', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const logText = (runner: TaskRunner, id: string): string =>
    runner.get(id)!.logs.map((l) => l.text).join('\n');

  beforeEach(() => {
    process.env.NUVIRA_TASK_HANG_POLL_MS = '200';
  });

  afterEach(() => {
    delete process.env.NUVIRA_TASK_HANG_POLL_MS;
  });

  it('a restart brings back the LIST and the LOGS, and the task can still be stopped', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'tick';
    const first = makeRunner();
    const { task } = first.start(['eval', 'run'], { timeoutMs: 0 });
    const id = task!.id;
    // Past the identity retry, so the record carries the process's identity (see
    // `captureIdentity`): without it a recovered task could only be stopped by hand.
    await sleep(800);

    // RESTART: a new runner, the same config dir — the child is untouched.
    const restarted = makeRunner();
    const recovered = restarted.get(id);
    expect(recovered, 'the list came back').toBeDefined();
    expect(recovered!.status).toBe('running');
    expect(recovered!.pid).toBe(task!.pid);
    // THE PANE: output produced before the restart is still readable.
    expect(logText(restarted, id)).toContain('tick');
    // …and it was RE-VERIFIED as the process this dashboard started.
    expect(recovered!.recovered?.verified, recovered!.recovered?.why).toBe(true);

    // So it is still stoppable — the operator's whole reason for wanting it back.
    expect(restarted.cancel(id)).toBe(true);
    await sleep(1_200);
    expect(restarted.get(id)!.status).toBe('cancelled');
  }, 30_000);

  it('settles a recovered task whose pid is GONE — with no invented exit code', async () => {
    // Driven from the registry rather than from a live runner, because a runner
    // that is still alive would have seen the exit itself. Written by hand, this
    // is exactly what a dashboard crash leaves behind: status running, a pid that
    // no longer exists.
    const { spawn } = await import('node:child_process');
    const victim = spawn('sleep 30', { shell: true, stdio: 'ignore' });
    try {
      await sleep(300);
      const row = lookupProcess(victim.pid!);
      saveTask({
        id: 'ghost-task',
        args: ['eval', 'run'],
        cwd: dir,
        timeoutMs: 0,
        pid: victim.pid!,
        startedAt: Date.now() - 5_000,
        status: 'running',
        exitCode: null,
        ...(row?.startedAtText ? { osStartedAt: row.startedAtText } : {}),
        ...(row?.command ? { osCommand: row.command } : {}),
      });
      killProcessTree(victim.pid!, 'SIGKILL', victim);
      await sleep(300);

      const runner = makeRunner();
      const ghost = runner.get('ghost-task')!;
      expect(ghost.status).toBe('error');
      // The honest part: nothing observed how it ended, so the exit code is null
      // rather than a number that would read as a verdict.
      expect(ghost.exitCode).toBeNull();
      expect(ghost.error ?? '').toContain('exit code was not recorded');
      expect(logText(runner, 'ghost-task')).toContain('was not recorded');
    } finally {
      killProcessTree(victim.pid!, 'SIGKILL', victim);
    }
  }, 30_000);

  it('REFUSES to stop a recovered task whose pid belongs to another process', async () => {
    // A pid can be recycled, and the dashboard's answer must not be "probably
    // fine": it stops only work it can prove it started, and it SAYS so.
    const { spawn } = await import('node:child_process');
    const stranger = spawn('sleep 30', { shell: true, stdio: 'ignore' });
    try {
      await sleep(300);
      saveTask({
        id: 'stale-task',
        args: ['sleep', '30'],
        cwd: dir,
        timeoutMs: 0,
        pid: stranger.pid!,
        startedAt: Date.now(),
        status: 'running',
        exitCode: null,
        // The same command line, a start token from another moment: exactly what
        // a recycled pid looks like to this check.
        osStartedAt: 'Tue Jan 01 00:00:00 1980',
        osCommand: 'sleep 30',
      });

      const runner = makeRunner();
      const stale = runner.get('stale-task')!;
      expect(stale.recovered?.verified).toBe(false);
      expect(runner.cancel('stale-task')).toBe(false);
      // The refusal is on the TASK (the pane is where an operator will look),
      // and it carries the pid for a deliberate manual stop.
      const text = logText(runner, 'stale-task');
      expect(text).toContain('refused to stop this task');
      expect(text).toContain(String(stranger.pid));

      // …and nothing was signalled: the stranger is still running.
      await sleep(300);
      expect(stranger.exitCode === null && stranger.signalCode === null).toBe(true);
    } finally {
      killProcessTree(stranger.pid!, 'SIGKILL', stranger);
    }
  }, 30_000);

  it('keeps no record of a task that finished before the restart (nothing to recover)', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'ok';
    const first = makeRunner();
    const { task } = first.start(['eval', 'run'], { timeoutMs: 10_000 });
    await waitForStatus(first, task!.id);

    // The record stays (that is task history, which the console shows), but it is
    // NOT presented as work still in flight by the next process.
    const restarted = makeRunner();
    const record = restarted.get(task!.id)!;
    expect(record.status).toBe('done');
    expect(record.recovered).toBeUndefined();
    expect(restarted.list().some((t) => t.status === 'running')).toBe(false);
  }, 30_000);
});

describe('liveness watchdog — a HANG is identified and stopped, a slow task is not', () => {
  /**
   * The knobs are GLOBAL env, so each test gets a clean, aggressive set and
   * restores what the developer had. Aggressive on purpose: if the classifier
   * used silence alone, the chatty test below would be reaped.
   */
  const ENV = [
    'NUVIRA_TASK_HANG_POLL_MS',
    'NUVIRA_TASK_HANG_REAP_MS',
    'NUVIRA_HANG_QUIET_MS',
    'NUVIRA_STALL_QUIET_MS',
    'NUVIRA_HANG_CPU_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.NUVIRA_TASK_HANG_POLL_MS = '150';
    process.env.NUVIRA_STALL_QUIET_MS = '200';
    process.env.NUVIRA_HANG_QUIET_MS = '400';
  });

  afterEach(() => {
    for (const name of ENV) {
      const previous = saved[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  const logText = (runner: TaskRunner, id: string): string =>
    runner.get(id)!.logs.map((l) => l.text).join('\n');

  it('identifies a task producing neither output nor CPU, and stops it after the grace', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    process.env.NUVIRA_TASK_HANG_REAP_MS = '400';
    const runner = makeRunner();
    // NO clock: nothing but the liveness evidence can end this task.
    const { task } = runner.start(['eval', 'run'], { timeoutMs: 0 });

    const status = await waitForStatus(runner, task!.id, 25_000);
    expect(status!.status).toBe('hung');
    expect(status!.stopReason).toContain('hung');
    expect(status!.stopReason).toContain('no output and no CPU');

    const record = runner.get(task!.id)!;
    expect(record.liveness?.verdict).toBe('hung');
    // A hang is not a verdict on the code: the log says WHY it stopped.
    const text = logText(runner, task!.id);
    expect(text).toContain('HUNG');
    expect(text).toContain('no output and no CPU');
  }, 40_000);

  it('a long-lived SERVER command is flagged as hung but never stopped for it', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'sleep';
    process.env.NUVIRA_TASK_HANG_REAP_MS = '400';
    const runner = makeRunner();
    // `gateway start` waits for work: silent and idle is its CORRECT state, and
    // reaping it is exactly the failure the old per-preset exemption papered over.
    const { task } = runner.start(['gateway', 'start', '--no-events'], { timeoutMs: 0 });

    await new Promise((r) => setTimeout(r, 6_000));
    const record = runner.get(task!.id)!;
    // Still alive…
    expect(record.status).toBe('running');
    // …identified, with the evidence, so the operator can judge…
    expect(record.liveness?.verdict).toBe('hung');
    expect(logText(runner, task!.id)).toContain('HUNG');
    // …and NOT stopped by the watchdog.
    expect(record.stopReason).toBeUndefined();

    // The operator's own stop still works, and is reported as a plain cancel.
    expect(runner.cancel(task!.id)).toBe(true);
    expect((await waitForStatus(runner, task!.id)).status).toBe('cancelled');
  }, 40_000);

  it('a task that keeps producing output is never flagged — the false positive is the bug', async () => {
    process.env.NUVIRA_TASK_FIXTURE_MODE = 'tick';
    process.env.NUVIRA_STALL_QUIET_MS = '400';
    process.env.NUVIRA_HANG_QUIET_MS = '800';
    process.env.NUVIRA_TASK_HANG_REAP_MS = '800';
    const runner = makeRunner();
    const { task } = runner.start(['eval', 'run'], { timeoutMs: 0 });

    await new Promise((r) => setTimeout(r, 5_000));
    const record = runner.get(task!.id)!;
    expect(record.status).toBe('running');
    expect(record.liveness?.verdict).toBe('working');
    expect(record.hungSince ?? null).toBeNull();
    expect(record.stopReason).toBeUndefined();
    expect(logText(runner, task!.id)).not.toContain('HUNG');

    expect(runner.cancel(task!.id)).toBe(true);
    await waitForStatus(runner, task!.id);
  }, 40_000);

  it('knows which commands are long-lived servers (never reaped for a hang)', () => {
    for (const server of [
      ['gateway', 'start', '--no-events'],
      ['dashboard'],
      ['npm', 'run', 'dev'],
      ['vitest', 'run', '--watch'],
      ['gateway', 'start', '--supervise'],
    ]) {
      expect(isLongLivedCommand(server), server.join(' ')).toBe(true);
    }
    // The one-shot commands worth reaping must NOT be caught by that class.
    for (const oneShot of [
      ['eval', 'run', '--task', 'smoke'],
      ['npm', 'test'],
      ['npm', 'run', 'build'],
      ['release:gate'],
    ]) {
      expect(isLongLivedCommand(oneShot), oneShot.join(' ')).toBe(false);
    }
  });
});
