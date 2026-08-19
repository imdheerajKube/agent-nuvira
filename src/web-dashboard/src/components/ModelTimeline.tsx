import { useState, useEffect, useCallback, useRef } from 'react';
import { dashboardAPI } from '../api';

interface ModelTimelineEntry {
  provider: string;
  model: string;
  status: 'verified' | 'unverified' | 'unavailable';
  lastVerifiedAt: number;
  lastProbedAt: number;
  lastUsedAt: number;
  errorRate: number;
  latencyMs?: number;
  contextWindowTokens?: number;
  firstSeenAt?: number;
}

interface TimelineData {
  entries: ModelTimelineEntry[];
  lastUpdated: number;
  totalModels: number;
  freshCount: number;
  staleCount: number;
  removedCount: number;
}

function formatTimeAgo(ms: number): string {
  if (ms <= 0) return 'never';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 30) return `${days}d ago`;
  if (days > 0) return `${days}d ${hours % 24}h ago`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

function getStatusColor(status: string, lastProbedAt: number, errorRate: number): string {
  if (status === 'unavailable') return '#f85149';
  if (status === 'unverified') return '#d29922';
  const now = Date.now();
  const daysSinceProbe = (now - lastProbedAt) / (24 * 60 * 60 * 1000);
  if (daysSinceProbe > 30 && errorRate > 0.5) return '#f85149';
  if (daysSinceProbe > 7) return '#d29922';
  return '#3fb950';
}

function getStatusLabel(status: string, lastProbedAt: number, errorRate: number): string {
  if (status === 'unavailable') return 'Unavailable';
  if (status === 'unverified') return 'Unverified';
  const now = Date.now();
  const daysSinceProbe = (now - lastProbedAt) / (24 * 60 * 60 * 1000);
  if (daysSinceProbe > 30 && errorRate > 0.5) return 'Likely Removed';
  if (daysSinceProbe > 7) return 'Stale';
  return 'Fresh';
}

