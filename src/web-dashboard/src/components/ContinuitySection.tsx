/**
 * Continuity — the stored session snapshots and the semantic recall index, with
 * a way to see and FORGET them, plus the effective state of the two switches.
 *
 * WHY THIS EXISTS. Continuity is ON by default (like checkpointing), which means
 * the agent writes transcripts and recall entries without being asked. A feature
 * that stores things on the user's disk must show what it stored and let the user
 * delete it — otherwise "on by default" is a setting with no off road. The two
 * switches themselves live on the Process Environment page; this view reports
 * their EFFECTIVE state and, crucially, the data.
 *
 * Self-contained and best-effort: it fetches its own data, and an older server
 * (no `/api/continuity`) or a failed fetch renders a quiet note instead of an
 * error, so the Memory page never breaks because of this section.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { ContinuityData } from '../types';

/** The "older than a week" bulk window (7 days, in ms). */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function relativeAge(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortenPath(p: string): string {
  const parts = (p || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

export default function ContinuitySection() {
  const [data, setData] = useState<ContinuityData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const d = await dashboardAPI.fetchContinuity();
    setData(d);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void dashboardAPI.fetchContinuity().then((d) => {
      if (!alive) return;
      setData(d);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const clear = useCallback(
    async (
      target: 'sessions' | 'recall' | 'session' | 'recall-entry',
      id?: string,
      /** Time-based bulk: only entries older than this (ms). Omit = all. */
      olderThanMs?: number,
    ) => {
      setBusy(true);
      setNotice(null);
      const r = await dashboardAPI.clearContinuity(target, id, olderThanMs);
      if (!r.ok) setNotice(r.error || 'Could not clear that.');
      else setNotice(`Removed ${r.removed ?? 0} record(s).`);
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  if (!loaded) {
    return (
      <>
        <h2 className="section-subtitle">🔗 Continuity</h2>
        <div className="loading-state"><p>Loading continuity data…</p></div>
      </>
    );
  }

  const unavailable = data === null;
  const sessions = data?.sessions ?? [];
  const recall = data?.recall ?? [];

  return (
    <>
      <h2 className="section-subtitle">🔗 Continuity</h2>
      <p className="memory-namespace-note">
        The conversation snapshots that let a crashed or killed turn be resumed, and the
        index of past asks used for semantic recall. Both are history — they never decide
        that work is done. Turn the switches on or off on the Process Environment page.
      </p>

      {unavailable ? (
        <p className="memory-namespace-note">
          Continuity data is unavailable — this dashboard server has no <code>/api/continuity</code> endpoint.
        </p>
      ) : (
        <>
          <p className="memory-backend">
            Session store: <code>{data.toggles.sessionStore ? 'ON' : 'OFF'}</code>
            {' · '}Semantic recall: <code>{data.toggles.sessionRecall ? 'ON' : 'OFF'}</code>
          </p>

          {notice ? <div className="env-var-notice">{notice}</div> : null}

          <h3 className="section-subtitle">Stored sessions ({sessions.length})</h3>
          {sessions.length === 0 ? (
            <p className="memory-namespace-note">No session snapshots yet.</p>
          ) : (
            <>
              <div className="memory-list">
                {sessions.map((s) => (
                  <div className="memory-item" key={s.id}>
                    <span className="memory-project">
                      {s.open ? '↩️ OPEN' : '✓ closed'} · {s.goal}
                    </span>
                    <span className="memory-count">
                      {shortenPath(s.cwd)} · {s.steps} step(s) · {relativeAge(s.savedAt)}
                    </span>
                    <button
                      className="admin-mini-btn admin-mini-btn-danger"
                      type="button"
                      disabled={busy}
                      aria-label={`Forget session ${s.goal}`}
                      onClick={() => void clear('session', s.id)}
                    >
                      🗑️ Forget
                    </button>
                  </div>
                ))}
              </div>
              <div className="admin-row-actions">
                {/* Bulk cleanup: the store grows on every run, so deleting one
                    line at a time is the wrong tool for "tidy up". */}
                <button
                  className="admin-mini-btn admin-mini-btn-danger"
                  type="button"
                  disabled={busy}
                  title="Delete only session snapshots saved more than 7 days ago"
                  onClick={() => void clear('sessions', undefined, WEEK_MS)}
                >
                  🗑️ Forget older than a week
                </button>
                <button
                  className="admin-mini-btn admin-mini-btn-danger"
                  type="button"
                  disabled={busy || sessions.length === 0}
                  onClick={() => void clear('sessions')}
                >
                  🗑️ Forget all sessions
                </button>
              </div>
            </>
          )}

          <h3 className="section-subtitle">Recalled past asks ({recall.length})</h3>
          {recall.length === 0 ? (
            <p className="memory-namespace-note">Nothing indexed for recall yet.</p>
          ) : (
            <>
              <div className="memory-list">
                {recall.map((r) => (
                  <div className="memory-item" key={r.id}>
                    <span className="memory-project">
                      {r.outcome}: {r.goal}
                    </span>
                    <span className="memory-count">
                      {shortenPath(r.projectPath)} · {relativeAge(r.savedAt)}
                    </span>
                    <button
                      className="admin-mini-btn admin-mini-btn-danger"
                      type="button"
                      disabled={busy}
                      aria-label={`Forget recall entry ${r.goal}`}
                      onClick={() => void clear('recall-entry', r.id)}
                    >
                      🗑️ Forget
                    </button>
                  </div>
                ))}
              </div>
              <div className="admin-row-actions">
                <button
                  className="admin-mini-btn admin-mini-btn-danger"
                  type="button"
                  disabled={busy}
                  title="Delete only recall entries indexed more than 7 days ago"
                  onClick={() => void clear('recall', undefined, WEEK_MS)}
                >
                  🗑️ Forget older than a week
                </button>
                <button
                  className="admin-mini-btn admin-mini-btn-danger"
                  type="button"
                  disabled={busy || recall.length === 0}
                  onClick={() => void clear('recall')}
                >
                  🗑️ Forget all recall entries
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
