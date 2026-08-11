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

import { AsyncLocalStorage } from 'node:async_hooks';

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

const store = new AsyncLocalStorage<LogCorrelation>();

/** Run `fn` with correlation IDs attached to every log line it emits. */
export function withLogCorrelation<T>(ctx: LogCorrelation, fn: () => T): T {
  const parent = store.getStore();
  return store.run({ ...parent, ...ctx }, fn);
}

/** The correlation IDs currently active for this async context. */
export function getLogCorrelation(): LogCorrelation {
  return store.getStore() ?? {};
}

/** True when BUFF_LOG_JSON=1 (JSON line mode for dashboard/CI). */
export function isJsonLogMode(): boolean {
  const v = process.env.BUFF_LOG_JSON;
  return v === '1' || v === 'true';
}

/** Serialize one structured log record (already-redacted) to a JSON line. */
export function jsonLogLine(
  level: string,
  message: string,
  args: unknown[],
): string {
  const corr = getLogCorrelation();
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg: message,
  };
  if (corr.sessionId) record.sessionId = corr.sessionId;
  if (corr.runId) record.runId = corr.runId;
  if (corr.taskId) record.taskId = corr.taskId;
  if (corr.projectId) record.projectId = corr.projectId;
  // Numeric/primitive args ride along as fields (taskId from the orchestrator
  // is passed as an arg in some sites); objects are skipped to keep the line
  // JSON-safe and token-lean.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === null || a === undefined) continue;
    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
      record[`arg${i}`] = a;
    }
  }
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ level, time: new Date().toISOString(), msg: message });
  }
}
