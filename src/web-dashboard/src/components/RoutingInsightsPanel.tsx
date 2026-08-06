import type { ReactNode } from 'react';
import RoutingWalkthroughSection from './RoutingWalkthrough';
import type { BanditInsights, DashboardData, PromotionInsights, QuotaInsights, RetrievalInsights, RoutingHistoryEntry, RoutingInsights, RoutingUsage } from '../types';

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

function fmtDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.ceil(ms / 1000)}s`;
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

// ─── Bandit Learning (Thompson-sampling priors) ────────────────────────────

const BANDIT_BUCKETS = ['trivial', 'simple', 'moderate', 'complex', 'critical'];

function banditWinColor(rate: number): string {
  if (rate >= 0.7) return '#3fb950';
  if (rate >= 0.45) return '#d29922';
  return '#f85149';
}

function BanditSection({ bandit }: { bandit: BanditInsights }) {
  const providers = Object.keys(bandit.priors).sort();
  if (!bandit.enabled || providers.length === 0) return null;

  const recentHistory = bandit.learningHistory.slice(-15).reverse();

  return (
    <SectionCard
      icon="🎰"
      title="Bandit Learning — Thompson-sampling priors"
      subtitle="Beta(α, β) per provider × complexity bucket, learned from real task outcomes (routing.bandit = true). Higher expected win rate = more successful history."
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500 }}>Provider</th>
              {BANDIT_BUCKETS.map((b) => (
                <th key={b} style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 500 }}>
                  {COMPLEXITY_ICONS[b] || '•'} {b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider} style={{ borderBottom: '1px solid #21262d' }}>
                <td style={{ padding: '8px 10px', color: '#e6edf3', whiteSpace: 'nowrap' }}>
                  {providerIcon(provider)} {providerLabel(provider).split(' ')[0]}
                </td>
                {BANDIT_BUCKETS.map((bucket) => {
                  const prior = bandit.priors[provider]?.[bucket];
                  if (!prior || (prior.alpha === 0 && prior.beta === 0)) {
                    return <td key={bucket} style={{ padding: '8px 10px', textAlign: 'center', color: '#6e7681' }}>·</td>;
                  }
                  return (
                    <td key={bucket} style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: banditWinColor(prior.expectedWinRate), fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                        {(prior.expectedWinRate * 100).toFixed(0)}%
                      </div>
                      <div style={{ fontSize: 10, color: '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                        α{prior.alpha} β{prior.beta}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {recentHistory.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 8 }}>Recent learning history</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', paddingRight: 4 }}>
            {recentHistory.map((h, i) => {
              const icon = h.outcome === 'success' ? '✅' : h.outcome === 'escalated' ? '🔄' : '❌';
              const ts = new Date(h.timestamp).toLocaleTimeString();
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 4px', borderBottom: '1px solid #21262d' }}>
                  <span>{icon}</span>
                  <span style={{ color: '#e6edf3', fontSize: 12, width: 110, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={h.provider}>
                    {h.provider}
                  </span>
                  <span style={{ fontSize: 11, color: '#6e7681', width: 80 }}>{h.complexity}</span>
                  <span style={{ fontSize: 11, color: '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                    reward {h.reward.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 'auto' }}>{ts}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: '#6e7681', marginTop: 12 }}>
        Cold-start Beta(1,1) behaves like the heuristic router until outcomes accumulate.
        Enable learning with <code style={{ color: '#58a6ff' }}>buff config set routing.bandit true</code>.
      </div>
    </SectionCard>
  );
}

// ─── Promotion Gate (bandit vs heuristic A/B verdict) ──────────────────────

function deltaPct(value: number, digits = 1): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function PassChip({ state }: { state: 'pass' | 'fail' | 'neutral' }) {
  const styles = {
    pass: { bg: '#12291a', border: '#238636', color: '#3fb950', label: '✓ pass' },
    fail: { bg: '#2d1616', border: '#f85149', color: '#f85149', label: '✗ fail' },
    neutral: { bg: '#1c2128', border: '#6e7681', color: '#8b949e', label: '○ neutral' },
  }[state];
  return (
    <span style={{
      fontSize: 11, padding: '1px 8px', borderRadius: 10,
      background: styles.bg,
      border: `1px solid ${styles.border}`,
      color: styles.color,
    }}>
      {styles.label}
    </span>
  );
}

function PromotionGateSection({ promotion }: { promotion: PromotionInsights }) {
  if (!promotion.decisionCount) return null;

  const verdict = promotion.promoted
    ? { icon: '🎖️', label: 'Promoted — the bandit beats the heuristic', color: '#3fb950' }
    : promotion.sufficient
      ? { icon: '⚠️', label: 'Not promoted — the bandit is not (yet) better', color: '#d29922' }
      : { icon: '⏳', label: 'Collecting data — need more diverged decisions', color: '#58a6ff' };

  const progress = promotion.minDecisions > 0
    ? Math.min(100, Math.round((promotion.divergedCount / promotion.minDecisions) * 100))
    : 0;

  const rows = [
    {
      key: 'quality', label: 'Quality ↑',
      delta: promotion.qualityDelta,
      state: promotion.criteria.quality ? 'pass' as const : 'fail' as const,
      note: 'needs > +2%',
    },
    {
      key: 'cost', label: 'Cost ↓',
      delta: promotion.costDelta,
      state: promotion.criteria.cost ? 'pass' as const : 'fail' as const,
      note: 'regression < +1%',
    },
    {
      key: 'latency', label: 'Latency ↓',
      delta: promotion.latencyDelta,
      // Unmeasured latency is treated as neutral by the gate (never a win,
      // never a fail) — reflect that honestly instead of a green 'pass'.
      state: promotion.latencyMeasured
        ? (promotion.criteria.latency ? 'pass' as const : 'fail' as const)
        : 'neutral' as const,
      note: promotion.latencyMeasured ? 'regression < +5%' : 'no latency measurements yet',
    },
  ];

  return (
    <SectionCard
      icon="🎖️"
      title="Promotion Gate — is the bandit better than the heuristic?"
      subtitle="A/B verdict from real trajectories (router-promotion.jsonl): quality must improve >2% while cost and latency don't regress (ruflo ADR-150)"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span style={{ fontSize: 22 }}>{verdict.icon}</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: verdict.color }}>{verdict.label}</span>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8b949e', marginBottom: 5 }}>
          <span>{promotion.divergedCount} diverged decisions</span>
          <span>need {promotion.minDecisions} for a verdict</span>
        </div>
        <div style={{ background: '#0d1117', borderRadius: 4, height: 8, overflow: 'hidden', border: '1px solid #21262d' }}>
          <div style={{ width: `${progress}%`, background: promotion.sufficient ? '#3fb950' : '#58a6ff', height: '100%', transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ fontSize: 11, color: '#6e7681', marginTop: 4 }}>
          {promotion.decisionCount} total decisions logged
        </div>
      </div>

      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #21262d' }}>
          <span style={{ width: 70, fontSize: 12, color: '#e6edf3' }}>{row.label}</span>
          <span style={{ width: 92, fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: '#8b949e' }}>
            {deltaPct(row.delta)}
          </span>
          <span style={{ fontSize: 11, color: '#6e7681', flex: 1 }}>{row.note}</span>
          <PassChip state={row.state} />
        </div>
      ))}

      <div style={{ fontSize: 11, color: '#6e7681', marginTop: 12 }}>
        Run auto-routed tasks with <code style={{ color: '#58a6ff' }}>routing.bandit true</code> to accumulate A/B
        decisions. The gate does not disable the bandit — it tells you whether it's actually winning.
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

// ─── Quota Ledger (central quota tracking per provider × model) ─────────────

// ─── Vector Retrieval (token savings transparency) ─────────────────────────

function RetrievalSection({ retrieval }: { retrieval: RetrievalInsights }) {
  // Render when there's any retrieval activity OR a non-empty repo index — the
  // index may exist even before the first call (user ran `buff retrieval index`).
  if (!retrieval.enabled && retrieval.repoChunks === 0) return null;

  const saved = retrieval.totalSavedTokens ?? 0;
  const avgReduction = retrieval.avgPctReduced ?? 0;
  const lastCall = retrieval.lastCall;
  const totalCalls = retrieval.totalCalls ?? 0;
  const totalRetrievals = retrieval.totalRetrievals ?? 0;
  const failovers = retrieval.totalFailovers ?? 0;

  return (
    <SectionCard
      icon="🧠"
      title="Vector Retrieval — token savings"
      subtitle="Large contexts are chunked, embedded locally (bge-small-en-v1.5), and reduced to the top-k relevant chunks before the LLM — saving tokens so free quotas stretch further. Complements the quota ledger: retrieval saves, the ledger manages."
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ background: '#0d1117', border: '1px solid #238636', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#3fb950', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {saved.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>tokens saved</div>
        </div>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {avgReduction.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>avg context reduction</div>
        </div>
        <div style={{ background: '#0d1117', border: '1px solid #d29922', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#d29922', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {retrieval.repoChunks.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>repo chunks indexed</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: '#8b949e', marginBottom: 14 }}>
        <span>📞 {totalCalls} context calls · 🧠 {totalRetrievals} retrievals used · ⚠️ {failovers} failovers (full-context fallback)</span>
        {retrieval.dimensions > 0 && <span>· {retrieval.dimensions}-dim embeddings</span>}
      </div>

      {lastCall && lastCall.used !== false && lastCall.hits?.length > 0 && (
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 8 }}>
            Latest retrieval — {lastCall.originalTokens.toLocaleString()} → {lastCall.reducedTokens.toLocaleString()} tokens
            <span style={{ color: '#3fb950', fontFamily: "'SFMono-Regular', Consolas, monospace" }}> (−{lastCall.pctReduced?.toFixed(0)}%)</span>
          </div>
          <div style={{ fontSize: 11, color: '#8b949e' }}>
            {lastCall.hits.slice(0, 5).map((h) => (
              <div key={h.filePath} style={{ marginTop: 3 }}>
                <span style={{ color: '#58a6ff' }}>▸</span> {h.filePath}{' '}
                <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace" }}>(sim {h.similarity.toFixed(3)})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: '#6e7681' }}>
        Pre-index your repo with <code style={{ color: '#58a6ff' }}>buff retrieval index &lt;dir&gt;</code>, query it with{' '}
        <code style={{ color: '#58a6ff' }}>buff retrieval query "&lt;question&gt;"</code>, and see the same stats with{' '}
        <code style={{ color: '#58a6ff' }}>buff retrieval stats</code>.
      </div>
    </SectionCard>
  );
}

function QuotaSection({ quota }: { quota: QuotaInsights }) {
  // Render the card when there are usage entries OR failover-timeline events —
  // failovers can precede any successful call (auth/rate-limit on first use),
  // so the timeline must be visible even on an empty ledger.
  if ((!quota.enabled || quota.entries.length === 0) && (quota.events?.length ?? 0) === 0) return null;

  const totalTokens = quota.entries.reduce((s, e) => s + e.tokensConsumed, 0);
  const totalRequests = quota.entries.reduce((s, e) => s + e.requests, 0);
  const parkedCount = quota.entries.filter((e) => e.parked).length;
  // Free/local-first transparency (assessment #7): free-tier tokens = money
  // saved (would have cost on a paid provider); paid tokens = actual spend.
  const freeTokens = quota.freeTokens ?? totalTokens - (quota.paidTokens ?? 0);
  const paidTokens = quota.paidTokens ?? 0;
  const estimatedSavedUsd = quota.estimatedSavedUsd ?? 0;
  const freePct = totalTokens > 0 ? (freeTokens / totalTokens) * 100 : 0;

  return (
    <SectionCard
      icon="📒"
      title="Quota Ledger — free-tier usage & auto re-enable"
      subtitle="Tokens/requests per provider × model with reset windows. Exhausted providers are parked (excluded from Auto routing) and re-enable when the window rolls."
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {totalTokens.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>tokens tracked</div>
        </div>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{totalRequests}</div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>requests</div>
        </div>
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: parkedCount > 0 ? '#d29922' : '#3fb950', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{parkedCount}</div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>parked</div>
        </div>
      </div>

      {/* Cost transparency: free/local tokens saved vs paid spend triggered */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{
          flex: '1 1 200px', background: '#0d1117', borderRadius: 10, padding: '12px 16px',
          border: '1px solid #238636',
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#3fb950', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {freeTokens.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
            tokens on free/local · {freePct.toFixed(0)}% of usage
          </div>
          <div style={{ fontSize: 12, color: '#3fb950', marginTop: 4, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            💰 est. ${estimatedSavedUsd.toFixed(4)} saved
          </div>
        </div>
        <div style={{
          flex: '1 1 200px', background: '#0d1117', borderRadius: 10, padding: '12px 16px',
          border: '1px solid #d29922',
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: paidTokens > 0 ? '#d29922' : '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {paidTokens.toLocaleString()}
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginTop: 2 }}>
            tokens on paid providers (spend triggered)
          </div>
          <div style={{ fontSize: 12, color: paidTokens > 0 ? '#d29922' : '#8b949e', marginTop: 4 }}>
            {quota.paidRequests ?? 0} paid request{quota.paidRequests === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500 }}>Provider / Model</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Tokens</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Requests</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Resets in</th>
              <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 500 }}>State</th>
            </tr>
          </thead>
          <tbody>
            {quota.entries.map((e) => (
              <tr key={`${e.provider}|${e.model}`} style={{ borderBottom: '1px solid #21262d' }}>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: '#e6edf3' }}>{providerIcon(e.provider)} {providerLabel(e.provider).split(' ')[0]}</span>
                  <span style={{ color: '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                    {' / '}{e.model.length > 24 ? e.model.slice(0, 21) + '…' : e.model}
                  </span>
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", color: '#8b949e' }}>
                  {e.tokensConsumed.toLocaleString()}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", color: '#8b949e' }}>
                  {e.requests}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: '#8b949e', whiteSpace: 'nowrap' }}>
                  {fmtDuration(e.resetsInMs)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  {e.parked ? (
                    <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#2d1616', border: '1px solid #f85149', color: '#f85149' }}>
                      ⏸ parked
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#12291a', border: '1px solid #238636', color: '#3fb950' }}>
                      ✓ available
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: '#6e7681', marginTop: 12 }}>
        Configure limits with <code style={{ color: '#58a6ff' }}>buff config set routing.quota.gemini.requestsPerWindow 1500</code>;
        the ledger always tracks usage but only parks when limits are set.
      </div>

      {/* M2.3/M2.4: parked multi-account keys — makes key rotation visible. */}
      {quota.parkedAccounts && quota.parkedAccounts.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 10 }}>
            🔑 Parked Accounts — multi-account key rotation
          </div>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 8 }}>
            Accounts skipped predictively by the failover walk (rate-limit / auth). Fingerprints only — raw keys are never stored.
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '8px 0' }}>
            {quota.parkedAccounts.map((acct, i) => {
              const reason = acct.reason === 'auth' ? 'auth' : acct.reason === 'rate-limit' ? 'rate-limit' : acct.reason || 'cooldown';
              const color = acct.reason === 'rate-limit' ? '#d29922' : '#f85149';
              return (
                <div key={`${acct.provider}-${acct.accountId}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderBottom: i < quota.parkedAccounts!.length - 1 ? '1px solid #161b22' : 'none' }}>
                  <span style={{ fontSize: 13 }}>🔒</span>
                  <span style={{ width: 90, flexShrink: 0, fontSize: 12, color: '#e6edf3' }}>
                    {providerIcon(acct.provider)} {providerLabel(acct.provider).split(' ')[0]}
                  </span>
                  <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: '#8b949e' }} title={acct.accountId}>
                    #{acct.accountId.slice(0, 8)}
                  </span>
                  <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#161b22', border: `1px solid ${color}`, color, textAlign: 'center' }}>
                    {reason}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: '#6e7681', whiteSpace: 'nowrap' }}>
                    re-admits in {fmtDuration(acct.remainingMs)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Failover timeline (assessment #7: show users when failover occurred and why) */}
      {quota.events && quota.events.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 10 }}>
            🛟 Failover Timeline — quota management & mid-session swaps
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '8px 0' }}>
            {quota.events.map((ev, i) => {
              const icon = ev.type === 'parked' ? '⏸' : ev.type === 're-enabled' ? '🔁' : ev.type === 'released' ? '✅' : '⚡';
              const color = ev.type === 'parked' ? '#f85149' : ev.type === 're-enabled' ? '#3fb950' : ev.type === 'released' ? '#3fb950' : '#d29922';
              const label = ev.type === 'parked' ? 'parked' : ev.type === 're-enabled' ? 're-enabled' : ev.type === 'released' ? 'released' : 'failover';
              return (
                <div key={`${ev.timestamp}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderBottom: i < quota.events!.length - 1 ? '1px solid #161b22' : 'none' }}>
                  <span style={{ fontSize: 13 }}>{icon}</span>
                  <span style={{ width: 80, flexShrink: 0, fontSize: 11, padding: '1px 8px', borderRadius: 10, background: '#161b22', border: `1px solid ${color}`, color, textAlign: 'center' }}>
                    {label}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, color: '#e6edf3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {providerIcon(ev.provider)} {providerLabel(ev.provider)}
                  </span>
                  {ev.reason && <span style={{ fontSize: 11, color: '#8b949e' }}>{ev.reason}</span>}
                  <span style={{ fontSize: 11, color: '#6e7681', whiteSpace: 'nowrap' }}>{timeAgo(ev.timestamp)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
  // The walkthrough needs replayable decisions: real history or complexity profiles.
  const hasWalkthrough = !!routing && (routing.history?.length ?? 0) > 0 || !!routing?.preference?.length;
  const hasBandit = !!routing?.bandit?.enabled;
  const hasPromotion = !!routing?.promotion?.decisionCount;
  const hasQuota = !!routing?.quota?.enabled;
  const hasRetrieval = !!routing?.retrieval?.enabled || !!routing?.retrieval?.repoChunks;

  return (
    <>
      <h2 className="section-title">🤖 Auto Routing Insights</h2>
      <p className="section-description">
        Which providers and models the Auto router prefers — from real pricing, benchmark
        quality, per-agent success stats, and the Thompson-sampling bandit. Run{' '}
        <code>buff benchmark</code> and use Auto routing to build this up over time.
      </p>

      {!hasAny && !hasUsage && !hasHistory && !hasBandit && !hasPromotion && !hasQuota && !hasRetrieval ? (
        <EmptyNote />
      ) : (
        <>
          {hasWalkthrough && routing && <RoutingWalkthroughSection routing={routing} />}
          {hasUsage && <UsageSection usage={routing!.usage!} />}
          {hasHistory && <AuditTimelineSection history={routing!.history!} />}
          {hasBandit && <BanditSection bandit={routing!.bandit!} />}
          {hasPromotion && <PromotionGateSection promotion={routing!.promotion!} />}
          {hasQuota && <QuotaSection quota={routing!.quota!} />}
          {hasRetrieval && <RetrievalSection retrieval={routing!.retrieval!} />}
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
