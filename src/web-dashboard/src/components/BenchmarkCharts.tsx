import type { DashboardData } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';

interface BenchmarkChartsProps {
  data: DashboardData | null;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return '$0.00';
  return '$' + usd.toFixed(6);
}

function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return '0%';
  return (value * 100).toFixed(1) + '%';
}

export default function BenchmarkCharts({ data }: BenchmarkChartsProps) {
  if (!data) {
    return <div className="loading-state"><p>Loading benchmark data...</p></div>;
  }

  const { benchmarks } = data;
  const latest = benchmarks.latest;
  const runs = benchmarks.runs || [];

  // Build chart data from historical runs
  const passRateData = runs.map((run) => ({
    name: run.model.length > 12 ? run.model.slice(0, 10) + '..' : run.model,
    passRate: run.summary.totalTasks > 0 ? Math.round((run.summary.tasksPassed / run.summary.totalTasks) * 100) : 0,
    quality: Math.round(run.summary.avgQualityScore * 100),
    latency: run.summary.medianLatencyMs,
    cost: run.summary.totalCostUsd,
    fullModel: run.model,
    provider: run.provider,
  })).reverse();

  return (
    <>
      <h2 className="section-title">📈 Benchmark Results</h2>

      {/* Latest Run */}
      <div className="benchmark-latest">
        {latest ? (
          <>
            <div className="benchmark-header">
              <strong>Latest Run:</strong> {latest.provider}/{latest.model}
            </div>
            <div className="benchmark-stats">
              <div className="benchmark-stat pass">
                <div className="benchmark-stat-value">{latest.summary.tasksPassed}/{latest.summary.totalTasks}</div>
                <div className="benchmark-stat-label">Passed</div>
              </div>
              <div className="benchmark-stat quality">
                <div className="benchmark-stat-value">{formatPercent(latest.summary.avgQualityScore)}</div>
                <div className="benchmark-stat-label">Quality</div>
              </div>
              <div className="benchmark-stat latency">
                <div className="benchmark-stat-value">{latest.summary.medianLatencyMs}ms</div>
                <div className="benchmark-stat-label">Latency</div>
              </div>
              <div className="benchmark-stat fail">
                <div className="benchmark-stat-value">{formatCost(latest.summary.totalCostUsd)}</div>
                <div className="benchmark-stat-label">Cost</div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">No benchmark runs yet. Run <code>buff benchmark</code> to start.</div>
        )}
      </div>

      {/* Pass Rate Chart */}
      {passRateData.length > 1 && (
        <>
          <h3 className="section-subtitle">Pass Rate by Model</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
                <YAxis domain={[0, 100]} tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickFormatter={(v) => v + '%'} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                  labelStyle={{ color: '#e6edf3' }}
                  formatter={(value: number) => [value + '%', 'Pass Rate']}
                />
                <Bar dataKey="passRate" radius={[4, 4, 0, 0]}>
                  {passRateData.map((entry, i) => (
                    <Cell key={i} fill={entry.passRate >= 80 ? '#3fb950' : entry.passRate >= 50 ? '#d29922' : '#f85149'} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Latency Chart */}
          <h3 className="section-subtitle">Latency by Model</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
                <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickFormatter={(v) => v + 'ms'} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                  labelStyle={{ color: '#e6edf3' }}
                  formatter={(value: number) => [value + 'ms', 'Latency']}
                />
                <Bar dataKey="latency" fill="#d29922" radius={[4, 4, 0, 0]} fillOpacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cost Chart */}
          <h3 className="section-subtitle">Cost by Model</h3>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} />
                <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickFormatter={(v) => '$' + v.toFixed(6)} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8 }}
                  labelStyle={{ color: '#e6edf3' }}
                  formatter={(value: number) => ['$' + value.toFixed(6), 'Cost']}
                />
                <Bar dataKey="cost" fill="#bc8cff" radius={[4, 4, 0, 0]} fillOpacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* Run History */}
      <h3 className="section-subtitle">Run History</h3>
      <div className="benchmark-list">
        {runs.length === 0 ? (
          <div className="empty-state">No benchmark runs yet. Run <code>buff benchmark</code> to start.</div>
        ) : (
          runs.map((run) => {
            const passRate = run.summary.totalTasks > 0
              ? Math.round((run.summary.tasksPassed / run.summary.totalTasks) * 100)
              : 0;
            const scoreClass = passRate >= 80 ? 'high' : passRate >= 50 ? 'medium' : 'low';
            return (
              <div className="benchmark-item" key={run.id}>
                <span className="benchmark-date">
                  {new Date(run.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <span className="benchmark-model">{run.provider}/{run.model}</span>
                <span className={`benchmark-score ${scoreClass}`}>{passRate}%</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
