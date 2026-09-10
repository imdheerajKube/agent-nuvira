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
 * Timeouts SIGTERM the child, then SIGKILL after a grace period. Logs are
 * ring-buffered (capped) so a chatty command can't exhaust memory. All state
 * is in-memory (P4: persist task history + rerun).
 *
 * The spawn target is injectable (`execPath`/`cliEntry`) so unit tests can
 * point at fixture scripts instead of the real CLI.
 */
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'error';
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
    /** Spawn-level errors (ENOENT, entry missing, …). */
    error?: string;
}
export interface TaskRunnerOptions {
    /** Executable to spawn. Defaults to process.execPath (node). */
    execPath?: string;
    /** CLI entry passed to execPath. Defaults to <repoRoot>/dist/index.js. */
    cliEntry?: string;
    /** Working directory for spawned tasks. Defaults to process.cwd(). */
    cwd?: string;
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
    };
}
export declare class TaskRunner {
    private readonly opts;
    private tasks;
    private order;
    private children;
    private cancelled;
    private timedOut;
    private listeners;
    constructor(opts?: TaskRunnerOptions);
    /** Subscribe to task events ('log' + 'status'). Returns an unsubscribe fn. */
    onEvent(cb: (id: string, payload: TaskEventPayload) => void): () => void;
    private emit;
    /** The CLI entry the runner spawns (resolved once per call, cached). */
    cliEntry(): string;
    /** All tasks, newest first (P1 keeps full logs in memory for history). */
    list(): TaskRecord[];
    get(id: string): TaskRecord | undefined;
    private appendLog;
    /**
     * Start a CLI task. `args` are the CLI args (e.g. ['eval', 'run', '--task', 'smoke']).
     * Returns the task record immediately; the task runs in the background.
     */
    start(args: string[], opts?: {
        timeoutMs?: number;
        cwd?: string;
    }): {
        ok: boolean;
        task?: TaskRecord;
        error?: string;
    };
    /** Cancel a running task (SIGTERM). True when a task existed. */
    cancel(id: string): boolean;
}
//# sourceMappingURL=task-runner.d.ts.map