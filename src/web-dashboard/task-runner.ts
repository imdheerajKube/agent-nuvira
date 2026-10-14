/**
 * P1 — Dashboard task runner.
 *
 * The CLI is the single source of truth for every command; the dashboard's
 * task console runs it as an isolated child process (`node dist/index.js <args>`)
 * so "every command works from the GUI" is guaranteed by construction — the
 * GUI is literally running the CLI. This module provides:
 *
 *  - start(args, { timeoutMs, cwd })      → spawn + track a task
 *  - cancel(id)                           → SIGTERM the child (status 'cancelled')
 *  - get(id) / list()                     → serializable task records
 *  - onEvent(cb)                          → 'log'/'status' events (SSE fan-out)
 *
 * An EXPLICIT timeout SIGTERMs the child, then SIGKILLs after a grace period.
 * With no timeout (the default) nothing is killed on a clock — instead a
 * LIVENESS WATCHDOG samples the task's process tree and distinguishes a command
 * that is genuinely HUNG (no output AND no CPU: a prompt with no stdin, a lock,
 * a socket that never answers) from one that is merely slow (silent but still
 * burning CPU). A confirmed hang is flagged on the record and in the log, and —
 * unless the command is a long-lived server/watch command, which is SUPPOSED to
 * be silent and idle — the runner stops it after a further grace, so a hang is
 * never left running forever. Logs are ring-buffered (capped) so a chatty
 * command can't exhaust memory.
 *
 * STATE OUTLIVES THE PROCESS (see `task-registry.ts`). A task is written to a
 * durable record the moment it starts — pid, args, cwd, start time, the OS's
 * start token for that pid — and its output to a bounded log window. A new
 * dashboard process HYDRATES from those: the list and the log pane come back,
 * a task whose process is still alive is re-attached to the liveness watchdog,
 * and one whose pid is gone is settled honestly (no exit code, because none was
 * ever observed). The bug this fixes was measured: restarting the dashboard left
 * the child running and the console empty, so work kept burning CPU that nothing
 * could see, collect or stop.
 *
 * A recovered process is stopped ONLY once its identity is re-verified (the
 * command line AND the OS start token — see `processIdentityVerdict`); a refusal
 * is logged on the task with its pid so it can be stopped by hand.
 *
 * ONE OWNER PER PROFILE, like the monitored-run registry: two dashboards sharing
 * a config dir write the same records and the last write wins. That is a
 * limitation, not a claim.
 *
 * The spawn target is injectable (`execPath`/`cliEntry`) so unit tests can
 * point at fixture scripts instead of the real CLI.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  classifyLiveness,
  formatSpan,
  killProcessTree,
  livenessThresholds,
  lookupProcess,
  processTableSnapshot,
  processTreeOf,
  sampleProcessTree,
  tableAlive,
  type Liveness,
  type ProcessTreeSample,
} from '../tools/process-liveness.js';
import { processIdentityCheck } from '../tools/run-registry.js';
import type { SpoolWriter } from '../tools/run-registry.js';
import {
  createTaskLog,
  loadTasks,
  readTaskLog,
  saveTask,
  sweepTaskLogs,
  type PersistedTask,
} from './task-registry.js';

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'error' | 'hung';

export type TaskLogStream = 'stdout' | 'stderr' | 'system';

export interface TaskLogLine {
  stream: TaskLogStream;
  text: string;
  at: number;
}

/** Serializable task record (never holds the ChildProcess). */
export interface TaskRecord {
  id: string;
  /** Human display line: the args joined with spaces. */
  command: string;
  args: string[];
  cwd: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  timeoutMs: number;
  logs: TaskLogLine[];
  /** When the last output arrived — the silence half of the liveness check. */
  lastOutputAt: number;
  /**
   * The watchdog's last liveness verdict and the evidence behind it. Present
   * once a run has been sampled; this is what makes "still running" different
   * from "running, and here is why I believe it is stuck".
   */
  liveness?: { verdict: Liveness; why: string; at: number };
  /** When a CONFIRMED hang began (cleared the moment it speaks or computes). */
  hungSince?: number | null;
  /** Why the task stopped, when it was stopped rather than finishing on its own. */
  stopReason?: string;
  /** Spawn-level errors (ENOENT, entry missing, …). */
  error?: string;
  /** The child's pid — what a RESTART needs in order to find the work again. */
  pid?: number | null;
  /**
   * Set only on a task recovered from a previous dashboard process. `verified`
   * is the identity verdict (`null` = this platform could not tell), and `why`
   * is the evidence — a recovered task that cannot be verified is still SHOWN,
   * but never stopped.
   */
  recovered?: { verified: boolean | null; why: string };
}

