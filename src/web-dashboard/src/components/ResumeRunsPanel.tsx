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
 * Continue button sends that row back to the page, so the conversation continues
 * EXACTLY that turn. Nothing is inferred from "the most recent thing".
 *
 * CONTINUING IS A CHAT TURN, NOT A DETACHED PROCESS. The first version spawned
 * `nuvira resume run` in the background and reported a pid, so pressing
 * "Continue" produced a log path and NOTHING in the conversation — the one place
 * the work was supposed to continue. The row now hands the turn to the page
 * (`onContinue`), which opens a conversation, attaches the folder the turn was
 * working in, and sends the stored ask; the engine rehydrates that same OPEN
 * snapshot, so the continuation reads like a continuation. The detached spawner
 * survives only behind the explicit "Continue all until done" bulk action, where
 * it is labelled as detached.
 *
 * DISMISSING IS EXPLICIT. A turn that stopped 31 days ago is often work the user
 * no longer wants, and a list with no way out is the store's list, not the
 * user's. "Done" clears one row and "Clear all" clears every listed row; both
 * REMOVE the snapshot (the same record the continuity store owns), so a cleared
 * turn never comes back and is never silently continued.
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

export interface ResumeRunsPanelProps {
  /**
   * Load this unfinished turn into the conversation. Given by the Chat page, so
   * Continue means "continue here" — a panel that spawned its own process is
   * exactly the behaviour this replaces.
   */
  onContinue?: (run: ResumableRun) => Promise<void> | void;
  /**
   * Continuations waiting for the running turn to finish, oldest first. Owned by
   * the Chat page (it is the page's queue), shown here because this card is where
   * the user started them — a queued row that is invisible is indistinguishable
   * from a click that did nothing.
   */
  queued?: ResumableRun[];
  /** Drop one WAITING continuation. The running turn is not affected. */
  onCancelQueued?: (id: string) => void;
}

export default function ResumeRunsPanel({
  onContinue,
  queued,
  onCancelQueued,
}: ResumeRunsPanelProps) {
  const [runs, setRuns] = useState<ResumableRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Deadline in HOURS — it bounds the explicit detached bulk action only. */
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

  /** Continue ONE row in the conversation, not in a background process. */
  const continueInChat = useCallback(
    async (run: ResumableRun) => {
      if (!onContinue) return;
      setBusy(true);
      setNotice(null);
      try {
        await onContinue(run);
        // The snapshot stays OPEN until the continued turn finishes, so the row
        // is expected to be here immediately after — the turn closing it is what
        // removes it. Re-read rather than optimistically drop it.
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [onContinue, refresh],
  );

  /** Clear ONE row: forget the snapshot so it is never listed or continued. */
  const dismiss = useCallback(
    async (id: string) => {
      setBusy(true);
      setNotice(null);
      const result = await dashboardAPI.clearContinuity('session', id);
      if (!result.ok) setNotice(result.error || 'Could not clear that unfinished turn.');
      await refresh();
      setBusy(false);
    },
    [refresh],
  );

  /** Clear every listed row. One request per row: a refusal must not lie. */
  const clearAll = useCallback(async () => {
    const list = runs ?? [];
    setBusy(true);
    setNotice(null);
    let removed = 0;
    for (const run of list) {
      const result = await dashboardAPI.clearContinuity('session', run.id);
      if (result.ok) removed += 1;
    }
    await refresh();
    setNotice(
      removed > 0
        ? `Cleared ${removed} unfinished turn${removed === 1 ? '' : 's'} — they will not be listed again.`
        : 'Nothing was cleared.',
    );
    setBusy(false);
  }, [runs, refresh]);

  /**
   * The explicit bulk action, still detached: continuing every open turn can run
   * for hours across several projects, which one chat turn cannot represent.
   */
  const startAll = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const parsed = Number(hours);
    const deadlineMinutes = Math.max(
      1,
      Math.round((Number.isFinite(parsed) && parsed > 0 ? parsed : 24) * 60),
    );
    const result = await dashboardAPI.startResume({ all: true, deadlineMinutes });
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
  }, [hours, refresh]);

  // No runs, no queue, an unavailable endpoint, or a store that is still
  // loading: render nothing. The panel must not take space from a normal
  // conversation. A NON-EMPTY QUEUE KEEPS IT VISIBLE even after every row is
  // cleared — otherwise the card would vanish while continuations are still
  // waiting, and the cancel buttons with it.
  const hasRuns = !!runs && runs.length > 0;
  const hasQueued = !!queued && queued.length > 0;
  if (!hasRuns && !hasQueued) return null;

  return (
    <section className="chat-project-bar" aria-label="Unfinished work">
      <div className="chat-project-attached" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <span className="chat-project-icon" aria-hidden="true">↩️</span>
        <strong>Unfinished work ({(runs?.length ?? 0) + (queued?.length ?? 0)})</strong>
        <span className="admin-hint">
          These turns stopped before finishing (budget, crash or failure). Continue loads the turn
          into this chat with its folder attached, from its checkpoint — no new prompt. Done clears
          a turn you no longer need.
        </span>
      </div>

      {hasRuns ? (
      <div className="memory-list" style={{ padding: '0 0.75rem 0.5rem' }}>
        {(runs ?? []).map((run) => (
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
              disabled={busy || !onContinue}
              aria-label={`Continue ${run.goal}`}
              onClick={() => void continueInChat(run)}
            >
              ↩️ Continue
            </button>
            <button
              className="admin-mini-btn"
              type="button"
              disabled={busy}
              aria-label={`Mark ${run.goal} as done`}
              title="Clear this unfinished turn — it will not be listed or continued again"
              onClick={() => void dismiss(run.id)}
            >
              ✓ Done
            </button>
          </div>
        ))}
      </div>
      ) : null}

      {hasQueued ? (
        <div
          className="memory-list"
          style={{ padding: '0 0.75rem 0.5rem' }}
          aria-label="Queued continuations"
        >
          {(queued ?? []).map((run) => (
            <div className="memory-item" key={`queued-${run.id}`}>
              <span className="memory-project" title={`${run.goal}\nqueued: ${run.id}`}>
                ⏳ {run.goal.length > 90 ? `${run.goal.slice(0, 90)}…` : run.goal}
              </span>
              <span className="memory-count">
                Queued — starts when the current turn ends
              </span>
              <button
                className="admin-mini-btn"
                type="button"
                disabled={busy}
                aria-label={`Cancel queued continuation ${run.goal}`}
                title="Remove this continuation from the queue — it is never started"
                onClick={() => onCancelQueued?.(run.id)}
              >
                ✕ Cancel
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="admin-row-actions" style={{ padding: '0 0.75rem 0.75rem', alignItems: 'center' }}>
        <button
          className="admin-refresh-btn"
          type="button"
          disabled={busy}
          onClick={() => void clearAll()}
        >
          🧹 Clear all
        </button>
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
          onClick={() => void startAll()}
        >
          ▶️ Continue all until done
        </button>
        <span className="admin-hint">Runs detached; closing this page does not stop it.</span>
      </div>

      {notice ? <div className="env-var-notice" style={{ margin: '0 0.75rem 0.75rem' }}>{notice}</div> : null}
    </section>
  );
}
