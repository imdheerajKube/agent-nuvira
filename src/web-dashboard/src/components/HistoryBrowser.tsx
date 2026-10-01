import type { DashboardData } from '../types';
import PageHeader from './PageHeader';

interface HistoryBrowserProps {
  data: DashboardData | null;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HistoryBrowser({ data }: HistoryBrowserProps) {
  if (!data) {
    // Header kept in the loading branch, so the page still says what it is.
    return (
      <>
        <PageHeader icon="📝" title="Conversation History" />
        <div className="loading-state"><p>Loading history...</p></div>
      </>
    );
  }

  const { history } = data;
  const sessions = history.recent || [];

  return (
    <>
      <PageHeader icon="📝" title="Conversation History" />
      <div className="history-stats">
        <span className="history-count">Total: <strong>{history.total}</strong> sessions</span>
      </div>

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
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
