/**
 * Model Discovery Timeline — the REGISTRY's age profile, not a second Models page.
 *
 * WHAT THIS TAB IS FOR. The Models page (`/models`) probes each provider live and
 * answers "can the agent use this model right now, and if not why". This page
 * reads the registry mirror instead and answers a question the live probe cannot:
 * *how has my model knowledge aged* — when each id was probed, when it was last
 * VERIFIED, when it was last used, and which models are about to fall out of
 * routing as their proof ages past the 7-day cutoff.
 *
 * WHY IT WAS REWRITTEN. It used to answer "is this available" three ways at once:
 * the summary cards and the filter classified on PROBE age, while each row's
 * badge checked verification first. MEASURED on a real profile — 555 tracked,
 * 17 verified, 531 probed within 7 days — so "Fresh (531)" opened a list where
 * 514 rows read "Unverified". The card was right, the filter was right, the badge
 * was reporting a different property, and the page contradicted itself.
 *
 * The fix is not a shared threshold, it is two honest axes:
 *
 *   - **Reachability** — `routable` / `parked` / `proof-expired` / `proven-dead`
 *     / `never-verified`. Computed SERVER-side by `classifyReachability`, which
 *     mirrors `isUsable()`. The panel only filters on the string it is handed, so
 *     the count, the filter and the badge cannot drift apart — there is one
 *     classifier, and it is not in this file.
 *   - **Freshness** — whether the provider still lists the id (probe age). Shown
 *     as a chip, not a filter, because it is a different question.
 *
 * `never-verified` is deliberately NOT called "unreachable": it means the
 * provider lists the id and nothing has ever been tried against it. 514 of the
 * author's 555 rows are in that state, and asserting they are unreachable would
 * be 514 claims nobody checked.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { dashboardAPI } from '../api';
// The SAME counts Overview and the Models page show — one endpoint, so the
// three tabs cannot head different numbers under the same word.
import { useModelCounts } from '../useModelCounts';
import type { VerifyBacklogState } from '../types';
import PageHeader from './PageHeader';

/** Server-computed routing verdict, mirrored from `ModelRegistry.isUsable()`. */
type Reachability = 'routable' | 'parked' | 'proof-expired' | 'proven-dead' | 'never-verified';
type Freshness = 'fresh' | 'stale' | 'likely-removed';

interface CopyEntry {
  label: string;
  blurb: string;
  color: string;
}

interface ModelTimelineEntry {
  provider: string;
  model: string;
  status: string;
  reachability: Reachability;
  freshness: Freshness;
  lastVerifiedAt: number;
  lastProbedAt: number;
  lastUsedAt: number;
  errorRate: number;
  latencyMs?: number;
  contextWindowTokens?: number;
  firstSeenAt?: number;
  daysSinceVerify: number | null;
}

interface TimelineData {
  entries: ModelTimelineEntry[];
  lastUpdated: number;
  totalModels: number;
  counts: Record<Reachability, number>;
  freshnessCounts: Record<Freshness, number>;
  reachabilityCopy: Record<Reachability, CopyEntry>;
  freshnessCopy: Record<Freshness, CopyEntry>;
  freshDays: number;
}

/** The order the not-routable reasons matter in: act on these first. */
const NOT_ROUTABLE_ORDER: Reachability[] = ['proven-dead', 'proof-expired', 'parked', 'never-verified'];

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

function ageDays(at: number): string {
  if (at <= 0) return 'never';
  const days = (Date.now() - at) / (24 * 60 * 60 * 1000);
  return days < 1 ? `${(days * 24).toFixed(1)}h` : `${days.toFixed(2)}d`;
}