function TimelineBar({ entry }: { entry: ModelTimelineEntry }) {
  const now = Date.now();
  const probeAge = now - entry.lastProbedAt;
  const verifyAge = now - entry.lastVerifiedAt;
  const useAge = now - entry.lastUsedAt;
  
  // Normalize to 30-day scale
  const probePercent = Math.min(100, (probeAge / (30 * 24 * 60 * 60 * 1000)) * 100);
  const verifyPercent = entry.lastVerifiedAt > 0 ? Math.min(100, (verifyAge / (30 * 24 * 60 * 60 * 1000)) * 100) : -1;
  const usePercent = entry.lastUsedAt > 0 ? Math.min(100, (useAge / (30 * 24 * 60 * 60 * 1000)) * 100) : -1;
  
  return (
    <div className="timeline-bar-container">
      <div className="timeline-bar" title={`Last probed: ${formatTimeAgo(probeAge)}`}>
        <div 
          className="timeline-bar-fill probe"
          style={{ width: `${probePercent}%` }}
        />
      </div>
      {verifyPercent >= 0 && (
        <div className="timeline-bar small" title={`Last verified: ${formatTimeAgo(verifyAge)}`}>
          <div 
            className="timeline-bar-fill verify"
            style={{ width: `${verifyPercent}%` }}
          />
        </div>
      )}
      {usePercent >= 0 && (
        <div className="timeline-bar small" title={`Last used: ${formatTimeAgo(useAge)}`}>
          <div 
            className="timeline-bar-fill use"
            style={{ width: `${usePercent}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function ModelTimeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'fresh' | 'stale' | 'removed'>('all');
  const [sortBy, setSortBy] = useState<'provider' | 'lastProbed' | 'status'>('provider');
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const response = await fetch('/api/model-timeline');
      if (!response.ok) throw new Error('Failed to fetch timeline data');
      const result = await response.json();
      if (mountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load timeline');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30s
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  if (loading) {
    return (
      <div className="admin-header">
        <h2 className="section-title">📅 Model Discovery Timeline</h2>
        <div className="loading-state">
          <div className="loading-spinner" />
          <p>Loading timeline...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-header">
        <h2 className="section-title">📅 Model Discovery Timeline</h2>
        <div className="admin-row-msg admin-row-msg-err">{error}</div>
      </div>
    );
  }

  const entries = data?.entries ?? [];
  
  // Filter entries
  const filteredEntries = entries.filter((e) => {
    const now = Date.now();
    const daysSinceProbe = (now - e.lastProbedAt) / (24 * 60 * 60 * 1000);
    const isStale = daysSinceProbe > 7;
    const isRemoved = daysSinceProbe > 30 && e.errorRate > 0.5;
    const isFresh = !isStale && !isRemoved;
    
    if (filter === 'fresh') return isFresh;
    if (filter === 'stale') return isStale && !isRemoved;
    if (filter === 'removed') return isRemoved;
    return true;
  });

  // Sort entries
  const sortedEntries = [...filteredEntries].sort((a, b) => {
    if (sortBy === 'provider') return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    if (sortBy === 'lastProbed') return b.lastProbedAt - a.lastProbedAt;
    if (sortBy === 'status') {
      const statusOrder = { unavailable: 0, unverified: 1, verified: 2 };
      return (statusOrder[b.status] ?? 0) - (statusOrder[a.status] ?? 0);
    }
    return 0;
  });

  // Group by provider
  const byProvider = new Map<string, ModelTimelineEntry[]>();
  for (const e of sortedEntries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider)!.push(e);
  }

  return (
    <div className="admin-header">
      <h2 className="section-title">📅 Model Discovery Timeline</h2>
      
      {/* Summary cards */}
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <div className="stat-value">{data?.totalModels ?? 0}</div>
          <div className="stat-label">Total Models</div>
        </div>
        <div className="stat-card" style={{ borderColor: '#3fb950' }}>
          <div className="stat-value" style={{ color: '#3fb950' }}>{data?.freshCount ?? 0}</div>
          <div className="stat-label">Fresh (&lt;7d)</div>
        </div>
        <div className="stat-card" style={{ borderColor: '#d29922' }}>
          <div className="stat-value" style={{ color: '#d29922' }}>{data?.staleCount ?? 0}</div>
          <div className="stat-label">Stale (7-30d)</div>
        </div>
        <div className="stat-card" style={{ borderColor: '#f85149' }}>
          <div className="stat-value" style={{ color: '#f85149' }}>{data?.removedCount ?? 0}</div>
          <div className="stat-label">Likely Removed (&gt;30d)</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'fresh', 'stale', 'removed'] as const).map((f) => (
            <button
              key={f}
              className={`admin-refresh-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? '#238636' : '#21262d',
                border: `1px solid ${filter === f ? '#3fb950' : '#30363d'}`,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['provider', 'lastProbed', 'status'] as const).map((s) => (
            <button
              key={s}
              className={`admin-refresh-btn ${sortBy === s ? 'active' : ''}`}
              onClick={() => setSortBy(s)}
              style={{
                background: sortBy === s ? '#238636' : '#21262d',
                border: `1px solid ${sortBy === s ? '#3fb950' : '#30363d'}`,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Sort: {s === 'lastProbed' ? 'Last Seen' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button
          className="admin-refresh-btn"
          onClick={fetchData}
          style={{
            background: '#21262d',
            border: '1px solid #30363d',
            padding: '4px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11, color: '#8b949e' }}>
        <span><span style={{ color: '#58a6ff' }}>■</span> Probe (last seen)</span>
        <span><span style={{ color: '#3fb950' }}>■</span> Verified (last success)</span>
        <span><span style={{ color: '#d29922' }}>■</span> Used (last invocation)</span>
      </div>

      {/* Timeline entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from(byProvider.entries()).map(([provider, models]) => (
          <div key={provider} style={{
            background: '#161b22',
            borderRadius: 8,
            border: '1px solid #30363d',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '10px 14px',
              borderBottom: '1px solid #30363d',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>
                {provider === 'groq' ? '⚡' : provider === 'gemini' ? '🌀' : provider === 'local' ? '💻' : '🤖'}
              </span>
              <span style={{ fontWeight: 600, color: '#e6edf3' }}>{provider}</span>
              <span style={{ fontSize: 12, color: '#8b949e' }}>({models.length} models)</span>
            </div>
            <div style={{ padding: '8px 14px' }}>
              {models.map((entry) => {
                const now = Date.now();
                const daysSinceProbe = (now - entry.lastProbedAt) / (24 * 60 * 60 * 1000);
                const statusColor = getStatusColor(entry.status, entry.lastProbedAt, entry.errorRate);
                const statusLabel = getStatusLabel(entry.status, entry.lastProbedAt, entry.errorRate);
                
                return (
                  <div key={entry.model} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 0',
                    borderBottom: '1px solid #21262d',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ 
                        fontSize: 13, 
                        color: '#e6edf3',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {entry.model}
                      </div>
                      <div style={{ fontSize: 11, color: '#8b949e', display: 'flex', gap: 12 }}>
                        <span>Probed: {formatTimeAgo(now - entry.lastProbedAt)}</span>
                        {entry.lastVerifiedAt > 0 && (
                          <span>Verified: {formatTimeAgo(now - entry.lastVerifiedAt)}</span>
                        )}
                        {entry.lastUsedAt > 0 && (
                          <span>Used: {formatTimeAgo(now - entry.lastUsedAt)}</span>
                        )}
                        {entry.latencyMs !== undefined && (
                          <span>{entry.latencyMs}ms</span>
                        )}
                      </div>
                    </div>
                    <TimelineBar entry={entry} />
                    <div style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: `${statusColor}20`,
                      color: statusColor,
                      border: `1px solid ${statusColor}40`,
                      whiteSpace: 'nowrap',
                    }}>
                      {statusLabel}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {filteredEntries.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '40px 20px',
          color: '#8b949e',
        }}>
          No models match the current filter
        </div>
      )}
    </div>
  );
}
