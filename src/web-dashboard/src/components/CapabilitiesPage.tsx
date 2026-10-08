/**
 * Capabilities — what the agent can DO on this machine, and what it cannot.
 *
 * The capability layer (Bundle 41+) declares each high-level verb once:
 * its effect, whether it is reversible and how, the credentials or binaries it
 * needs, and the per-OS command where the OS genuinely decides it. The CLI and
 * the model read those declarations through `tool_search`; this page is the
 * HUMAN view of the same facts, so a user can answer "will `deploy` work here?"
 * before asking for it rather than after a run abandons halfway.
 *
 * Three things, one screen:
 *   1. readiness per curated verb — ready, or the exact gap (a missing
 *      executable BLOCKS; a credential that is not an env var is reported and
 *      does not, because it may live in the vault — see requirement-probe.ts);
 *   2. the missing executables, aggregated, so the same `gh` names every verb
 *      that needs it instead of appearing nine times;
 *   3. the live session grants, read and ended through the same endpoints the
 *      Models panel uses (one source), so "trusted for this session" is a thing
 *      the user can SEE and revoke.
 *
 * Nothing here changes a declaration: the page is a read-model plus the existing
 * grant-revocation action (which can only make the agent more conservative).
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { CapabilitiesData, CapabilityReadinessVerb, SessionGrantInfo } from '../types';
import PageHeader from './PageHeader';

/** Human label + tone per effect class. */
const EFFECT_META: Record<string, { label: string; className: string }> = {
  read: { label: 'read', className: 'cap-effect-read' },
  'local-write': { label: 'local write', className: 'cap-effect-local' },
  'local-state': { label: 'machine state', className: 'cap-effect-local' },
  external: { label: 'off-machine', className: 'cap-effect-external' },
  destructive: { label: 'destructive', className: 'cap-effect-destructive' },
};

function effectMeta(effect: string): { label: string; className: string } {
  return EFFECT_META[effect] ?? { label: effect, className: 'cap-effect-local' };
}

