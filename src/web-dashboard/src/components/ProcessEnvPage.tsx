/**
 * Process Environment — the curated switches that change how a RUN behaves.
 *
 * There is already an env page (`/env`), and this is deliberately not it. That
 * one edits SKILL secrets: any well-formed name a skill might declare, mostly
 * opaque strings, all masked. These are switches — isolation, resume, the debug
 * log, OTLP export, tool hooks — where the interesting question is not "what is
 * the value" but "is it on, what does leaving it unset do, and is something
 * outranking me".
 *
 * Hence the two things this page does that a generic NAME=VALUE editor cannot:
 *
 *   1. It renders a real control per variable (on / off / unset), and writes the
 *      CANONICAL spelling for it. `NUVIRA_STRICT_MODEL=true` reads as OFF — the
 *      only value that enables it is the literal `1` — so a page that stored
 *      what the user typed would show "on" for a setting that is off.
 *   2. It reports the file value and the process value separately. `loadEnv()`
 *      never overrides an existing environment variable, so a shell export
 *      silently beats anything written here. Showing only the file would let a
 *      user turn export off and keep exporting.
 *
 * Adds no capability the server does not already gate: writes require the same
 * `admin`/`operator` role the endpoint enforces, and the endpoint refuses every
 * name that is not on the allowlist.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { ProcessEnvVarRow } from '../types';

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  role: string | null;
}

/** The page's sections, in the order a run meets them. */
const GROUPS: Array<{ id: ProcessEnvVarRow['group']; title: string; blurb: string }> = [
  {
    id: 'turn',
    title: 'Turn behaviour',
    blurb: 'How each turn runs. Unset means nobody has asked for anything, which is not the same as asking for no.',
  },
  {
    id: 'observability',
    title: 'Observability',
    blurb: 'What a run records about itself. Both are off by default and off unless asked for.',
  },
  {
    id: 'hooks',
    title: 'Tool hooks',
    blurb:
      'A command run around every tool call, with the call on stdin as JSON. For a phase, a value here REPLACES the hooks declared in tools.hooks.',
  },
];

