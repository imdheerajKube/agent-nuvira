"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = TaskConsole;
const react_1 = require("react");
const api_1 = require("../api");
const STATUS_LABEL = {
    running: '⏳ running',
    done: '✅ done',
    failed: '❌ failed',
    cancelled: '⏹ cancelled',
    timeout: '⏰ timed out',
    error: '💥 error',
};
function TaskConsole({ presets, customPlaceholder, timeoutMs = 300_000, hint }) {
    const [auth, setAuth] = (0, react_1.useState)(null);
    const [running, setRunning] = (0, react_1.useState)(false);
    const [error, setError] = (0, react_1.useState)('');
    const [custom, setCustom] = (0, react_1.useState)('');
    const [active, setActive] = (0, react_1.useState)(null);
    const [logs, setLogs] = (0, react_1.useState)([]);
    const logEndRef = (0, react_1.useRef)(null);
    const subRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        void api_1.dashboardAPI.fetchAdminAuthStatus().then((s) => {
            setAuth(s ? { authenticated: s.authenticated, role: s.role } : { authenticated: false, role: null });
        });
    }, []);
    (0, react_1.useEffect)(() => {
        try {
            logEndRef.current?.scrollIntoView?.({ block: 'end' });
        }
        catch {
            /* jsdom / non-DOM environments */
        }
    }, [logs]);
    (0, react_1.useEffect)(() => {
        return () => {
            subRef.current?.();
        };
    }, []);
    const canRun = auth?.authenticated === true && (auth.role === 'admin' || auth.role === 'operator');
    const start = (0, react_1.useCallback)(async (args, presetTimeoutMs) => {
        if (running)
            return;
        setRunning(true);
        setError('');
        setLogs([]);
        const r = await api_1.dashboardAPI.startTask(args, presetTimeoutMs ?? timeoutMs);
        if (!r.ok || !r.task) {
            setError(r.error || 'Could not start the command.');
            setRunning(false);
            return;
        }
        const task = r.task;
        setActive(task);
        const init = await api_1.dashboardAPI.getTask(task.id);
        if (init?.task) {
            setLogs(init.task.logs.map((l) => ({ stream: l.stream, text: l.text })));
        }
        subRef.current?.();
        subRef.current = api_1.dashboardAPI.subscribeTask(task.id, {
            onLog: (line) => setLogs((l) => [...l, { stream: line.stream, text: line.text }]),
            onStatus: (status) => {
                setActive((t) => (t ? { ...t, status } : t));
                if (status !== 'running')
                    setRunning(false);
            },
        });
    }, [running, timeoutMs]);
    const cancel = (0, react_1.useCallback)(async () => {
        if (!active)
            return;
        await api_1.dashboardAPI.cancelTask(active.id);
    }, [active]);
    return (<div className="ops-console">
      {!auth?.authenticated ? (<div className="admin-login-hint">Log in (admin or operator) to run commands.</div>) : !canRun ? (<div className="admin-login-hint">Your role can view but not run commands (requires admin or operator).</div>) : (<>
          <div className="ops-presets">
            {presets.map((p) => (<button key={p.label} className="admin-refresh-btn" type="button" onClick={() => void start(p.args, p.timeoutMs)} disabled={running}>
                {p.label}
              </button>))}
          </div>
          <div className="ops-custom-row">
            <input type="text" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={customPlaceholder} disabled={running} maxLength={160}/>
            <button className="admin-refresh-btn" type="button" onClick={() => void start(custom.trim().split(/\s+/))} disabled={running || !custom.trim()}>
              Run
            </button>
          </div>
          {hint ? <p className="admin-hint">{hint}</p> : null}
        </>)}

      {error ? <div className="admin-row-msg admin-row-msg-err">{error}</div> : null}

      {active ? (<div className="ops-console-box">
          <div className="ops-console-head">
            <span>
              {active.command} · <span className={active.status === 'running' ? 'task-status-running' : ''}>{STATUS_LABEL[active.status]}</span>
            </span>
            {active.status === 'running' ? (<button className="admin-refresh-btn" type="button" onClick={() => void cancel()}>
                ⏹ Cancel
              </button>) : null}
          </div>
          <pre className="ops-console" role="log">
            {logs.length > 0 ? logs.map((l, i) => <div key={i}>{l.text}</div>) : <div className="admin-hint">Waiting for output…</div>}
            <div ref={logEndRef}/>
          </pre>
        </div>) : null}
    </div>);
}
