/**
 * QuotaPanel — Session 36: the user-declared daily budget editor.
 *
 * The provider's TPD (tokens-per-day) allowance is invisible to us — only the
 * user knows their plan. This panel lets them declare it (tokens / requests
 * per reset window + the admin cost cap) in the SAME config the CLI writes
 * (`buff model quota set` → `routing.quota.*` + `routing.governance.maxCostUsd`),
 * so the quota ledger + auto-router pace around it BEFORE requests go out.
 *
 * Semantics (Design Decision 21): advisory + pacing, never a product hard cap.
 * Unset = current behavior; set = the ledger parks the provider at the cap and
 * auto-re-enables on window rollover. Clearing a field (blank) returns to
 * unset. Role gates: budget fields → routing.operate (admin + operator); cost
 * cap → policy.write (admin); viewer sees a read-only table.
 */
import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { AdminQuotaConfig, AdminQuotaLimit } from '../types';

interface DraftRow {
  provider: string;
  tokens: string;
  requests: string;
  windowMs: string;
}

function toField(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function QuotaPanel({ authed, role }: { authed: boolean; role: string }) {
  const [data, setData] = useState<AdminQuotaConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [costDraft, setCostDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canEditBudget = authed && (role === 'admin' || role === 'operator');
  const canEditCost = authed && role === 'admin';

  const load = useCallback(async () => {
    const d = await dashboardAPI.fetchAdminQuota();
    if (!d) {
      setError('Could not load budget config.');
      return;
    }
    setError(null);
    setData(d);
    const rows: Record<string, DraftRow> = {};
    for (const p of d.providers) {
      const limit = d.quota[p] || {};
      rows[p] = {
        provider: p,
        tokens: limit.tokensPerWindow?.toString() ?? '',
        requests: limit.requestsPerWindow?.toString() ?? '',
        windowMs: limit.windowMs?.toString() ?? '',
      };
    }
    setDrafts(rows);
    setCostDraft(d.costUsd === null ? '' : String(d.costUsd));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDraft = (provider: string, field: keyof DraftRow, value: string) => {
    setDrafts((d) => ({ ...d, [provider]: { ...(d[provider] || { provider }), [field]: value } }));
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const quota: Record<string, AdminQuotaLimit | null> = {};
    for (const row of Object.values(drafts)) {
      const limit: AdminQuotaLimit = {};
      const t = toField(row.tokens);
      const r = toField(row.requests);
      const w = toField(row.windowMs);
      if (t !== null) limit.tokensPerWindow = t;
      if (r !== null) limit.requestsPerWindow = r;
      if (w !== null) limit.windowMs = w;
      quota[row.provider] = Object.keys(limit).length > 0 ? limit : null;
    }
    const payload: Record<string, unknown> = { quota };
    // The cost cap is gated on policy.write (admin) SERVER-side — an operator
    // must never send costUsd or every save would 403. Omit it entirely unless
    // this session can edit the cap.
    if (canEditCost) {
      if (costDraft.trim() !== '') {
        const n = Number(costDraft);
        if (!Number.isFinite(n) || n < 0) {
          setMsg({ ok: false, text: 'Cost cap must be a non-negative number.' });
          setBusy(false);
          return;
        }
        payload.costUsd = n;
      } else {
        payload.costUsd = null; // clears the cap
      }
    }
    const res = await dashboardAPI.saveAdminQuota(payload as Parameters<typeof dashboardAPI.saveAdminQuota>[0]);
    setBusy(false);
    if (res.ok) {
      setMsg({ ok: true, text: 'Budget saved — the quota ledger + auto-router will enforce it.' });
      void load();
    } else {
      setMsg({ ok: false, text: res.error || 'Save failed.' });
    }
  };

  const configured = (p: string): boolean => {
    const limit = data?.quota[p];
    return !!limit && (limit.tokensPerWindow !== undefined || limit.requestsPerWindow !== undefined || limit.windowMs !== undefined);
  };

  const input = (disabled: boolean) => disabled ? 'admin-input' : 'admin-input';

  return (
    <div className="admin-quota-panel">
      <h3 className="section-subtitle">💰 Daily Budget (routing.quota — your plan, your say)</h3>
      <p className="admin-quota-note">
        Free-tier providers enforce tokens-per-day caps the API doesn't advertise — only you
        know your plan's allowance. Declare it here and the agent paces around it (parks the provider
        at the cap, auto-resumes at window rollover) instead of exhausting your budget mid-task.
        Unset = current behavior. Same config as <code>buff model quota set</code>.
      </p>
      {error ? <div className="admin-error">{error}</div> : null}
      {data ? (
        <>
          <div className="admin-quota-table">
            <div className="admin-quota-row admin-quota-head">
              <span>Provider</span>
              <span>Tokens / window</span>
              <span>Requests / window</span>
              <span>Window (ms)</span>
              <span>Status</span>
            </div>
            {data.providers.map((p) => (
              <div className="admin-quota-row" key={p}>
                <span className="admin-provider-type">{p}</span>
                <input
                  className={input(!canEditBudget)}
                  type="number"
                  min={0}
                  placeholder="unset"
                  disabled={!canEditBudget}
                  value={drafts[p]?.tokens ?? ''}
                  onChange={(e) => setDraft(p, 'tokens', e.target.value)}
                />
                <input
                  className={input(!canEditBudget)}
                  type="number"
                  min={0}
                  placeholder="unset"
                  disabled={!canEditBudget}
                  value={drafts[p]?.requests ?? ''}
                  onChange={(e) => setDraft(p, 'requests', e.target.value)}
                />
                <input
                  className={input(!canEditBudget)}
                  type="number"
                  min={0}
                  placeholder="86400000 (24h)"
                  disabled={!canEditBudget}
                  value={drafts[p]?.windowMs ?? ''}
                  onChange={(e) => setDraft(p, 'windowMs', e.target.value)}
                />
                <span className={`admin-role-badge ${configured(p) ? 'admin-role-admin' : 'admin-role-viewer'}`}>
                  {configured(p) ? 'declared' : 'unset'}
                </span>
              </div>
            ))}
          </div>

          <div className="admin-quota-row admin-quota-cost">
            <span className="admin-provider-type">Max cost / call (USD, admin)</span>
            <input
              className={input(!canEditCost)}
              type="number"
              min={0}
              step={0.01}
              placeholder="unset"
              disabled={!canEditCost}
              value={costDraft}
              onChange={(e) => setCostDraft(e.target.value)}
            />
            <span className="admin-quota-cost-hint">governance.maxCostUsd — hard admin cap</span>
          </div>

          {canEditBudget || canEditCost ? (
            <div className="admin-quota-actions">
              <button className="admin-mini-btn" onClick={() => void save()} disabled={busy}>
                {busy ? '⏳ Saving…' : '💾 Save budget'}
              </button>
              {msg ? (
                <span className={msg.ok ? 'admin-quota-ok' : 'admin-quota-err'}>{msg.text}</span>
              ) : null}
            </div>
          ) : (
            <div className="admin-readonly-note">
              🔒 Read-only for <code>{role}</code> — budget limits need <code>admin</code> or{' '}
              <code>operator</code>; the cost cap needs <code>admin</code>.
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">Loading budget…</div>
      )}
    </div>
  );
}
