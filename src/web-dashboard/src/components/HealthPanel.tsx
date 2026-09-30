/**
 * System Health — the real doctor page, not a second copy of the Admin tab.
 *
 * WHAT WAS WRONG. This tab was called "System Health" and showed four counters:
 * the size of the JSON stores the agent learns into (patterns, feedback,
 * vectors) plus the memory directory path. None of that is system health. Worse,
 * the row labelled **Status** was the hardcoded string `● Connected` — a value
 * that cannot be wrong because it never reads anything. The genuine connection
 * state was tracked in `Layout` and shown in the nav footer, and the doctor
 * checks a user would look for under this name (`runAllChecks()`, split into
 * system/enterprise with pass/warn/fail counts) were rendered on the **Admin**
 * tab instead.
 *
 * WHAT THIS IS NOW. The checks ARE the page: the same `runAllChecks()` the CLI's
 * `nuvira doctor` runs, served from `/api/admin/checks`, grouped by system and
 * enterprise, with a rollup that states failures first. The connection state is
 * the real SSE state passed down from `App` (the same value the nav footer
 * shows), so it can be wrong and therefore means something. Agent performance —
 * `health.agentStats`, computed by the server and previously rendered NOWHERE —
 * has a section. The four store counters survive as a clearly-labelled
 * subsection, because "how big is my memory" is a fair question; it was just
 * never the answer to "System Health".
 *
 * THE CHECKS FETCH IS INDEPENDENT of the SSE payload, deliberately: the page is
 * useful before the first stream frame arrives, so it does not gate the doctor
 * output behind `data` being non-null the way the old panel did.
 */

import { useCallback, useEffect, useState } from 'react';
import { dashboardAPI } from '../api';
import type { AdminCheck, AdminChecksData, DashboardData } from '../types';
import { CheckRow, countByStatus, summarise } from './CheckRow';
import { formatCount } from '../format';

interface HealthPanelProps {
  data: DashboardData | null;
  /**
   * True while the dashboard's SSE stream is up. The REAL connection state —
   * passed from `App`, which is where it is tracked, rather than asserted here.
   */
  connected: boolean;
  /** When the last SSE payload arrived (the same string the nav footer shows). */
  lastUpdated: string;
}

/** `successRate` and `overallSuccessRate` are FRACTIONS — the CLI prints rate*100. */
function asPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return formatCount(n);
}

