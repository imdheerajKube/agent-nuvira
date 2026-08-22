/**
 * Execution History — View past skill executions in the dashboard.
 *
 * This component shows:
 * - List of all skill executions
 * - Filter by skill name, status, runtime
 * - View execution details (stdout, stderr, duration)
 * - Export execution history
 * - Clear history
 */

import { useState, useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ExecutionEntry {
  /** Unique entry ID */
  id: string;
  /** Skill name */
  skillName: string;
  /** Skill version (if known) */
  skillVersion?: string;
  /** Skill source (bundled, marketplace, local) */
  skillSource: string;
  /** Execution runtime (python, node, shell, ruby, go, rust) */
  runtime: string;
  /** Execution status */
  status: 'success' | 'failure' | 'timeout' | 'rejected' | 'error';
  /** Timestamp */
  timestamp: number;
  /** Session ID */
  sessionId: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Exit code (for shell execution) */
  exitCode?: number;
  /** Error message (if failed) */
  error?: string;
  /** Command executed */
  command?: string;
  /** Output size in bytes */
  outputSizeBytes?: number;
}

export interface ExecutionHistoryProps {
  /** Callback to fetch execution history */
  onFetch: (filters?: {
    skillName?: string;
    status?: string;
    limit?: number;
  }) => Promise<ExecutionEntry[]>;
  /** Callback to clear history */
  onClear?: () => Promise<void>;
  /** Callback to export history */
  onExport?: (format: 'json' | 'csv') => Promise<string>;
}

// ─── Component ───────────────────────────────────────────────────────────

export function ExecutionHistory({
  onFetch,
  onClear,
  onExport,
}: ExecutionHistoryProps) {
  const [entries, setEntries] = useState<ExecutionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterSkill, setFilterSkill] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<ExecutionEntry | null>(null);
  const [stats, setStats] = useState<{
    total: number;
    success: number;
    failure: number;
    avgDuration: number;
  } | null>(null);

  // Fetch entries on mount and when filters change
  useEffect(() => {
    fetchEntries();
  }, [filterSkill, filterStatus]);

  const fetchEntries = async () => {
    setLoading(true);
    try {
      const fetched = await onFetch({
        skillName: filterSkill || undefined,
        status: filterStatus || undefined,
        limit: 100,
      });
      setEntries(fetched);

      // Calculate stats
      const total = fetched.length;
      const success = fetched.filter((e) => e.status === 'success').length;
      const failure = fetched.filter((e) => e.status === 'failure').length;
      const avgDuration = total > 0
        ? Math.round(fetched.reduce((sum, e) => sum + e.durationMs, 0) / total)
        : 0;

      setStats({ total, success, failure, avgDuration });
    } catch (err) {
      console.error('Failed to fetch execution history:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!onExport) return;
    try {
      const data = await onExport(format);
      const blob = new Blob([data], { type: format === 'json' ? 'application/json' : 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `execution-history.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export history:', err);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    if (!confirm('Are you sure you want to clear all execution history?')) return;
    try {
      await onClear();
      setEntries([]);
      setStats(null);
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success': return '✅';
      case 'failure': return '❌';
      case 'timeout': return '⏰';
      case 'rejected': return '🚫';
      case 'error': return '💥';
      default: return '❓';
    }
  };

  const getRuntimeIcon = (runtime: string) => {
    switch (runtime) {
      case 'python': return '🐍';
      case 'node': return '🟢';
      case 'shell': return '🖥️';
      case 'ruby': return '💎';
      case 'go': return '🔵';
      case 'rust': return '🦀';
      default: return '📜';
    }
  };

  return (
    <div className="execution-history">
      <div className="execution-history-header">
        <h3 className="execution-history-title">📜 Execution History</h3>
        <div className="execution-history-actions">
          <button
            className="admin-mini-btn"
            type="button"
            onClick={() => handleExport('json')}
          >
            📥 Export JSON
          </button>
          <button
            className="admin-mini-btn"
            type="button"
            onClick={() => handleExport('csv')}
          >
            📥 Export CSV
          </button>
          {onClear && (
            <button
              className="admin-mini-btn admin-mini-btn-danger"
              type="button"
              onClick={handleClear}
            >
              🗑️ Clear
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="execution-history-stats">
          <div className="stat-item">
            <span className="stat-value">{stats.total}</span>
            <span className="stat-label">Total</span>
          </div>
          <div className="stat-item stat-success">
            <span className="stat-value">{stats.success}</span>
            <span className="stat-label">Success</span>
          </div>
          <div className="stat-item stat-failure">
            <span className="stat-value">{stats.failure}</span>
            <span className="stat-label">Failed</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{stats.avgDuration}ms</span>
            <span className="stat-label">Avg Duration</span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="execution-history-filters">
        <input
          className="env-var-input"
          type="text"
          placeholder="Filter by skill name..."
          value={filterSkill}
          onChange={(e) => setFilterSkill(e.target.value)}
        />
        <select
          className="env-var-input"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="timeout">Timeout</option>
          <option value="rejected">Rejected</option>
          <option value="error">Error</option>
        </select>
      </div>

      {/* Entry list */}
      <div className="execution-history-list">
        {loading ? (
          <div className="execution-history-empty">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="execution-history-empty">
            No execution history found. Execute a skill to see results here.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={`execution-history-entry ${entry.status}`}
              onClick={() => setSelectedEntry(selectedEntry?.id === entry.id ? null : entry)}
            >
              <div className="entry-header">
                <span className="entry-icon">{getStatusIcon(entry.status)}</span>
                <span className="entry-skill">{entry.skillName}</span>
                <span className="entry-runtime">{getRuntimeIcon(entry.runtime)} {entry.runtime}</span>
                <span className="entry-duration">{entry.durationMs}ms</span>
                <span className="entry-time">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
                <span className="entry-expand">
                  {selectedEntry?.id === entry.id ? '▼' : '▶'}
                </span>
              </div>

              {selectedEntry?.id === entry.id && (
                <div className="entry-details">
                  <div className="entry-detail-row">
                    <span className="detail-label">Status:</span>
                    <span className="detail-value">{entry.status}</span>
                  </div>
                  <div className="entry-detail-row">
                    <span className="detail-label">Runtime:</span>
                    <span className="detail-value">{entry.runtime}</span>
                  </div>
                  <div className="entry-detail-row">
                    <span className="detail-label">Duration:</span>
                    <span className="detail-value">{entry.durationMs}ms</span>
                  </div>
                  {entry.exitCode !== undefined && (
                    <div className="entry-detail-row">
                      <span className="detail-label">Exit Code:</span>
                      <span className="detail-value">{entry.exitCode}</span>
                    </div>
                  )}
                  {entry.error && (
                    <div className="entry-detail-row">
                      <span className="detail-label">Error:</span>
                      <span className="detail-value entry-error">{entry.error}</span>
                    </div>
                  )}
                  {entry.command && (
                    <div className="entry-detail-row">
                      <span className="detail-label">Command:</span>
                      <code className="detail-value">{entry.command}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ExecutionHistory;
