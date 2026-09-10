/**
 * K1 — Structured logging (correlation IDs + JSON line mode).
 *
 * Extends `utils/logger.ts` with:
 *   1. A correlation-id CARRIER — an AsyncLocalStorage context that threads
 *      `{ sessionId, projectId, taskId }` through every log line emitted while
 *      a run is active, without passing them as parameters. One chat session
 *      = one sessionId; one orchestrator run = one runId; one task = one
 *      taskId — the acceptance criterion for K1.
 *   2. A JSON LINE mode — `BUFF_LOG_JSON=1` makes the logger emit one JSON
 *      object per line (level / time / msg / correlation / numeric args),
 *      machine-readable for the dashboard and CI, instead of chalk text.
 *
 * The existing `scrub()`/redaction path in logger.ts is preserved — JSON
 * lines are redacted BEFORE serialization.
 *
 * No new dependency: the carrier is node:async_hooks, the emitter is the
 * existing logger with a JSON branch.
 */
/** Correlation identifiers threaded through a run's log lines. */
export interface LogCorrelation {
    /** One chat session (from ChatHistory.storeSession). */
    sessionId?: string;
    /** One pipeline run (from the orchestrator). */
    runId?: string;
    /** One task inside a run (from the orchestrator). */
    taskId?: string;
    /** Project (from the workspace store / A2). */
    projectId?: string;
}
/** Run `fn` with correlation IDs attached to every log line it emits. */
export declare function withLogCorrelation<T>(ctx: LogCorrelation, fn: () => T): T;
/** The correlation IDs currently active for this async context. */
export declare function getLogCorrelation(): LogCorrelation;
/** True when BUFF_LOG_JSON=1 (JSON line mode for dashboard/CI). */
export declare function isJsonLogMode(): boolean;
/** Serialize one structured log record (already-redacted) to a JSON line. */
export declare function jsonLogLine(level: string, message: string, args: unknown[]): string;
//# sourceMappingURL=log.d.ts.map