export default function ProcessEnvPage() {
  const [auth, setAuth] = useState<AuthState>({ configured: false, authenticated: false, role: null });
  const [rows, setRows] = useState<ProcessEnvVarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Typed-but-unsaved values, keyed by variable name. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const canWrite = auth.authenticated && (auth.role === 'admin' || auth.role === 'operator');

  const refresh = useCallback(async () => {
    setLoading(true);
    setRows(await dashboardAPI.fetchProcessEnv());
    setLoading(false);
  }, []);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(
        s
          ? { configured: s.configured, authenticated: s.authenticated, role: s.role ?? null }
          : { configured: false, authenticated: false, role: null },
      );
    });
    void refresh();
  }, [refresh]);

  /**
   * Write one switch and adopt the row the server sent back.
   *
   * The re-read is the point: the server normalizes a value before storing it
   * (`true` → `1`), and a refused write must leave the row reading exactly what
   * it read before rather than what the user hoped for.
   */
  const set = useCallback(
    async (name: string, value: string) => {
      setBusy(name);
      setError(null);
      setNotice(null);
      const r = await dashboardAPI.saveProcessEnvVar(name, value);
      if (!r.ok || !r.row) {
        setError(r.error || `Could not set ${name}.`);
      } else {
        const row = r.row;
        setRows((prev) => prev.map((x) => (x.name === row.name ? row : x)));
        setDrafts((prev) => ({ ...prev, [name]: '' }));
        setNotice(`${name} = ${row.fileValue}. Takes effect on the next turn; the dashboard picked it up immediately.`);
      }
      setBusy(null);
    },
    [],
  );

  const unset = useCallback(async (name: string) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    const r = await dashboardAPI.deleteProcessEnvVar(name);
    if (!r.ok || !r.row) {
      setError(r.error || `Could not unset ${name}.`);
    } else {
      const row = r.row;
      setRows((prev) => prev.map((x) => (x.name === row.name ? row : x)));
      setDrafts((prev) => ({ ...prev, [name]: '' }));
      setNotice(
        r.removed
          ? `${name} removed from the env file. ${row.unsetMeans}`
          : `${name} had no line in the env file. ${row.unsetMeans}`,
      );
    }
    setBusy(null);
  }, []);

  return (
    <div>
      <h2 className="section-title">🌱 Process Environment</h2>
      <div className="env-var-header">
        <span className="env-var-title">
          These are the switches Agent-Nuvira reads for how a run behaves. Values are written to the credential
          env file and are not masked — do not put a secret in a hook command.
        </span>
        <button className="admin-refresh-btn" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>

      <div className="admin-hint">
        A value exported in your shell <strong>wins over this file</strong>, for the dashboard and for every CLI run
        in that shell. A row that says <em>shell value wins</em> is reporting exactly that, and writes here will not
        change it.
      </div>

      {!auth.authenticated ? (
        <div className="admin-hint">
          {auth.configured ? 'Log in to view or change the process environment.' : 'Set up an admin account to change the process environment.'}
        </div>
      ) : null}
      {auth.authenticated && !canWrite ? (
        <div className="admin-hint">Read-only — admins and operators can change these values.</div>
      ) : null}

      {error ? <div className="env-var-notice env-var-notice-error">{error}</div> : null}
      {notice ? <div className="env-var-notice">{notice}</div> : null}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : (
        GROUPS.map((group) => {
          const inGroup = rows.filter((r) => r.group === group.id);
          if (inGroup.length === 0) return null;
          return (
            <section key={group.id} className="process-env-group">
              <h3 className="process-env-group-title">{group.title}</h3>
              <p className="process-env-group-blurb">{group.blurb}</p>
              <div className="env-var-list">
                {inGroup.map((row) => (
                  <ProcessEnvRowView
                    key={row.name}
                    row={row}
                    draft={drafts[row.name] ?? ''}
                    busy={busy === row.name}
                    readOnly={!canWrite}
                    onDraft={(value) => setDrafts((prev) => ({ ...prev, [row.name]: value }))}
                    onSet={(value) => void set(row.name, value)}
                    onUnset={() => void unset(row.name)}
                  />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

/** One curated switch. */
function ProcessEnvRowView({
  row,
  draft,
  busy,
  readOnly,
  onDraft,
  onSet,
  onUnset,
}: {
  row: ProcessEnvVarRow;
  draft: string;
  busy: boolean;
  readOnly: boolean;
  onDraft: (value: string) => void;
  onSet: (value: string) => void;
  onUnset: () => void;
}) {
  const isOn = row.state === 'on';
  const isSet = row.state !== 'unset';
  const buttonClass = (active: boolean) => `admin-mini-btn${active ? ' process-env-active' : ''}`;
  // A resume row that holds a record name is ON but not `1`, so the stored value
  // is worth showing: "on" alone would hide which record it replays.
  const storedSummary =
    row.kind === 'flag' && row.fileValue !== null && row.fileValue !== '1' && row.fileValue !== '0'
      ? row.fileValue
      : null;

  return (
    <div
      className={`env-var-row ${isSet ? 'env-var-set' : 'env-var-missing'}`}
      data-testid={`process-env-row-${row.name}`}
    >
      <div className="env-var-row-header">
        <span className="env-var-name">
          {row.name}
          {row.shadowed ? (
            <span className="env-var-blocked-badge">⚠️ shell value wins: {row.processValue}</span>
          ) : null}
        </span>
        <span className="env-var-status">
          {row.kind === 'flag' ? (isOn ? '✅ On' : isSet ? '⭕ Off' : '➖ Unset') : isSet ? '✅ Set' : '➖ Unset'}
          {storedSummary ? ` (${storedSummary})` : ''}
        </span>
      </div>

      <div className="env-var-description">
        <strong>{row.label}</strong> — {row.description}
      </div>
      <div className="env-var-description">Unset: {row.unsetMeans}</div>
      {row.cliEquivalent ? (
        <div className="env-var-description">
          Same switch: <code>{row.cliEquivalent}</code>
        </div>
      ) : null}
      {row.warning ? <div className="env-var-warning">⚠️ {row.warning}</div> : null}

      {!readOnly ? (
        <div className="env-var-actions">
          {row.kind === 'flag' ? (
            <>
              <button className={buttonClass(isOn)} type="button" disabled={busy} onClick={() => onSet('1')}>
                On
              </button>
              <button
                className={buttonClass(isSet && !isOn)}
                type="button"
                disabled={busy}
                onClick={() => onSet('0')}
              >
                Off
              </button>
              <button className={buttonClass(!isSet)} type="button" disabled={busy} onClick={onUnset}>
                Unset
              </button>
            </>
          ) : null}

          {row.kind === 'text' || row.acceptsValue ? (
            <>
              <input
                className="env-var-input"
                type="text"
                value={draft}
                placeholder={row.placeholder}
                disabled={busy}
                onChange={(e) => onDraft(e.target.value)}
                aria-label={`${row.name} value`}
              />
              <button
                className="admin-mini-btn"
                type="button"
                disabled={busy || draft.trim() === ''}
                onClick={() => onSet(draft)}
              >
                💾 {row.valueLabel ?? 'Save'}
              </button>
            </>
          ) : null}

          {row.kind === 'text' ? (
            <button className="admin-mini-btn admin-mini-btn-danger" type="button" disabled={busy} onClick={onUnset}>
              🗑️ Unset
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
