/**
 * Service Provider API Key Configuration (Admin).
 *
 * The LLM providers live in the Provider Configuration section above: those
 * hand us MODELS. This section is the other half — the third-party SERVICES the
 * agent calls directly: image generation (Nano Banana / DALL·E / Stability),
 * video (FAL), web search (Brave / Serper / Tavily / Google CSE / SearXNG),
 * page reading (Jina), vision/interpretation and speech (ElevenLabs / OpenAI).
 *
 * Every row is backed by a real env var the tool path reads at call time, and
 * writes go to the same 0600 credential env file (`~/.nuvira/.env`) the
 * platform config uses — loaded by `loadEnv()` at startup and hot-applied to
 * the running process. Nothing here is cosmetic: a saved key is what makes that
 * backend available to the agent.
 *
 * RBAC: reads require any authenticated session (secret values are redacted
 * for roles without credential.write); writes require `admin`.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { AdminServiceRow } from '../types';

interface ServiceProvidersPanelProps {
  authed: boolean;
  role: string;
}

/** Capability render order + headings (mirrors src/config/service-catalog.ts). */
const CAPABILITY_ORDER = ['image', 'video', 'search', 'vision', 'speech'] as const;
const CAPABILITY_LABELS: Record<string, string> = {
  image: '🖼️ Image generation',
  video: '🎬 Video generation',
  search: '🔎 Web search & page reading',
  vision: '👁️ Vision / interpretation',
  speech: '🔊 Speech (TTS / STT)',
};

/** Draft inputs, keyed by `${serviceId}:${varName}`. */
type Drafts = Record<string, string>;

