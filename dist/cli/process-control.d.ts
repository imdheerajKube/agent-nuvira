/**
 * process-control.ts — find + gracefully stop a running gateway/dashboard.
 *
 * Both `nuvira gateway start` and `nuvira dashboard` run in the FOREGROUND of
 * whatever terminal launched them — so "how do I stop it?" used to mean
 * Ctrl+C there, or `pkill -f`. These helpers give a proper answer:
 *
 *   nuvira gateway stop      → SIGTERM the running `gateway start` process
 *   nuvira dashboard stop    → SIGTERM the running `dashboard` process
 *
 * and back the dashboard's own Shutdown buttons (POST /api/admin/shutdown).
 *
 * Discovery is two-pronged:
 *   1. Port-based — the gateway binds its webhook receiver (default 8787) and
 *      the dashboard binds its port (default 3030); `findPidOnPort` from the
 *      dashboard-restart helpers locates whatever listens there.
 *   2. Command-line — `ps`/`wmic` match on the exact command (e.g.
 *      `agent-nuvira gateway start`) so a gateway started on a custom port,
 *      or one whose receiver failed to bind, is still found.
 *
 * Stopping is graceful: SIGTERM (both processes handle it — the gateway's
 * start() and the dashboard's serve() both shut down cleanly on SIGTERM),
 * with a grace window before SIGKILL so a slow socket close isn't cut short.
 */
/** Find the PID of a process whose command line matches `pattern`, or null.
 *  Never matches the current process. Cross-platform (ps / wmic / PowerShell). */
export declare function findPidByCommandLine(pattern: RegExp): number | null;
/** Gracefully stop a PID: SIGTERM, wait up to `graceMs`, then SIGKILL. */
export declare function stopProcess(pid: number, graceMs?: number): Promise<boolean>;
/** Result of a stop attempt. */
export interface StopResult {
    stopped: boolean;
    pid?: number;
    reason?: string;
}
/**
 * Stop a running gateway: locate the `gateway start` process (command-line
 * match first, then the webhook receiver port, default 8787) and SIGTERM it.
 */
export declare function stopGateway(opts?: {
    port?: number;
}): Promise<StopResult>;
/**
 * Stop a running dashboard: locate it on its port (default 3030), falling
 * back to a command-line match for a dashboard started with `--port` /
 * `--host` overrides. The `stop` subcommand itself never matches (its own
 * command line is excluded, and the pattern rejects `dashboard stop`).
 */
export declare function stopDashboard(opts?: {
    port?: number;
}): Promise<StopResult>;
//# sourceMappingURL=process-control.d.ts.map