function TimelineBar({ entry }: { entry: ModelTimelineEntry }) {
  const now = Date.now();
  const probeAge = now - entry.lastProbedAt;
  const verifyAge = now - entry.lastVerifiedAt;
  const useAge = now - entry.lastUsedAt;

  // Normalize to 30-day scale.
  const probePercent = Math.min(100, (probeAge / (30 * 24 * 60 * 60 * 1000)) * 100);
  const verifyPercent = entry.lastVerifiedAt > 0 ? Math.min(100, (verifyAge / (30 * 24 * 60 * 60 * 1000)) * 100) : -1;
  const usePercent = entry.lastUsedAt > 0 ? Math.min(100, (useAge / (30 * 24 * 60 * 60 * 1000)) * 100) : -1;

  return (
    <div className="timeline-bar-container">
      <div className="timeline-bar" title={`Last probed: ${formatTimeAgo(probeAge)}`}>
        <div className="timeline-bar-fill probe" style={{ width: `${probePercent}%` }} />
      </div>
      {verifyPercent >= 0 && (
        <div className="timeline-bar small" title={`Last verified: ${formatTimeAgo(verifyAge)}`}>
          <div className="timeline-bar-fill verify" style={{ width: `${verifyPercent}%` }} />
        </div>
      )}
      {usePercent >= 0 && (
        <div className="timeline-bar small" title={`Last used: ${formatTimeAgo(useAge)}`}>
          <div className="timeline-bar-fill use" style={{ width: `${usePercent}%` }} />
        </div>
      )}
    </div>
  );
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    background: `${color}20`,
    color,
    border: `1px solid ${color}40`,
    whiteSpace: 'nowrap',
  };
}

