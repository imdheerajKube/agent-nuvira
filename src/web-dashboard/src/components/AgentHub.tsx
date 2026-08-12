/**
 * Agent Hub panel (I4 + I5) — the Hermes-style 4-tab management page the
 * user picked out: **Skills / Tools / Channels / Artifacts** on one screen.
 *
 * - **Tools** — I1 toolsets with enable/disable switches. Writes are
 *   admin-gated (PUT /api/admin/hub/toolsets/<name>, routing.operate) and
 *   honored by the runtime gate, so a toggle is never cosmetic.
 * - **Channels** — I2 gateway delivery ledger (pending/sent/failed + recent
 *   entries) and the channel directory aliases.
 * - **Artifacts** — I3 per-session artifact store (sessions + recent items).
 * - **Skills** — compiled SkillStore skills + hub-installed SKILL.md skills.
 *
 * Reads are open; the toggle surface follows the AdminPanel auth pattern:
 * unconfigured → setup form, configured → login form, authed → role-gated
 * switches (admin/operator can toggle, viewer reads).
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { HubData, HubToolset } from '../types';

type HubTab = 'tools' | 'channels' | 'artifacts' | 'skills';

const TABS: Array<{ id: HubTab; label: string; icon: string }> = [
  { id: 'tools', label: 'Tools', icon: '🧰' },
  { id: 'channels', label: 'Channels', icon: '📡' },
  { id: 'artifacts', label: 'Artifacts', icon: '📦' },
  { id: 'skills', label: 'Skills', icon: '🧠' },
];

const STATUS_LABEL: Record<string, string> = { pending: '⏳ pending', sent: '✅ sent', failed: '❌ failed' };

/** A pending toggle the user triggered before logging in. */
interface PendingToggle {
  kind: 'toolset' | 'skill';
  name: string;
  enabled: boolean;
}

