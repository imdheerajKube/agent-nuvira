/**
 * Hooks — declarative lifecycle rules, exposed to the operator.
 *
 * POSITIONING (the design decision, made explicit on the page itself): a hook
 * here is a RULE, not code. It binds to one of nuvira's four lifecycle seams and
 * the action it may take is a fixed, native allow-list — `deny` (stop a tool
 * call), `notify` (log a line), or `scan-args` (look for secret shapes in a
 * call's arguments). Installing a hook can therefore never execute third-party
 * code; that is why this surface is safe to expose at all. See
 * `docs/HOOKS.md` and `docs/DESIGN-skill-plugin-ecosystem.md` §5.2/§6 for why
 * nuvira deliberately does NOT run Claude Code-style hooks.
 *
 * WHY IT IS ON THE DASHBOARD. The contract existed only in code: an operator had
 * no way to see what would run, which seam it binds to, or what it can do. The
 * page is the contract's human-readable face plus an editor that writes the same
 * `<config-dir>/hooks.json` the runtime reads.
 *
 * Writes require admin/operator (`routing.operate`), matching every other config
 * write. Reads are open, like the History page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { dashboardAPI } from '../api';
import { useAuthVersion } from '../useAuthVersion';
import type { HookAction, HookDeclaration, HooksData, HookEvent } from '../types';
import PageHeader from './PageHeader';

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  role: string | null;
}

const EVENT_ICON: Record<HookEvent, string> = {
  before_tool_call: '🛑',
  after_tool_call: '✅',
  failed_tool_call: '❌',
  on_session_end: '🏁',
};

/** `key=glob` lines → the `argsMatch` record. Blank / malformed lines are dropped. */
export function parseArgsMatch(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A one-line, human summary of what a declaration matches and does. */
export function describeHook(hook: HookDeclaration): string {
  const when = hook.when ?? {};
  const parts: string[] = [];
  if (when.tool) parts.push(`tool ${when.tool}`);
  if (when.surface) parts.push(`surface ${when.surface}`);
  if (when.cwdPrefix) parts.push(`cwd ${when.cwdPrefix}*`);
  if (when.argsMatch) for (const [k, v] of Object.entries(when.argsMatch)) parts.push(`${k}=${v}`);
  const target = parts.length > 0 ? parts.join(' · ') : 'every call';
  switch (hook.action.kind) {
    case 'deny':
      return `${target} → deny${hook.action.reason ? `: ${hook.action.reason}` : ''}`;
    case 'notify':
      return `${target} → notify: ${hook.action.message}`;
    case 'scan-args':
      return `${target} → scan args for secrets${hook.action.denyOnHit ? ' (deny on hit)' : ''}`;
  }
}

export default function HooksPage() {
  const authVersion = useAuthVersion();
  const [auth, setAuth] = useState<AuthState>({ configured: false, authenticated: false, role: null });
  const [data, setData] = useState<HooksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The working copy. Saved to the server only on Save. */
  const [hooks, setHooks] = useState<HookDeclaration[]>([]);

  // Add-form state.
  const [draftId, setDraftId] = useState('');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftEvent, setDraftEvent] = useState<HookEvent>('before_tool_call');
  const [draftKind, setDraftKind] = useState<HookAction['kind']>('deny');
  const [draftTool, setDraftTool] = useState('');
  const [draftSurface, setDraftSurface] = useState('');
  const [draftCwd, setDraftCwd] = useState('');
  const [draftArgs, setDraftArgs] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [draftMessage, setDraftMessage] = useState('hook fired: {tool}');
  const [draftDenyOnHit, setDraftDenyOnHit] = useState(false);

  const canWrite = auth.authenticated && (auth.role === 'admin' || auth.role === 'operator');

  const refresh = useCallback(async () => {
    setLoading(true);
    const d = await dashboardAPI.fetchHooks();
    if (d) {
      setData(d);
      setHooks(d.hooks);
    } else {
      setError('Could not load hooks — the dashboard server may be older than this bundle.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(
        s ? { configured: s.configured, authenticated: s.authenticated, role: s.role ?? null } : { configured: false, authenticated: false, role: null },
      );
    });
    void refresh();
  }, [refresh, authVersion]);

  const events = data?.events ?? (['before_tool_call', 'after_tool_call', 'failed_tool_call', 'on_session_end'] as HookEvent[]);
  const eventDescriptions = data?.eventDescriptions ?? {};
  const actionKinds = (data?.actionKinds ?? ['deny', 'notify', 'scan-args']) as HookAction['kind'][];
  const actionDescriptions = data?.actionDescriptions ?? {};

  const idTaken = useMemo(() => hooks.some((h) => h.id === draftId.trim()), [hooks, draftId]);
  const idValid = /^[a-z0-9][a-z0-9-]{0,63}$/.test(draftId.trim());
  const canAdd = idValid && !idTaken && draftLabel.trim().length > 0;

  const addHook = useCallback(() => {
    setError(null);
    setNotice(null);
    const when = {
      ...(draftTool.trim() ? { tool: draftTool.trim() } : {}),
      ...(draftSurface.trim() ? { surface: draftSurface.trim() } : {}),
      ...(draftCwd.trim() ? { cwdPrefix: draftCwd.trim() } : {}),
      ...(parseArgsMatch(draftArgs) ? { argsMatch: parseArgsMatch(draftArgs) } : {}),
    };
    const action: HookAction =
      draftKind === 'deny'
        ? { kind: 'deny', ...(draftReason.trim() ? { reason: draftReason.trim() } : {}) }
        : draftKind === 'notify'
          ? { kind: 'notify', message: draftMessage.trim() || 'hook fired: {tool}' }
          : { kind: 'scan-args', denyOnHit: draftDenyOnHit, ...(draftReason.trim() ? { reason: draftReason.trim() } : {}) };
    const next: HookDeclaration = {
      id: draftId.trim(),
      label: draftLabel.trim(),
      event: draftEvent,
      enabled: true,
      ...(Object.keys(when).length > 0 ? { when } : {}),
      action,
      source: 'user',
      updatedAt: Date.now(),
    };
    setHooks((prev) => [...prev, next]);
    // Reset the form for the next one.
    setDraftId('');
    setDraftLabel('');
    setDraftTool('');
    setDraftSurface('');
    setDraftCwd('');
    setDraftArgs('');
    setDraftReason('');
    setDraftDenyOnHit(false);
  }, [
    draftId, draftLabel, draftEvent, draftKind, draftTool, draftSurface, draftCwd, draftArgs, draftReason, draftMessage, draftDenyOnHit,
  ]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await dashboardAPI.saveHooks(hooks);
    if (!r.ok) {
      setError(r.error || 'Could not save hooks.');
    } else {
      setHooks(r.hooks ?? hooks);
      setNotice(`Saved ${(r.hooks ?? hooks).length} hook(s). They are in force on the next tool call.`);
    }
    setBusy(false);
  }, [hooks]);

  return (
    <div>
      <PageHeader
        icon="🪝"
        title="Hooks"
        description="Declarative lifecycle rules bound to nuvira's own seams. A hook is DATA, not code: its only possible actions are deny, notify and secret-scan. There is no run-command action and no third-party script — nothing here executes."
      />

      <div className="env-var-header">
        <span className="env-var-title">
          {hooks.length} declared · {hooks.filter((h) => h.enabled).length} enabled
          {data?.file ? <> · stored at <code>{data.file}</code></> : null}
        </span>
        <button className="admin-refresh-btn" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
        {canWrite ? (
          <button className="admin-refresh-btn" type="button" disabled={busy} onClick={() => void save()}>
            💾 {busy ? 'Saving…' : 'Save hooks'}
          </button>
        ) : null}
      </div>

      {!auth.authenticated ? (
        <div className="admin-hint">
          {auth.configured ? 'Log in to view or change hooks.' : 'Set up an admin account to change hooks.'}
        </div>
      ) : null}
      {auth.authenticated && !canWrite ? (
        <div className="admin-hint">Read-only — admins and operators can change hooks.</div>
      ) : null}

      {error ? <div className="env-var-notice env-var-notice-error">{error}</div> : null}
      {notice ? <div className="env-var-notice">{notice}</div> : null}

      <section className="panel">
        <h2 className="section-title">How it works</h2>
        <p className="admin-hint">
          When a seam fires, nuvira tests each enabled hook whose event matches, in order, and the FIRST <code>deny</code>{' '}
          wins. Every action is implemented natively, so a bad hook can at worst block a call or print a line — it can
          never run code, reach the network, or read a credential.
        </p>
        <table className="chat-plan-table">
          <thead>
            <tr>
              <th>Seam</th>
              <th>When it fires</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event}>
                <td>
                  {EVENT_ICON[event]} <code>{event}</code>
                </td>
                <td>{eventDescriptions[event] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="chat-plan-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>What it can do</th>
            </tr>
          </thead>
          <tbody>
            {actionKinds.map((kind) => (
              <tr key={kind}>
                <td>
                  <code>{kind}</code>
                </td>
                <td>{actionDescriptions[kind] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="section-title">Declared hooks</h2>
        {loading ? (
          <div className="loading-state">Loading…</div>
        ) : hooks.length === 0 ? (
          <div className="admin-hint">No hooks declared. Add one below — it stays a draft until you Save.</div>
        ) : (
          <div className="env-var-list">
            {hooks.map((hook) => (
              <div key={hook.id} className={`env-var-row ${hook.enabled ? 'env-var-set' : 'env-var-missing'}`} data-testid={`hook-row-${hook.id}`}>
                <div className="env-var-row-header">
                  <span className="env-var-name">
                    {EVENT_ICON[hook.event]} <code>{hook.id}</code> — {hook.label}
                    {hook.source === 'builtin' ? <span className="hub-chip">builtin</span> : null}
                  </span>
                  <span className="env-var-status">{hook.event}</span>
                </div>
                <div className="env-var-description">{describeHook(hook)}</div>
                {canWrite ? (
                  <div className="env-var-actions">
                    <button
                      className={`admin-mini-btn${hook.enabled ? ' process-env-active' : ''}`}
                      type="button"
                      onClick={() => setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, enabled: !h.enabled } : h)))}
                    >
                      {hook.enabled ? '✅ Enabled' : '⭕ Disabled'}
                    </button>
                    {hook.source === 'builtin' ? (
                      // A built-in is a code-owned DEFAULT, not a file entry: it is
                      // merged back in on every load, so "Remove" would look like it
                      // worked and then undo itself. Offer the honest lever instead —
                      // disabling it — and say why there is no delete.
                      <span className="admin-hint">Built-in default — disable it to switch it off; it cannot be deleted.</span>
                    ) : (
                      <button
                        className="admin-mini-btn admin-mini-btn-danger"
                        type="button"
                        onClick={() => setHooks((prev) => prev.filter((h) => h.id !== hook.id))}
                      >
                        🗑️ Remove
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {canWrite ? (
        <section className="panel">
          <h2 className="section-title">Add a hook</h2>
          <div className="env-var-row">
            <div className="env-var-row-header">
              <span className="env-var-name">
                <input
                  className="env-var-input"
                  type="text"
                  value={draftId}
                  placeholder="id (e.g. block-rm-rf)"
                  aria-label="Hook id"
                  onChange={(e) => setDraftId(e.target.value)}
                />
                <input
                  className="env-var-input"
                  type="text"
                  value={draftLabel}
                  placeholder="label"
                  aria-label="Hook label"
                  onChange={(e) => setDraftLabel(e.target.value)}
                />
              </span>
            </div>
            {draftId.trim() && !idValid ? <div className="env-var-warning">⚠️ id must be lowercase letters, digits and hyphens.</div> : null}
            {idTaken ? <div className="env-var-warning">⚠️ that id is already declared.</div> : null}

            <div className="env-var-description">
              <label>
                Seam:{' '}
                <select value={draftEvent} aria-label="Hook event" onChange={(e) => setDraftEvent(e.target.value as HookEvent)}>
                  {events.map((event) => (
                    <option key={event} value={event}>
                      {event}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <label>
                Action:{' '}
                <select value={draftKind} aria-label="Hook action" onChange={(e) => setDraftKind(e.target.value as HookAction['kind'])}>
                  {actionKinds.map((kind) => (
                    <option key={kind} value={kind} disabled={kind === 'deny' && draftEvent !== 'before_tool_call'}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="env-var-description">
              Match (blank = every call):{' '}
              <input className="env-var-input" type="text" value={draftTool} placeholder="tool glob (run_*)" aria-label="Tool glob" onChange={(e) => setDraftTool(e.target.value)} />{' '}
              <input className="env-var-input" type="text" value={draftSurface} placeholder="surface glob" aria-label="Surface glob" onChange={(e) => setDraftSurface(e.target.value)} />{' '}
              <input className="env-var-input" type="text" value={draftCwd} placeholder="cwd prefix" aria-label="Cwd prefix" onChange={(e) => setDraftCwd(e.target.value)} />
            </div>

            <div className="env-var-description">
              Arg match (one <code>key=glob</code> per line, optional):{' '}
              <textarea className="env-var-input" value={draftArgs} placeholder={'command=rm -rf*'} aria-label="Arg match" onChange={(e) => setDraftArgs(e.target.value)} />
            </div>

            {draftKind === 'notify' ? (
              <div className="env-var-description">
                Message:{' '}
                <input className="env-var-input" type="text" value={draftMessage} aria-label="Notify message" onChange={(e) => setDraftMessage(e.target.value)} />{' '}
                <span className="admin-hint">{'{tool} {surface} {event}'} are interpolated.</span>
              </div>
            ) : (
              <div className="env-var-description">
                {draftKind === 'deny' ? 'Reason' : 'Reason (when denied)'}:{' '}
                <input className="env-var-input" type="text" value={draftReason} aria-label="Reason" onChange={(e) => setDraftReason(e.target.value)} />
              </div>
            )}

            {draftKind === 'scan-args' && draftEvent === 'before_tool_call' ? (
              <label className="env-var-description">
                <input type="checkbox" checked={draftDenyOnHit} onChange={(e) => setDraftDenyOnHit(e.target.checked)} /> Block the call when a secret shape is found
              </label>
            ) : null}

            <div className="env-var-actions">
              <button className="admin-refresh-btn" type="button" disabled={!canAdd} onClick={addHook}>
                ➕ Add to draft
              </button>
              <span className="admin-hint">Nothing is in force until you press Save hooks.</span>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
