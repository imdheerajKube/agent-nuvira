import type { ReactNode } from 'react';
import type { DashboardData, RoutingHistoryEntry, RoutingInsights, RoutingUsage } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, string> = {
  local: '💻', groq: '🟢', nim: '🔶', gemini: '🔷', openrouter: '🟣',
};

const PROVIDER_LABELS: Record<string, string> = {
  local: 'Ollama (Local)', groq: 'Groq', nim: 'NVIDIA NIM',
  gemini: 'Gemini', openrouter: 'OpenRouter',
};

const COMPLEXITY_ICONS: Record<string, string> = {
  trivial: '🟢', simple: '🔵', moderate: '🟡', complex: '🟠', critical: '🔴',
};

function providerIcon(provider: string): string {
  return PROVIDER_ICONS[provider] || '🔌';
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

// ─── Small Components ───────────────────────────────────────────────────────

function SectionCard({ icon, title, subtitle, children }: {
  icon: string; title: string; subtitle?: string; children: ReactNode;
}) {
  return (
    <div style={{
      background: '#161b22', borderRadius: 12,
      border: '1px solid #21262d', padding: '18px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3', margin: 0 }}>{title}</h3>
      </div>
      {subtitle && <p style={{ fontSize: 12, color: '#8b949e', margin: '2px 0 12px 0' }}>{subtitle}</p>}
      {!subtitle && <div style={{ height: 6 }} />}
      {children}
    </div>
  );
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  const pctWidth = Math.min(100, Math.max(0, value * 100));
  return (
    <div style={{
      flex: 1, background: '#0d1117', borderRadius: 4, height: 6,
      overflow: 'hidden', border: '1px solid #21262d',
    }}>
      <div style={{
        width: `${pctWidth}%`, background: color, height: '100%',
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function EmptyNote() {
  return (
    <div style={{
      background: '#0d1117', border: '1px dashed #30363d', borderRadius: 10,
      padding: '18px 20px', color: '#8b949e', fontSize: 13, textAlign: 'center',
    }}>
      📊 No routing data yet — run <code style={{ color: '#58a6ff' }}>buff benchmark</code> to populate
      provider quality scores, or use Auto routing (<code style={{ color: '#58a6ff' }}>buff model switch auto</code>)
      to build per-agent best-model stats over time.
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  chat: '💬 chat',
  orchestrator: '🔀 orchestrator',
  explain: '🔍 explain',
  benchmark: '📈 benchmark',
  eval: '🎯 eval',
};

const COMPLEXITY_LABELS: Record<string, string> = {
  trivial: '🟢 trivial',
  simple: '🔵 simple',
  moderate: '🟡 moderate',
  complex: '🟠 complex',
  critical: '🔴 critical',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Routing Usage Stats (actual picks over time) ───────────────────────────

function UsageCountRow({ label, value, total, color }: {
  label: string; value: number; total: number; color: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
      <span style={{ width: 110, color: '#e6edf3', whiteSpace: 'nowrap', fontSize: 12 }}>{label}</span>
      <div style={{ flex: 1, background: '#0d1117', borderRadius: 4, height: 6, overflow: 'hidden', border: '1px solid #21262d' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, background: color, height: '100%', transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ width: 34, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: '#8b949e' }}>
        {value}
      </span>
    </div>
  );
}

function UsageSection({ usage }: { usage: RoutingUsage }) {
  if (!usage.total) return null;

  const total = usage.total;
  const topProviders = Object.entries(usage.byProvider).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topModels = Object.entries(usage.byModel).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <SectionCard
      icon="🧮"
      title="Routing Usage — actual picks over time"
      subtitle="Recorded from live chat, orchestrator runs, explain snapshots, benchmark --routing, and eval --routing"
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{usage.total}</div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>total decisions</div>
        </div>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: usage.last24h > 0 ? '#3fb950' : '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{usage.last24h}</div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>last 24h</div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 6 }}>By provider</div>
      {topProviders.map(([provider, count]) => (
        <UsageCountRow key={provider} label={`${providerIcon(provider)} ${providerLabel(provider).split(' ')[0]}`} value={count} total={total} color="#58a6ff" />
      ))}

      {Object.keys(usage.bySource).length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(usage.bySource).sort((a, b) => b[1] - a[1]).map(([source, count]) => (
            <span key={source} style={{
              background: '#0d1117', border: '1px solid #21262d', borderRadius: 20,
              padding: '3px 10px', fontSize: 11, color: '#e6edf3',
            }}>
              {sourceLabel(source)} · {count}
            </span>
          ))}
        </div>
      )}

      {topModels.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 6 }}>Most-picked models</div>
          {topModels.map(([model, count]) => (
            <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ flex: 1, color: '#e6edf3', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={model}>
                {model.length > 42 ? model.slice(0, 39) + '…' : model}
              </span>
              <span style={{ width: 34, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: '#8b949e' }}>{count}</span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Audit Trail (explain snapshots timeline) ───────────────────────────────

function AuditTimelineSection({ history }: { history: RoutingHistoryEntry[] }) {
  if (!history.length) return null;

  return (
    <SectionCard
      icon="🕓"
      title="Audit Trail — routing decision timeline"
      subtitle="Every explain snapshot (and routing-mode pick) persisted for transparency"
    >
      <div style={{ maxHeight: 320, overflowY: 'auto', paddingRight: 4 }}>
        {history.map((h) => (
          <div key={h.id} style={{
            display: 'flex', gap: 10, padding: '8px 4px',
            borderBottom: '1px solid #21262d',
          }}>
            <div style={{ width: 52, flexShrink: 0, fontSize: 11, color: '#6e7681', paddingTop: 2 }}>
              {timeAgo(h.timestamp)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 11, padding: '1px 8px', borderRadius: 10,
                  background: '#0d1117', border: '1px solid #30363d', color: '#8b949e',
                }}>
                  {sourceLabel(h.source)}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#3fb950', fontFamily: "'SFMono-Regular', Consolas, monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${h.provider}/${h.model}`}>
                  {providerIcon(h.provider)} {h.provider}/{h.model.length > 26 ? h.model.slice(0, 23) + '…' : h.model}
                </span>
                {h.complexity && (
                  <span style={{ fontSize: 11, color: '#6e7681' }}>
                    {COMPLEXITY_LABELS[h.complexity] || h.complexity}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#8b949e', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.task}>
                {h.task || h.agentType}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Auto Router Preference ─────────────────────────────────────────────────

function PreferenceSection({ routing }: { routing: RoutingInsights }) {
  if (!routing.preference.length) return null;

  return (
    <SectionCard
      icon="🤖"
      title="Auto Router — What the agent would pick"
      subtitle="Complexity-weighted scoring across reasoning, speed, cost, privacy, and reliability (real provider pricing)"
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Complexity</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Winner</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Score</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>All providers</th>
            </tr>
          </thead>
          <tbody>
            {routing.preference.map((p) => (
              <tr key={p.complexity} style={{ borderBottom: '1px solid #21262d' }}>
                <td style={{ padding: '10px 12px', color: '#e6edf3', whiteSpace: 'nowrap' }}>
                  {COMPLEXITY_ICONS[p.complexity] || '•'} {p.complexity}
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#3fb950', fontWeight: 600 }}>
                    {providerIcon(p.winner.split('/')[0])} {p.winner}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', fontFamily: "'SFMono-Regular', Consolas, monospace", color: '#8b949e' }}>
                  {p.score.toFixed(3)}
                </td>
                <td style={{ padding: '10px 12px', minWidth: 260 }}>
                  {p.providers.map((prov, i) => (
                    <div key={prov.provider} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ width: 16, fontSize: 11, color: '#6e7681', textAlign: 'right' }}>{i + 1}.</span>
                      <span style={{ width: 90, color: '#e6edf3', whiteSpace: 'nowrap', fontSize: 12 }}>
                        {providerIcon(prov.provider)} {providerLabel(prov.provider).split(' ')[0]}
                      </span>
                      <ScoreBar value={prov.score} color={i === 0 ? '#3fb950' : '#58a6ff'} />
                      <span style={{ width: 40, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: '#8b949e' }}>
                        {prov.score.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Provider Benchmark Quality ─────────────────────────────────────────────

function ProviderQualitySection({ routing }: { routing: RoutingInsights }) {
  if (!routing.providers.length) return null;

  return (
    <SectionCard
      icon="📈"
      title="Provider Benchmark Quality"
      subtitle="Measured from your own `buff benchmark` runs — blended into Auto routing decisions"
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Provider</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Runs</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Avg Quality</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Pass Rate</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {routing.providers.map((p) => (
              <tr key={p.provider} style={{ borderBottom: '1px solid #21262d' }}>
                <td style={{ padding: '10px 12px', color: '#e6edf3', whiteSpace: 'nowrap' }}>
                  {providerIcon(p.provider)} {providerLabel(p.provider)}
                </td>
                <td style={{ padding: '10px 12px', color: '#8b949e' }}>{p.runs}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ScoreBar value={p.avgQuality} color="#58a6ff" />
                    <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: '#8b949e', width: 44, textAlign: 'right' }}>
                      {pct(p.avgQuality)}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '10px 12px', color: p.passRate >= 0.8 ? '#3fb950' : '#d29922' }}>
                  {pct(p.passRate)}
                </td>
                <td style={{ padding: '10px 12px', fontFamily: "'SFMono-Regular', Consolas, monospace", color: '#8b949e' }}>
                  {usd(p.totalCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Best Model per Agent ───────────────────────────────────────────────────

function BestModelsSection({ routing }: { routing: RoutingInsights }) {
  if (!routing.bestModels.length) return null;

  return (
    <SectionCard
      icon="🏆"
      title="Best Model per Agent (from your runs)"
      subtitle="Success-rate-ranked models from agent-stats — the Auto router boosts the proven winner"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {routing.bestModels.map((b) => (
          <div
            key={`${b.agentType}-${b.model}`}
            style={{
              background: '#0d1117', border: '1px solid #21262d', borderRadius: 10,
              padding: '12px 14px', minWidth: 200, flex: '1 1 200px',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#3fb950';
              e.currentTarget.style.boxShadow = '0 2px 10px #3fb95022';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#21262d';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 4 }}>
              {providerIcon(b.model.split('/')[0])} {b.agentType}
            </div>
            <div style={{
              fontSize: 13, fontWeight: 600, color: '#e6edf3',
              fontFamily: "'SFMono-Regular', Consolas, monospace",
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={b.model}>
              {b.model.length > 34 ? b.model.slice(0, 31) + '…' : b.model}
            </div>
            <div style={{ fontSize: 11, color: '#6e7681', marginTop: 6 }}>
              <span style={{ color: b.successRate >= 0.8 ? '#3fb950' : '#d29922' }}>
                {pct(b.successRate, 0)} success
              </span>
              {' · '}{b.runs} run{b.runs !== 1 ? 's' : ''}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function RoutingInsightsPanel({ data }: { data: DashboardData | null }) {
  const routing = data?.routing;
  const hasAny =
    routing &&
    (routing.preference.length > 0 || routing.providers.length > 0 || routing.bestModels.length > 0);
  const hasUsage = !!routing?.usage?.total;
  const hasHistory = !!routing?.history?.length;

  return (
    <>
      <h2 className="section-title">🤖 Auto Routing Insights</h2>
      <p className="section-description">
        Which providers and models the Auto router prefers — from real pricing, benchmark
        quality, and per-agent success stats. Run <code>buff benchmark</code> and use
        Auto routing to build this up over time.
      </p>

      {!hasAny && !hasUsage && !hasHistory ? (
        <EmptyNote />
      ) : (
        <>
          {hasUsage && <UsageSection usage={routing!.usage!} />}
          {hasHistory && <AuditTimelineSection history={routing!.history!} />}
          <PreferenceSection routing={routing!} />
          <ProviderQualitySection routing={routing!} />
          <BestModelsSection routing={routing!} />
        </>
      )}

      {routing && routing.providers.length === 0 && routing.bestModels.length === 0 && routing.preference.length > 0 && (
        <div style={{ fontSize: 12, color: '#6e7681', marginTop: 4 }}>
          Auto-router preference is always available (static profiles + real pricing); quality
          metrics appear once you run benchmarks and agent tasks.
        </div>
      )}
    </>
  );
}