export default function ModelTimeline() {
  const [data, setData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'routable' | 'not-routable'>('all');
  const [sortBy, setSortBy] = useState<'provider' | 'lastProbed'>('provider');
  const mountedRef = useRef(true);
  const modelCounts = useModelCounts();

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

  // ── The page's one ACTION: spend a bounded number of 1-token probes on the
  // never-verified backlog. The run happens in the SERVER process (it owns the
  // registry and the provider credentials); this panel only watches it, because
  // 25 probes at up to 20s each cannot be held open in one request.
  const [job, setJob] = useState<VerifyBacklogState | null>(null);
  const [count, setCount] = useState(10);
  const [starting, setStarting] = useState(false);
  const [jobMessage, setJobMessage] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  /** Was a run in flight on the previous poll? Drives the one refresh on landing. */
  const wasRunningRef = useRef(false);

  const refreshJob = useCallback(async () => {
    const next = await dashboardAPI.fetchVerifyBacklog();
    if (!mountedRef.current) return;
    setJob(next);
    const running = next?.status === 'running';
    // A run that STOPPED has changed what is routable, so the counts above are
    // stale by exactly one fetch at that moment — and at no other time.
    if (wasRunningRef.current && !running) void fetchData();
    wasRunningRef.current = running;
  }, [fetchData]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchData();
    void refreshJob();
    const interval = setInterval(() => void fetchData(), 30_000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData, refreshJob]);

  // Poll fast, but ONLY while a run is in flight — an idle page makes no extra
  // requests. The interval is keyed on the RUNNING flag, not on `job`, so a
  // progress update does not tear the timer down and restart it.
  const jobRunning = job?.status === 'running';
  useEffect(() => {
    if (!jobRunning) return;
    const interval = setInterval(() => void refreshJob(), 1_000);
    return () => clearInterval(interval);
  }, [jobRunning, refreshJob]);

  const start = useCallback(async () => {
    setStarting(true);
    setJobMessage(null);
    const r = await dashboardAPI.startVerifyBacklog(count);
    if (!mountedRef.current) return;
    if (r.state) setJob(r.state);
    if (!r.ok) {
      // "Nothing left to verify" is good news and is worded as such by the
      // server; only a real refusal (already running, not logged in) is an error.
      const text = r.refusal ?? r.error ?? 'Could not start the run.';
      setJobMessage({ text, kind: r.refusal ? 'info' : 'error' });
    }
    setStarting(false);
  }, [count]);

  if (loading) {
    return (
      <div className="admin-header">
        <PageHeader icon="📅" title="Model Discovery Timeline" />
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
        <PageHeader icon="📅" title="Model Discovery Timeline" />
        <div className="admin-row-msg admin-row-msg-err">{error}</div>
      </div>
    );
  }

  // A dashboard server older than this bundle has no classifier in its payload.
  // Saying so beats rendering every row with a blank badge and looking broken.
  if (data && !data.counts) {
    return (
      <div className="admin-header">
        <PageHeader icon="📅" title="Model Discovery Timeline" />
        <div className="admin-row-msg admin-row-msg-err">
          This dashboard server predates the reachability view. Restart it
          (<code>nuvira dashboard stop</code>, then start it again) and reload this page.
        </div>
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const counts = data?.counts;
  const copy = data?.reachabilityCopy;
  const freshnessCopy = data?.freshnessCopy;

  const notRoutableTotal = counts
    ? NOT_ROUTABLE_ORDER.reduce((sum, state) => sum + (counts[state] ?? 0), 0)
    : 0;

  const filteredEntries = entries.filter((e) => {
    if (filter === 'routable') return e.reachability === 'routable';
    if (filter === 'not-routable') return e.reachability !== 'routable';
    return true;
  });

  const sortedEntries = [...filteredEntries].sort((a, b) => {
    if (sortBy === 'provider') return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    return b.lastProbedAt - a.lastProbedAt;
  });

  const byProvider = new Map<string, ModelTimelineEntry[]>();
  for (const e of sortedEntries) {
    const list = byProvider.get(e.provider);
    if (list) list.push(e);
    else byProvider.set(e.provider, [e]);
  }

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--accent-green)' : 'var(--bg-hover)',
    border: `1px solid ${active ? 'var(--accent-green)' : 'var(--border)'}`,
    padding: '4px 12px',
    fontSize: 12,
    cursor: 'pointer',
  });

  return (
    <div className="admin-header">
        <PageHeader icon="📅" title="Model Discovery Timeline" />
      <p className="section-description">
        The registry&apos;s age profile: when each tracked model was last probed, last <em>verified</em>, and last
        used — and which ones routing can actually reach. The Models page answers &ldquo;is it usable right now&rdquo;;
        this one answers &ldquo;what is ageing out&rdquo;.
      </p>

      {/* Summary cards. These ARE the filter counts — same classifier, same numbers. */}
      <div className="stats-grid" style={{ marginBottom: 8 }}>
        <div className="stat-card">
          <div className="stat-value">{data?.totalModels ?? 0}</div>
          <div className="stat-label">Tracked models (registry)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{modelCounts?.trackedProviders ?? 0}</div>
          <div className="stat-label">Tracked providers (registry)</div>
        </div>
        {modelCounts && (
          <>
            <div className="stat-card">
              <div className="stat-value">{modelCounts.listedModels}</div>
              <div className="stat-label">Listed models (live probe)</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{modelCounts.listedProviders}</div>
              <div className="stat-label">Listed providers (live probe)</div>
            </div>
          </>
        )}
        <div className="stat-card" style={{ borderColor: 'var(--accent-green)' }}>
          <div className="stat-value" style={{ color: 'var(--accent-green)' }}>{counts?.routable ?? 0}</div>
          <div className="stat-label">Routable now</div>
        </div>
        <div className="stat-card" style={{ borderColor: 'var(--border-hover)' }}>
          <div className="stat-value" style={{ color: 'var(--text-secondary)' }}>{notRoutableTotal}</div>
          <div className="stat-label">Not routable</div>
        </div>
      </div>

      {/* The breakdown of "not routable", because the four reasons need opposite
          actions: one is repaired by re-probing, one clears itself, one is
          permanent, and one is simply unknown. */}
      {counts ? (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14, fontSize: 11 }}>
          {NOT_ROUTABLE_ORDER.map((state) => {
            const entry = copy?.[state];
            return (
              <span key={state} title={entry?.blurb}>
                <span style={{ color: entry?.color ?? 'var(--text-secondary)' }}>■</span>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {entry?.label ?? state}: <strong style={{ color: 'var(--text-primary)' }}>{counts[state] ?? 0}</strong>
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* The page's one ACTION, sat directly under the "Never verified" number
          because it is the control that moves that number. Rendered only when
          the server reports the endpoint: an older server must read as "no such
          action" rather than as a button that silently does nothing. */}
      {job ? (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '12px 14px',
            marginBottom: 16,
          }}
          data-testid="verify-backlog-panel"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Work the backlog down</span>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, minWidth: 260 }}>
              Each check is a real 1-token generation against one of your provider keys — not a listing lookup.
              A never-verified model is an <em>unknown</em>, not a broken one: a check either proves it routable or
              marks it proven dead. Runs are bounded and one at a time.
            </span>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              How many
              <input
                type="number"
                min={1}
                max={job.maxCount ?? 25}
                value={count}
                disabled={starting || jobRunning}
                aria-label="how many models to verify"
                onChange={(e) => setCount(Number(e.target.value))}
                style={{
                  width: 64,
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontSize: 12,
                }}
              />
            </label>
            <button
              className="admin-refresh-btn"
              type="button"
              disabled={starting || jobRunning || !(count > 0)}
              onClick={() => void start()}
              style={{
                background: 'var(--accent-green)',
                border: '1px solid var(--accent-green)',
                padding: '4px 12px',
                fontSize: 12,
                cursor: starting || jobRunning ? 'default' : 'pointer',
              }}
              data-testid="verify-backlog-start"
            >
              {jobRunning ? '⏳ Verifying…' : starting ? 'Starting…' : `▶ Verify next ${count} now`}
            </button>
          </div>

          {jobRunning ? (
            <div className="env-var-notice" data-testid="verify-backlog-progress">
              Probing{' '}
              <code>
                {job.current ? `${job.current.provider}/${job.current.model}` : '…'}
              </code>{' '}
              — {job.processed}/{job.planned} done · {job.verified} verified · {job.unavailable} proven dead
            </div>
          ) : null}

          {!jobRunning && job.status === 'done' ? (
            <div className="env-var-notice" data-testid="verify-backlog-summary">
              ✅ {job.verified} verified · ⛔ {job.unavailable} proven unavailable · ⚠️ {job.errored} errored · ⏭{' '}
              {job.skipped} skipped
              {job.remaining !== null ? ` — ${job.remaining} still never verified` : ''}
            </div>
          ) : null}

          {/* Per-model outcomes: the summary says how many, this says WHICH —
              "verified" is only useful if you can see what joined the pool.
              `?? []` because a payload from a server that predates the results
              array must render as "no detail yet", not crash the page. */}
          {(job.results ?? []).length > 0 ? (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
              {(job.results ?? []).map((r) => (
                <span
                  key={`${r.provider}:${r.model}`}
                  style={{ fontSize: 11, color: 'var(--text-secondary)' }}
                  title={
                    r.outcome === 'verified'
                      ? 'Proven routable — a 1-token call succeeded'
                      : r.outcome === 'unavailable'
                        ? 'Proven dead — the provider refused it (403/404), re-probing will not help'
                        : r.outcome === 'skipped'
                          ? 'Skipped — verified recently enough'
                          : 'Errored — transient, still unknown, will be retried next run'
                  }
                >
                  {r.outcome === 'verified'
                    ? '✅'
                    : r.outcome === 'unavailable'
                      ? '⛔'
                      : r.outcome === 'skipped'
                        ? '⏭'
                        : '⚠️'}{' '}
                  <code>
                    {r.provider}/{r.model}
                  </code>
                </span>
              ))}
            </div>
          ) : null}

          {jobMessage ? (
            <div
              className={`env-var-notice${jobMessage.kind === 'error' ? ' env-var-notice-error' : ''}`}
              data-testid="verify-backlog-message"
            >
              {jobMessage.text}
            </div>
          ) : job.status === 'idle' && job.refusal ? (
            <div className="env-var-notice" data-testid="verify-backlog-message">
              {job.refusal}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'routable', 'not-routable'] as const).map((f) => (
            <button
              key={f}
              className={`admin-refresh-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
              style={buttonStyle(filter === f)}
            >
              {f === 'all' ? 'All' : f === 'routable' ? 'Routable' : 'Not routable'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['provider', 'lastProbed'] as const).map((s) => (
            <button
              key={s}
              className={`admin-refresh-btn ${sortBy === s ? 'active' : ''}`}
              onClick={() => setSortBy(s)}
              style={buttonStyle(sortBy === s)}
            >
              Sort: {s === 'lastProbed' ? 'Last seen' : 'Provider'}
            </button>
          ))}
        </div>
        <button
          className="admin-refresh-btn"
          onClick={() => void fetchData()}
          style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
        >
          🔄 Refresh
        </button>
      </div>

      {/* Two axes, stated once. */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 4, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        <span><span style={{ color: 'var(--accent-blue)' }}>■</span> Probe (last seen in the provider&apos;s catalog)</span>
        <span><span style={{ color: 'var(--accent-green)' }}>■</span> Verified (last success)</span>
        <span><span style={{ color: 'var(--accent-yellow)' }}>■</span> Used (last invocation)</span>
      </div>
      <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>Fresh</strong> means the provider still lists it.{' '}
        <strong style={{ color: 'var(--text-primary)' }}>Routable</strong> means a turn has been proven to work on it within{' '}
        {data?.freshDays ?? 7} days. A fresh model that was never verified is an unknown, not a failure — background
        spot-checks work through those a few at a time.
      </div>

      {/* Timeline entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from(byProvider.entries()).map(([provider, models]) => {
          const providerRoutable = models.filter((m) => m.reachability === 'routable').length;
          return (
            <div
              key={provider}
              style={{ background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}
            >
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 16 }}>
                  {provider === 'groq' ? '⚡' : provider === 'gemini' ? '🌀' : provider === 'local' ? '💻' : '🤖'}
                </span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{provider}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  ({models.length} shown · {providerRoutable} routable)
                </span>
              </div>
              <div style={{ padding: '8px 14px' }}>
                {models.map((entry) => {
                  const now = Date.now();
                  const reach = copy?.[entry.reachability];
                  const fresh = freshnessCopy?.[entry.freshness];
                  const color = reach?.color ?? 'var(--text-secondary)';
                  return (
                    <div
                      key={entry.model}
                      data-testid={`timeline-row-${entry.provider}-${entry.model}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '6px 0',
                        borderBottom: '1px solid var(--border-light)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            color: 'var(--text-primary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {entry.model}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          <span>Probed: {formatTimeAgo(now - entry.lastProbedAt)}</span>
                          <span>Verified: {entry.lastVerifiedAt > 0 ? formatTimeAgo(now - entry.lastVerifiedAt) : 'never'}</span>
                          {entry.lastUsedAt > 0 && <span>Used: {formatTimeAgo(now - entry.lastUsedAt)}</span>}
                          {entry.latencyMs !== undefined && <span>{entry.latencyMs}ms</span>}
                          {entry.errorRate > 0 && (
                            <span style={{ color: entry.errorRate > 0.5 ? 'var(--accent-red)' : 'var(--accent-yellow)' }}>
                              err {(entry.errorRate * 100).toFixed(0)}%
                            </span>
                          )}
                          {entry.daysSinceVerify !== null && entry.daysSinceVerify > 7 && (
                            <span style={{ color: 'var(--accent-yellow)' }}>proof {ageDays(entry.lastVerifiedAt)} old</span>
                          )}
                        </div>
                      </div>
                      <TimelineBar entry={entry} />
                      {fresh && (
                        <span style={badgeStyle(fresh.color)} title={fresh.blurb}>
                          {fresh.label}
                        </span>
                      )}
                      <span
                        style={badgeStyle(color)}
                        title={reach?.blurb ?? entry.reachability}
                        data-testid={`reachability-${entry.provider}-${entry.model}`}
                      >
                        {(reach?.label ?? entry.reachability).toUpperCase()}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {filteredEntries.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
          {filter === 'routable' && entries.length > 0
            ? 'No model is routable right now — every tracked model is unverified, parked, expired or dead. The Models page shows what each provider would offer live.'
            : 'No models match the current filter'}
        </div>
      )}
    </div>
  );
}
