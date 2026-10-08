/**
 * Decisions — the must-ask choices a project's turns recorded (`ask_user`),
 * shown so they can be referred to and REVISED.
 *
 * WHY THIS EXISTS. When the agent cannot proceed without the user's decision, the
 * question and answer used to live only in that turn's transcript. `nuvira
 * decisions` (and `learning/decision-log.ts`) keep them as project artifacts;
 * this page is the dashboard half of the same store, reading the same files, so
 * the two surfaces cannot disagree.
 *
 * READ-ONLY apart from one action: revising a decision (its previous answer is
 * kept in the record's history by the server). It is never a substitute for
 * asking — nothing here answers a question for you.
 *
 * Best-effort and self-contained: an older server (no `/api/decisions`) or a
 * failed fetch renders a quiet note instead of breaking the page.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { DecisionsData } from '../types';
import PageHeader from './PageHeader';

function relativeAge(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function DecisionsPanel() {
  const [projects, setProjects] = useState<Array<{ path: string; name: string; kind: 'cwd' | 'recent' }>>([]);
  const [dir, setDir] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<DecisionsData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The id of the decision currently being revised, and its draft fields. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftNote, setDraftNote] = useState('');

  const load = useCallback(async (target: string, forText?: string) => {
    const d = await dashboardAPI.fetchDecisions(target, forText);
    setData(d);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    void dashboardAPI.listProjects().then((ps) => {
      if (!alive) return;
      setProjects(ps);
      const first = ps.find((p) => p.kind === 'cwd')?.path ?? ps[0]?.path ?? '';
      setDir(first);
      void load(first);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const search = useCallback(() => {
    if (dir) void load(dir, query.trim() || undefined);
  }, [dir, query, load]);

  const save = useCallback(
    async (id: string) => {
      if (!dir || !draft.trim()) return;
      setBusy(true);
      setNotice(null);
      const updated = await dashboardAPI.reviseDecision(dir, id, draft.trim(), draftNote.trim() || undefined);
      if (!updated) {
        setNotice('Could not revise that decision — it may no longer exist.');
      } else {
        setNotice(`Revised ${id} — the previous answer is kept in its history.`);
        setEditing(null);
        setDraft('');
        setDraftNote('');
        await load(dir, query.trim() || undefined);
      }
      setBusy(false);
    },
    [dir, draft, draftNote, query, load],
  );

  const decisions = data?.decisions ?? [];

  return (
    <>
      <PageHeader
        icon="🧭"
        title="Decisions"
        description="The choices the agent asked YOU to make (ask_user), kept so you can refer back and revise them. Written to the project's .nuvira/decisions.jsonl — never a substitute for asking."
      />

      {!loaded ? (
        <div className="loading-state"><p>Loading decisions…</p></div>
      ) : data === null ? (
        <p className="memory-namespace-note">
          Decision data is unavailable — this dashboard server has no <code>/api/decisions</code> endpoint.
        </p>
      ) : (
        <>
          <h2 className="section-subtitle">Workspace</h2>
          {projects.length > 1 ? (
            <label className="memory-backend">
              Project:{' '}
              <select
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value);
                  void load(e.target.value, query.trim() || undefined);
                }}
              >
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>{p.name} ({p.kind})</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="memory-backend"><code>{data.dir}</code></p>
          )}

          <div className="admin-row-actions">
            <input
              type="search"
              value={query}
              placeholder="Find decisions relevant to an ask…"
              aria-label="Search decisions relevant to an ask"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            />
            <button className="admin-mini-btn" type="button" disabled={!dir} onClick={search}>
              🔎 Search
            </button>
            {data.relevant ? (
              <button
                className="admin-mini-btn"
                type="button"
                disabled={!dir}
                onClick={() => { setQuery(''); void load(dir); }}
              >
                ✕ Clear
              </button>
            ) : null}
          </div>

          {notice ? <div className="env-var-notice">{notice}</div> : null}

          <h2 className="section-subtitle">
            {data.relevant ? `Relevant decisions (${decisions.length})` : `Recorded decisions (${decisions.length})`}
          </h2>
          {decisions.length === 0 ? (
            <p className="memory-namespace-note">
              {data.relevant
                ? 'No recorded decision matches that ask.'
                : 'None yet — a decision is recorded when the agent has to ask you one.'}
            </p>
          ) : (
            <div className="memory-list">
              {decisions.map((d) => (
                <div className="memory-item" key={d.id}>
                  <div>
                    <span className="memory-project">
                      {d.status === 'revised' ? '✏️' : '✅'} {d.question}
                    </span>
                    <div className="memory-count">
                      → {d.answer || '(none)'} · {relativeAge(d.at)} · {d.source} · {d.id}
                      {d.status === 'revised' ? ` · revised ${d.revisions?.length ?? 0}×` : ''}
                    </div>
                    {d.choices && d.choices.length > 0 ? (
                      <div className="memory-count">offered: {d.choices.join(' | ')}</div>
                    ) : null}
                  </div>
                  {editing === d.id ? (
                    <div>
                      <input
                        type="text"
                        value={draft}
                        placeholder="New answer"
                        aria-label={`New answer for ${d.question}`}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <input
                        type="text"
                        value={draftNote}
                        placeholder="Why it changed (optional)"
                        aria-label={`Note for ${d.question}`}
                        onChange={(e) => setDraftNote(e.target.value)}
                      />
                      <button
                        className="admin-mini-btn"
                        type="button"
                        disabled={busy || !draft.trim()}
                        onClick={() => void save(d.id)}
                      >
                        💾 Save
                      </button>
                      <button
                        className="admin-mini-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => { setEditing(null); setDraft(''); setDraftNote(''); }}
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="admin-mini-btn"
                      type="button"
                      onClick={() => { setEditing(d.id); setDraft(d.answer); setDraftNote(''); }}
                    >
                      ✏️ Revise
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
