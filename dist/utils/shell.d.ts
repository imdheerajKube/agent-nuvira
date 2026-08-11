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
export declare function getHostShell(): string;
/** Options for `runShell` / `runShellSync`. */
export interface RunShellOptions {
    /** Working directory for the command (defaults to the caller's cwd). */
    cwd?: string;
    /** Timeout in milliseconds — the process is killed when exceeded. */
    timeoutMs?: number;
    /** AbortSignal — aborting kills the process and marks the result aborted. */
    signal?: AbortSignal;
    /** Called with each stdout+stderr chunk as it arrives (streaming). */
    onChunk?: (chunk: string) => void;
    /** Max captured output per stream in bytes (default: 10 MB). */
    maxBuffer?: number;
    /** Emit EventBus shell events (default: true). Set false for silent internal calls. */
    emitEvents?: boolean;
    /** Source label for emitted events (default: 'shell'). */
    source?: string;
}
/** Result of a `runShell` / `runShellSync` call. */
export interface RunShellResult {
    /** Process exit code (1 when the process could not start). */
    exitCode: number;
    /** Captured stdout. */
    stdout: string;
    /** Captured stderr. */
    stderr: string;
    /** Whether the command exited 0 without timing out or aborting. */
    success: boolean;
    /** Whether the process was killed by the timeout. */
    timedOut: boolean;
    /** Whether the process was killed by an abort signal. */
    aborted: boolean;
    /** Total wall-clock duration in milliseconds. */
    durationMs: number;
    /** The command that was executed. */
    command: string;
}
/**
 * Run a shell command (async), capturing output and emitting
 * `exec:shell-start` / `exec:shell-end` events. Never throws on a non-zero
 * exit code — the exit code is returned in the result. Supports streaming via
 * `onChunk`, timeout via `timeoutMs`, and abort via `signal`.
 */
export declare function runShell(command: string, options?: RunShellOptions): Promise<RunShellResult>;
/**
 * Run a shell command (synchronous), capturing output and emitting
 * `exec:shell-start` / `exec:shell-end` events. Never throws on a non-zero
 * exit code. Use only where the caller is inherently synchronous (git
 * plumbing, quick checks); prefer `runShell` for anything interactive.
 */
export declare function runShellSync(command: string, options?: RunShellOptions): RunShellResult;
//# sourceMappingURL=shell.d.ts.map