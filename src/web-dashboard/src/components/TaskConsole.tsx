/**
 * TaskConsole — a reusable "run a CLI command" console for the dashboard.
 *
 * Renders preset buttons + a custom-command input, starts the command through
 * the P1 task runner (the REAL CLI as an isolated child process), and streams
 * the live output via SSE with cancel. Used by the Evals tab and the Gateway
 * ops tab — one console, many surfaces.
 *
 * Running commands is a write action: the console is gated behind the admin
 * session + routing.operate (admin or operator).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { dashboardAPI } from '../api';
import { formatElapsed } from '../format';
import { useAuthVersion } from '../useAuthVersion';
import type { TaskRecord, TaskStatus } from '../types';

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '⏳ running',
  done: '✅ done',
  failed: '❌ failed',
  cancelled: '⏹ cancelled',
  timeout: '⏰ timed out',
  error: '💥 error',
  // Stopped by the liveness watchdog: the command was producing neither output
  // nor CPU, i.e. it was stuck — not a verdict on the code it was checking.
  hung: '🚫 stopped (hung)',
};

export interface TaskPreset {
  label: string;
  args: string[];
  /** Optional per-preset timeout (ms). 0 = no timeout; falls back to the console-level timeoutMs prop. */
  timeoutMs?: number;
}

interface Props {
  /** Preset command buttons. */
  presets: TaskPreset[];
  /** Placeholder for the custom-command input. */
  customPlaceholder: string;
  /**
   * Timeout for started tasks (ms). `0` = run until it finishes or the user
   * cancels. See the default below for why that is the default here.
   */
  timeoutMs?: number;
  /**
   * Optional hint shown under the buttons. Rich text: both callers explain what
   * the console really runs, with code spans and emphasis.
   */
  hint?: ReactNode;
}

/**
 * NO TIMEOUT BY DEFAULT (0 = run until finished or cancelled).
 *
 * The 5-minute default SIGTERMed real work. A command started from the GUI is the
 * same command the user would run in their own terminal, and the ones worth
 * reaching for here are the LONG ones — `npm test` on a real repo (measured on
 * this project: the full root suite is ~3 minutes, and it is not the slow one), a
 * release build, an eval matrix. Killing those at 5:00 while the log pane still
 * looked live is the worst version of that failure: the page reports a failure
 * about work that was merely unfinished. The runner already supports 0 (its own gateway
 * preset used it, precisely because the timeout was SIGTERMing a server process),
 * the console STREAMS the output live and offers an explicit ⏹ Cancel, so a
 * command that needs an hour is allowed to take one. A bounded timeout stays
 * available to callers that want one — pass `timeoutMs` (EvalsPage passes 15
 * minutes), or a per-preset override.
 */
const DEFAULT_CONSOLE_TIMEOUT_MS = 0;

export default function TaskConsole({ presets, customPlaceholder, timeoutMs = DEFAULT_CONSOLE_TIMEOUT_MS, hint }: Props) {
  const [auth, setAuth] = useState<{ authenticated: boolean; role: string | null } | null>(null);
  const authVersion = useAuthVersion();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState('');
  const [active, setActive] = useState<TaskRecord | null>(null);
  const [logs, setLogs] = useState<Array<{ stream: string; text: string }>>([]);
  /**
   * How long the active command has been running, ticked while it runs.
   *
   * With no timeout, the wait can now legitimately be an hour, and a log pane that
   * has gone quiet is indistinguishable from a wedged one — so the console counts
   * the time, the same way the chat's long-turn notice does. A finished task shows
   * the duration it actually took.
   */
  const [elapsedMs, setElapsedMs] = useState(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<(() => void) | null>(null);
  /** When the active command started (the elapsed clock's origin). */
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(s ? { authenticated: s.authenticated, role: s.role ?? null } : { authenticated: false, role: null });
    });
  }, [authVersion]);

  useEffect(() => {
    try {
      logEndRef.current?.scrollIntoView?.({ block: 'end' });
    } catch {
      /* jsdom / non-DOM environments */
    }
  }, [logs]);

  useEffect(() => {
    return () => {
      subRef.current?.();
    };
  }, []);

  const canRun = auth?.authenticated === true && (auth.role === 'admin' || auth.role === 'operator');

  const start = useCallback(
    async (args: string[], presetTimeoutMs?: number) => {
      if (running) return;
      setRunning(true);
      setError('');
      setLogs([]);
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      const r = await dashboardAPI.startTask(args, presetTimeoutMs ?? timeoutMs);
      if (!r.ok || !r.task) {
        setError(r.error || 'Could not start the command.');
        setRunning(false);
        return;
      }
      const task = r.task;
      setActive(task);
      const init = await dashboardAPI.getTask(task.id);
      if (init?.task) {
        setLogs(init.task.logs.map((l) => ({ stream: l.stream, text: l.text })));
      }
      subRef.current?.();
      subRef.current = dashboardAPI.subscribeTask(task.id, {
        onLog: (line) => setLogs((l) => [...l, { stream: line.stream, text: line.text }]),
        onStatus: (status) => {
          setActive((t) => (t ? { ...t, status } : t));
          if (status !== 'running') setRunning(false);
        },
      });
    },
    [running, timeoutMs],
  );

  const cancel = useCallback(async () => {
    if (!active) return;
    await dashboardAPI.cancelTask(active.id);
  }, [active]);

  // Tick the elapsed clock while the command runs (and stop when it ends).
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div className="ops-console">
      {!auth?.authenticated ? (
        <div className="admin-login-hint">Log in (admin or operator) to run commands.</div>
      ) : !canRun ? (
        <div className="admin-login-hint">Your role can view but not run commands (requires admin or operator).</div>
      ) : (
        <>
          <div className="ops-presets">
            {presets.map((p) => (
              <button key={p.label} className="admin-refresh-btn" type="button" onClick={() => void start(p.args, p.timeoutMs)} disabled={running}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="ops-custom-row">
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={customPlaceholder}
              disabled={running}
              maxLength={160}
            />
            <button
              className="admin-refresh-btn"
              type="button"
              onClick={() => void start(custom.trim().split(/\s+/))}
              disabled={running || !custom.trim()}
            >
              Run
            </button>
          </div>
          {hint ? <p className="admin-hint">{hint}</p> : null}
        </>
      )}

      {error ? <div className="admin-row-msg admin-row-msg-err">{error}</div> : null}

      {active ? (
        <div className="ops-console-box">
          <div className="ops-console-head">
            <span>
              {active.command} · <span className={active.status === 'running' ? 'task-status-running' : ''}>{STATUS_LABEL[active.status]}</span>
              {' · '}
              <span className="task-elapsed">
                {active.status === 'running'
                  ? formatElapsed(elapsedMs)
                  : formatElapsed(active.durationMs ?? elapsedMs)}
              </span>
            </span>
            {active.status === 'running' ? (
              <button className="admin-refresh-btn" type="button" onClick={() => void cancel()}>
                ⏹ Cancel
              </button>
            ) : null}
          </div>
          <pre className="ops-console" role="log">
            {logs.length > 0 ? logs.map((l, i) => <div key={i}>{l.text}</div>) : <div className="admin-hint">Waiting for output…</div>}
            <div ref={logEndRef} />
          </pre>
        </div>
      ) : null}
    </div>
  );
}