export default function CapabilitiesPage() {
  const [data, setData] = useState<CapabilitiesData | null>(null);
  const [grants, setGrants] = useState<SessionGrantInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [caps, g] = await Promise.all([
      dashboardAPI.fetchCapabilities(),
      dashboardAPI.fetchSessionGrants(),
    ]);
    if (!caps) setError('Could not read capabilities from the server.');
    else setError(null);
    setData(caps);
    setGrants(g ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** End a session grant — the user asking to be asked again. */
  const endGrant = useCallback(async (sessionId: string) => {
    setBusy(sessionId);
    const ok = await dashboardAPI.revokeSessionGrant(sessionId);
    if (!ok) setError(`Could not end the grant for ${sessionId}.`);
    else setGrants((prev) => prev.filter((g) => g.sessionId !== sessionId));
    setBusy(null);
  }, []);

  const ready = data?.readyCount ?? 0;
  const blocked = data?.blockedCount ?? 0;
  const missing = data?.missingExecutables ?? [];

  return (
    <div>
      <PageHeader icon="🧰" title="Capabilities" />
      <div className="env-var-header">
        <span className="env-var-title">
          What the agent can do on this machine, read from the same declarations the model discovers. A missing
          executable blocks a verb; a credential that is not an environment variable does not — it may live in the vault.
        </span>
        <button className="admin-refresh-btn" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>

      {error ? <div className="env-var-notice env-var-notice-error">{error}</div> : null}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : !data ? (
        <div className="admin-hint">Capabilities are unavailable right now.</div>
      ) : (
        <>
          <div className="cap-summary" data-testid="cap-summary">
            <span className="cap-tile cap-tile-ok" data-testid="cap-tile-ready">
              <strong>{ready}</strong> ready
            </span>
            <span className={`cap-tile${blocked > 0 ? ' cap-tile-blocked' : ''}`} data-testid="cap-tile-blocked">
              <strong>{blocked}</strong> blocked
            </span>
            <span
              className={`cap-tile${missing.length > 0 ? ' cap-tile-blocked' : ''}`}
              data-testid="cap-tile-missing"
            >
              <strong>{missing.length}</strong> missing executable{missing.length === 1 ? '' : 's'}
            </span>
            <span className="cap-tile" data-testid="cap-tile-grants">
              <strong>{grants.length}</strong> live session grant{grants.length === 1 ? '' : 's'}
            </span>
          </div>

          <section className="cap-section" data-testid="cap-missing">
            <h3 className="cap-section-title">Missing executables</h3>
            {missing.length === 0 ? (
              <p className="cap-empty">Every executable the curated verbs need is on PATH.</p>
            ) : (
              <ul className="cap-missing-list">
                {missing.map((m) => (
                  <li key={m.anyOf.join('|')} className="cap-missing-row">
                    <code className="cap-missing-bins">{m.anyOf.join(' or ')}</code>
                    <span className="cap-missing-for">needed by {m.forRefs.join(', ')}</span>
                    <span className="cap-missing-remedy">{m.remedy}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cap-section" data-testid="cap-verbs">
            <h3 className="cap-section-title">Curated verbs</h3>
            <div className="cap-verb-list">
              {data.verbs.map((verb) => (
                <VerbRow key={verb.id} verb={verb} />
              ))}
            </div>
          </section>

          <section className="cap-section" data-testid="cap-grants">
            <h3 className="cap-section-title">Live session grants</h3>
            {grants.length === 0 ? (
              <p className="cap-empty">No live session grants — off-machine actions will ask.</p>
            ) : (
              <ul className="cap-grant-list">
                {grants.map((g) => (
                  <li key={g.sessionId} className="cap-grant-row" data-testid={`cap-grant-${g.sessionId}`}>
                    <code className="cap-grant-id">{g.sessionId}</code>
                    <span className="cap-grant-cats">{g.categories.join(', ') || '(no categories)'}</span>
                    <button
                      className="admin-mini-btn admin-mini-btn-danger"
                      type="button"
                      disabled={busy === g.sessionId}
                      onClick={() => void endGrant(g.sessionId)}
                    >
                      End
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** One curated verb: its effect, its readiness, and why if it is not ready. */
function VerbRow({ verb }: { verb: CapabilityReadinessVerb }) {
  const effect = effectMeta(verb.effect);
  return (
    <div
      className={`cap-verb${verb.ready ? ' cap-verb-ready' : ' cap-verb-blocked'}`}
      data-testid={`cap-verb-${verb.ref}`}
    >
      <div className="cap-verb-header">
        <span className="cap-verb-name">{verb.name}</span>
        <span className={`cap-badge ${effect.className}`}>{effect.label}</span>
        <span className={`cap-badge ${verb.ready ? 'cap-effect-read' : 'cap-effect-destructive'}`}>
          {verb.ready ? '✅ ready' : '⛔ blocked'}
        </span>
        {verb.grantable ? <span className="cap-badge cap-effect-local">grantable: {verb.grantable}</span> : null}
      </div>
      <div className="cap-verb-does">{verb.does}</div>
      {verb.gaps.length > 0 ? (
        <ul className="cap-verb-gaps">
          {verb.gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : null}
      {verb.ask.length > 0 ? (
        <div className="cap-verb-ask">Will ask for: {verb.ask.join(', ')}</div>
      ) : null}
      {verb.onThisMachine ? (
        <div className="cap-verb-cmd">
          On this machine: <code>{verb.onThisMachine.command}</code>
          {verb.onThisMachine.note ? <span className="cap-verb-note"> — {verb.onThisMachine.note}</span> : null}
        </div>
      ) : null}
      {verb.undo ? <div className="cap-verb-undo">Undo: {verb.undo}</div> : null}
    </div>
  );
}
