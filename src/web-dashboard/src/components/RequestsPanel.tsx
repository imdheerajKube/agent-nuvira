/**
 * Requests Panel (Nuvira-Router P3-M3.2) — per provider × model × action
 * request aggregates from the action-telemetry JSONL (the SAME file the Models
 * panel reads, so both panels always agree): requests, p50/p95/p99 latency,
 * error rate, measured cost, and correlation ids for traceability.
 *
 * Degrades cleanly: an older server that doesn't send `requests` shows the
 * empty state instead of crashing (established jsonOrNull guard pattern).
 */
import { useMemo, useState } from 'react';
import type { DashboardData, RequestsInsights } from '../types';
import { formatCount } from '../format';
import PageHeader from './PageHeader';

interface RequestsPanelProps {
  data: DashboardData | null;
}

const ACTION_ICONS: Record<string, string> = {
  chat: '💬', execute: '⚙️', plan: '🗺️', edit: '✏️', skill: '🧩', learn: '📚',
  ci: '🔁', doctor: '🩺', probe: '🔭', 'spot-check': '🧪', telemetry: '📡',
  usage: '🧮', 'ide-chat': '💬', 'ide-inline': '✍️', 'ide-execute': '⚙️',
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtMs(v?: number): string {
  return v !== undefined ? `${v}ms` : '—';
}

function errorColor(rate: number): string {
  if (rate === 0) return 'var(--accent-green)';
  if (rate < 0.2) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
}

function RequestsStats({ data }: { data: RequestsInsights }) {
  const rows = data.rows;
  const totalRequests = rows.reduce((a, r) => a + r.requests, 0);
  const totalFailures = rows.reduce((a, r) => a + Math.round(r.errorRate * r.requests), 0);
  const totalCost = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const latencies = rows.flatMap((r) => (r.latency ? [r.latency.avg] : []));
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : undefined;
  const actions = new Set(rows.map((r) => r.action)).size;

  return (
    <div className="stats-grid" style={{ marginBottom: 16 }}>
      <div className="stat-card">
        <span className="stat-icon">📨</span>
        <div className="stat-body">
          <div className="stat-value">{formatCount(totalRequests)}</div>
          <div className="stat-label">Requests</div>
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">🎯</span>
        <div className="stat-body">
          <div className="stat-value">{rows.length}</div>
          <div className="stat-label">provider × model × action groups</div>
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">⚡</span>
        <div className="stat-body">
          <div className="stat-value" style={{ color: avgLatency !== undefined ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
            {avgLatency !== undefined ? `${avgLatency}ms` : '—'}
          </div>
          <div className="stat-label">Avg latency{avgLatency !== undefined ? ` (${latencies.length} groups)` : ' (no samples)'}</div>
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">📛</span>
        <div className="stat-body">
          <div className="stat-value" style={{ color: errorColor(totalRequests > 0 ? totalFailures / totalRequests : 0) }}>
            {totalRequests > 0 ? `${((totalFailures / totalRequests) * 100).toFixed(1)}%` : '—'}
          </div>
          <div className="stat-label">Overall error rate ({formatCount(totalFailures)} failures)</div>
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon">💰</span>
        <div className="stat-body">
          <div className="stat-value" style={{ color: totalCost > 0 ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
            {totalCost > 0 ? `$${totalCost.toFixed(4)}` : '—'}
          </div>
          <div className="stat-label">Measured cost{actions > 0 ? ` · ${actions} actions` : ''}</div>
        </div>
      </div>
    </div>
  );
}

export default function RequestsPanel({ data }: RequestsPanelProps) {
  const [query, setQuery] = useState('');
  const [actionFilter, setActionFilter] = useState('all');

  const requests = data?.requests;
  const rows = useMemo(() => {
    if (!requests) return [];
    const q = query.trim().toLowerCase();
    return requests.rows.filter((r) => {
      if (actionFilter !== 'all' && r.action !== actionFilter) return false;
      if (!q) return true;
      return `${r.provider} ${r.model} ${r.action}`.toLowerCase().includes(q);
    });
  }, [requests, query, actionFilter]);

  // ONE header for all three states. It used to be written twice — once inside
  // the empty branch and once in the loaded branch — and omitted entirely while
  // loading, so the page title appeared only after the fetch settled.
  const header = (
    <PageHeader
      icon="📨"
      title="Requests — per provider × model × action"
      description="Aggregated from the same action-telemetry log as the Models panel — every Auto-routed call, grouped by action × provider × model. Latency percentiles appear once ≥3 samples exist; cost when the caller reported usage."
    />
  );

  if (!data) {
    return (
      <>
        {header}
        <div className="loading-state"><p>Loading requests...</p></div>
      </>
    );
  }

  if (!requests || !requests.enabled || requests.rows.length === 0) {
    return (
      <>
        {header}
        <div className="empty-state" style={{ padding: '40px 24px', textAlign: 'center' as const }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>📨</div>
          <p className="section-description" style={{ maxWidth: 560, margin: '0 auto' }}>
            No request telemetry yet. As you use <strong>chat</strong>, <strong>execute</strong>,{' '}
            <strong>plan</strong> and <strong>edit</strong> under Auto routing, every call writes to the
            action-telemetry log and this panel aggregates it: request counts, p50/p95/p99 latency, error
            rate and measured cost — the same feed that drives the Models panel.
          </p>
        </div>
      </>
    );
  }

  const actions = [...new Set(requests.rows.map((r) => r.action))].sort();

  return (
    <>
      {header}

      <RequestsStats data={requests} />

      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          aria-label="Filter by action"
          style={{
            background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '8px 10px', fontSize: 13, cursor: 'pointer',
          }}
        >
          <option value="all">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>{ACTION_ICONS[a] || '🎯'} {a}</option>
          ))}
        </select>
        <div style={{ flex: 1, minWidth: 220, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: 8, color: 'var(--text-muted)', fontSize: 13 }}>🔍</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search provider, model or action..."
            style={{
              width: '100%', padding: '8px 12px 8px 32px', background: 'var(--bg-card)',
              border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)',
              fontSize: 13, outline: 'none',
            }}
          />
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {rows.length} of {requests.rows.length} groups
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Action</th>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Provider</th>
              <th style={{ padding: '8px 12px', fontWeight: 500 }}>Model</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Requests</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Error rate</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Latency avg</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>p50</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>p95</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>p99</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Measured cost</th>
              <th style={{ padding: '8px 12px', fontWeight: 500, textAlign: 'right' }}>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No request groups match your filter.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={`${r.action}|${r.provider}|${r.model}`}
                  style={{ borderBottom: '1px solid var(--border-light)' }}
                >
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    <span style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 8,
                      background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                    }}>
                      {ACTION_ICONS[r.action] || '🎯'} {r.action}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{r.provider}</td>
                  <td style={{
                    padding: '8px 12px', color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace",
                    fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} title={r.callIds.length > 0 ? `Correlation ids: ${r.callIds.join(', ')}` : undefined}>
                    {r.model.length > 42 ? r.model.slice(0, 39) + '…' : r.model}
                    {r.callIds.length > 0 && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: 6 }} title={r.callIds.join(', ')}>🔗{r.callIds.length}</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>{r.requests}</td>
                  <td style={{
                    padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace",
                    fontSize: 12, color: errorColor(r.errorRate),
                  }}>
                    {(r.errorRate * 100).toFixed(1)}%
                    {(r.partials ?? 0) > 0 && (
                      <span
                        title={`⏸ ${r.partials} mid-stream interruption(s) — started streaming, died before finish; the router deprioritizes flaky providers (P4 M4.4)`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          marginLeft: 6, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
                          background: 'var(--purple-soft)', border: '1px solid var(--accent-purple)', color: 'var(--accent-purple)',
                        }}
                      >
                        ⏸ {r.partials}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
                    {fmtMs(r.latency?.avg)}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
                    {r.latency && r.latency.samples >= 3 ? fmtMs(r.latency.p50) : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
                    {r.latency && r.latency.samples >= 3 ? fmtMs(r.latency.p95) : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
                    {r.latency && r.latency.samples >= 3 ? fmtMs(r.latency.p99) : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: r.costUsd ? 'var(--accent-yellow)' : 'var(--text-muted)' }}>
                    {r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {fmtTime(r.lastAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
        Auto-refreshes with the dashboard feed · percentile columns need ≥3 latency samples per group
      </div>
    </>
  );
}
