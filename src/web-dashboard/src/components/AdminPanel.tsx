/**
 * Admin panel — command-runner + the auth'd WRITE surface (Sessions 17–19).
 *
 * Three layers, per the user's roadmap:
 * 1. Command-runner (Session 17): the dashboard EXECUTES the state commands
 *    (doctor system + enterprise checks) on demand — no command needed.
 * 2. Write surface (Session 18): API-key / provider configuration in the
 *    dashboard, gated behind a user-id + password (the control layer). The CLI
 *    is NEVER deprecated — writes go through the SAME ConfigManager save() the
 *    CLI uses (GUI parallel, one config file). Keys are ALWAYS masked; the key
 *    input only ever receives a NEW value.
 * 3. RBAC roles (Session 19): sessions carry an admin/operator/viewer role
 *    (rbac.json assignment wins over the stored role — CLI governance parity);
 *    provider writes + user management require admin; operator/viewer get a
 *    read-only table. Admins manage dashboard users (role.manage) in-panel.
 *
 * Auth states: unconfigured → bootstrap setup form; configured → login form;
 * authenticated → role-gated editor. Read paths (checks/catalog) stay open;
 * every write requires the Bearer token issued at login AND the admin role.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import QuotaPanel from './QuotaPanel';
import type {
  AdminCatalogProvider,
  AdminCheck,
  AdminChecksData,
  AdminProviderSummary,
  AdminUser,
  CheckStatus,
} from '../types';

const STATUS_ICON: Record<CheckStatus, string> = { pass: '✅', warn: '⚠️', fail: '❌' };
const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
const KEY_SOURCE_LABEL: Record<string, string> = {
  env: 'Environment',
  config: 'Config',
  vault: 'Vault',
  local: 'Local (no key)',
  none: 'Not configured',
};

interface ProviderDraft {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  runner?: string;
}

function CheckRow({ check }: { check: AdminCheck }) {
  return (
    <div className="admin-check-row" data-status={check.status}>
      <span className={`admin-check-badge admin-check-${check.status}`}>
        {STATUS_ICON[check.status]} {STATUS_LABEL[check.status]}
      </span>
      <div className="admin-check-body">
        <div className="admin-check-name">{check.name}</div>
        <div className="admin-check-message">{check.message}</div>
        {check.detail ? <div className="admin-check-detail">{check.detail}</div> : null}
        {check.fix ? <div className="admin-check-fix">💡 {check.fix}</div> : null}
      </div>
    </div>
  );
}

export default function AdminPanel() {
  const [data, setData] = useState<AdminChecksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Auth (Session 18 control layer) + RBAC role (Session 19)
  const [authStatus, setAuthStatus] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // User management (Session 19 — role.manage = admin only)
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersMsg, setUsersMsg] = useState<string | null>(null);
  const [newUserName, setNewUserName] = useState('');
  const [newUserPass, setNewUserPass] = useState('');
  const [newUserRole, setNewUserRole] = useState('viewer');
  // Provider editor
  const [catalog, setCatalog] = useState<AdminCatalogProvider[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});
  const [newType, setNewType] = useState('');
  // Shutdown controls (dashboard / gateway) — admin sees both, operator sees
  // only the gateway stop (gateway.manage), viewer sees neither.
  const [shutdownMsg, setShutdownMsg] = useState<string | null>(null);
  const [shutdownBusy, setShutdownBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dashboardAPI.fetchAdminChecks();
    setData(result);
    if (!result) setError('Could not reach the dashboard server, or the server is older than this panel. Run `buff dashboard` to start it.');
    setLoading(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    const c = await dashboardAPI.fetchAdminCatalog();
    if (c && c.length > 0) setCatalog(c);
  }, []);

  const loadUsers = useCallback(async () => {
    const r = await dashboardAPI.fetchAdminUsers();
    if (r.ok && r.users) setUsers(r.users);
  }, []);

  useEffect(() => {
    let alive = true;
    dashboardAPI.fetchAdminAuthStatus().then((s) => {
      if (!alive) return;
      if (!s) {
        setError('Could not reach the dashboard server, or the server is older than this panel. Run `buff dashboard` to start it.');
        setLoading(false);
        return;
      }
      setAuthStatus({ configured: s.configured, authenticated: s.authenticated });
      setAuthed(s.authenticated);
      setRole(s.role ?? null);
      setUserName(s.user ?? null);
      if (s.authenticated) {
        void refresh();
        void loadCatalog();
        void loadUsers();
      } else {
        setLoading(false);
      }
    });
    return () => { alive = false; };
  }, [refresh, loadCatalog, loadUsers]);

  const isAdmin = role === 'admin';

  const sessionExpired = () => {
    setAuthed(false);
    setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
    setAuthError('Session expired — log in again.');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    const r = await dashboardAPI.adminLogin(user, password);
    if (r.ok) {
      setAuthed(true);
      setAuthStatus({ configured: true, authenticated: true });
      setRole(r.role ?? 'admin');
      setUserName(r.user ?? null);
      setUser('');
      setPassword('');
      void refresh();
      void loadCatalog();
      void loadUsers();
    } else {
      setAuthError(r.error || 'Login failed.');
    }
    setAuthBusy(false);
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    if (password.length < 8) {
      setAuthError('Password must be at least 8 characters.');
      setAuthBusy(false);
      return;
    }
    if (password !== confirm) {
      setAuthError('Passwords do not match.');
      setAuthBusy(false);
      return;
    }
    const r = await dashboardAPI.adminSetup(user, password);
    if (r.ok) {
      setAuthed(true);
      setAuthStatus({ configured: true, authenticated: true });
      setRole(r.role ?? 'admin');
      setUserName(r.user ?? null);
      setUser('');
      setPassword('');
      setConfirm('');
      void refresh();
      void loadCatalog();
      void loadUsers();
    } else {
      setAuthError(r.error || 'Setup failed.');
    }
    setAuthBusy(false);
  };

  const handleLogout = async () => {
    await dashboardAPI.adminLogout();
    setAuthed(false);
    setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
    setRole(null);
    setUserName(null);
    setData(null);
    setDrafts({});
    setRowMsg({});
    setUsers([]);
  };

  /** Shut down the gateway (any terminal can restart it with `buff gateway start`). */
  const stopGateway = async () => {
    if (!window.confirm('Stop the running gateway? Channels will stop responding until you restart it with `buff gateway start`.')) return;
    setShutdownBusy('gateway');
    setShutdownMsg(null);
    const r = await dashboardAPI.shutdown('gateway');
    setShutdownBusy(null);
    if (r.ok) {
      setShutdownMsg(r.stopped ? '✅ Gateway stopped.' : `ℹ️ ${r.reason || 'No running gateway found — nothing to stop.'}`);
    } else {
      setShutdownMsg(`❌ ${r.error || 'Stop failed.'}`);
      if (r.unauthorized) sessionExpired();
    }
  };

  /** Shut down this dashboard server — the page will disconnect. */
  const stopDashboard = async () => {
    if (!window.confirm('Shut down the dashboard? This page will disconnect and the server will exit. Restart with `buff dashboard`.')) return;
    setShutdownBusy('dashboard');
    setShutdownMsg('🛑 Shutting down the dashboard — this page will disconnect…');
    await dashboardAPI.shutdown('dashboard');
    // The server exits on its own; if the request failed the page stays up.
    setShutdownBusy(null);
    setShutdownMsg('ℹ️ The dashboard server did not stop (see the server terminal). You can also stop it with `buff dashboard stop`.');
  };

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setUsersMsg(null);
    if (newUserPass.length < 8) {
      setUsersMsg('Password must be at least 8 characters.');
      return;
    }
    const r = await dashboardAPI.addAdminUser(newUserName, newUserPass, newUserRole);
    if (r.ok) {
      setNewUserName('');
      setNewUserPass('');
      setUsersMsg('✅ User added');
      void loadUsers();
    } else {
      setUsersMsg(`❌ ${r.error || 'Failed to add user'}`);
      if (r.unauthorized) sessionExpired();
    }
  };

  const removeUser = async (name: string) => {
    if (!window.confirm(`Remove dashboard user '${name}'?`)) return;
    setUsersMsg(null);
    const r = await dashboardAPI.removeAdminUser(name);
    if (r.ok) {
      setUsersMsg(`✅ Removed ${name}`);
      void loadUsers();
    } else {
      setUsersMsg(`❌ ${r.error || 'Failed to remove user'}`);
      if (r.unauthorized) sessionExpired();
    }
  };

  const setDraft = (type: string, field: keyof ProviderDraft, value: string) => {
    setDrafts((d) => ({ ...d, [type]: { ...(d[type] || {}), [field]: value } }));
  };

  const saveProvider = async (type: string) => {
    setBusy(type);
    setRowMsg({});
    const draft = drafts[type] || {};
    const r = await dashboardAPI.saveProvider(type, draft);
    if (r.ok) {
      setData((d) => {
        if (!d) return d;
        // Replace the row IN PLACE when it exists (keeps provider order), append when new.
        const exists = d.providers.some((p) => p.type === type);
        const providers = exists
          ? d.providers.map((p) => (p.type === type && r.provider ? r.provider : p))
          : r.provider
            ? [...d.providers, r.provider]
            : d.providers;
        return { ...d, providers };
      });
      setDrafts((d) => { const next = { ...d }; delete next[type]; return next; });
      setRowMsg((m) => ({ ...m, [type]: '✅ Saved' }));
    } else {
      setRowMsg((m) => ({ ...m, [type]: `❌ ${r.error || 'Save failed'}` }));
      if (r.unauthorized) sessionExpired();
    }
    setBusy(null);
  };

  const removeProvider = async (type: string) => {
    if (!window.confirm(`Remove ${type}'s API key and configuration? This cannot be undone.`)) return;
    setBusy(type);
    setRowMsg({});
    const r = await dashboardAPI.deleteProvider(type);
    if (r.ok) {
      if (r.envSourced) {
        // The key lives in the environment — the row stays (env re-injects on
        // every load); explain how to actually remove it instead of hiding it.
        setData((d) => (d ? { ...d, providers: d.providers.map((p) => (p.type === type ? (r.provider || p) : p)) } : d));
        setRowMsg((m) => ({
          ...m,
          [type]: `⚠️ Key comes from ${r.envVar ? `$${r.envVar}` : 'an env var'} — unset it there to remove it (config can't override the env).`,
        }));
      } else {
        setData((d) => (d ? { ...d, providers: d.providers.filter((p) => p.type !== type) } : d));
        setDrafts((d) => { const next = { ...d }; delete next[type]; return next; });
      }
    } else {
      setRowMsg((m) => ({ ...m, [type]: `❌ ${r.error || 'Remove failed'}` }));
      if (r.unauthorized) sessionExpired();
    }
    setBusy(null);
  };

  const testProvider = async (type: string) => {
    setBusy(type);
    const r = await dashboardAPI.testProvider(type);
    setRowMsg((m) => ({
      ...m,
      [type]: r.ok
        ? `✅ Connected — ${r.models?.length ?? 0} model(s) reachable`
        : `❌ ${r.error || 'Connection failed'}`,
    }));
    setBusy(null);
  };

  const addProvider = () => {
    if (!newType) return;
    setDrafts((d) => ({ ...d, [newType]: {} }));
    setNewType('');
  };

  // ─── Auth gate ────────────────────────────────────────────────────────────
  if (error && !authStatus) {
    return (
      <div className="admin-header">
        <h2 className="section-title">🛠️ Admin</h2>
        <div className="admin-error">{error}</div>
      </div>
    );
  }

  if (!authStatus || (!authed && loading)) {
    return (
      <div className="admin-header">
        <h2 className="section-title">🛠️ Admin</h2>
        <div className="loading-state"><div className="loading-spinner" /><p>Loading…</p></div>
      </div>
    );
  }

  if (!authed) {
    const isSetup = !authStatus.configured;
    return (
      <div className="admin-header">
        <h2 className="section-title">🛠️ Admin — {isSetup ? 'Set up access' : 'Log in'}</h2>
        <p className="admin-subtitle">
          {isSetup
            ? 'Create the admin user-id and password that gate the dashboard write surface (API-key/provider configuration). The CLI keeps working exactly as before — this only guards the GUI.'
            : 'The write surface (API-key/provider configuration) is gated by the admin credentials. Read-only checks stay open.'}
        </p>
        <form className="admin-gate-form" onSubmit={isSetup ? handleSetup : handleLogin}>
          <label>
            <span>Username</span>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoComplete="username"
              placeholder="admin"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              placeholder="••••••••"
            />
          </label>
          {isSetup ? (
            <label>
              <span>Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="••••••••"
              />
            </label>
          ) : null}
          {authError ? <div className="admin-error">{authError}</div> : null}
          <button className="admin-refresh-btn" type="submit" disabled={authBusy || !user || !password}>
            {authBusy ? '⏳ …' : isSetup ? '🔐 Create admin' : '🔐 Log in'}
          </button>
          {isSetup ? (
            <p className="admin-hint">
              Automation alternative: set <code>BUFF_DASHBOARD_ADMIN_USER</code> and{' '}
              <code>BUFF_DASHBOARD_ADMIN_PASSWORD</code> in the dashboard's environment.
            </p>
          ) : null}
        </form>
      </div>
    );
  }

  // ─── Authenticated: checks + provider editor ─────────────────────────────
  const systemPass = data?.system.filter((c) => c.status === 'pass').length ?? 0;
  const systemWarn = data?.system.filter((c) => c.status === 'warn').length ?? 0;
  const systemFail = data?.system.filter((c) => c.status === 'fail').length ?? 0;
  const entPass = data?.enterprise.filter((c) => c.status === 'pass').length ?? 0;
  const entWarn = data?.enterprise.filter((c) => c.status === 'warn').length ?? 0;
  const entFail = data?.enterprise.filter((c) => c.status === 'fail').length ?? 0;
  const providers = data?.providers ?? [];
  const catalogLabel = (type: string): { label: string; icon?: string; keyless?: boolean; envVar?: string | null } => {
    const entry = catalog.find((c) => c.id === type);
    return entry ? entry : { label: type };
  };

  return (
    <>
      <div className="admin-header">
        <h2 className="section-title">
          🛠️ Admin — Command Runner &amp; Configuration
          {userName ? (
            <span className={`admin-role-badge admin-role-${role || 'viewer'}`}>
              {userName} · {role || 'viewer'}
            </span>
          ) : null}
        </h2>
        <div className="admin-header-actions">
          <button
            className="admin-refresh-btn"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? '⏳ Running checks…' : '🔄 Refresh (run all commands)'}
          </button>
          {isAdmin || role === 'operator' ? (
            <button
              className="admin-logout-btn"
              onClick={() => void stopGateway()}
              disabled={shutdownBusy !== null}
              title="Stop the running gateway (buff gateway stop)"
            >
              {shutdownBusy === 'gateway' ? '⏳ Stopping…' : '⏻ Stop gateway'}
            </button>
          ) : null}
          {isAdmin ? (
            <button
              className="admin-logout-btn"
              onClick={() => void stopDashboard()}
              disabled={shutdownBusy !== null}
              title="Shut down this dashboard server (buff dashboard stop)"
            >
              {shutdownBusy === 'dashboard' ? '⏳ Stopping…' : '🛑 Stop dashboard'}
            </button>
          ) : null}
          <button className="admin-logout-btn" onClick={() => void handleLogout()}>🚪 Log out</button>
        </div>
      </div>
      {shutdownMsg ? <div className="admin-error">{shutdownMsg}</div> : null}
      {!isAdmin ? (
        <div className="admin-readonly-note">
          🔒 Your role (<code>{role || 'viewer'}</code>) is read-only here — provider configuration
          and user management require the <code>admin</code> role. The CLI enforces the same
          governance policy (rbac.json).
        </div>
      ) : null}
      <p className="admin-subtitle">
        The dashboard executes the same state commands as the CLI — no command needed. Provider
        keys are masked here and every write goes through the same config the CLI uses.
      </p>

      {error ? <div className="admin-error">{error}</div> : null}

      {data ? (
        <>
          <div className="admin-summary-grid">
            <div className="admin-summary-card admin-summary-pass">
              <div className="admin-summary-value">{systemPass + entPass}</div>
              <div className="admin-summary-label">✅ Passing</div>
            </div>
            <div className="admin-summary-card admin-summary-warn">
              <div className="admin-summary-value">{systemWarn + entWarn}</div>
              <div className="admin-summary-label">⚠️ Warnings</div>
            </div>
            <div className="admin-summary-card admin-summary-fail">
              <div className="admin-summary-value">{systemFail + entFail}</div>
              <div className="admin-summary-label">❌ Failing</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{providers.length}</div>
              <div className="admin-summary-label">Providers</div>
            </div>
          </div>

          <h3 className="section-subtitle">⚙️ System Checks (buff doctor)</h3>
          <div className="admin-check-list">
            {data.system.map((c) => <CheckRow key={c.name} check={c} />)}
          </div>

          <h3 className="section-subtitle">🏥 Enterprise Self-Check (doctor --enterprise)</h3>
          <div className="admin-check-list">
            {data.enterprise.length > 0
              ? data.enterprise.map((c) => <CheckRow key={c.name} check={c} />)
              : <div className="empty-state">No enterprise checks returned.</div>}
          </div>

          <h3 className="section-subtitle">🔑 Provider Configuration (keys masked)</h3>
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Key</th>
                  <th>Base URL</th>
                  <th>Model</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => {
                  const meta = catalogLabel(p.type);
                  const draft = drafts[p.type] || {};
                  return (
                    <tr key={p.type}>
                      <td className="admin-provider-type">
                        {meta.icon ? `${meta.icon} ` : ''}{meta.label}
                        <div className="admin-provider-sub">
                          {p.type} · {KEY_SOURCE_LABEL[p.keySource] || p.keySource}
                        </div>
                        {p.keySource === 'env' ? (
                          <div className="admin-hint">comes from {meta.envVar || 'env var'} — change it there, config can't override it</div>
                        ) : p.keySource === 'vault' ? (
                          <div className="admin-hint">stored in the OS keyring (vault)</div>
                        ) : null}
                      </td>
                      <td>
                        <span className={`admin-check-badge ${p.configured ? 'admin-check-pass' : 'admin-check-warn'}`}>
                          {p.configured ? '✅ Configured' : '⚠️ Not configured'}
                        </span>
                      </td>
                      <td>
                        {meta.keyless ? (
                          <div className="admin-hint">No key needed (probed)</div>
                        ) : isAdmin ? (
                          <input
                            className="admin-input admin-key-input"
                            type="password"
                            aria-label={`${p.type} API key`}
                            placeholder={p.keyMasked || 'set a new key…'}
                            value={draft.apiKey ?? ''}
                            onChange={(e) => setDraft(p.type, 'apiKey', e.target.value)}
                            autoComplete="new-password"
                          />
                        ) : (
                          <div className="admin-hint">{p.keyMasked || '—'}</div>
                        )}
                      </td>
                      <td>
                        {isAdmin ? (
                          <input
                            className="admin-input"
                            type="text"
                            aria-label={`${p.type} base URL`}
                            placeholder={p.baseUrl || 'default endpoint'}
                            value={draft.baseUrl ?? ''}
                            onChange={(e) => setDraft(p.type, 'baseUrl', e.target.value)}
                          />
                        ) : (
                          <div className="admin-hint">{p.baseUrl ? p.baseUrl.replace(/^https?:\/\/(?:[^@/]*@)?/, '') : 'default endpoint'}</div>
                        )}
                      </td>
                      <td>
                        {isAdmin ? (
                          <input
                            className="admin-input"
                            type="text"
                            aria-label={`${p.type} model`}
                            placeholder={p.model || 'default model'}
                            value={draft.model ?? ''}
                            onChange={(e) => setDraft(p.type, 'model', e.target.value)}
                          />
                        ) : (
                          <div className="admin-hint">{p.model || 'default model'}</div>
                        )}
                      </td>
                      <td>
                        {isAdmin ? (
                          <>
                            <div className="admin-row-actions">
                              <button className="admin-mini-btn" disabled={busy === p.type} onClick={() => void saveProvider(p.type)}>💾 Save</button>
                              <button
                                className="admin-mini-btn"
                                disabled={busy === p.type}
                                title="Tests the SAVED configuration — save first to test a new key"
                                onClick={() => void testProvider(p.type)}
                              >🔌 Test</button>
                              <button className="admin-mini-btn admin-mini-danger" disabled={busy === p.type} onClick={() => void removeProvider(p.type)}>🗑 Remove</button>
                            </div>
                            {rowMsg[p.type] ? <div className="admin-row-msg">{rowMsg[p.type]}</div> : null}
                          </>
                        ) : (
                          <div className="admin-hint">read-only</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {providers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="admin-empty-cell">No providers configured yet.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {isAdmin && catalog.length > 0 ? (
            <div className="admin-add-provider">
              <select
                className="admin-input"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              >
                <option value="">Add a provider…</option>
                {catalog
                  .filter((c) => !providers.some((p) => p.type === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon ? `${c.icon} ` : ''}{c.label} ({c.id})
                    </option>
                  ))}
              </select>
              <button className="admin-mini-btn" disabled={!newType} onClick={addProvider}>➕ Add</button>
            </div>
          ) : null}

          <QuotaPanel authed={authed} role={role || 'viewer'} />

          {isAdmin ? (
            <>
              <h3 className="section-subtitle">👥 Dashboard Users (role.manage)</h3>
              <div className="admin-users-list">
                {users.map((u) => (
                  <div className="admin-user-row" key={u.user}>
                    <span className="admin-user-name">{u.user}</span>
                    <span className={`admin-role-badge admin-role-${u.role}`}>{u.role}</span>
                    <span className="admin-user-since">since {new Date(u.createdAt).toLocaleDateString()}</span>
                    {u.user !== userName ? (
                      <button className="admin-mini-btn admin-mini-danger" onClick={() => void removeUser(u.user)}>🗑 Remove user</button>
                    ) : (
                      <span className="admin-hint">you</span>
                    )}
                  </div>
                ))}
                {users.length === 0 ? <div className="empty-state">No dashboard users yet.</div> : null}
              </div>
              <form className="admin-gate-form admin-user-form" onSubmit={addUser}>
                <label>
                  <span>Username</span>
                  <input type="text" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} autoComplete="off" />
                </label>
                <label>
                  <span>Password (min 8 chars)</span>
                  <input type="password" value={newUserPass} onChange={(e) => setNewUserPass(e.target.value)} autoComplete="new-password" />
                </label>
                <label>
                  <span>Role</span>
                  <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)}>
                    <option value="viewer">viewer — read-only</option>
                    <option value="operator">operator — read-only in the dashboard today</option>
                    <option value="admin">admin — full control</option>
                  </select>
                </label>
                {usersMsg ? <div className="admin-row-msg">{usersMsg}</div> : null}
                <button className="admin-refresh-btn" type="submit" disabled={!newUserName || !newUserPass}>
                  ➕ Add user
                </button>
              </form>
            </>
          ) : null}
        </>
      ) : loading ? (
        <div className="loading-state"><div className="loading-spinner" /><p>Running all state checks…</p></div>
      ) : null}
    </>
  );
}