export default function ServiceProvidersPanel({ authed, role }: ServiceProvidersPanelProps) {
  const [services, setServices] = useState<AdminServiceRow[]>([]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const canWrite = authed && role === 'admin';

  const load = useCallback(async () => {
    const r = await dashboardAPI.fetchAdminServices();
    if (!r) {
      setError('Could not load service configuration — is the dashboard server up to date?');
      return;
    }
    setError(null);
    setServices(r.services);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const draftKey = (id: string, varName: string) => `${id}:${varName}`;

  const setDraft = (id: string, varName: string, value: string) => {
    setDrafts((d) => ({ ...d, [draftKey(id, varName)]: value }));
  };

  const save = async (svc: AdminServiceRow) => {
    // Send only the vars the user actually typed into — an untouched field must
    // not overwrite (or clear) the stored value.
    const values: Record<string, string> = {};
    for (const v of svc.envVars) {
      const raw = drafts[draftKey(svc.id, v.varName)];
      if (raw !== undefined && raw.trim() !== '') values[v.varName] = raw.trim();
    }
    if (Object.keys(values).length === 0) {
      setMsg((m) => ({ ...m, [svc.id]: 'ℹ️ Type a value to save.' }));
      return;
    }
    setBusy(svc.id);
    setMsg((m) => ({ ...m, [svc.id]: '' }));
    const r = await dashboardAPI.saveService(svc.id, values);
    if (r.ok && r.service) {
      const updated = r.service;
      setServices((prev) => prev.map((s) => (s.id === svc.id ? updated : s)));
      setDrafts((d) => {
        const next = { ...d };
        for (const v of svc.envVars) delete next[draftKey(svc.id, v.varName)];
        return next;
      });
      setMsg((m) => ({ ...m, [svc.id]: `✅ Saved — the agent will use it on the next call.` }));
    } else {
      setMsg((m) => ({ ...m, [svc.id]: `❌ ${r.error || 'Save failed.'}` }));
    }
    setBusy(null);
  };

  const test = async (svc: AdminServiceRow) => {
    setBusy(svc.id);
    setMsg((m) => ({ ...m, [svc.id]: '⏳ Testing…' }));
    const r = await dashboardAPI.testService(svc.id);
    setMsg((m) => ({
      ...m,
      [svc.id]: r.ok ? `✅ ${r.detail || 'Reachable'}` : `❌ ${r.error || r.detail || 'Unreachable'}`,
    }));
    setBusy(null);
  };

  const remove = async (svc: AdminServiceRow) => {
    if (!window.confirm(`Remove ${svc.label}'s stored key(s)? The agent will fall back to another configured backend.`)) return;
    setBusy(svc.id);
    const r = await dashboardAPI.removeService(svc.id);
    if (r.ok && r.service) {
      const updated = r.service;
      setServices((prev) => prev.map((s) => (s.id === svc.id ? updated : s)));
      setDrafts((d) => {
        const next = { ...d };
        for (const v of svc.envVars) delete next[draftKey(svc.id, v.varName)];
        return next;
      });
      setMsg((m) => ({ ...m, [svc.id]: `🗑️ Removed ${r.removed?.join(', ') || 'key(s)'}.` }));
    } else {
      setMsg((m) => ({ ...m, [svc.id]: `❌ ${r.error || 'Remove failed.'}` }));
    }
    setBusy(null);
  };

  const grouped = CAPABILITY_ORDER.map((cap) => ({
    cap,
    services: services.filter((s) => s.capability === cap),
  })).filter((g) => g.services.length > 0);

  const configuredCount = services.filter((s) => s.configured).length;

  return (
    <div className="service-providers-panel">
      <h2 className="section-subtitle">🔌 Service Provider API Keys (image · video · search · vision · speech)</h2>
      <p className="admin-subtitle">
        These are the third-party services the agent calls directly — separate from the LLM
        providers above. Each row maps to a real environment variable the tool path reads; keys are
        written to the credential env file and picked up by the agent on the next call.
        {services.length > 0 ? ` ${configuredCount} of ${services.length} services ready.` : ''}
      </p>

      {!canWrite ? (
        <div className="admin-readonly-note">
          🔒 Read-only — configuring service keys requires the <code>admin</code> role
          (credential.write). Secret values are shown redacted.
        </div>
      ) : null}
      {error ? <div className="admin-error">{error}</div> : null}

      {services.length === 0 && !error ? (
        <div className="empty-state">Loading service configuration…</div>
      ) : null}

      {grouped.map((group) => (
        <section key={group.cap} className="service-providers-group">
          <h3 className="process-env-group-title">{CAPABILITY_LABELS[group.cap] ?? group.cap}</h3>
          <div className="admin-table-wrapper">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Configuration</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {group.services.map((svc) => (
                  <tr key={svc.id}>
                    <td className="admin-provider-type">
                      {svc.icon} {svc.label}
                      <div className="admin-provider-sub">{svc.id}</div>
                      <div className="admin-hint">{svc.description}</div>
                      {svc.sharedNote ? <div className="admin-hint">🔗 {svc.sharedNote}</div> : null}
                      {svc.docsUrl ? (
                        <div className="admin-hint">
                          <a href={svc.docsUrl} target="_blank" rel="noreferrer">Get a key ↗</a>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`admin-check-badge ${svc.configured ? 'admin-check-pass' : 'admin-check-warn'}`}>
                        {svc.configured ? '✅ Ready' : '⚠️ Not set'}
                      </span>
                      {svc.keyless ? <div className="admin-hint">no key needed</div> : null}
                      {svc.free ? <div className="admin-hint">free</div> : null}
                    </td>
                    <td>
                      {svc.envVars.length === 0 ? (
                        <div className="admin-hint">Nothing to configure — works out of the box.</div>
                      ) : (
                        svc.envVars.map((v) => {
                          const key = draftKey(svc.id, v.varName);
                          const draft = drafts[key] ?? '';
                          // Non-secret values can be safely prefilled; a secret is
                          // never placed in the DOM — the placeholder reports it is set.
                          const prefill = !v.secret && v.set ? v.value : '';
                          return (
                            <div className="service-env-row" key={v.varName}>
                              <label className="service-env-label" htmlFor={key}>
                                <code>{v.varName}</code>
                                <span className="admin-hint">{v.prompt}</span>
                              </label>
                              {canWrite ? (
                                <input
                                  id={key}
                                  className="admin-input"
                                  type={v.secret ? 'password' : 'text'}
                                  aria-label={`${svc.id} ${v.varName}`}
                                  placeholder={v.set ? (v.secret ? '•••••• set — type to replace' : prefill) : 'not set'}
                                  value={draft}
                                  onChange={(e) => setDraft(svc.id, v.varName, e.target.value)}
                                  autoComplete="new-password"
                                />
                              ) : (
                                <div className="admin-hint">{v.set ? v.value : '—'}</div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </td>
                    <td>
                      {svc.envVars.length === 0 ? (
                        <div className="admin-hint">always available</div>
                      ) : canWrite ? (
                        <div className="admin-row-actions">
                          <button className="admin-mini-btn" disabled={busy === svc.id} onClick={() => void save(svc)}>💾 Save</button>
                          <button
                            className="admin-mini-btn"
                            disabled={busy === svc.id}
                            title="Probes the SAVED configuration — save first to test a new key"
                            onClick={() => void test(svc)}
                          >🔌 Test</button>
                          <button className="admin-mini-btn admin-mini-danger" disabled={busy === svc.id} onClick={() => void remove(svc)}>🗑 Remove</button>
                        </div>
                      ) : (
                        <div className="admin-hint">read-only</div>
                      )}
                      {msg[svc.id] ? <div className="admin-row-msg">{msg[svc.id]}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
