import type { DashboardData } from '../types';
import { formatCount } from '../format';
import PageHeader from './PageHeader';

interface MemoryPanelProps {
  data: DashboardData | null;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return formatCount(n);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return '0%';
  return (value * 100).toFixed(1) + '%';
}

export default function MemoryPanel({ data }: MemoryPanelProps) {
  if (!data) {
    // Header kept in the loading branch, so the page still says what it is.
    return (
      <>
        <PageHeader icon="💾" title="Memory Store" />
        <div className="loading-state"><p>Loading memory data...</p></div>
      </>
    );
  }

  const { memory, health } = data;
  const entries = Object.entries(memory.byFingerprint || {}).sort(([, a], [, b]) => b - a);
  const factEntries = Object.entries(memory.facts?.byProject || {}).sort(([, a], [, b]) => b - a);
  const recall = memory.recall || { total: 0, today: 0, last7d: 0 };

  return (
    <>
      <PageHeader icon="💾" title="Memory Store" />

      <div className="stats-grid mini">
        <div className="stat-card">
          <div className="stat-value">{formatNumber(memory.total)}</div>
          <div className="stat-label">Trajectories</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatPercent(memory.avgScore)}</div>
          <div className="stat-label">Avg Score</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(memory.facts?.total)}</div>
          <div className="stat-label">Facts</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(recall.total)}</div>
          <div className="stat-label">Recall Hits</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(health?.patterns)}</div>
          <div className="stat-label">Coding Patterns</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(health?.feedback)}</div>
          <div className="stat-label">Feedback Ratings</div>
        </div>
      </div>

      <p className="memory-backend">
        Backend: <code>{memory.backend || 'local'}</code>
        {recall.last7d > 0 ? ` · ${formatNumber(recall.last7d)} recall(s) this week, ${formatNumber(recall.today)} today` : ' · no recalls yet'}
      </p>

      {entries.length > 0 && (
        <>
          <h2 className="section-subtitle">By Project Type</h2>
          <div className="memory-list">
            {entries.map(([project, count]) => (
              <div className="memory-item" key={project}>
                <span className="memory-project">{project}</span>
                <span className="memory-count">{count} trajectory(ies)</span>
              </div>
            ))}
          </div>
        </>
      )}

      {factEntries.length > 0 && (
        <>
          <h2 className="section-subtitle">Facts by Project</h2>
          <div className="memory-list">
            {factEntries.map(([project, count]) => (
              <div className="memory-item" key={project}>
                <span className="memory-project">{project}</span>
                <span className="memory-count">{count} fact(s)</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
