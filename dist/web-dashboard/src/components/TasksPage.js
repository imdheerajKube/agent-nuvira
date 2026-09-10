"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = TasksPage;
const react_1 = require("react");
const react_router_dom_1 = require("react-router-dom");
const api_1 = require("../api");
const STATUS_LABEL = {
    running: '⏳ running',
    done: '✅ done',
    failed: '❌ failed',
    cancelled: '⏹ cancelled',
    timeout: '⏰ timed out',
    error: '💥 error',
};
function statusClass(status) {
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
function splitArgs(line) {
    const out = [];
    let cur = '';
    let quote = null;
    for (const ch of line.trim()) {
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                out.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        out.push(cur);
    return out;
}
function fmtDuration(ms) {
    if (ms === null)
        return '—';
    if (ms < 1000)
        return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
function fmtAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
}
function TasksPage() {
    const [auth, setAuth] = (0, react_1.useState)(null);
    const [command, setCommand] = (0, react_1.useState)('');
    const [timeoutSec, setTimeoutSec] = (0, react_1.useState)(300);
    const [starting, setStarting] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)('');
    // The task being displayed in the console (running or a selected history task).
    const [active, setActive] = (0, react_1.useState)(null);
    const [history, setHistory] = (0, react_1.useState)([]);
    const [autoScroll, setAutoScroll] = (0, react_1.useState)(true);
    const logEndRef = (0, react_1.useRef)(null);
    const subRef = (0, react_1.useRef)(null);
    const refreshHistory = (0, react_1.useCallback)(async () => {
        const r = await api_1.dashboardAPI.listTasks();
        if (r)
            setHistory(r.tasks);
    }, []);
    (0, react_1.useEffect)(() => {
        void api_1.dashboardAPI.fetchAdminAuthStatus().then((s) => {
            setAuth(s
                ? { configured: s.configured, authenticated: s.authenticated, role: s.role }
                : { configured: false, authenticated: false, role: null });
            if (s?.authenticated)
                void refreshHistory();
        });
    }, [refreshHistory]);
    // Auto-scroll the console to the newest line while running.
    (0, react_1.useEffect)(() => {
        if (autoScroll && active?.status === 'running') {
            try {
                logEndRef.current?.scrollIntoView?.({ block: 'end' });
            }
            catch {
                /* jsdom / non-DOM scroll environments */
            }
        }
    }, [active?.logs.length, active?.status, autoScroll]);
    (0, react_1.useEffect)(() => () => subRef.current?.(), []);
    const openTask = (0, react_1.useCallback)((task, subscribe) => {
        subRef.current?.();
        setActive(task);
        setError('');
        if (!subscribe)
            return;
        const off = api_1.dashboardAPI.subscribeTask(task.id, {
            onLog: (line) => setActive((prev) => (prev && prev.id === task.id ? { ...prev, logs: [...prev.logs, line] } : prev)),
            onStatus: (status) => setActive((prev) => (prev && prev.id === task.id ? { ...prev, status } : prev)),
        });
        subRef.current = off;
    }, []);
    const run = (0, react_1.useCallback)(async () => {
        const args = splitArgs(command);
        if (args.length === 0) {
            setError('Type a command first — e.g. `eval run --task smoke-test` or `gateway status`.');
            return;
        }
        setStarting(true);
        setError('');
        const r = await api_1.dashboardAPI.startTask(args, timeoutSec * 1000);
        setStarting(false);
        if (!r.ok || !r.task) {
            setError(r.error || 'Failed to start task.');
            return;
        }
        setCommand('');
        void refreshHistory();
        openTask(r.task, true);
    }, [command, timeoutSec, openTask, refreshHistory]);
    const cancel = (0, react_1.useCallback)(async (id) => {
        await api_1.dashboardAPI.cancelTask(id);
    }, []);
    const showHistory = (0, react_1.useCallback)(async (id) => {
        const r = await api_1.dashboardAPI.getTask(id);
        if (r?.task)
            openTask(r.task, false);
    }, [openTask]);
    const clearConsole = (0, react_1.useCallback)(() => {
        subRef.current?.();
        setActive(null);
    }, []);
    if (!auth) {
        return (<div className="panel">
        <h2 className="panel-title">🚀 Command Console</h2>
        <div className="loading-state">Loading…</div>
      </div>);
    }
    if (!auth.authenticated) {
        return (<div className="panel">
        <h2 className="panel-title">🚀 Command Console</h2>
        <div className="empty-state">
          <p>
            <strong>Log in to run tasks.</strong> The console executes commands on this machine, so it needs an
            admin session (like the Agent Hub toggles).
          </p>
          <p>
            {auth.configured ? (<react_router_dom_1.Link className="admin-refresh-btn" to="/admin">🔐 Log in</react_router_dom_1.Link>) : (<react_router_dom_1.Link className="admin-refresh-btn" to="/admin">🔐 Create admin account</react_router_dom_1.Link>)}
          </p>
        </div>
      </div>);
    }
    return (<div className="panel">
      <h2 className="panel-title">🚀 Command Console</h2>
      <p className="admin-subtitle">
        Run any agent-nuvira command — the same CLI, executed by the dashboard. Messaging, skills, tools, eval,
        memory, traces and more.
      </p>

      <form className="task-run-form" onSubmit={(e) => {
            e.preventDefault();
            void run();
        }}>
        <input className="admin-input task-cmd-input" placeholder="eval run --task smoke-test   ·   gateway status   ·   skill list   ·   memory stats" value={command} onChange={(e) => setCommand(e.target.value)} autoComplete="off" spellCheck={false}/>
        <select className="admin-input task-timeout-select" title="Task timeout" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
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

      {active && (<div className="task-console-wrap">
          <div className="task-console-header">
            <code className="task-console-cmd">{active.command}</code>
            <span className={`task-status ${statusClass(active.status)}`}>{STATUS_LABEL[active.status]}</span>
            <span className="task-meta">
              exit {active.exitCode ?? '—'} · {fmtDuration(active.durationMs)}
            </span>
            {active.status === 'running' && (<button className="admin-mini-btn task-cancel-btn" onClick={() => void cancel(active.id)}>
                ⏹ Cancel
              </button>)}
            <button className="admin-mini-btn" onClick={clearConsole}>✕ Close</button>
          </div>
          <div className="task-console">
            {active.logs.map((line, i) => (<div key={i} className={`task-line task-line-${line.stream}`}>
                {line.text}
              </div>))}
            {active.logs.length === 0 && active.status === 'running' && (<div className="task-line task-line-system">⏳ waiting for output…</div>)}
            <div ref={logEndRef}/>
          </div>
          <label className="task-autoscroll">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)}/> auto-scroll
          </label>
        </div>)}

      <h3 className="task-history-title">History</h3>
      {history.length === 0 ? (<div className="empty-state">No tasks yet — run your first command above.</div>) : (<div className="admin-table-wrapper">
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
              {history.map((t) => (<tr key={t.id} className={active?.id === t.id ? 'task-row-active' : ''} onClick={() => void showHistory(t.id)}>
                  <td><code>{t.command}</code></td>
                  <td><span className={`task-status ${statusClass(t.status)}`}>{STATUS_LABEL[t.status]}</span></td>
                  <td>{t.exitCode ?? '—'}</td>
                  <td>{fmtDuration(t.durationMs)}</td>
                  <td>{fmtAge(t.startedAt)}</td>
                </tr>))}
            </tbody>
          </table>
        </div>)}
    </div>);
}
