/**
 * The durable half of the dashboard's task console.
 *
 * WHY THIS EXISTS. The runner spawned the CLI as a child and kept everything it
 * knew in memory — so restarting the dashboard (a deploy, a crash, a laptop
 * sleep) left the child RUNNING with nothing in the world that knew its pid.
 * Measured consequence, and the reason the operator reported it: work kept
 * burning CPU, and the task list and log pane came back empty, so the only thing
 * left to do with that work was guess. Two facts have to outlive the process:
 *
 *   what is running  — id, args, cwd, pid, when it started, how it ended;
 *   what it said     — its output, bounded, so a diagnosis is possible after.
 *
 * This is deliberately the same shape as the monitored-run registry
 * (`src/tools/run-registry.ts`) for shell commands, and for the same reasons:
 * bounded records, an atomic write, a bounded log window, and a pid that is
 * re-verified before anything is signalled. Both registries exist because the
 * same defect appeared in two places.
 *
 * Everything here is best-effort: a missing, unreadable or corrupt file is an
 * empty registry, never a throw. A task console that fails to start because a
 * state file is bad would be a worse bug than the one it fixes.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveNuviraDataPath } from '../config/paths.js';
import { SpoolWriter } from '../tools/run-registry.js';

/** Task statuses, kept in step with the runner's own union. */
export type PersistedTaskStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'error'
  | 'hung';

export interface PersistedTask {
  id: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** The child's pid — the only handle that survives the process. */
  pid: number | null;
  startedAt: number;
  status: PersistedTaskStatus;
  exitCode: number | null;
  finishedAt?: number;
  durationMs?: number;
  stopReason?: string;
  error?: string;
  /**
   * The OS's own start token for `pid`, read AT SPAWN — while the process is
   * certainly ours. It is the second identity witness: after a restart the pid
   * may already belong to someone else, and this is the value that tells the
   * two apart (see `processIdentityVerdict`).
   */
  osStartedAt?: string;
  /** The live command line at spawn, for the same re-verification. */
  osCommand?: string;
}

interface TasksFile {
  version: 1;
  tasks: PersistedTask[];
}

/**
 * Bounded history. The same number the runner keeps in memory, so the file
 * cannot describe more tasks than the console can show.
 */
export const MAX_PERSISTED_TASKS = 50;

/** `<config dir>/dashboard-tasks` — isolated by `$NUVIRA_CONFIG_DIR`, like the rest. */
export function tasksDir(): string {
  return resolveNuviraDataPath('dashboard-tasks');
}

function registryPath(): string {
  return join(tasksDir(), 'tasks.json');
}

/** Where a task's bounded log window lives. */
export function taskLogsDir(): string {
  return join(tasksDir(), 'logs');
}

export function taskLogPath(id: string): string {
  return join(taskLogsDir(), `${id}.log`);
}

/** Read the registry. A missing/corrupt file is an EMPTY registry, never a throw. */
export function loadTasks(): PersistedTask[] {
  try {
    const path = registryPath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<TasksFile>;
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    return parsed.tasks.filter(
      (t): t is PersistedTask =>
        !!t &&
        typeof t.id === 'string' &&
        Array.isArray(t.args) &&
        typeof t.startedAt === 'number' &&
        typeof t.status === 'string',
    );
  } catch {
    return [];
  }
}

function writeTasks(tasks: PersistedTask[]): boolean {
  try {
    mkdirSync(tasksDir(), { recursive: true });
    const path = registryPath();
    // Written via rename so a crash mid-write cannot leave a half file that reads
    // as an empty registry — which would silently orphan every running task.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks } satisfies TasksFile, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add or update one task, newest last, bounded.
 *
 * A task that is still RUNNING is never dropped to satisfy the cap: its record is
 * the only thing left that knows the child exists. Finished history is dropped
 * first, oldest first.
 */
export function saveTask(entry: PersistedTask): void {
  const tasks = loadTasks().filter((t) => t.id !== entry.id);
  tasks.push(entry);
  while (tasks.length > MAX_PERSISTED_TASKS) {
    const finishedAt = tasks.findIndex((t) => t.status !== 'running');
    if (finishedAt === -1) break; // everything left is live: the cap loses
    tasks.splice(finishedAt, 1);
  }
  writeTasks(tasks);
}

/** Read a task's bounded log window, or null when there is none. */
export function readTaskLog(id: string): string | null {
  try {
    const path = taskLogPath(id);
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf-8');
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Delete log files no record refers to.
 *
 * The log directory would otherwise be the one thing in this feature that grows
 * without a bound: records are capped, but a swept task's file would stay behind
 * forever. Run on hydrate, when the live set is exactly known.
 */
export function sweepTaskLogs(liveIds: readonly string[]): void {
  try {
    const keep = new Set(liveIds);
    const dir = taskLogsDir();
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const id = name.slice(0, -4);
      if (keep.has(id)) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    /* best-effort: a sweep that fails must not stop the dashboard booting */
  }
}

/**
 * A task's bounded log window on disk: HEAD until full, then a rolling TAIL.
 *
 * Same discipline as the monitored-run spool, and the same reason — a chatty task
 * must not be able to fill the disk, and the two ends are the parts a diagnosis
 * actually reads. Unlike the run spool this starts persisting IMMEDIATELY: a
 * dashboard task is durable from the moment it starts, because the child
 * outliving the dashboard is precisely the case being fixed.
 */
export function createTaskLog(id: string): SpoolWriter {
  const writer = new SpoolWriter(id, TASK_LOG_HEAD_BYTES, TASK_LOG_TAIL_BYTES, taskLogsDir());
  writer.startPersisting();
  return writer;
}

/**
 * Twice the monitored-run window, because this one is read as a TRANSCRIPT: a
 * task console is where someone scrolls back through what the CLI printed, not
 * just where an agent reads the last error.
 */
export const TASK_LOG_HEAD_BYTES = 65_536;
export const TASK_LOG_TAIL_BYTES = 65_536;
