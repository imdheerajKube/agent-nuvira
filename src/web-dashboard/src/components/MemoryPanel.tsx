import type { DashboardData } from '../types';

interface MemoryPanelProps {
  data: DashboardData | null;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return '0%';
  return (value * 100).toFixed(1) + '%';
}

export default function MemoryPanel({ data }: MemoryPanelProps) {
  if (!data) {
    return <div className="loading-state"><p>Loading memory data...</p></div>;
  }

  const { memory, health } = data;
  const entries = Object.entries(memory.byFingerprint || {}).sort(([, a], [, b]) => b - a);

  return (
    <>
      <h2 className="section-title">💾 Memory Store</h2>

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
          <div className="stat-value">{formatNumber(health?.patterns)}</div>
          <div className="stat-label">Coding Patterns</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatNumber(health?.feedback)}</div>
          <div className="stat-label">Feedback Ratings</div>
        </div>
      </div>

      {entries.length > 0 && (
        <>
          <h3 className="section-subtitle">By Project Type</h3>
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
    </>
  );
}
