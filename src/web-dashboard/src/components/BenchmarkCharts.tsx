import type { DashboardData } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts';
import PageHeader from './PageHeader';

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
    // Header kept in the loading branch, so the page still says what it is.
    return (
      <>
        <PageHeader icon="📈" title="Benchmark Results" />
        <div className="loading-state"><p>Loading benchmark data...</p></div>
      </>
    );
  }

  const { benchmarks, evals } = data;
  const latest = benchmarks.latest;
  const runs = benchmarks.runs || [];

  // ── Evaluation framework data (end-to-end agent tasks) ────────────────
  const evalRuns = evals?.runs || [];
  const latestEval = evals?.latest || null;
  const evalChartData = evalRuns.map((run) => ({
    name: run.model.length > 12 ? run.model.slice(0, 10) + '..' : run.model,
    score: Math.round(run.summary.avgCompositeScore * 100),
    completion: Math.round(run.summary.completionRate * 100),
    tests: Math.round(run.summary.testPassRate * 100),
    recovery: Math.round(run.summary.recoveryRate * 100),
    efficiency: Math.round(run.summary.avgTokenEfficiency * 100),
    fullModel: run.model,
    provider: run.provider,
  })).reverse();

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
      <PageHeader icon="📈" title="Benchmark Results" />

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
          <h2 className="section-subtitle">Pass Rate by Model</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={(v) => v + '%'} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(value: number) => [value + '%', 'Pass Rate']}
                />
                <Bar dataKey="passRate" radius={[4, 4, 0, 0]}>
                  {passRateData.map((entry, i) => (
                    <Cell key={i} fillOpacity={0.8} style={{ fill: entry.passRate >= 80 ? 'var(--accent-green)' : entry.passRate >= 50 ? 'var(--accent-yellow)' : 'var(--accent-red)' }} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Latency Chart */}
          <h2 className="section-subtitle">Latency by Model</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v + 'ms'} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(value: number) => [value + 'ms', 'Latency']}
                />
                <Bar dataKey="latency" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-yellow)" style={{ fill: 'var(--accent-yellow)' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cost Chart */}
          <h2 className="section-subtitle">Cost by Model</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={passRateData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => '$' + v.toFixed(6)} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(value: number) => ['$' + value.toFixed(6), 'Cost']}
                />
                <Bar dataKey="cost" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-purple)" style={{ fill: 'var(--accent-purple)' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* ═══ Evaluation Framework Section ═══ */}
      <h2 className="section-subtitle">🎯 Agent Evaluation</h2>
      <p className="section-hint" style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 16 }}>
        End-to-end coding tasks run through the full agent pipeline — measures if the agent is actually improving.
      </p>

      {/* Latest Eval Run */}
      <div className="benchmark-latest">
        {latestEval ? (
          <>
            <div className="benchmark-header">
              <strong>Latest Eval Run:</strong> {latestEval.provider}/{latestEval.model}
            </div>
            <div className="benchmark-stats">
              <div className="benchmark-stat pass">
                <div className="benchmark-stat-value">{latestEval.summary.tasksPassed}/{latestEval.summary.totalTasks}</div>
                <div className="benchmark-stat-label">Tests Passed</div>
              </div>
              <div className="benchmark-stat quality">
                <div className="benchmark-stat-value">{formatPercent(latestEval.summary.avgCompositeScore)}</div>
                <div className="benchmark-stat-label">Composite Score</div>
              </div>
              <div className="benchmark-stat latency">
                <div className="benchmark-stat-value">{formatPercent(latestEval.summary.recoveryRate)}</div>
                <div className="benchmark-stat-label">Recovery Rate</div>
              </div>
              <div className="benchmark-stat fail">
                <div className="benchmark-stat-value">{latestEval.summary.totalRollbacks}</div>
                <div className="benchmark-stat-label">Rollbacks</div>
              </div>
              <div className="benchmark-stat deps">
                <div className="benchmark-stat-value">{formatPercent(latestEval.summary.dependencyInstallRate)}</div>
                <div className="benchmark-stat-label">Deps Installed</div>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">No eval runs yet. Run <code>buff eval run</code> to measure the agent end-to-end.</div>
        )}
      </div>

      {/* Eval Composite Score Chart */}
      {evalChartData.length > 1 && (
        <>
          <h2 className="section-subtitle">Composite Score by Model</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={evalChartData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={(v) => v + '%'} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(value: number) => [value + '%', 'Composite Score']}
                />
                <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                  {evalChartData.map((entry, i) => (
                    <Cell key={i} fillOpacity={0.8} style={{ fill: entry.score >= 80 ? 'var(--accent-green)' : entry.score >= 50 ? 'var(--accent-yellow)' : 'var(--accent-red)' }} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Eval Metrics Breakdown Chart */}
          <h2 className="section-subtitle">Metric Breakdown (completion / tests / recovery / token efficiency)</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={evalChartData} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} tickFormatter={(v) => v + '%'} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                />
                <Legend />
                <Bar dataKey="completion" name="Completion" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-green)" style={{ fill: 'var(--accent-green)' }} />
                <Bar dataKey="tests" name="Tests" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-blue)" style={{ fill: 'var(--accent-blue)' }} />
                <Bar dataKey="recovery" name="Recovery" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-yellow)" style={{ fill: 'var(--accent-yellow)' }} />
                <Bar dataKey="efficiency" name="Token Eff." radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-purple)" style={{ fill: 'var(--accent-purple)' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* Eval Run History */}
      <h2 className="section-subtitle">Eval Run History</h2>
      <div className="benchmark-list">
        {evalRuns.length === 0 ? (
          <div className="empty-state">No eval runs yet. Run <code>buff eval run</code> to start.</div>
        ) : (
          evalRuns.map((run) => {
            const score = Math.round(run.summary.avgCompositeScore * 100);
            const scoreClass = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low';
            return (
              <div className="benchmark-item" key={run.id}>
                <span className="benchmark-date">
                  {new Date(run.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                <span className="benchmark-model">{run.provider}/{run.model}</span>
                <span className={`benchmark-score ${scoreClass}`}>{score}%</span>
              </div>
            );
          })
        )}
      </div>

      {/* Run History */}
      <h2 className="section-subtitle">Run History</h2>
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
