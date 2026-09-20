/**
 * Skill environment variables — the page that owns `EnvVarEditor`'s data.
 *
 * `EnvVarEditor` is a pure presentational component (rows in, callbacks out);
 * it has no fetcher, which is why it sat unreachable even though the write
 * endpoint for skill secrets existed. This page supplies exactly the four
 * things it needs — rows, onSave, onDelete, onTest — and owns the auth gating
 * so the panel can never present a write control the server would reject.
 *
 * Write capability mirrors AgentHub's rule (`admin` or `operator`), because the
 * endpoints behind these controls require `routing.operate`. Reusing that rule
 * here rather than reading a server response keeps the UI and the guard in
 * agreement: a viewer sees the values that exist but no way to change them.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { SkillEnvVarRow } from '../types';
import { EnvVarEditor } from './EnvVarEditor';

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  role: string | null;
}

export default function SkillEnvPage() {
  const [auth, setAuth] = useState<AuthState>({ configured: false, authenticated: false, role: null });
  const [vars, setVars] = useState<SkillEnvVarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canWrite = auth.authenticated && (auth.role === 'admin' || auth.role === 'operator');

  const refresh = useCallback(async () => {
    setLoading(true);
    const rows = await dashboardAPI.fetchSkillEnv();
    setVars(rows);
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
   * Save one variable, then re-read.
   *
   * The re-read is not decoration: it is how a REFUSED write becomes visible.
   * The server declines provider credentials and invalid names, and if the page
   * trusted its own optimism the save would look successful while the row still
   * read ❌ Not set.
   */
  const handleSave = useCallback(
    async (name: string, value: string) => {
      setError(null);
      setNotice(null);
      const r = await dashboardAPI.saveSecrets({ [name]: value });
      const refused = r.refused?.find((x) => x.name === name);
      if (!r.ok || refused) {
        setError(refused ? describeRefusal(name, refused.reason) : r.error || `Could not save ${name}.`);
      } else {
        setNotice(`Saved ${name}.`);
      }
      await refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (name: string) => {
      setError(null);
      setNotice(null);
      const r = await dashboardAPI.deleteSkillEnvVar(name);
      if (!r.ok) setError(r.error || `Could not delete ${name}.`);
      else setNotice(r.removed ? `Deleted ${name}.` : `${name} was not stored in the env file.`);
      await refresh();
    },
    [refresh],
  );

  /**
   * The probe result is reported in the notice line rather than inside the
   * component's per-row badge: `onTest`'s boolean only says "usable", and the
   * interesting part is always WHY (blocked? platform-owned? simply unset?).
   */
  const handleTest = useCallback(async (name: string) => {
    const r = await dashboardAPI.testSkillEnvVar(name);
    if (!r.ok) {
      setError(r.error || `Could not test ${name}.`);
      return false;
    }
    setError(null);
    setNotice(r.detail || `${name}: ${r.usable ? 'usable by skills' : 'not usable by skills'}`);
    return r.usable === true;
  }, []);

  return (
    <div>
      <h2 className="section-title">🔐 Skill Environment Variables</h2>
      <div className="env-var-header">
        <span className="env-var-title">Values are masked; only names and set/unset state are shown.</span>
        <button className="admin-refresh-btn" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>

      <div className="admin-hint">
        Secrets here are injected into skill executions that declare them (
        <code>required_environment_variables</code>). Provider credentials are listed but locked —
        they belong to provider setup, and skills never receive them.
      </div>

      {!auth.authenticated ? (
        <div className="admin-hint">
          {auth.configured ? 'Log in to view or edit skill secrets.' : 'Set up an admin account to manage skill secrets.'}
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
        <EnvVarEditor
          envVars={vars}
          onSave={(name, value) => void handleSave(name, value)}
          onDelete={(name) => void handleDelete(name)}
          onTest={handleTest}
          readOnly={!canWrite}
        />
      )}
    </div>
  );
}

/**
 * Turn the server's refusal reason into something a user can act on. Kept next
 * to the page (not the server) because it is UI copy — the server sends a
 * stable machine reason, the panel decides how to say it.
 */
function describeRefusal(name: string, reason: string): string {
  switch (reason) {
    case 'provider-credential':
      return `${name} is a provider credential — configure it in provider setup instead. Skills never receive it.`;
    case 'invalid-name':
      return `${name} is not a valid environment variable name.`;
    case 'write-failed':
      return `${name} could not be written to the env file.`;
    default:
      return `${name} was not saved (${reason}).`;
  }
}
