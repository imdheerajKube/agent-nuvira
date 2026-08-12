/**
 * Shell utilities — Platform-aware host shell detection + a single execution
 * choke point for every subprocess Agent-Nuvira spawns.
 *
 * ## Why a choke point (E1)
 *
 * Before this module grew, `execSync`/`spawn` calls were scattered across the
 * codebase with inconsistent options (different shells, buffers, timeouts) and
 * zero observability — a command could run and nobody could see it. All shell
 * execution now flows through `runShell`/`runShellSync`, which:
 *
 * 1. Picks the correct host shell cross-platform (`getHostShell()`).
 * 2. Emits `exec:shell-start` / `exec:shell-end` events on the EventBus, so
 *    every subprocess is visible as a live `$ npm test` lane (the pipeline
 *    board and dashboard consume the same events).
 * 3. Applies a sane default buffer (10 MB), optional timeout, optional abort
 *    signal, and optional per-chunk streaming.
 * 4. Never throws on a non-zero exit code — the exit code is returned in the
 *    result, matching how the execution pipeline wants to handle failures.
 *
 * Usage:
 * ```ts
 * import { runShell, runShellSync } from '../../utils/shell.js';
 *
 * const result = await runShell('npm test', { cwd: projectDir, timeoutMs: 60_000 });
 * console.log(result.exitCode, result.stdout);
 *
 * const sync = runShellSync('git status --porcelain', { cwd: projectDir });
 * ```
 */
import { platform } from 'node:os';
import { execa, execaSync } from 'execa';
import { getEventBus, EventNames } from '../observability/event-bus.js';
/**
 * Return the path to the host shell executable, determined at runtime based
 * on the current operating system.
 *
 * | Platform  | Return value                        |
 * |-----------|-------------------------------------|
 * | Linux     | `/bin/sh`                           |
 * | macOS     | `/bin/sh`                           |
 * | Windows   | `process.env.COMSPEC \|\| 'cmd.exe'` |
 *
 * The `COMSPEC` environment variable points to the command interpreter on
 * Windows (usually `C:\Windows\system32\cmd.exe`). We fall back to the
 * bare executable name `cmd.exe` which Node.js resolves via `PATH`.
 */
export function getHostShell() {
    return platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
}
/** Emit shell events unless the caller opted out. */
function emitShellEvent(event, data, options) {
    if (options.emitEvents === false)
        return;
    try {
        getEventBus().emit(event, data, options.source ?? 'shell');
    }
    catch {
        // Observability must never break execution.
    }
}
/**
 * Run a shell command (async), capturing output and emitting
 * `exec:shell-start` / `exec:shell-end` events. Never throws on a non-zero
 * exit code — the exit code is returned in the result. Supports streaming via
 * `onChunk`, timeout via `timeoutMs`, and abort via `signal`.
 */
export async function runShell(command, options = {}) {
    const startedAt = Date.now();
    emitShellEvent(EventNames.EXEC_SHELL_START, { command, cwd: options.cwd }, options);
    let exitCode = 1;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    try {
        const subprocess = execa(command, {
            cwd: options.cwd,
            shell: getHostShell(),
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
            all: true,
            reject: false,
            signal: options.signal,
            windowsHide: true,
        });
        if (options.onChunk && subprocess.all) {
            subprocess.all.on('data', (chunk) => {
                options.onChunk?.(chunk.toString());
            });
        }
        const result = await subprocess;
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
        exitCode = result.exitCode ?? 1;
        timedOut = result.timedOut ?? false;
        // execa v8: with `reject: false`, an aborted process resolves with
        // `isCanceled: true` on the result (not a rejection).
        aborted = result.isCanceled ?? false;
    }
    catch (err) {
        const e = err;
        aborted = !!e.isCanceled;
        exitCode = e.exitCode ?? 1;
        stdout = e.stdout ?? '';
        stderr = e.stderr ?? e.message ?? '';
    }
    const durationMs = Date.now() - startedAt;
    const success = exitCode === 0 && !timedOut && !aborted;
    emitShellEvent(EventNames.EXEC_SHELL_END, {
        command,
        cwd: options.cwd,
        exitCode,
        success,
        timedOut,
        aborted,
        durationMs,
        // Failure transparency: include the captured output (truncated) when the
        // command FAILED so the pipeline board, NDJSON events, and the dashboard
        // show WHY — previously only the exit code was visible (gap-assessment
        // #3). Gated to failures to avoid noise and to keep potentially sensitive
        // success output (auth flows echoing tokens) out of the event stream.
        ...(!success ? {
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
        } : {}),
    }, options);
    return { exitCode, stdout, stderr, success, timedOut, aborted, durationMs, command };
}
/**
 * Run a shell command (synchronous), capturing output and emitting
 * `exec:shell-start` / `exec:shell-end` events. Never throws on a non-zero
 * exit code. Use only where the caller is inherently synchronous (git
 * plumbing, quick checks); prefer `runShell` for anything interactive.
 */
export function runShellSync(command, options = {}) {
    const startedAt = Date.now();
    emitShellEvent(EventNames.EXEC_SHELL_START, { command, cwd: options.cwd }, options);
    let exitCode = 1;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    try {
        const result = execaSync(command, {
            cwd: options.cwd,
            shell: getHostShell(),
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
            all: true,
            reject: false,
            windowsHide: true,
        });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
        exitCode = result.exitCode ?? 1;
        timedOut = result.timedOut ?? false;
    }
    catch (err) {
        const e = err;
        exitCode = e.exitCode ?? 1;
        stdout = e.stdout ?? '';
        stderr = e.stderr ?? e.message ?? '';
    }
    const durationMs = Date.now() - startedAt;
    // Sync execution cannot be aborted — `aborted` is always false here.
    const success = exitCode === 0 && !timedOut;
    emitShellEvent(EventNames.EXEC_SHELL_END, {
        command,
        cwd: options.cwd,
        exitCode,
        success,
        timedOut,
        durationMs,
        // Failure transparency (see runShell above) — output only on failures.
        ...(!success ? {
            stdout: stdout.slice(0, 2000),
            stderr: stderr.slice(0, 2000),
        } : {}),
    }, options);
    return { exitCode, stdout, stderr, success, timedOut, aborted: false, durationMs, command };
}
//# sourceMappingURL=shell.js.map