export interface TaskRunnerOptions {
  /** Executable to spawn. Defaults to process.execPath (node). */
  execPath?: string;
  /** CLI entry passed to execPath. Defaults to <repoRoot>/dist/index.js. */
  cliEntry?: string;
  /** Working directory for spawned tasks. Defaults to process.cwd(). */
  cwd?: string;
}

/** Per-arg length cap (a runaway arg must not wedge the runner). */
const MAX_ARG_LENGTH = 512;
/** Max args per task (argv is bounded). */
const MAX_ARGS = 50;
/** Max log lines kept per task (ring buffer — chatty commands are capped). */
const MAX_LOG_LINES = 2000;
/** Max single log line kept (spawned tools can emit megabyte blobs). */
const MAX_LINE_LENGTH = 4000;
/** Max tasks kept in history (oldest dropped). */
const MAX_TASKS = 50;
/**
 * Default task timeout: NONE (0 = run until the command finishes or is
 * cancelled).
 *
 * The 5-minute default was SIGTERMing real work — the commands worth running
 * from the dashboard are the long ones (`npm test`, a build, an eval matrix) —
 * so the page reported a failure about work that was merely unfinished. A
 * caller that genuinely wants a cutoff passes `timeoutMs > 0` (the GUI's
 * timeout picker does exactly that), which is now an explicit choice rather than
 * a trap for everything that forgets to state one.
 */
const DEFAULT_TIMEOUT_MS = 0;
/** Grace after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * How often a running task's process tree is sampled for liveness.
 *
 * `NUVIRA_TASK_HANG_POLL_MS` overrides it — the sample rate is a cost/precision
 * trade (one `ps` per running task per interval), and a test needs it fast.
 */
function taskHangPollMs(): number {
  return Math.max(50, envMs('NUVIRA_TASK_HANG_POLL_MS', 30_000));
}

/**
 * Commands that are SUPPOSED to be silent and idle: a server, a watcher, a
 * daemon. They burn no CPU and print nothing while they wait for work, which is
 * exactly the signature of a hang — so they are flagged like anything else but
 * are NEVER stopped for it. Getting this wrong in the other direction (reaping a
 * running server) is the failure the old one-preset-at-a-time `gateway start`
 * exemption was papering over; this is that exemption, made a class.
 */
const LONG_LIVED_COMMAND_RE =
  /\b(gateway\s+start|supervise|dashboard|serve|server|dev|watch|worker|daemon|listen|tail\s+-f|smee|tunnel)\b/i;

/** True when this command is a long-lived server/watcher (never reaped for a hang). */
export function isLongLivedCommand(args: string[]): boolean {
  return LONG_LIVED_COMMAND_RE.test(args.join(' '));
}

