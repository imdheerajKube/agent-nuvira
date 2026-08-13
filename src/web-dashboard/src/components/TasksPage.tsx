/**
 * TasksPage — P1 command console.
 *
 * The dashboard's task runner executes the agent-nuvira CLI as an isolated
 * child process (`node dist/index.js <args>`), so every command that works in
 * a terminal works here too — the GUI is literally running the CLI. This page
 * provides the run form, a live log console (SSE), cancel, and history.
 *
 * Running commands is a write action: the page is gated behind the same admin
 * session as the other action surfaces (Admin, Agent Hub toggles).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { dashboardAPI } from '../api';
import type { TaskLogLine, TaskRecord, TaskStatus } from '../types';

interface AuthState {
  configured: boolean;
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

function statusClass(status: TaskStatus): string {
  switch (status) {
    case 'done': return 'task-status-done';
    case 'running': return 'task-status-running';
    case 'failed': return 'task-status-failed';
    case 'cancelled': return 'task-status-cancelled';
    case 'timeout': return 'task-status-timeout';
    default: return 'task-status-error';
  }
}

/** Split a command line into argv (whitespace, quote-aware). */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtAge(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export default function TasksPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [command, setCommand] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(300);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  // The task being displayed in the console (running or a selected history task).
  const [active, setActive] = useState<TaskRecord | null>(null);
  const [history, setHistory] = useState<TaskRecord[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);

  const logEndRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<(() => void) | null>(null);

  const refreshHistory = useCallback(async () => {
    const r = await dashboardAPI.listTasks();
    if (r) setHistory(r.tasks);
  }, []);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(
        s
          ? { configured: s.configured, authenticated: s.authenticated, role: s.role }
          : { configured: false, authenticated: false, role: null },
      );
      if (s?.authenticated) void refreshHistory();
    });
  }, [refreshHistory]);

  // Auto-scroll the console to the newest line while running.
  useEffect(() => {
    if (autoScroll && active?.status === 'running') {
      try {
        logEndRef.current?.scrollIntoView?.({ block: 'end' });
      } catch {
        /* jsdom / non-DOM scroll environments */
      }
    }
  }, [active?.logs.length, active?.status, autoScroll]);

  useEffect(() => () => subRef.current?.(), []);

  const openTask = useCallback(
    (task: TaskRecord, subscribe: boolean) => {
      subRef.current?.();
      setActive(task);
      setError('');
      if (!subscribe) return;
      const off = dashboardAPI.subscribeTask(task.id, {
        onLog: (line: TaskLogLine) => setActive((prev) => (prev && prev.id === task.id ? { ...prev, logs: [...prev.logs, line] } : prev)),
        onStatus: (status: TaskStatus) =>
          setActive((prev) => (prev && prev.id === task.id ? { ...prev, status } : prev)),
      });
      subRef.current = off;
    },
    [],
  );

  const run = useCallback(async () => {
    const args = splitArgs(command);
    if (args.length === 0) {
      setError('Type a command first — e.g. `eval run --task smoke-test` or `gateway status`.');
      return;
    }
    setStarting(true);
    setError('');
    const r = await dashboardAPI.startTask(args, timeoutSec * 1000);
    setStarting(false);
    if (!r.ok || !r.task) {
      setError(r.error || 'Failed to start task.');
      return;
    }
    setCommand('');
    void refreshHistory();
    openTask(r.task, true);
  }, [command, timeoutSec, openTask, refreshHistory]);

  const cancel = useCallback(async (id: string) => {
    await dashboardAPI.cancelTask(id);
  }, []);

  const showHistory = useCallback(
    async (id: string) => {
      const r = await dashboardAPI.getTask(id);
      if (r?.task) openTask(r.task, false);
    },
    [openTask],
  );

  const clearConsole = useCallback(() => {
    subRef.current?.();
    setActive(null);
  }, []);

  if (!auth) {
    return (
      <div className="panel">
        <h2 className="panel-title">🚀 Command Console</h2>
        <div className="loading-state">Loading…</div>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="panel">
        <h2 className="panel-title">🚀 Command Console</h2>
        <div className="empty-state">
          <p>
            <strong>Log in to run tasks.</strong> The console executes commands on this machine, so it needs an
            admin session (like the Agent Hub toggles).
          </p>
          <p>
            {auth.configured ? (
              <Link className="admin-refresh-btn" to="/admin">🔐 Log in</Link>
            ) : (
              <Link className="admin-refresh-btn" to="/admin">🔐 Create admin account</Link>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 className="panel-title">🚀 Command Console</h2>
      <p className="admin-subtitle">
        Run any agent-nuvira command — the same CLI, executed by the dashboard. Messaging, skills, tools, eval,
        memory, traces and more.
      </p>

      <form
        className="task-run-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          className="admin-input task-cmd-input"
          placeholder="eval run --task smoke-test   ·   gateway status   ·   skill list   ·   memory stats"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <select
          className="admin-input task-timeout-select"
          title="Task timeout"
          value={timeoutSec}
          onChange={(e) => setTimeoutSec(Number(e.target.value))}
        >
          <option value={60}>1 min</option>
          <option value={300}>5 min</option>
          <option value={600}>10 min</option>
          <option value={1800}>30 min</option>
        </select>
        <button className="admin-refresh-btn" type="submit" disabled={starting || command.trim() === ''}>
          {starting ? '⏳ Starting…' : '▶ Run'}
        </button>
      </form>
      {error && <div className="admin-error">{error}</div>}
      <p className="task-hint">
        Long-running commands stream their output live. Runs are capped at the chosen timeout and can be cancelled.
      </p>

      {active && (
        <div className="task-console-wrap">
          <div className="task-console-header">
            <code className="task-console-cmd">{active.command}</code>
            <span className={`task-status ${statusClass(active.status)}`}>{STATUS_LABEL[active.status]}</span>
            <span className="task-meta">
              exit {active.exitCode ?? '—'} · {fmtDuration(active.durationMs)}
            </span>
            {active.status === 'running' && (
              <button className="admin-mini-btn task-cancel-btn" onClick={() => void cancel(active.id)}>
                ⏹ Cancel
              </button>
            )}
            <button className="admin-mini-btn" onClick={clearConsole}>✕ Close</button>
          </div>
          <div className="task-console">
            {active.logs.map((line, i) => (
              <div key={i} className={`task-line task-line-${line.stream}`}>
                {line.text}
              </div>
            ))}
            {active.logs.length === 0 && active.status === 'running' && (
              <div className="task-line task-line-system">⏳ waiting for output…</div>
            )}
            <div ref={logEndRef} />
          </div>
          <label className="task-autoscroll">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> auto-scroll
          </label>
        </div>
      )}

      <h3 className="task-history-title">History</h3>
      {history.length === 0 ? (
        <div className="empty-state">No tasks yet — run your first command above.</div>
      ) : (
        <div className="admin-table-wrapper">
          <table className="admin-table task-table">
            <thead>
              <tr>
                <th>Command</th>
                <th>Status</th>
                <th>Exit</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((t) => (
                <tr key={t.id} className={active?.id === t.id ? 'task-row-active' : ''} onClick={() => void showHistory(t.id)}>
                  <td><code>{t.command}</code></td>
                  <td><span className={`task-status ${statusClass(t.status)}`}>{STATUS_LABEL[t.status]}</span></td>
                  <td>{t.exitCode ?? '—'}</td>
                  <td>{fmtDuration(t.durationMs)}</td>
                  <td>{fmtAge(t.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
