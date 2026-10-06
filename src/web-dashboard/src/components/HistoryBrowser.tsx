import { useCallback, useState } from 'react';
import { dashboardAPI } from '../api';
import type { DashboardData, HistoryData } from '../types';
import PageHeader from './PageHeader';

interface HistoryBrowserProps {
  data: DashboardData | null;
}

/** The "older than a week" bulk window (7 days, in ms). */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Conversation history — with cleanup.
 *
 * This page used to be READ-ONLY: the store grows on every chat session, and
 * the only ways to shrink it were `clear()` (wipes everything) or `prune()`
 * (drops a whole age band). Neither answers "get rid of these two, and
 * everything from last month". So the page now offers per-session delete plus a
 * time-based sweep and a confirmed clear-all.
 *
 * It stays prop-driven for the FIRST paint (App already holds `data` and streams
 * updates) and re-reads the list from the server after a delete, because an
 * optimistic removal would lie whenever the server refuses (a viewer without
 * `routing.operate` gets a 403) or when the id was already gone.
 */
export default function HistoryBrowser({ data }: HistoryBrowserProps) {
  /** A fresh server read taken after a delete; wins over the streamed props. */
  const [fresh, setFresh] = useState<HistoryData | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const history = fresh ?? data?.history;

  const clear = useCallback(
    async (target: 'session' | 'older' | 'all', opts: { id?: string; olderThanMs?: number } = {}) => {
      setBusy(true);
      setNotice(null);
      const r = await dashboardAPI.clearHistory(target, opts);
      if (!r.ok) {
        setNotice(r.error || 'Could not delete that.');
      } else if (target === 'all') {
        setNotice(`Removed ${r.removed ?? 0} conversation(s).`);
      } else if (target === 'older') {
        setNotice(
          r.removed
            ? `Removed ${r.removed} conversation(s) older than a week.`
            : 'Nothing older than a week — nothing removed.',
        );
      } else {
        setNotice(`Removed ${r.removed ? r.removed : 0} conversation(s).`);
      }
      const updated = await dashboardAPI.fetchHistory();
      if (updated) setFresh(updated);
      setBusy(false);
    },
    [],
  );

  if (!history) {
    // Header kept in the loading branch, so the page still says what it is.
    return (
      <>
        <PageHeader icon="📝" title="Conversation History" />
        <div className="loading-state"><p>Loading history...</p></div>
      </>
    );
  }

  const sessions = history.recent || [];

  return (
    <>
      <PageHeader icon="📝" title="Conversation History" />
      <div className="history-stats">
        <span className="history-count">Total: <strong>{history.total}</strong> sessions</span>
        {/* Cleanup: the store grows on every session, so one-line-at-a-time
            deletion is the wrong tool. The sweep and the clear are explicit. */}
        <div className="admin-row-actions">
          <button
            className="admin-mini-btn admin-mini-btn-danger"
            type="button"
            disabled={busy}
            title="Delete only conversations started more than 7 days ago"
            onClick={() => void clear('older', { olderThanMs: WEEK_MS })}
          >
            🗑️ Forget older than a week
          </button>
          <button
            className="admin-mini-btn admin-mini-btn-danger"
            type="button"
            disabled={busy || history.total === 0}
            onClick={() => {
              if (window.confirm('Delete ALL stored conversations? This cannot be undone.')) {
                void clear('all');
              }
            }}
          >
            🗑️ Clear all history
          </button>
        </div>
      </div>

      {notice ? <div className="env-var-notice">{notice}</div> : null}

      <div className="history-list">
        {sessions.length === 0 ? (
          <div className="empty-state">No conversations recorded yet.</div>
        ) : (
          sessions.map((session) => (
            <div className="history-item" key={session.id}>
              <div className="history-summary">{session.summary || 'Untitled'}</div>
              <div className="history-meta">
                <span>📅 {formatTime(session.startedAt)}</span>
                <span>🤖 {session.provider || '--'}</span>
                <span>💬 {session.messageCount || 0} msgs</span>
                {session.tags && session.tags.length > 0 && (
                  <span>
                    🏷️ {session.tags.map((tag) => (
                      <span className="history-tag" key={tag}>{tag}</span>
                    ))}
                  </span>
                )}
                <button
                  className="admin-mini-btn admin-mini-btn-danger"
                  type="button"
                  disabled={busy}
                  aria-label={`Forget conversation ${session.summary || session.id}`}
                  onClick={() => void clear('session', { id: session.id })}
                >
                  🗑️ Forget
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