function envMs(name: string, fallback: number): number {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * How long a CONFIRMED hang runs before the runner stops it (0 = never — flag it
 * and leave the decision to the operator, who can always cancel).
 *
 * Ten minutes by default, and the grace only starts once a hang has been
 * ESTABLISHED from evidence, so a slow-but-working command is never touched.
 */
export function taskHangReapMs(): number {
  return envMs('NUVIRA_TASK_HANG_REAP_MS', 600_000);
}

function repoRootDir(): string {
  // Compiled: dist/web-dashboard/task-runner.js → repo root is ../../dist/index.js.
  // Dev (tsx): src/web-dashboard/task-runner.ts → repo root is the same ../../.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export interface TaskEventPayload {
  kind: 'log' | 'status';
  /** New log line (log events only). */
  line?: TaskLogLine;
  /** Status snapshot (status events only). */
  status?: {
    status: TaskStatus;
    exitCode: number | null;
    durationMs: number | null;
    error?: string;
    /** Set when the task was stopped rather than finishing on its own. */
    stopReason?: string;
  };
}

export class TaskRunner {
  private tasks = new Map<string, TaskRecord>();
  private order: string[] = [];
  private children = new Map<string, ChildProcess>();
  private cancelled = new Set<string>();
  private timedOut = new Set<string>();
  /** Tasks the liveness watchdog stopped (distinct from a user's cancel). */
  private hung = new Set<string>();
  /** The last CPU sample per task — the delta is what proves a hang. */
  private cpuSamples = new Map<string, { cpuMs: number | null; at: number }>();
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  private listeners = new Set<(id: string, payload: TaskEventPayload) => void>();
  /** The bounded on-disk log window per task (what a restart reads back). */
  private logs = new Map<string, SpoolWriter>();
  /**
   * Recovered RUNNING tasks: their pid, and whether it could be re-verified as
   * the process this dashboard started. A recovered task has no child handle, so
   * this is what the watchdog samples and what a cancel is gated on.
   */
  private recoveredRuns = new Map<string, { pid: number | null }>();
  /**
   * The identity of each task's process (OS start token + live command line at
   * spawn), remembered so every later write of the record keeps it — a record
   * that lost its token could no longer be re-verified after a restart.
   */
  private identities = new Map<string, { osStartedAt?: string; osCommand?: string }>();

  constructor(private readonly opts: TaskRunnerOptions = {}) {
    // Recover BEFORE returning: a caller that lists tasks right after construction
    // must see the work a previous process left running, not an empty console.
    this.hydrate();
  }

  /**
   * Restore the previous process's task list, logs, and live pids.
   *
   * This is the whole point of the registry: without it, a dashboard restart
   * orphaned a child that kept running while the console forgot it existed.
   *
   * A recovered task whose pid is GONE is settled honestly — with no exit code,
   * because none was ever observed — rather than being left "running" forever or
   * quietly deleted. A recovered task whose pid may belong to someone else is
   * followed and reported, and only stopped once its identity is re-verified.
   */
  private hydrate(): void {
    const persisted = loadTasks();
    const now = Date.now();
    for (const entry of persisted) {
      if (this.tasks.has(entry.id)) continue;
      const record: TaskRecord = {
        id: entry.id,
        command: entry.args.join(' '),
        args: entry.args,
        cwd: entry.cwd,
        status: entry.status,
        exitCode: entry.exitCode,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt ?? null,
        durationMs: entry.durationMs ?? null,
        timeoutMs: entry.timeoutMs,
        logs: this.restoreLogs(entry.id),
        // The silence clock restarts here: there is no output timeline to measure
        // from after a restart, and "quiet since before the restart" would be a
        // fact about the downtime rather than about the task.
        lastOutputAt: now,
        ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.pid !== null ? { pid: entry.pid } : {}),
      };
      this.tasks.set(entry.id, record);
      this.order.push(entry.id);
      // Keep the identity with the record, so a later write cannot lose the very
      // token that makes a recovered task stoppable.
      if (entry.osStartedAt || entry.osCommand) {
        this.identities.set(entry.id, {
          ...(entry.osStartedAt ? { osStartedAt: entry.osStartedAt } : {}),
          ...(entry.osCommand ? { osCommand: entry.osCommand } : {}),
        });
      }

      if (entry.status !== 'running' || entry.pid === null) continue;

      const check = processIdentityCheck(
        { command: entry.osCommand ?? '', osStartedAt: entry.osStartedAt ?? null },
        lookupProcess(entry.pid),
      );
      record.recovered = { verified: check.verdict, why: check.why };
      if (check.kind === 'gone') {
        // The ONLY branch that may settle a task from an identity check: the pid
        // is not in the process table at all, which is a fact about liveness. No
        // exit code was observed, and the record says so rather than guessing.
        this.settleRecovered(
          entry.id,
          'error',
          'it ended while the dashboard was not running — its exit code was not recorded',
        );
        continue;
      }
      // Everything else is a claim about IDENTITY, not about liveness, so the
      // task stays listed and is watched. A pid that now belongs to another
      // process is never signalled (that is what `verified` gates), and it is
      // reported as such instead of being deleted from the console — deleting it
      // would hide work the operator may still need to stop by hand.
      this.recoveredRuns.set(entry.id, { pid: entry.pid });
      this.startWatching(entry.id);
      this.appendLog(
        record,
        'system',
        check.kind === 'verified'
          ? `↩ recovered from a previous dashboard process — still running, and re-verified as this task (${check.why}).`
          : `↩ recovered from a previous dashboard process — still running, but NOT re-verified as this task (${check.why}). It will be followed, and it will NOT be stopped automatically: stop it by hand with pid ${entry.pid} if you know it is still yours.`,
      );
    }
    // Logs nobody refers to must not accumulate: the records are capped, so the
    // files have to be swept or the directory grows forever.
    sweepTaskLogs([...this.tasks.keys()]);
  }

  /** The restored transcript of a task, capped like the live ring buffer. */
  private restoreLogs(id: string): TaskLogLine[] {
    const text = readTaskLog(id);
    if (!text) return [];
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.slice(-MAX_LOG_LINES).map((line) => ({ stream: 'stdout' as const, text: line, at: Date.now() }));
  }

  /** Write one task's record to the registry (best-effort — never throws). */
  private persist(id: string): void {
    const record = this.tasks.get(id);
    if (!record) return;
    const identity = this.identities.get(id);
    const entry: PersistedTask = {
      id,
      args: record.args,
      cwd: record.cwd,
      timeoutMs: record.timeoutMs,
      pid: record.pid ?? this.recoveredRuns.get(id)?.pid ?? null,
      startedAt: record.startedAt,
      status: record.status,
      exitCode: record.exitCode,
      ...(record.finishedAt !== null ? { finishedAt: record.finishedAt } : {}),
      ...(record.durationMs !== null ? { durationMs: record.durationMs } : {}),
      ...(record.stopReason ? { stopReason: record.stopReason } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(identity?.osStartedAt ? { osStartedAt: identity.osStartedAt } : {}),
      ...(identity?.osCommand ? { osCommand: identity.osCommand } : {}),
    };
    saveTask(entry);
  }

  /**
   * Capture the identity of a task's process, for a restart that has to tell it
   * apart from whatever holds that pid later.
   *
   * Read NOW, at spawn, because that is the last moment it is certainly ours. If
   * the read misses (a freshly forked child can take a few milliseconds to appear
   * in the table) it is retried once off the request path; a task that still has
   * no token is followable after a restart but not stoppable, and it SAYS so in
   * its own log rather than failing quietly.
   */
  private captureIdentity(id: string, pid: number | null): void {
    if (pid === null || pid <= 0) return;
    // Either witness is worth keeping: the token is the stronger one, and the
    // command line still works on a platform whose `ps` has no `lstart`. Only a
    // read that gives NEITHER leaves the task followable-but-not-stoppable.
    const remember = (row: { found: boolean; command: string | null; startedAtText: string | null } | null): boolean => {
      if (!row?.found || (!row.startedAtText && !row.command)) return false;
      this.identities.set(id, {
        ...(row.startedAtText ? { osStartedAt: row.startedAtText } : {}),
        ...(row.command ? { osCommand: row.command } : {}),
      });
      this.persist(id);
      return true;
    };
    if (remember(lookupProcess(pid))) return;

    // Retried a few times, not once. On Windows this read is a PowerShell/CIM
    // snapshot that takes the better part of a second to produce, so a process
    // milliseconds old is routinely not in it yet — a single retry at 250ms
    // recorded NOTHING, and then wrote its warning into the task's own log, where
    // it became the first line an operator (and the SSE stream) saw.
    //
    // The timers are unref'd, so waiting on a slow probe never holds the dashboard
    // open, and the warning is still the honest outcome once every attempt misses:
    // a task with no recorded identity is followable after a restart, not
    // stoppable.
    const retryDelaysMs = [250, 900, 2_000];
    let attempt = 0;
    const retry = (): void => {
      // A task that has already SETTLED has no process left to identify, so a read
      // for it can only cost time — and on Windows time IS the price: this read is
      // a PowerShell/CIM snapshot taken SYNCHRONOUSLY, on the event loop every
      // task's output flows through. Left unfiltered it also ends in a warning
      // about being stoppable-by-hand-only, written into the log of a task that is
      // already over. Measured on the release matrix: a burst of instant-exit
      // tasks (the history test starts 55) walked the whole ladder for each of
      // them, blocked the loop for minutes and timed out at 150s, while v3.5.2 —
      // ONE retry, same test, same budget — passed.
      const record = this.tasks.get(id);
      if (!record || record.status !== 'running') return;
      if (remember(lookupProcess(pid))) return;
      if (attempt >= retryDelaysMs.length) {
        this.appendLog(
          record,
          'system',
          '⚠️ could not read this task\'s OS start token — if the dashboard restarts it will still be listed, but it can only be stopped by hand.',
        );
        return;
      }
      const timer = setTimeout(retry, retryDelaysMs[attempt++]);
      timer.unref?.();
    };
    const first = setTimeout(retry, retryDelaysMs[attempt++]);
    first.unref?.();
  }

  /** Start the liveness watchdog for one task (spawned or recovered). */
  private startWatching(id: string): void {
    const watch = setInterval(() => this.sampleLiveness(id), taskHangPollMs());
    // A monitored task must never hold the process open: the dashboard exits on
    // its own terms, and the run continues without it.
    watch.unref?.();
    this.watchers.set(id, watch);
  }

  /**
   * Settle a RECOVERED task — one with no child handle, so nothing will ever
   * fire an exit event for it. The status is the best evidence available, and the
   * exit code is `null` because none was observed: inventing one would be the
   * exact lie this feature exists to avoid.
   */
  private settleRecovered(id: string, status: TaskStatus, reason: string): void {
    const record = this.tasks.get(id);
    if (!record || record.status !== 'running') return;
    this.stopWatching(id);
    this.cpuSamples.delete(id);
    this.recoveredRuns.delete(id);
    record.status = status;
    record.exitCode = null;
    record.finishedAt = Date.now();
    record.durationMs = record.finishedAt - record.startedAt;
    if (status === 'error') record.error = reason;
    else record.stopReason = reason;
    this.appendLog(record, 'system', `— ${reason}`);
    this.persist(id);
    this.emit(id, {
      kind: 'status',
      status: {
        status,
        exitCode: null,
        durationMs: record.durationMs,
        stopReason: reason,
        ...(status === 'error' ? { error: reason } : {}),
      },
    });
  }

  /** Subscribe to task events ('log' + 'status'). Returns an unsubscribe fn. */
  onEvent(cb: (id: string, payload: TaskEventPayload) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(id: string, payload: TaskEventPayload): void {
    for (const cb of this.listeners) {
      try {
        cb(id, payload);
      } catch {
        /* a listener must never break the runner */
      }
    }
  }

  /** The CLI entry the runner spawns (resolved once per call, cached). */
  cliEntry(): string {
    const override = this.opts.cliEntry;
    if (override) return isAbsolute(override) ? override : join(process.cwd(), override);
    return join(repoRootDir(), 'dist', 'index.js');
  }

  /** All tasks, newest first (P1 keeps full logs in memory for history). */
  list(): TaskRecord[] {
    return [...this.order].reverse().map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  private appendLog(record: TaskRecord, stream: TaskLogStream, text: string): void {
    const clean = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (!clean) return;
    // Output from the CHILD is evidence of life: it resets the silence half of
    // the liveness check (and so clears a pending hang — see `sampleLiveness`).
    //
    // `system` lines are the RUNNER talking, and they must NOT count: the
    // watchdog writes "looks HUNG" through this very function, so counting its
    // own notice as output made the run look alive again on the next sample —
    // measured: the verdict oscillated hung → working → stalled → hung forever,
    // the log filled with the same warning, and the hang was never reaped.
    if (stream !== 'system') record.lastOutputAt = Date.now();
    for (const raw of clean.split('\n')) {
      const line = raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}…` : raw;
      record.logs.push({ stream, text: line, at: Date.now() });
    }
    if (record.logs.length > MAX_LOG_LINES) {
      record.logs.splice(0, record.logs.length - MAX_LOG_LINES);
    }
    // …and to the durable window, so a restart can read the transcript back.
    // Everything that reaches the pane goes through here, INCLUDING the runner's
    // own notes: a refusal a restart cannot show is a refusal nobody will read.
    this.logs.get(record.id)?.write(`${clean}\n`);
    this.emit(record.id, { kind: 'log', line: { stream, text: clean, at: Date.now() } });
  }

  /**
   * Start a CLI task. `args` are the CLI args (e.g. ['eval', 'run', '--task', 'smoke']).
   * Returns the task record immediately; the task runs in the background.
   */
  start(args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): { ok: boolean; task?: TaskRecord; error?: string } {
    if (!Array.isArray(args) || args.length === 0) {
      return { ok: false, error: 'Missing command args — expected an array of CLI args (e.g. ["eval", "run", "--task", "smoke"]).' };
    }
    if (args.length > MAX_ARGS) {
      return { ok: false, error: `Too many args (${args.length} > ${MAX_ARGS}).` };
    }
    for (const a of args) {
      if (typeof a !== 'string') return { ok: false, error: 'All args must be strings.' };
      if (a.length > MAX_ARG_LENGTH) return { ok: false, error: `Arg exceeds ${MAX_ARG_LENGTH} chars.` };
    }

    const entry = this.cliEntry();
    if (!existsSync(entry)) {
      return {
        ok: false,
        error: `CLI entry not found at ${entry} — build the project first (npm run build) so the dashboard can run tasks.`,
      };
    }

    // timeoutMs <= 0 means NO timeout (e.g. `gateway start` — a foreground
    // server process must not be SIGTERM'd after a few minutes). undefined
    // falls back to the default.
    const timeoutMs =
      opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs <= 0 ? 0 : Math.max(1_000, opts.timeoutMs);
    const cwd = opts.cwd ?? this.opts.cwd ?? process.cwd();
    const id = randomUUID();
    const record: TaskRecord = {
      id,
      command: args.join(' '),
      args,
      cwd,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
      timeoutMs,
      logs: [],
      lastOutputAt: Date.now(),
    };
    this.tasks.set(id, record);
    this.order.push(id);
    if (this.order.length > MAX_TASKS) {
      const drop = this.order.splice(0, this.order.length - MAX_TASKS);
      for (const old of drop) {
        this.tasks.delete(old);
        this.children.delete(old);
        this.cancelled.delete(old);
        this.timedOut.delete(old);
        this.hung.delete(old);
        this.cpuSamples.delete(old);
        this.recoveredRuns.delete(old);
        this.identities.delete(old);
        this.stopWatching(old);
        // Its record is leaving the history with it, so its log goes too — the
        // alternative is a log directory that only ever grows.
        this.logs.get(old)?.discard();
        this.logs.delete(old);
      }
    }

    // The durable log window opens BEFORE the spawn, so no early output can be
    // lost to the gap between `spawn` returning and the first listener firing.
    this.logs.set(id, createTaskLog(id));

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entry, ...args], {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      record.status = 'error';
      record.finishedAt = Date.now();
      record.durationMs = 0;
      record.error = err instanceof Error ? err.message : String(err);
      this.appendLog(record, 'system', `Failed to spawn: ${record.error}`);
      this.emit(id, { kind: 'status', status: { status: 'error', exitCode: null, durationMs: 0, error: record.error } });
      return { ok: true, task: record };
    }

    this.children.set(id, child);
    record.pid = child.pid ?? null;
    let settled = false;
    let killGrace: ReturnType<typeof setTimeout> | null = null;

    // Durable from here on: the child outliving this process is the case being
    // fixed, so its record and pid exist before it has produced a byte.
    this.captureIdentity(id, record.pid);
    this.persist(id);

    const settle = (status: TaskStatus, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (killGrace) clearTimeout(killGrace);
      this.stopWatching(id);
      this.cpuSamples.delete(id);
      record.status = status;
      record.exitCode = exitCode;
      record.finishedAt = Date.now();
      record.durationMs = record.finishedAt - record.startedAt;
      this.children.delete(id);
      this.timedOut.delete(id);
      // Final flush; the file STAYS — the transcript is why the record exists.
      this.logs.get(id)?.close();
      this.persist(id);
      this.emit(id, {
        kind: 'status',
        status: {
          status,
          exitCode,
          durationMs: record.durationMs,
          ...(record.stopReason ? { stopReason: record.stopReason } : {}),
        },
      });
    };

    // Liveness watchdog: silence ALONE is never a hang (a real suite is quiet
    // for minutes), so the sample is the task's whole process tree CPU — and a
    // hang needs BOTH no output and no CPU. See ../tools/process-liveness.ts.
    this.startWatching(id);

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        this.timedOut.add(id);
        try {
          child.kill('SIGTERM');
        } catch {
          /* best-effort */
        }
        killGrace = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* best-effort */
          }
        }, KILL_GRACE_MS);
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(record, 'stdout', chunk.toString('utf-8')));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(record, 'stderr', chunk.toString('utf-8')));
    child.on('close', () => this.logs.get(id)?.close());

    child.on('error', (err) => {
      record.error = err.message;
      this.appendLog(record, 'system', `Spawn error: ${err.message}`);
      settle('error', null);
    });

    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      // Hung FIRST: the watchdog's stop is its own outcome, not a user cancel.
      if (this.hung.has(id)) {
        settle('hung', code ?? null);
        return;
      }
      if (this.cancelled.has(id)) {
        settle('cancelled', code ?? null);
        return;
      }
      if (this.timedOut.has(id)) {
        settle('timeout', code ?? null);
        return;
      }
      settle(code === 0 ? 'done' : 'failed', code ?? null);
    });

    return { ok: true, task: record };
  }

  private stopWatching(id: string): void {
    const watch = this.watchers.get(id);
    if (watch) clearInterval(watch);
    this.watchers.delete(id);
  }

  /**
   * One liveness sample for a running task: classify it, flag a hang on the
   * record (and in the log, live), and — only for a task that is not a
   * long-lived server, and only after the grace — stop it.
   *
   * Exported behaviour is reached through the watchdog interval; this method is
   * also the seam a test drives directly.
   */
  private sampleLiveness(id: string): void {
    const record = this.tasks.get(id);
    if (!record || record.status !== 'running') return;
    const child = this.children.get(id);
    const pid = child?.pid ?? this.recoveredRuns.get(id)?.pid ?? null;
    if (pid === null) return;
    const now = Date.now();
    const previous = this.cpuSamples.get(id) ?? null;

    let alive: boolean;
    let sample: ProcessTreeSample;
    if (child) {
      alive = child.exitCode === null && child.signalCode === null;
      sample = sampleProcessTree(pid);
    } else {
      // A recovered task has no child handle, so the process table is the only
      // witness — and ONE read answers both questions. An UNREADABLE table is not
      // evidence of death (`tableAlive` returns null): the task stays alive rather
      // than being declared finished by a probe that failed.
      const table = processTableSnapshot();
      alive = tableAlive(table, pid) ?? true;
      sample = processTreeOf(table ?? new Map(), pid);
    }

    // A process that is already being STOPPED must not be given a fresh (and
    // wrong) verdict. Between signalling it and its `close` event the pid can be
    // gone from the process table while the handle still calls it alive, so the
    // sample reads "no CPU" from the ABSENCE OF A ROW rather than from an absence
    // of work — which flipped a task that had just been reported HUNG (correctly)
    // back to `stalled` on the slower Windows runners. A task with a child handle
    // is settled by that child's own exit event, so there is nothing to say here;
    // a RECOVERED task has no such event and the table is its only witness, which
    // is why this deliberately does not cover it.
    const stopping =
      this.cancelled.has(id) || this.timedOut.has(id) || this.hung.has(id) || Boolean(record.stopReason);
    if (child && stopping && !sample.found) return;

    const verdict = classifyLiveness(
      {
        alive,
        // The runner counts LINES, not bytes; "has it ever spoken" is all the
        // classifier needs from this (recency comes from `quietMs`).
        bytes: record.logs.length,
        quietMs: now - record.lastOutputAt,
        ageMs: now - record.startedAt,
        cpuMs: sample.cpuMs,
        prevCpuMs: previous ? previous.cpuMs : null,
        sampleWindowMs: previous ? now - previous.at : taskHangPollMs(),
      },
      livenessThresholds(),
    );
    this.cpuSamples.set(id, { cpuMs: sample.cpuMs, at: now });
    const changed = record.liveness?.verdict !== verdict.verdict;
    record.liveness = { verdict: verdict.verdict, why: verdict.why, at: now };

    // A RECOVERED task that has exited: nothing will ever fire an exit event for
    // it, so the sample is what settles it — reported with no exit code, because
    // none was observed.
    if (verdict.verdict === 'finished') {
      if (this.cancelled.has(id)) this.settleRecovered(id, 'cancelled', 'stopped on request');
      else if (this.hung.has(id)) this.settleRecovered(id, 'hung', `hung: no output and no CPU (${verdict.why})`);
      else this.settleRecovered(id, 'error', 'it ended while the dashboard was not watching — its exit code was not recorded');
      return;
    }

    if (verdict.verdict === 'hung') {
      record.hungSince = record.hungSince ?? now;
      if (changed) {
        // Live, in the log pane AND on the record: the operator sees WHY it is
        // believed stuck, not just that time passed.
        this.appendLog(record, 'system', `🚫 no output and no CPU — looks HUNG. ${verdict.why}`);
      }
      const reapAfter = taskHangReapMs();
      if (reapAfter > 0 && !isLongLivedCommand(record.args) && now - record.hungSince >= reapAfter) {
        if (child) {
          this.stopHungTask(id, record, child, `hung: no output and no CPU for ${formatSpan(now - record.hungSince)}`);
        } else {
          this.stopRecoveredHung(id, record, pid, `hung: no output and no CPU for ${formatSpan(now - record.hungSince)}`);
        }
      }
      return;
    }

    // It spoke or it computed — not hung, and any pending grace starts over.
    record.hungSince = null;
    if (changed && verdict.verdict === 'stalled') {
      this.appendLog(record, 'system', `⚠️ quiet for a while — ${verdict.why}`);
    }
  }

  /** Stop a task the watchdog has established is hung, and say why. */
  private stopHungTask(id: string, record: TaskRecord, child: ChildProcess, why: string): void {
    this.hung.add(id);
    record.stopReason = why;
    killProcessTree(child.pid ?? -1, 'SIGTERM', child);
    const grace = setTimeout(() => {
      killProcessTree(child.pid ?? -1, 'SIGKILL', child);
    }, KILL_GRACE_MS);
    grace.unref?.();
  }

  /**
   * The same, for a task recovered from a previous dashboard process.
   *
   * Gated on the identity verdict. A pid that outlived the process table it came
   * from may now belong to something else, and this runner only ever signals work
   * IT started — so an unverifiable "hang" is reported and left running, and the
   * refusal says why. That is the honest trade: a hung command that keeps running
   * is bad, and stopping a stranger's process is worse.
   */
  private stopRecoveredHung(id: string, record: TaskRecord, pid: number, why: string): void {
    if (record.recovered?.verified !== true) {
      record.hungSince = Date.now(); // re-arms the grace rather than re-noticing every tick
      this.appendLog(
        record,
        'system',
        `🚫 looks HUNG, but it was recovered from a previous dashboard process and its pid could not ` +
          `be re-verified (${record.recovered?.why ?? 'the check could not be completed'}) — so it is ` +
          `deliberately NOT being stopped. Stop it by hand with pid ${pid} if you know it is still yours.`,
      );
      this.persist(id);
      return;
    }
    this.hung.add(id);
    record.stopReason = why;
    killProcessTree(pid, 'SIGTERM');
    const grace = setTimeout(() => {
      killProcessTree(pid, 'SIGKILL');
    }, KILL_GRACE_MS);
    grace.unref?.();
    this.persist(id);
  }

  /**
   * Cancel a running task (SIGTERM). True when a task existed and was signalled.
   *
   * A task recovered from a previous dashboard process has no child handle, so it
   * is stoppable only once its pid was re-verified as the process this dashboard
   * started. A refusal is logged on the task itself (not just returned) so the
   * operator sees it in the pane, with the pid for a manual stop.
   */
  cancel(id: string): boolean {
    const child = this.children.get(id);
    if (child) {
      this.cancelled.add(id);
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort — the exit handler still settles */
      }
      this.persist(id);
      return true;
    }

    const record = this.tasks.get(id);
    const recovered = this.recoveredRuns.get(id);
    const pid = recovered?.pid ?? null;
    if (!record || !recovered || record.status !== 'running' || pid === null) return false;
    if (record.recovered?.verified !== true) {
      this.appendLog(
        record,
        'system',
        `refused to stop this task: it was recovered from a previous dashboard process and its pid could ` +
          `not be re-verified as this task (${record.recovered?.why ?? 'the check could not be completed'}). ` +
          `Stop it by hand with pid ${pid} if you know it is still yours.`,
      );
      this.persist(id);
      return false;
    }
    this.cancelled.add(id);
    killProcessTree(pid, 'SIGTERM');
    const grace = setTimeout(() => {
      killProcessTree(pid, 'SIGKILL');
    }, KILL_GRACE_MS);
    grace.unref?.();
    this.appendLog(
      record,
      'system',
      `SIGTERM sent to pid ${pid} and everything under it (SIGKILL follows in ${formatSpan(KILL_GRACE_MS)} if it does not exit).`,
    );
    this.persist(id);
    return true;
  }
}
