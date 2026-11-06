/**
 * Unfinished work — the Chat page's surface for `nuvira resume`.
 *
 * WHY IT LIVES ON THE CHAT PAGE. A resume is the continuation of a CONVERSATION
 * that outlived its process. That is a chat fact, not a memory-management one:
 * the user starts work here, so the work that did not finish must be visible
 * here, above the composer, not buried under Memory → Continuity.
 *
 * WHAT IT SHOWS, AND WHY THE ID MATTERS. Every row is one OPEN session snapshot.
 * The row carries the snapshot's own id, goal, directory and step count; the
 * Continue button sends that id back, so the server continues EXACTLY that turn.
 * "Continue all until done" is the only action that spans rows, and it is
 * explicit. Nothing is inferred from "the most recent thing".
 *
 * WHY IT STARTS DETACHED. A continuation can run for hours; a dashboard request
 * cannot hold that. The server spawns the CLI in its own process and returns a
 * pid + log path, which the panel shows.
 *
 * Best-effort by design: an older server (no `/api/resume`) or an empty store
 * renders nothing at all, so the chat page is unchanged for users who never
 * leave unfinished work.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { ResumableRun } from '../types';

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

export default function ResumeRunsPanel() {
  const [runs, setRuns] = useState<ResumableRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Deadline in HOURS (the CLI takes minutes; the CLI flag can stay minutes). */
  const [hours, setHours] = useState('24');

  const refresh = useCallback(async () => {
    setRuns(await dashboardAPI.fetchResumableRuns());
  }, []);

  useEffect(() => {
    let alive = true;
    void dashboardAPI.fetchResumableRuns().then((rows) => {
      if (alive) setRuns(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  const start = useCallback(
    async (input: { id?: string; all?: boolean }) => {
      setBusy(true);
      setNotice(null);
      const parsed = Number(hours);
      const deadlineMinutes = Math.max(1, Math.round((Number.isFinite(parsed) && parsed > 0 ? parsed : 24) * 60));
      const result = await dashboardAPI.startResume({ ...input, deadlineMinutes });
      if (!result.ok) {
        setNotice(result.error || 'Could not start the continuation.');
      } else {
        setNotice(
          `Started in the background${result.pid ? ` (pid ${result.pid})` : ''}.` +
            (result.log ? ` Log: ${result.log}` : ''),
        );
        await refresh();
      }
      setBusy(false);
    },
    [hours, refresh],
  );

  // No runs, an unavailable endpoint, or a store that is still loading: render
  // nothing. The panel must not take space from a normal conversation.
  if (!runs || runs.length === 0) return null;

  return (
    <section className="chat-project-bar" aria-label="Unfinished work">
      <div className="chat-project-attached" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <span className="chat-project-icon" aria-hidden="true">↩️</span>
        <strong>Unfinished work ({runs.length})</strong>
        <span className="admin-hint">
          These turns stopped before finishing (budget, crash or failure). Continuing runs the SAME
          stored ask from its checkpoint — no new prompt.
        </span>
      </div>

      <div className="memory-list" style={{ padding: '0 0.75rem 0.5rem' }}>
        {runs.map((run) => (
          <div className="memory-item" key={run.id}>
            <span className="memory-project" title={`${run.goal}\nid: ${run.id}`}>
              {run.goal.length > 90 ? `${run.goal.slice(0, 90)}…` : run.goal}
            </span>
            <span className="memory-count">
              {shortenPath(run.cwd)} · {run.steps} step(s) · {relativeAge(run.savedAt)}
            </span>
            <button
              className="admin-refresh-btn"
              type="button"
              disabled={busy}
              aria-label={`Continue ${run.goal}`}
              onClick={() => void start({ id: run.id })}
            >
              ↩️ Continue
            </button>
          </div>
        ))}
      </div>

      <div className="admin-row-actions" style={{ padding: '0 0.75rem 0.75rem', alignItems: 'center' }}>
        <label className="admin-hint" htmlFor="resume-deadline-hours">
          Stop after
        </label>
        <input
          id="resume-deadline-hours"
          className="chat-project-input"
          style={{ maxWidth: '5rem' }}
          type="number"
          min={1}
          step={1}
          value={hours}
          disabled={busy}
          aria-label="Deadline in hours"
          onChange={(e) => setHours(e.target.value)}
        />
        <span className="admin-hint">hours</span>
        <button
          className="admin-refresh-btn"
          type="button"
          disabled={busy}
          onClick={() => void start({ all: true })}
        >
          ▶️ Continue all until done
        </button>
        <span className="admin-hint">Runs detached; closing this page does not stop it.</span>
      </div>

      {notice ? <div className="env-var-notice" style={{ margin: '0 0.75rem 0.75rem' }}>{notice}</div> : null}
    </section>
  );
}
