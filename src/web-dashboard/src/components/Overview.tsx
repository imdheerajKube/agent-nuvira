import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardData, HubData, TaskRecord } from '../types';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { formatCost, formatNumber } from '../format';
import { dashboardAPI } from '../api';
import MetricTiles, { buildMetricTiles } from './MetricTiles';
import PageHeader from './PageHeader';
// The SAME model/provider counts Overview, the Timeline and the Models page
// show — one endpoint, so the three tabs cannot disagree.
import { useModelCounts } from '../useModelCounts';
// The task list is admin-gated, so a sign-in made from the shell's account menu
// must re-read it: otherwise Overview keeps the 401 it read on mount — claiming
// "sign in" to a user who just did — until they navigate away and back remounts
// the page. `authVersion` is the single signal every gated page re-reads on.
import { useAuthVersion } from '../useAuthVersion';

interface OverviewProps {
  data: DashboardData | null;
  /** Same handler the top bar's Refresh uses, so both refresh the same things. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

const PROVIDER_COLORS: Record<string, string> = {
  local: 'var(--accent-green)',
  groq: 'var(--accent-blue)',
  gemini: 'var(--accent-purple)',
  nim: 'var(--accent-cyan)',
  openrouter: 'var(--accent-yellow)',
};

/** Local midnight, so "today" means the user's today and not the last 24h. */
function isToday(ts: number | null | undefined): boolean {
  if (!ts) return false;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return ts >= start.getTime();
}

function SummaryCard({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="summary-card">
      {/* h2: the page's own title is the h1 above, so sections sit one level down. */}
      <h2 className="summary-card-title">{title}</h2>
      <div className="summary-rows">{children}</div>
      {action ? <div className="summary-card-action">{action}</div> : null}
    </section>
  );
}

function SummaryRow({ value, label }: { value: string; label: string }) {
  return (
    <p className="summary-row">
      <span className="summary-row-value">{value}</span>
      <span className="summary-row-label">{label}</span>
    </p>
  );
}

export default function Overview({ data, onRefresh, refreshing = false }: OverviewProps) {
  // The headline tiles and the gateway card need the Agent Hub aggregate (tools,
  // skills, conversations, platforms), which is deliberately NOT part of the
  // shared /api/all payload — it is the one endpoint that reads the skills and
  // toolset registries off disk. So it is fetched here, once, exactly as
  // AgentHub does. A failure is not an error state: whatever a card has no
  // source for is omitted rather than shown as zero.
  const [hub, setHub] = useState<HubData | null>(null);
  const [tasks, setTasks] = useState<{ status: number; tasks: TaskRecord[] } | null>(null);
  const modelCounts = useModelCounts();
  const authVersion = useAuthVersion();

  useEffect(() => {
    let cancelled = false;
    dashboardAPI.fetchHub().then((h) => {
      if (!cancelled && h) setHub(h);
    });
    void dashboardAPI.listTasks().then((r) => {
      if (!cancelled && r) setTasks(r);
    });
    return () => {
      cancelled = true;
    };
    // Re-read on any sign in/out. The task list answers 401 while signed out, so
    // without this a login left the Task Summary stuck on its "sign in" note.
  }, [authVersion]);

  if (!data) {
    // The header stays while the data arrives, so the page keeps its title and
    // its identity instead of becoming an anonymous spinner.
    return (
      <>
        <PageHeader icon="📊" title="System Overview" description="Cost, memory, benchmarks and routing — read live from the dashboard server." />
        <div className="loading-state">
          <div className="loading-spinner" />
          <p>Connecting to dashboard...</p>
        </div>
      </>
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

  const tiles = buildMetricTiles(data, hub);

  // Task Summary. `listTasks` is admin-gated, so a 401 is a real answer and gets
  // said out loud instead of rendering as "0 running".
  const taskList = tasks?.tasks ?? [];
  const needsAuth = tasks !== null && tasks.status === 401;
  const running = taskList.filter((t) => t.status === 'running').length;
  const failedToday = taskList.filter((t) => isToday(t.finishedAt) && (t.status === 'failed' || t.status === 'error')).length;
  const doneToday = taskList.filter((t) => isToday(t.finishedAt) && t.status === 'done').length;

  const registry = data.modelRegistry;
  const platforms = hub?.channels?.platforms ?? [];
  const configuredPlatforms = platforms.filter((p) => p.configured).length;

  return (
    <>
      <PageHeader
        icon="📊"
        title="System Overview"
        description="Cost, memory, benchmarks and routing — read live from the dashboard server."
        actions={
          onRefresh ? (
            <button type="button" className="btn-secondary" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing}>
              {refreshing ? 'Refreshing…' : '⟳ Refresh data'}
            </button>
          ) : null
        }
      />

      <MetricTiles tiles={tiles} />

      {/* The reference's summary row: three cards beside a quick-actions column.
          Every action here is a real navigation or a call to the same refresh the
          top bar uses — there is no gateway stop endpoint behind this dashboard,
          so the reference's "Stop Gateway" button is deliberately absent rather
          than wired to nothing. */}
      <div className="overview-summary">
        <div className="summary-cards">
          <SummaryCard
            title="Task Summary"
            action={
              <Link className="summary-card-link" to="/tasks">
                Open console →
              </Link>
            }
          >
            {needsAuth ? (
              <p className="summary-note">Sign in to Admin to see task history.</p>
            ) : tasks === null ? (
              <p className="summary-note">Loading task history…</p>
            ) : (
              <>
                <SummaryRow value={formatNumber(running)} label="Running now" />
                <SummaryRow value={formatNumber(doneToday)} label="Completed today" />
                {failedToday > 0 && <SummaryRow value={formatNumber(failedToday)} label="Failed today" />}
              </>
            )}
          </SummaryCard>

          {registry && (
            <SummaryCard
              title="Models"
              action={
                <Link className="summary-card-link" to="/models">
                  Manage →
                </Link>
              }
            >
              {/* Two numbers, deliberately: "routable now" is the staleness-gated
                  subset of "verified". One row labelled "Verified / routable"
                  read as a single count and contradicted the Discovery
                  Timeline's "routable now" whenever a proof aged past 7 days. */}
              <SummaryRow value={formatNumber(registry.routableNow ?? registry.verified)} label="Routable now" />
              <SummaryRow value={formatNumber(registry.verified)} label="Verified (proven)" />
              {/* Two labelled pairs, matching the Timeline and the Models page
                  word-for-word — an unlabelled single "models" number is what
                  let the three tabs look inconsistent when they were not. */}
              <SummaryRow
                value={formatNumber(modelCounts?.trackedModels ?? registry.total)}
                label="Tracked models (registry)"
              />
              <SummaryRow
                value={formatNumber(modelCounts?.trackedProviders ?? registry.providers?.length ?? 0)}
                label="Tracked providers (registry)"
              />
              {modelCounts && (
                <>
                  <SummaryRow value={formatNumber(modelCounts.listedModels)} label="Listed models (live probe)" />
                  <SummaryRow value={formatNumber(modelCounts.listedProviders)} label="Listed providers (live probe)" />
                </>
              )}
              {registry.parked > 0 && <SummaryRow value={formatNumber(registry.parked)} label="Quota-parked" />}
            </SummaryCard>
          )}

          {hub && (
            <SummaryCard
              title="Gateway Status"
              action={
                <Link className="summary-card-link" to="/gateway">
                  Gateway ops →
                </Link>
              }
            >
              <SummaryRow value={`${configuredPlatforms}/${platforms.length}`} label="Platforms configured" />
              <SummaryRow value={formatNumber(hub.skills.total)} label="Skills loaded" />
              <SummaryRow value={formatNumber(hub.toolsets.enabled)} label="Toolsets enabled" />
            </SummaryCard>
          )}
        </div>

        <aside className="quick-actions" aria-labelledby="quick-actions-title">
          <h2 className="summary-card-title" id="quick-actions-title">
            Quick Actions
          </h2>
          <Link className="quick-action" to="/tasks">
            <span aria-hidden="true">🚀</span> Run a CLI command
          </Link>
          <Link className="quick-action" to="/hub">
            <span aria-hidden="true">🧰</span> Skills &amp; channels
          </Link>
          <Link className="quick-action" to="/models">
            <span aria-hidden="true">🧠</span> Model registry
          </Link>
          <Link className="quick-action" to="/traces">
            <span aria-hidden="true">🔍</span> Reasoning traces
          </Link>
          <Link className="quick-action" to="/system">
            <span aria-hidden="true">⚙️</span> Doctor checks
          </Link>
        </aside>
      </div>

      <h2 className="section-subtitle">Key metrics</h2>
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

      {/* Memory Health Summary Card */}
      <div className="memory-health-card">
        <h2 className="section-subtitle">🧠 Memory Health</h2>
        <div className="memory-health-stats">
          <div className="memory-health-stat">
            <span className="memory-health-value">{formatNumber(memory.total)}</span>
            <span className="memory-health-label">Trajectories</span>
          </div>
          <div className="memory-health-stat">
            <span className="memory-health-value">{formatNumber(memory.facts?.total || 0)}</span>
            <span className="memory-health-label">Facts Learned</span>
          </div>
          <div className="memory-health-stat">
            <span className="memory-health-value">{formatNumber(memory.recall?.last7d || 0)}</span>
            <span className="memory-health-label">Recalls This Week</span>
          </div>
          <div className="memory-health-stat">
            <span className="memory-health-value">{health.patterns || 0}</span>
            <span className="memory-health-label">Coding Patterns</span>
          </div>
        </div>
        <p className="memory-health-status">
          Memory tier: <code>{memory.backend || 'local'}</code>
          {' · '}Vector index: <code>{memory.vectorBackend || 'unknown'}</code>
          {memory.recall?.last7d ? ` · ${memory.recall.last7d} recall(s) this week` : ' · no recalls yet'}
        </p>
      </div>

      <h2 className="section-subtitle">💰 Cost by Provider</h2>
      <div className="chart-container">
        {providerEntries.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={providerEntries} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => '$' + v.toFixed(4)} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text-primary)' }}
                formatter={(value: number) => [formatCost(value), 'Cost']}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {providerEntries.map((entry) => (
                  <Cell key={entry.name} fillOpacity={0.8} style={{ fill: PROVIDER_COLORS[entry.name] || 'var(--accent-blue)' }} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">No cost data yet.</div>
        )}
      </div>

      <h2 className="section-subtitle">📊 Trajectories by Project Type</h2>
      <div className="chart-container">
        {projectEntries.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={projectEntries} margin={{ top: 20, right: 20, left: 10, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--text-primary)' }}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} fillOpacity={0.8} fill="var(--accent-purple)" style={{ fill: 'var(--accent-purple)' }} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">No trajectory data yet.</div>
        )}
      </div>
    </>
  );
}
