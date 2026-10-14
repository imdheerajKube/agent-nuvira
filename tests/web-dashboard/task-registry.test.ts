/**
 * The dashboard's task registry — the part that has to outlive the dashboard.
 *
 * Restarting the dashboard used to leave the child running with nothing that knew
 * its pid: the console came back empty and the work was unreachable. These tests
 * pin the machinery underneath the fix — a bounded record set, a bounded log
 * window, and a sweep, so the state cannot grow without a bound in either
 * direction.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MAX_PERSISTED_TASKS,
  TASK_LOG_HEAD_BYTES,
  TASK_LOG_TAIL_BYTES,
  createTaskLog,
  loadTasks,
  readTaskLog,
  saveTask,
  sweepTaskLogs,
  taskLogPath,
  tasksDir,
  type PersistedTask,
} from '../../src/web-dashboard/task-registry.js';

let configDir: string;
const created: string[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-task-registry-'));
  created.push(configDir);
  // `resolveNuviraDataPath` reads this at CALL time, so every test stays out of
  // the developer's real ~/.nuvira.
  process.env.NUVIRA_CONFIG_DIR = configDir;
});

afterAll(() => {
  delete process.env.NUVIRA_CONFIG_DIR;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(over: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: 'task-1',
    args: ['eval', 'run'],
    cwd: '/repo',
    timeoutMs: 0,
    pid: 4321,
    startedAt: 1,
    status: 'running',
    exitCode: null,
    ...over,
  };
}

describe('the task registry — durable, bounded, and never a throw', () => {
  it('round-trips a running task and a finished one, keeping the identity', () => {
    saveTask(entry({ osStartedAt: 'T1', osCommand: 'node dist/index.js eval run' }));
    saveTask(
      entry({
        id: 'task-2',
        status: 'failed',
        exitCode: 3,
        finishedAt: 5,
        durationMs: 4,
        stopReason: 'hung: no output and no CPU for 10m 00s',
      }),
    );
    const tasks = loadTasks();
    expect(tasks.map((t) => t.id)).toEqual(['task-1', 'task-2']);
    expect(tasks[0].osStartedAt).toBe('T1');
    expect(tasks[0].osCommand).toBe('node dist/index.js eval run');
    expect(tasks[1].exitCode).toBe(3);
    expect(tasks[1].stopReason).toContain('hung');
  });

  it('updates in place: a task is never listed twice', () => {
    saveTask(entry());
    saveTask(entry({ status: 'done', exitCode: 0, finishedAt: 9 }));
    const tasks = loadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('done');
  });

  it('a corrupt file reads as EMPTY, never as a throw', () => {
    saveTask(entry());
    writeFileSync(join(tasksDir(), 'tasks.json'), '{ this is not json');
    expect(loadTasks()).toEqual([]);
  });

  it('caps the history — and NEVER drops a task that is still running', () => {
    // The rule that matters: a live task's record is the only thing in the world
    // that knows its child exists, so the cap must spend the finished ones first.
    for (let i = 0; i < MAX_PERSISTED_TASKS; i++) {
      saveTask(
        entry({ id: `done-${i}`, status: 'done', exitCode: 0, finishedAt: i, startedAt: i }),
      );
    }
    saveTask(entry({ id: 'live', status: 'running' }));
    saveTask(entry({ id: 'done-last', status: 'done', exitCode: 0, finishedAt: 999 }));

    const tasks = loadTasks();
    expect(tasks.length).toBeLessThanOrEqual(MAX_PERSISTED_TASKS);
    expect(tasks.some((t) => t.id === 'live')).toBe(true);
    // The oldest finished one is what got spent.
    expect(tasks.some((t) => t.id === 'done-0')).toBe(false);
  });
});

describe('the task log window — bounded on disk, both ends readable', () => {
  it('keeps the WHOLE transcript while it fits under the cap', () => {
    // The task console is where someone scrolls back through what the CLI
    // printed, so a run that fits keeps every line — the middle included.
    const log = createTaskLog('task-log');
    log.write('FIRST-LINE\n');
    for (let i = 0; i < 200; i++) log.write('x'.repeat(1_000));
    log.write('\nMIDDLE-LINE\n');
    for (let i = 0; i < 200; i++) log.write('y'.repeat(1_000));
    log.write('\nLAST-LINE\n');
    log.close();

    const text = readFileSync(taskLogPath('task-log'), 'utf-8');
    expect(text).toContain('FIRST-LINE');
    expect(text).toContain('MIDDLE-LINE');
    expect(text).toContain('LAST-LINE');
    expect(text).not.toContain('characters omitted');
    expect(text.length).toBeGreaterThan(300_000);
  });

  it('past the cap it collapses to the bounded window, and says how much it dropped', () => {
    const log = createTaskLog('task-big');
    log.write('FIRST-LINE\n');
    // 3MB: past the cap, so the file must stop growing — one task must not be
    // able to fill the disk.
    for (let i = 0; i < 3_000; i++) log.write('x'.repeat(1_000));
    log.write('\nLAST-LINE\n');
    log.close();

    const text = readFileSync(taskLogPath('task-big'), 'utf-8');
    expect(text).toContain('FIRST-LINE');
    expect(text).toContain('LAST-LINE');
    // Head + tail, plus the omission marker — the only thing allowed past the cap.
    expect(text.length).toBeLessThan(TASK_LOG_HEAD_BYTES + TASK_LOG_TAIL_BYTES + 300);
    expect(text).toContain('characters omitted');
  });

  it('sweeps logs nothing refers to — the directory cannot grow forever', () => {
    const keep = createTaskLog('kept');
    keep.write('live output\n');
    keep.close();
    const orphan = createTaskLog('orphan');
    orphan.write('from a task that has been dropped\n');
    orphan.close();
    expect(existsSync(taskLogPath('orphan'))).toBe(true);

    sweepTaskLogs(['kept']);
    expect(existsSync(taskLogPath('kept'))).toBe(true);
    expect(existsSync(taskLogPath('orphan'))).toBe(false);
    expect(readTaskLog('kept')).toContain('live output');
    expect(readTaskLog('orphan')).toBeNull();
  });

  it('reads back null for a task that never logged', () => {
    expect(readTaskLog('never-existed')).toBeNull();
  });
});
