/**
 * EvalsPage — P2 eval runner in the GUI (GUI parity with `buff eval run`).
 *
 * The eval framework runs through the SAME task runner as the Tasks console —
 * each run is `buff eval run <args>` executed as an isolated child process,
 * with the live console streamed via SSE. Past runs come from the dashboard
 * data feed (evals.json, auto-refreshed every 10s), so results appear in the
 * table as soon as a run finishes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { DashboardData, EvalRun, TaskRecord, TaskStatus } from '../types';

interface AuthState {
  authenticated: boolean;
  role: string | null;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: '⏳ running',
  done: '✅ done',
  failed: '❌ failed',
  cancelled: '⏹ cancelled',
  timeout: '⏰ timed out',
  error: '💥 error',
};

const PRESETS: Array<{ label: string; args: string[]; hint: string }> = [
  { label: '⚡ Quick smoke', args: ['eval', 'run', '--tasks', 'quick', '--format', 'text'], hint: 'fast smoke tasks' },
  { label: '⏱ Medium suite', args: ['eval', 'run', '--tasks', 'medium', '--format', 'text'], hint: 'moderate-depth tasks' },
  { label: '🐢 Slow suite', args: ['eval', 'run', '--tasks', 'slow', '--format', 'text'], hint: 'deep tasks — minutes each' },
  { label: '🏆 M2B parity', args: ['eval', 'run', '--suite', 'm2b', '--format', 'text'], hint: 'experience-parity benchmark' },
  { label: '📦 Full suite', args: ['eval', 'run', '--suite', 'full', '--format', 'text'], hint: 'all tasks' },
];

function fmtPct(v: number | undefined): string {
  if (typeof v !== 'number') return '—';
  return `${Math.round(v * 100)}%`;
}

function fmtDate(at: number): string {
  return new Date(at).toLocaleString();
}

export default function EvalsPage({ data }: { data: DashboardData | null }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [customTask, setCustomTask] = useState('');
  const [active, setActive] = useState<TaskRecord | null>(null);
  const [logs, setLogs] = useState<Array<{ stream: string; text: string }>>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(s ? { authenticated: s.authenticated, role: s.role } : { authenticated: false, role: null });
    });
  }, []);

  // Auto-scroll the eval console to the newest line.
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

  const startEval = useCallback(
    async (args: string[]) => {
      if (running) return;
      setRunning(true);
      setError('');
      setLogs([]);
      const r = await dashboardAPI.startTask(args, 900_000);
      if (!r.ok || !r.task) {
        setError(r.error || 'Could not start the eval run.');
        setRunning(false);
        return;
      }
      const task = r.task;
      setActive(task);
      // Live console: replay any existing logs, then stream new ones.
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
    [running],
  );

  const cancelRun = useCallback(async () => {
    if (!active) return;
    await dashboardAPI.cancelTask(active.id);
  }, [active]);

  const runs: EvalRun[] = data?.evals?.runs ?? [];

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>🏆 Evals — run buff eval from the GUI</h2>
      </div>

      {!auth?.authenticated ? (
        <div className="admin-login-hint">Log in (admin or operator) to run evals.</div>
      ) : !canRun ? (
        <div className="admin-login-hint">Your role can view eval results but not run them (requires admin or operator).</div>
      ) : (
        <div className="eval-run-panel">
          <h3 className="section-subtitle">▶️ Run an eval</h3>
          <div className="eval-presets">
            {PRESETS.map((p) => (
              <button key={p.label} className="admin-refresh-btn" type="button" onClick={() => void startEval(p.args)} disabled={running}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="eval-custom-row">
            <input
              type="text"
              value={customTask}
              onChange={(e) => setCustomTask(e.target.value)}
              placeholder="custom: --tasks <id> or --provider <p> --model <m>"
              disabled={running}
              maxLength={120}
            />
            <button
              className="admin-refresh-btn"
              type="button"
              onClick={() => void startEval(['eval', 'run', ...customTask.trim().split(/\s+/), '--format', 'text'])}
              disabled={running || !customTask.trim()}
            >
              Run custom
            </button>
          </div>
          <p className="admin-hint">
            Runs the real <code>buff eval run</code> as an isolated process — same engine, same ledger, same results as
            the CLI. Long suites can take minutes; you can cancel mid-run.
          </p>
        </div>
      )}

      {error ? <div className="admin-row-msg admin-row-msg-err">{error}</div> : null}

      {active ? (
        <div className="eval-console-box">
          <div className="eval-console-head">
            <span>
              {active.command} · <span className={active.status === 'running' ? 'task-status-running' : ''}>{STATUS_LABEL[active.status]}</span>
            </span>
            {active.status === 'running' ? (
              <button className="admin-refresh-btn" type="button" onClick={() => void cancelRun()}>
                ⏹ Cancel
              </button>
            ) : null}
          </div>
          <pre className="eval-console" role="log">
            {logs.length > 0 ? logs.map((l, i) => <div key={i}>{l.text}</div>) : <div className="admin-hint">Waiting for output…</div>}
            <div ref={logEndRef} />
          </pre>
        </div>
      ) : null}

      <h3 className="section-subtitle">📜 Past runs (auto-refreshes)</h3>
      {runs.length > 0 ? (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Tasks</th>
                <th>Pass</th>
                <th>Completion</th>
                <th>Composite</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.startedAt)}</td>
                  <td className="admin-provider-type">{r.provider}</td>
                  <td>{r.model}</td>
                  <td>{r.summary.totalTasks}</td>
                  <td>{r.summary.tasksPassed}/{r.summary.totalTasks}</td>
                  <td>{fmtPct(r.summary.completionRate)}</td>
                  <td>{fmtPct(r.summary.avgCompositeScore)}</td>
                  <td>${(r.summary.totalCostUsd ?? 0).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">No eval runs yet — start one above (or `buff eval run` from the CLI).</div>
      )}
    </div>
  );
}
