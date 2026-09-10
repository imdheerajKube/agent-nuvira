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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
/** Default task timeout: 5 minutes (long evals/benchmarks need room). */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Grace after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
function repoRootDir() {
    // Compiled: dist/web-dashboard/task-runner.js → repo root is ../../dist/index.js.
    // Dev (tsx): src/web-dashboard/task-runner.ts → repo root is the same ../../.
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}
export class TaskRunner {
    opts;
    tasks = new Map();
    order = [];
    children = new Map();
    cancelled = new Set();
    timedOut = new Set();
    listeners = new Set();
    constructor(opts = {}) {
        this.opts = opts;
    }
    /** Subscribe to task events ('log' + 'status'). Returns an unsubscribe fn. */
    onEvent(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit(id, payload) {
        for (const cb of this.listeners) {
            try {
                cb(id, payload);
            }
            catch {
                /* a listener must never break the runner */
            }
        }
    }
    /** The CLI entry the runner spawns (resolved once per call, cached). */
    cliEntry() {
        const override = this.opts.cliEntry;
        if (override)
            return isAbsolute(override) ? override : join(process.cwd(), override);
        return join(repoRootDir(), 'dist', 'index.js');
    }
    /** All tasks, newest first (P1 keeps full logs in memory for history). */
    list() {
        return [...this.order].reverse().map((id) => this.tasks.get(id)).filter(Boolean);
    }
    get(id) {
        return this.tasks.get(id);
    }
    appendLog(record, stream, text) {
        const clean = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (!clean)
            return;
        for (const raw of clean.split('\n')) {
            const line = raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}…` : raw;
            record.logs.push({ stream, text: line, at: Date.now() });
        }
        if (record.logs.length > MAX_LOG_LINES) {
            record.logs.splice(0, record.logs.length - MAX_LOG_LINES);
        }
        this.emit(record.id, { kind: 'log', line: { stream, text: clean, at: Date.now() } });
    }
    /**
     * Start a CLI task. `args` are the CLI args (e.g. ['eval', 'run', '--task', 'smoke']).
     * Returns the task record immediately; the task runs in the background.
     */
    start(args, opts = {}) {
        if (!Array.isArray(args) || args.length === 0) {
            return { ok: false, error: 'Missing command args — expected an array of CLI args (e.g. ["eval", "run", "--task", "smoke"]).' };
        }
        if (args.length > MAX_ARGS) {
            return { ok: false, error: `Too many args (${args.length} > ${MAX_ARGS}).` };
        }
        for (const a of args) {
            if (typeof a !== 'string')
                return { ok: false, error: 'All args must be strings.' };
            if (a.length > MAX_ARG_LENGTH)
                return { ok: false, error: `Arg exceeds ${MAX_ARG_LENGTH} chars.` };
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
        const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs <= 0 ? 0 : Math.max(1_000, opts.timeoutMs);
        const cwd = opts.cwd ?? this.opts.cwd ?? process.cwd();
        const id = randomUUID();
        const record = {
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
            }
        }
        let child;
        try {
            child = spawn(process.execPath, [entry, ...args], {
                cwd,
                env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        }
        catch (err) {
            record.status = 'error';
            record.finishedAt = Date.now();
            record.durationMs = 0;
            record.error = err instanceof Error ? err.message : String(err);
            this.appendLog(record, 'system', `Failed to spawn: ${record.error}`);
            this.emit(id, { kind: 'status', status: { status: 'error', exitCode: null, durationMs: 0, error: record.error } });
            return { ok: true, task: record };
        }
        this.children.set(id, child);
        let settled = false;
        let killGrace = null;
        const settle = (status, exitCode) => {
            if (settled)
                return;
            settled = true;
            if (killGrace)
                clearTimeout(killGrace);
            record.status = status;
            record.exitCode = exitCode;
            record.finishedAt = Date.now();
            record.durationMs = record.finishedAt - record.startedAt;
            this.children.delete(id);
            this.timedOut.delete(id);
            this.emit(id, { kind: 'status', status: { status, exitCode, durationMs: record.durationMs } });
        };
        let timer = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                this.timedOut.add(id);
                try {
                    child.kill('SIGTERM');
                }
                catch {
                    /* best-effort */
                }
                killGrace = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    }
                    catch {
                        /* best-effort */
                    }
                }, KILL_GRACE_MS);
            }, timeoutMs);
        }
        child.stdout?.on('data', (chunk) => this.appendLog(record, 'stdout', chunk.toString('utf-8')));
        child.stderr?.on('data', (chunk) => this.appendLog(record, 'stderr', chunk.toString('utf-8')));
        child.on('error', (err) => {
            record.error = err.message;
            this.appendLog(record, 'system', `Spawn error: ${err.message}`);
            settle('error', null);
        });
        child.on('exit', (code) => {
            if (timer)
                clearTimeout(timer);
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
    /** Cancel a running task (SIGTERM). True when a task existed. */
    cancel(id) {
        const child = this.children.get(id);
        if (!child)
            return false;
        this.cancelled.add(id);
        try {
            child.kill('SIGTERM');
        }
        catch {
            /* best-effort — the exit handler still settles */
        }
        return true;
    }
}
//# sourceMappingURL=task-runner.js.map