export default function AgentHub() {
  const [tab, setTab] = useState<HubTab>('tools');
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Auth (same control layer as AdminPanel).
  const [authStatus, setAuthStatus] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [authed, setAuthed] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<PendingToggle | null>(null);

  const [toggling, setToggling] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, string>>({});

  // I11 — Channels-tab test send (mirrors `buff gateway send <target> <text>`).
  const [sendTarget, setSendTarget] = useState('');
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const d = await dashboardAPI.fetchHub();
    setData(d);
    if (!d) setError('Could not reach the dashboard server, or the server is older than this panel. Run `buff dashboard` to start it.');
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    dashboardAPI.fetchAdminAuthStatus().then((s) => {
      if (!s) return;
      setAuthStatus({ configured: s.configured, authenticated: s.authenticated });
      setAuthed(s.authenticated);
      setRole(s.role ?? null);
      setUserName(s.user ?? null);
    });
  }, [refresh]);

  /** routing.operate — admin or operator may toggle capabilities. */
  const canWrite = authed && (role === 'admin' || role === 'operator');

  const sessionExpired = () => {
    setAuthed(false);
    setAuthStatus((s) => (s ? { ...s, authenticated: false } : s));
    setAuthError('Session expired — log in again to toggle capabilities.');
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
      const pending = pendingToggle;
      setPendingToggle(null);
      if (pending) await applyToggle(pending.kind, pending.name, pending.enabled);
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
    const r = await dashboardAPI.adminSetup(user, password);
    if (r.ok) {
      setAuthed(true);
      setAuthStatus({ configured: true, authenticated: true });
      setRole(r.role ?? 'admin');
      setUserName(r.user ?? null);
      setUser('');
      setPassword('');
      const pending = pendingToggle;
      setPendingToggle(null);
      if (pending) await applyToggle(pending.kind, pending.name, pending.enabled);
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
  };

  const applyToggle = async (kind: 'toolset' | 'skill', name: string, enabled: boolean) => {
    setToggling(name);
    const r = kind === 'skill'
      ? await dashboardAPI.setSkillEnabled(name, enabled)
      : await dashboardAPI.setToolsetEnabled(name, enabled);
    if (r.ok) {
      setRowMsg((m) => ({ ...m, [name]: `✅ ${enabled ? 'Enabled' : 'Disabled'} — live for new agent runs` }));
      void refresh();
    } else if (r.unauthorized) {
      sessionExpired();
    } else {
      setRowMsg((m) => ({ ...m, [name]: `❌ ${r.error || 'Toggle failed'}` }));
      if (r.forbidden) setAuthError(r.error || 'Your role cannot change capabilities.');
    }
    setToggling(null);
  };

  const toggleToolset = (name: string, enabled: boolean) => {
    if (!authed) {
      // Queue the toggle behind the login/setup gate.
      setPendingToggle({ kind: 'toolset', name, enabled });
      return;
    }
    void applyToggle('toolset', name, enabled);
  };

  const toggleSkill = (name: string, enabled: boolean) => {
    if (!authed) {
      // Queue the toggle behind the login/setup gate.
      setPendingToggle({ kind: 'skill', name, enabled });
      return;
    }
    void applyToggle('skill', name, enabled);
  };

  /** I11: send a test message through the gateway (admin/operator only). */
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authed) {
      setSendMsg({ kind: 'err', text: '🔐 Log in (or set up admin access) to send test messages.' });
      return;
    }
    if (!canWrite) {
      setSendMsg({ kind: 'err', text: '🔒 Your role cannot send channel messages — requires the admin or operator role.' });
      return;
    }
    setSending(true);
    setSendMsg(null);
    const r = await dashboardAPI.sendChannelMessage(sendTarget.trim(), sendText);
    if (r.ok) {
      setSendMsg({ kind: 'ok', text: `✅ Sent to ${sendTarget.trim()} (${r.platform}:${r.channelId})` });
      setSendText('');
    } else if (r.unauthorized) {
      sessionExpired();
      setSendMsg({ kind: 'err', text: r.error || 'Session expired — log in again.' });
    } else {
      setSendMsg({ kind: 'err', text: r.error || 'Send failed.' });
    }
    setSending(false);
  };

  // ─── Loading / auth gate ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="admin-header">
        <h2 className="section-title">🧰 Agent Hub</h2>
        <div className="loading-state"><div className="loading-spinner" /><p>Loading hub…</p></div>
      </div>
    );
  }

  const needsAuth = !authed && pendingToggle !== null;

  return (
    <>
      <div className="admin-header">
        <h2 className="section-title">
          🧰 Agent Hub
          {userName ? (
            <span className={`admin-role-badge admin-role-${role || 'viewer'}`}>
              {userName} · {role || 'viewer'}
            </span>
          ) : null}
        </h2>
        <div className="admin-header-actions">
          <button className="admin-refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? '⏳ Refreshing…' : '🔄 Refresh'}
          </button>
          {authed ? (
            <button className="admin-logout-btn" onClick={() => void handleLogout()}>🚪 Log out</button>
          ) : null}
        </div>
      </div>

      <p className="admin-subtitle">
        Capabilities, messaging, artifacts and skills in one place — the same 4-view
        concept as the Hermes web UI. Toggles persist to <code>buffconfig</code> and are
        honored by the runtime immediately (never cosmetic).
      </p>

      {error ? <div className="admin-error">{error}</div> : null}

      {/* ── Auth banner (only when a toggle was attempted) ───────────────── */}
      {needsAuth ? (
        <div className="admin-header">
          <h3 className="section-subtitle">
            {!authStatus?.configured
              ? `🔐 Set up admin access to ${pendingToggle.enabled ? 'enable' : 'disable'} '${pendingToggle.name}'`
              : `🔐 Log in to ${pendingToggle.enabled ? 'enable' : 'disable'} '${pendingToggle.name}'`}
          </h3>
          <form className="admin-gate-form" onSubmit={authStatus?.configured ? handleLogin : handleSetup}>
            <label>
              <span>Username</span>
              <input type="text" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" placeholder="admin" />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={authStatus?.configured ? 'current-password' : 'new-password'}
                placeholder="••••••••"
              />
            </label>
            {authError ? <div className="admin-error">{authError}</div> : null}
            <button className="admin-refresh-btn" type="submit" disabled={authBusy || !user || !password}>
              {authBusy ? '⏳ …' : authStatus?.configured ? '🔐 Log in & apply' : '🔐 Create admin & apply'}
            </button>
            {!authStatus?.configured ? (
              <p className="admin-hint">
                The first user is always an admin. Automation alternative: set{' '}
                <code>BUFF_DASHBOARD_ADMIN_USER</code> / <code>BUFF_DASHBOARD_ADMIN_PASSWORD</code>.
              </p>
            ) : null}
          </form>
        </div>
      ) : null}

      {!needsAuth && !canWrite && authed ? (
        <div className="admin-readonly-note">
          🔒 Your role (<code>{role || 'viewer'}</code>) can view but not change capabilities —
          toggles require the <code>admin</code> or <code>operator</code> role.
        </div>
      ) : null}

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="hub-tabs" role="tablist">
        {TABS.map((t) => {
          const count =
            t.id === 'tools' ? (data ? `${data.toolsets.enabled}/${data.toolsets.toolsets.length}` : '')
            : t.id === 'channels' ? (data ? String(data.channels.delivery.total) : '')
            : t.id === 'artifacts' ? (data ? String(data.artifacts.totalSessions) : '')
            : (data ? `${data.skills.enabled}/${data.skills.total}` : '');
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`hub-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
              {count ? <span className="hub-tab-count">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* ── Tools tab ────────────────────────────────────────────────────── */}
      {tab === 'tools' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.enabled}</div>
              <div className="admin-summary-label">Enabled toolsets</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.disabled}</div>
              <div className="admin-summary-label">Disabled toolsets</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.toolsets.totalTools}</div>
              <div className="admin-summary-label">Registered tools</div>
            </div>
          </div>
          <div className="hub-toolset-grid">
            {data.toolsets.toolsets.map((t: HubToolset) => (
              <div className={`hub-card${t.enabled ? '' : ' hub-card-disabled'}`} key={t.name}>
                <div className="hub-card-top">
                  <div className="hub-card-title">
                    <span className="hub-card-name">{t.label}</span>
                    <span className="hub-card-id">{t.name}</span>
                  </div>
                  <button
                    role="switch"
                    aria-checked={t.enabled}
                    aria-label={`${t.enabled ? 'Disable' : 'Enable'} ${t.label}`}
                    className={`hub-switch${t.enabled ? ' on' : ''}`}
                    // Disabled while a toggle is in flight, once a toggle is
                    // queued behind the login gate (no flip-flopping), or when
                    // an AUTHENTICATED role lacks permission (viewer). When
                    // not authenticated the switch stays clickable — it queues
                    // the toggle behind the login gate instead of failing.
                    disabled={toggling === t.name || pendingToggle !== null || (authed && !canWrite)}
                    onClick={() => toggleToolset(t.name, !t.enabled)}
                  >
                    <span className="hub-switch-knob" />
                  </button>
                </div>
                <p className="hub-card-desc">{t.description}</p>
                <div className="hub-card-tools">
                  {t.tools.length > 0
                    ? t.tools.map((tool) => <span className="hub-chip" key={tool}>{tool}</span>)
                    : <span className="admin-hint">gates dynamic MCP tools (no static names)</span>}
                </div>
                {rowMsg[t.name] ? <div className="admin-row-msg">{rowMsg[t.name]}</div> : null}
                {!t.enabled ? <div className="hub-card-note">⛔ Removed from the model schema — calls return an explicit error</div> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Channels tab ─────────────────────────────────────────────────── */}
      {tab === 'channels' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.pending}</div>
              <div className="admin-summary-label">⏳ Queued for retry</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.sent}</div>
              <div className="admin-summary-label">✅ Delivered</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.delivery.failed}</div>
              <div className="admin-summary-label">❌ Failed (max retries)</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.channels.aliases.length}</div>
              <div className="admin-summary-label">Channel aliases</div>
            </div>
          </div>

          <h3 className="section-subtitle">📮 Delivery ledger (guaranteed delivery)</h3>
          {data.channels.delivery.recent.length > 0 ? (
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Platform</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Next retry</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {data.channels.delivery.recent.map((e) => (
                    <tr key={e.id}>
                      <td className="admin-provider-type">{e.target}</td>
                      <td>{e.platform}</td>
                      <td>
                        <span className={`admin-check-badge admin-check-${e.status === 'sent' ? 'pass' : e.status === 'failed' ? 'fail' : 'warn'}`}>
                          {STATUS_LABEL[e.status] || e.status}
                        </span>
                      </td>
                      <td>{e.attempts}/5</td>
                      <td>
                        {e.status === 'pending'
                          ? `${Math.max(0, Math.round((e.nextAttemptAt - Date.now()) / 1000))}s`
                          : '—'}
                      </td>
                      <td className="admin-hint">{e.lastError ? `⚠️ ${e.lastError}` : (e.text || '').slice(0, 60)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">Delivery ledger is empty — every gateway send has gone through.</div>
          )}

          <h3 className="section-subtitle">🔌 Platform transports</h3>
          <div className="hub-platform-grid">
            {data.channels.platforms.map((p) => (
              <div className={`hub-platform${p.configured ? ' configured' : ''}`} key={p.platform}>
                <span className={`status-dot ${p.configured ? 'connected' : 'reconnecting'}`} />
                <span className="hub-platform-label">{p.label}</span>
                <span className="hub-card-id">{p.platform}</span>
                {!p.configured ? (
                  <span className="hub-platform-env">set {p.envVars.join(', ')}</span>
                ) : null}
              </div>
            ))}
          </div>

          <h3 className="section-subtitle">🔗 Channel aliases (buff gateway status)</h3>
          {data.channels.aliases.length > 0 ? (
            <div className="hub-alias-list">
              {data.channels.aliases.map((a) => (
                <div className="hub-alias-row" key={a.alias}>
                  <span className="hub-chip">{a.alias}</span>
                  <span className="admin-hint">→ {a.platform}:{a.channelId}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No aliases yet — register one with <code>buff gateway alias &lt;name&gt; &lt;platform&gt; &lt;channelId&gt;</code>.
            </div>
          )}

          <h3 className="section-subtitle">📤 Test a channel (buff gateway send)</h3>
          <form className="hub-send-form" onSubmit={(e) => void handleSendMessage(e)}>
            <label className="hub-send-target">
              <span className="admin-hint">Target — an alias or platform:channelId</span>
              <input
                type="text"
                value={sendTarget}
                onChange={(e) => setSendTarget(e.target.value)}
                placeholder="ops or slack:C0123 or email:team@example.com"
                disabled={sending}
                maxLength={128}
              />
            </label>
            <label className="hub-send-message">
              <span className="admin-hint">Message</span>
              <input
                type="text"
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                placeholder="nightly build done 🎉"
                disabled={sending}
                maxLength={4000}
              />
            </label>
            <button className="admin-refresh-btn" type="submit" disabled={sending || !sendTarget.trim() || !sendText}>
              {sending ? '⏳ Sending…' : '📤 Send test message'}
            </button>
          </form>
          {sendMsg ? (
            <div className={`admin-row-msg${sendMsg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{sendMsg.text}</div>
          ) : null}
          <p className="admin-hint">
            Sends through the same gateway the CLI uses — the dashboard process must have the
            platform's env token set (e.g. <code>BUFF_SMTP_HOST</code>). Requires admin or operator.
          </p>
        </div>
      ) : null}

      {/* ── Artifacts tab ────────────────────────────────────────────────── */}
      {tab === 'artifacts' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.artifacts.totalSessions}</div>
              <div className="admin-summary-label">Sessions</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.artifacts.totalArtifacts}</div>
              <div className="admin-summary-label">Artifacts</div>
            </div>
          </div>
          {data.artifacts.sessions.length > 0 ? (
            <div className="hub-session-list">
              {data.artifacts.sessions.map((s) => (
                <div className="hub-card" key={s.sessionId}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.sessionId}</span>
                      <span className="hub-card-id">{s.count} artifact{s.count === 1 ? '' : 's'} · {new Date(s.latestAt).toLocaleString()}</span>
                    </div>
                  </div>
                  {s.recent.length > 0 ? (
                    <ul className="hub-artifact-list">
                      {s.recent.map((a, i) => (
                        <li key={i}>
                          <span className="hub-chip">{a.kind}</span>
                          <span className="hub-artifact-title">{a.title || '(untitled)'}</span>
                          {a.preview ? <div className="hub-artifact-preview">{a.preview}</div> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="admin-hint">No artifact details.</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No artifacts yet — tools that return a deliverable payload land here per session.</div>
          )}
        </div>
      ) : null}

      {/* ── Skills tab ───────────────────────────────────────────────────── */}
      {tab === 'skills' && data ? (
        <div role="tabpanel">
          <div className="admin-summary-grid">
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.enabled}</div>
              <div className="admin-summary-label">Enabled skills</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.disabled}</div>
              <div className="admin-summary-label">Disabled skills</div>
            </div>
            <div className="admin-summary-card">
              <div className="admin-summary-value">{data.skills.hub.length}</div>
              <div className="admin-summary-label">Hub skills (SKILL.md)</div>
            </div>
          </div>

          <h3 className="section-subtitle">📚 Compiled skills (SkillStore — matched at plan time)</h3>
          {data.skills.compiled.length > 0 ? (
            <div className="hub-session-list">
              {data.skills.compiled.map((s) => (
                <div className={`hub-card${s.enabled ? '' : ' hub-card-disabled'}`} key={`c-${s.id}`}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.name}</span>
                      <span className="hub-card-id">{s.id}{s.version ? ` · v${s.version}` : ''}</span>
                    </div>
                    <button
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                      className={`hub-switch${s.enabled ? ' on' : ''}`}
                      disabled={toggling === s.id || pendingToggle !== null || (authed && !canWrite)}
                      onClick={() => toggleSkill(s.id, !s.enabled)}
                    >
                      <span className="hub-switch-knob" />
                    </button>
                  </div>
                  <p className="hub-card-desc">{s.description}</p>
                  <div className="hub-card-tools">
                    {typeof s.usageCount === 'number' ? <span className="hub-chip">{s.usageCount} uses</span> : null}
                    {!s.enabled ? <span className="hub-chip">disabled</span> : null}
                  </div>
                  {/* Edge note: a hub dir named exactly like a compiled id would
                      share the rowMsg key — both cards represent the SAME
                      disabled[] entry then, so toggling either is coherent. */}
                  {rowMsg[s.id] ? <div className="admin-row-msg">{rowMsg[s.id]}</div> : null}
                  {!s.enabled ? <div className="hub-card-note">⛔ Excluded from skill matching — not injected into the planner</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No compiled skills.</div>
          )}

          <h3 className="section-subtitle">🌍 Hub skills (installed SKILL.md)</h3>
          {data.skills.hub.length > 0 ? (
            <div className="hub-session-list">
              {data.skills.hub.map((s) => (
                <div className={`hub-card${s.enabled ? '' : ' hub-card-disabled'}`} key={`h-${s.id}`}>
                  <div className="hub-card-top">
                    <div className="hub-card-title">
                      <span className="hub-card-name">{s.name}</span>
                      <span className="hub-card-id">{s.id}</span>
                    </div>
                    <button
                      role="switch"
                      aria-checked={s.enabled}
                      aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                      className={`hub-switch${s.enabled ? ' on' : ''}`}
                      disabled={toggling === s.id || pendingToggle !== null || (authed && !canWrite)}
                      onClick={() => toggleSkill(s.id, !s.enabled)}
                    >
                      <span className="hub-switch-knob" />
                    </button>
                  </div>
                  <p className="hub-card-desc">{s.description}</p>
                  <div className="hub-card-tools">
                    <span className="hub-chip">SKILL.md</span>
                    {!s.enabled ? <span className="hub-chip">disabled</span> : null}
                  </div>
                  {rowMsg[s.id] ? <div className="admin-row-msg">{rowMsg[s.id]}</div> : null}
                  {!s.enabled ? <div className="hub-card-note">⛔ Excluded from skill matching — not injected into the planner</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              No hub skills installed — run <code>buff skills install &lt;name&gt;</code> to add one from the registry.
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
