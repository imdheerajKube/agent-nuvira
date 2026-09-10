/**
 * Stale-dashboard detection + restart helpers for `nuvira dashboard --force`.
 *
 * The stale scenario (v1.56.1 fix): an older dashboard server still running on
 * the port answers newer /api/* routes with the SPA index.html (HTTP 200,
 * text/html) — the "API/SSE mismatch" that made the browser's res.json() throw
 * "Unexpected token '<'". --force detects that mismatch, confirms with the
 * user, kills the stale process, waits for the port to free, and lets the CLI
 * re-bind a fresh server.
 *
 * All helpers are exported pure-ish functions so the logic is unit-testable
 * without launching real servers or killing real processes.
 */
/** What is listening on the port (or nothing). */
export type DashboardPortState = 'unreachable' | 'not-a-dashboard' | 'current-dashboard' | 'stale-dashboard' | 'unknown';
/**
 * Classify what's on `host:port`:
 *  1. nothing responds           → 'unreachable'
 *  2. not a dashboard (no JSON   → 'not-a-dashboard' (never kill arbitrary
 *     from /api/models|/api/health)   processes)
 *  3. dashboard, but /api/model-registry (a CURRENT-version route) answers
 *     with SPA HTML instead of JSON → 'stale-dashboard' (the exact mismatch)
 *  4. /api/model-registry answers JSON → 'current-dashboard'
 */
export declare function probeDashboardPortState(host: string, port: number, timeoutMs?: number): Promise<DashboardPortState>;
/** Find the PID listening on `port` (cross-platform), or null. */
export declare function findPidOnPort(port: number): Promise<number | null>;
/** Gracefully stop a PID (SIGTERM then SIGKILL; taskkill on Windows). */
export declare function killPid(pid: number): Promise<boolean>;
/** Poll until nothing accepts connections on the port (or timeout). */
export declare function waitForPortFree(host: string, port: number, timeoutMs?: number): Promise<boolean>;
/**
 * Ask before killing the stale dashboard. Non-interactive (CI / piped) runs
 * skip the prompt — `--force` was explicit consent — and restart immediately.
 */
export declare function confirmStaleRestart(port: number): Promise<boolean>;
//# sourceMappingURL=dashboard-restart.d.ts.map