function timeAgo(at: number | undefined): string {
  if (!at) return 'never';
  const seconds = Math.floor((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One group of checks with its own verdict line, failures stated first. */
function CheckGroup({
  title,
  blurb,
  checks,
  testId,
}: {
  title: string;
  blurb: string;
  checks: AdminCheck[];
  testId: string;
}) {
  const counts = countByStatus(checks);
  return (
    <section style={{ marginBottom: 18 }} data-testid={testId}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 className="section-subtitle" style={{ margin: 0 }}>
          {title}
        </h3>
        <span
          style={{
            fontSize: 12,
            color: counts.fail > 0 ? '#f85149' : counts.warn > 0 ? '#d29922' : '#3fb950',
          }}
          data-testid={`${testId}-summary`}
        >
          {summarise(counts)}
        </span>
      </div>
      <p style={{ fontSize: 11, color: '#8b949e', margin: '4px 0 10px' }}>{blurb}</p>
      {/* An empty group is stated, not hidden: a section that silently
          disappears reads as "this category passed" when it means "the server
          returned nothing for it". */}
      <div className="admin-check-list">
        {checks.length > 0 ? (
          checks.map((check) => <CheckRow key={check.name} check={check} />)
        ) : (
          <div className="empty-state">No {title.toLowerCase()} checks returned.</div>
        )}
      </div>
    </section>
  );
}

export default function HealthPanel({ data, connected, lastUpdated }: HealthPanelProps) {
  const [checks, setChecks] = useState<AdminChecksData | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const runChecks = useCallback(async () => {
    setRunning(true);
    setChecksError(null);
    const result = await dashboardAPI.fetchAdminChecks();
    if (result) setChecks(result);
    else {
      setChecksError(
        'Could not reach the dashboard server, or it is older than this page. Run `nuvira dashboard` to start it.',
      );
    }
    setRunning(false);
  }, []);

  // Run once on mount. Deliberately NOT on an interval: these checks touch the
  // network and the filesystem, so re-running them is the user's decision.
  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const health = data?.health;
  const agentStats = health?.agentStats ?? null;
  const allChecks = [...(checks?.system ?? []), ...(checks?.enterprise ?? [])];
  const rollup = countByStatus(allChecks);
  const configuredProviders = (checks?.providers ?? []).filter((p) => p.configured).length;
  const totalProviders = (checks?.providers ?? []).length;

  const agentRows = agentStats
    ? Object.entries(agentStats.agents)
        .map(([agent, s]) => ({ agent, ...s }))
        .sort((a, b) => b.totalRuns - a.totalRuns || a.agent.localeCompare(b.agent))
    : [];

  return (
    <>
      <h2 className="section-title">⚙️ System Health</h2>
      <p className="section-description" style={{ fontSize: 12, color: '#8b949e', marginBottom: 14 }}>
        The same checks <code>nuvira doctor</code> runs, executed on demand — pass / warn / fail, with the fix for
        anything that is not passing. The store counters at the bottom are how big the agent&apos;s memory files are;
        they are not a health verdict.
      </p>

      {/* ── The real connection state ──────────────────────────────────────
          This used to be the literal string "● Connected", which could never be
          wrong because it never read anything. It now reports the SSE stream
          that actually feeds every panel on this dashboard. */}
      <div className="health-grid" style={{ marginBottom: 18 }}>
        <div className="health-card">
          <span className="health-icon">{connected ? '🟢' : '🟠'}</span>
          <div className="health-body">
            <div className="health-title">Live Stream</div>
            <div className="health-value" data-testid="connection-state">
              {connected ? '● Connected' : '● Reconnecting…'}
            </div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">⏱️</span>
          <div className="health-body">
            <div className="health-title">Last Update</div>
            <div className="health-value">{lastUpdated}</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">🩺</span>
          <div className="health-body">
            <div className="health-title">Doctor</div>
            <div
              className="health-value"
              data-testid="doctor-verdict"
              style={{
                color: rollup.fail > 0 ? '#f85149' : rollup.warn > 0 ? '#d29922' : '#3fb950',
              }}
            >
              {checks ? summarise(rollup) : running ? 'running…' : '--'}
            </div>
          </div>
        </div>
      </div>

      {/* ── Doctor checks ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h3 className="section-subtitle" style={{ margin: 0 }}>
          Doctor Checks
        </h3>
        <button
          className="admin-refresh-btn"
          type="button"
          disabled={running}
          onClick={() => void runChecks()}
          data-testid="run-checks"
        >
          {running ? '⏳ Running…' : '↻ Run checks again'}
        </button>
        {totalProviders > 0 ? (
          <span style={{ fontSize: 11, color: '#8b949e' }}>
            {configuredProviders} of {totalProviders} providers configured — per-provider detail is on the Admin tab
          </span>
        ) : null}
      </div>

      {checksError ? (
        <div className="admin-row-msg admin-row-msg-err" style={{ marginBottom: 12 }}>
          {checksError}
        </div>
      ) : null}

      {!checks && !checksError ? <div className="loading-state">Running checks…</div> : null}

      {checks ? (
        <>
          <CheckGroup
            title="System"
            blurb="Runtime, filesystem, configuration and the local model surface."
            checks={checks.system}
            testId="checks-system"
          />
          <CheckGroup
            title="Enterprise"
            blurb="Governance, audit, RBAC and the controls an operator is accountable for."
            checks={checks.enterprise}
            testId="checks-enterprise"
          />
        </>
      ) : null}

      {/* ── Agent performance (server-computed, previously rendered nowhere) ── */}
      <h3 className="section-subtitle">Agent Performance</h3>
      {agentStats ? (
        <>
          <div className="stats-grid" style={{ marginBottom: 10 }}>
            <div className="stat-card">
              <div className="stat-value">{formatNumber(agentStats.totalRuns)}</div>
              <div className="stat-label">Recorded runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{asPercent(agentStats.overallSuccessRate)}</div>
              <div className="stat-label">Overall success rate</div>
            </div>
          </div>
          {agentRows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 18 }}>
              {agentRows.map((row) => (
                <div
                  key={row.agent}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    fontSize: 12,
                    padding: '4px 0',
                    borderBottom: '1px solid #21262d',
                  }}
                  data-testid={`agent-stats-${row.agent}`}
                >
                  <span style={{ flex: 1, color: '#e6edf3' }}>{row.agent}</span>
                  <span style={{ color: '#8b949e' }}>{formatNumber(row.totalRuns)} runs</span>
                  <span style={{ color: row.successRate >= 0.9 ? '#3fb950' : row.successRate >= 0.7 ? '#d29922' : '#f85149' }}>
                    {asPercent(row.successRate)}
                  </span>
                  <span style={{ color: '#8b949e', minWidth: 78, textAlign: 'right' }}>
                    {timeAgo(row.lastRun)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 11, color: '#8b949e', marginBottom: 18 }}>
              No agent runs recorded yet — this fills in as agents execute.
            </p>
          )}
        </>
      ) : (
        <p style={{ fontSize: 11, color: '#8b949e', marginBottom: 18 }}>
          No agent-stats file yet. Run a task and the per-agent success rates appear here.
        </p>
      )}

      {/* ── Learning stores — demoted, and labelled for what they are ──────── */}
      <h3 className="section-subtitle">Learning Stores</h3>
      <p style={{ fontSize: 11, color: '#8b949e', margin: '4px 0 10px' }}>
        What the agent has learned into disk. Sizes, not verdicts.
      </p>
      <div className="health-grid">
        <div className="health-card">
          <span className="health-icon">💾</span>
          <div className="health-body">
            <div className="health-title">Memory Directory</div>
            <div className="health-path">{health?.memoryDir || '~/.buff/memory/'}</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">📝</span>
          <div className="health-body">
            <div className="health-title">Coding Patterns</div>
            <div className="health-value">{formatNumber(health?.patterns)}</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">👍</span>
          <div className="health-body">
            <div className="health-title">User Feedback</div>
            <div className="health-value">{formatNumber(health?.feedback)} ratings</div>
          </div>
        </div>
        <div className="health-card">
          <span className="health-icon">🧠</span>
          <div className="health-body">
            <div className="health-title">Vector Index</div>
            <div className="health-value">{formatNumber(health?.vectors)} entries</div>
          </div>
        </div>
      </div>

      {!data ? (
        <p style={{ fontSize: 11, color: '#8b949e', marginTop: 10 }}>
          Waiting for the first data frame from the dashboard server — the checks above do not depend on it.
        </p>
      ) : null}

      <h3 className="section-subtitle">Server Info</h3>
      <div className="server-info">
        <div className="info-row">
          <span className="info-label">Stream</span>
          <span className="info-value">{connected ? '● Connected' : '● Reconnecting…'}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Last Updated</span>
          <span className="info-value">{lastUpdated}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Checks run at</span>
          <span className="info-value">
            {checks?.serverTime ? new Date(checks.serverTime).toLocaleString() : '--'}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">Data Directory</span>
          <span className="info-value">{health?.memoryDir || '~/.buff/memory/'}</span>
        </div>
      </div>
    </>
  );
}
