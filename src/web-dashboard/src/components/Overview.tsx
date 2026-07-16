import type { DashboardData } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface OverviewProps {
  data: DashboardData | null;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return '$0.00';
  if (usd < 0.00001) return '$0.00';
  if (usd < 0.01) return '$' + usd.toFixed(6);
  return '$' + usd.toFixed(4);
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

const PROVIDER_COLORS: Record<string, string> = {
  local: '#3fb950',
  groq: '#58a6ff',
  gemini: '#bc8cff',
  nim: '#39d2c0',
  openrouter: '#d29922',
};

export default function Overview({ data }: OverviewProps) {
  if (!data) {
    return (
      <div className="loading-state">
        <div className="loading-spinner" />
        <p>Connecting to dashboard...</p>
      </div>
    );
  }

  const { cost, history, benchmarks, memory, health } = data;

  const stats = [
    { icon: '💰', value: formatCost(cost.totalCost), label: 'Total Cost' },
    { icon: '📞', value: formatNumber(cost.totalRequests), label: 'API Requests' },
    { icon: '🧠', value: formatNumber(memory.total), label: 'Trajectories' },
    { icon: '📝', value: formatNumber(history.total), label: 'Chat Sessions' },
    { icon: '🏆', value: formatNumber(benchmarks.totalRuns), label: 'Benchmark Runs' },
    { icon: '📦', value: formatNumber(health.vectors), label: 'Vector Entries' },
  ];

  // Cost by provider chart data
  const providerEntries = Object.entries(cost.byProvider || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Trajectories by project chart data
  const projectEntries = Object.entries(memory.byFingerprint || {})
    .map(([name, value]) => ({ name: name.length > 15 ? name.slice(0, 13) + '..' : name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  return (
    <>
      <h2 className="section-title">📊 System Overview</h2>

      <div className="stats-grid">
        {stats.map((stat) => (
          <div className="stat-card" key={stat.label}>
            <div className="stat-icon">{stat.icon}</div>
            <div className="stat-body">
              <div className="stat-value">{stat.value}</div>
              <div className="stat-label">{stat.label}</div>
            </div>
          </div>
        ))}
      </div>

      <h3 className="section-subtitle">💰 Cost by Provider</h3>
      <div className="chart-container">
        {providerEntries.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={providerEntries} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
              <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickFormatter={(v) => '$' + v.toFixed(4)} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                labelStyle={{ color: '#e6edf3' }}
                formatter={(value: number) => [formatCost(value), 'Cost']}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {providerEntries.map((entry) => (
                  <Cell key={entry.name} fill={PROVIDER_COLORS[entry.name] || '#58a6ff'} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">No cost data yet.</div>
        )}
      </div>

      <h3 className="section-subtitle">📊 Trajectories by Project Type</h3>
      <div className="chart-container">
        {projectEntries.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={projectEntries} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
              <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                labelStyle={{ color: '#e6edf3' }}
              />
              <Bar dataKey="value" fill="#bc8cff" radius={[4, 4, 0, 0]} fillOpacity={0.8} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">No trajectory data yet.</div>
        )}
      </div>
    </>
  );
}
