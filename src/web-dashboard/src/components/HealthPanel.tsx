import type { DashboardData } from '../types';

interface HealthPanelProps {
  data: DashboardData | null;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export default function HealthPanel({ data }: HealthPanelProps) {
  if (!data) {
    return <div className="loading-state"><p>Loading system data...</p></div>;
  }

  const { health, serverTime } = data;

  return (
    <>
      <h2 className="section-title">⚙️ System Health</h2>

      <div className="health-grid">
        <div className="health-card">
          <span className="health-icon">💾</span>
          <div className="health-body">
            <div className="health-title">Memory Directory</div>
            <div className="health-path">{health.memoryDir || '~/.buff/memory/'}</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">📝</span>
          <div className="health-body">
            <div className="health-title">Coding Patterns</div>
            <div className="health-value">{formatNumber(health.patterns)}</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">👍</span>
          <div className="health-body">
            <div className="health-title">User Feedback</div>
            <div className="health-value">{formatNumber(health.feedback)} ratings</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">🧠</span>
          <div className="health-body">
            <div className="health-title">Vector Index</div>
            <div className="health-value">{formatNumber(health.vectors)} entries</div>
          </div>
        </div>
      </div>

      <h3 className="section-subtitle">Server Info</h3>
      <div className="server-info">
        <div className="info-row">
          <span className="info-label">Status</span>
          <span className="info-value">● Connected</span>
        </div>
        <div className="info-row">
          <span className="info-label">Last Updated</span>
          <span className="info-value">{serverTime ? new Date(serverTime).toLocaleString() : '--'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Data Directory</span>
          <span className="info-value">{health.memoryDir || '~/.buff/memory/'}</span>
        </div>
      </div>
    </>
  );
}
