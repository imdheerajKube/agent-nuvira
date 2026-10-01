import type { ReactNode } from 'react';
import RoutingWalkthroughSection from './RoutingWalkthrough';
import type { BanditInsights, DashboardData, GovernanceInsights, MlInsights, PromotionInsights, QuotaInsights, RbacInsights, RetrievalInsights, RoutingHistoryEntry, RoutingInsights, RoutingUsage } from '../types';
import { formatCount } from '../format';
import PageHeader from './PageHeader';

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
      background: 'var(--bg-card)', borderRadius: 12,
      border: '1px solid var(--border-light)', padding: '18px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{title}</h3>
      </div>
      {subtitle && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 12px 0' }}>{subtitle}</p>}
      {!subtitle && <div style={{ height: 6 }} />}
      {children}
    </div>
  );
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  const pctWidth = Math.min(100, Math.max(0, value * 100));
  return (
    <div style={{
      flex: 1, background: 'var(--bg-primary)', borderRadius: 4, height: 6,
      overflow: 'hidden', border: '1px solid var(--border-light)',
    }}>
      <div style={{
        width: `${pctWidth}%`, background: color, height: '100%',
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function chipStyle(background: string, border: string, textColor = 'var(--text-secondary)') {
  return {
    fontSize: 10,
    padding: '1px 7px',
    borderRadius: 9,
    background,
    border: `1px solid ${border}`,
    color: textColor,
    fontFamily: "'SFMono-Regular', Consolas, monospace" as const,
    whiteSpace: 'nowrap' as const,
  };
}

function EmptyNote() {
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px dashed var(--border)', borderRadius: 10,
      padding: '18px 20px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center',
    }}>
      📊 No routing data yet — run <code style={{ color: 'var(--accent-blue)' }}>buff benchmark</code> to populate
      provider quality scores, or use Auto routing (<code style={{ color: 'var(--accent-blue)' }}>buff model switch auto</code>)
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
      <span style={{ width: 110, color: 'var(--text-primary)', whiteSpace: 'nowrap', fontSize: 12 }}>{label}</span>
      <div style={{ flex: 1, background: 'var(--bg-primary)', borderRadius: 4, height: 6, overflow: 'hidden', border: '1px solid var(--border-light)' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, background: color, height: '100%', transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ width: 34, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: 'var(--text-secondary)' }}>
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
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{usage.total}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>total decisions</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: usage.last24h > 0 ? 'var(--accent-green)' : 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{usage.last24h}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>last 24h</div>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>By provider</div>
      {topProviders.map(([provider, count]) => (
        <UsageCountRow key={provider} label={`${providerIcon(provider)} ${providerLabel(provider).split(' ')[0]}`} value={count} total={total} color="var(--accent-blue)" />
      ))}

      {Object.keys(usage.bySource).length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(usage.bySource).sort((a, b) => b[1] - a[1]).map(([source, count]) => (
            <span key={source} style={{
              background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 20,
              padding: '3px 10px', fontSize: 11, color: 'var(--text-primary)',
            }}>
              {sourceLabel(source)} · {count}
            </span>
          ))}
        </div>
      )}

      {topModels.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Most-picked models</div>
          {topModels.map(([model, count]) => (
            <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={model}>
                {model.length > 42 ? model.slice(0, 39) + '…' : model}
              </span>
              <span style={{ width: 34, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: 'var(--text-secondary)' }}>{count}</span>
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
            borderBottom: '1px solid var(--border-light)',
          }}>
            <div style={{ width: 52, flexShrink: 0, fontSize: 11, color: 'var(--text-muted)', paddingTop: 2 }}>
              {timeAgo(h.timestamp)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 11, padding: '1px 8px', borderRadius: 10,
                  background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)',
                }}>
                  {sourceLabel(h.source)}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${h.provider}/${h.model}`}>
                  {providerIcon(h.provider)} {h.provider}/{h.model.length > 26 ? h.model.slice(0, 23) + '…' : h.model}
                </span>
                {h.complexity && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {COMPLEXITY_LABELS[h.complexity] || h.complexity}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={h.task}>
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
            <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Complexity</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Winner</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Score</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>All providers</th>
            </tr>
          </thead>
          <tbody>
            {routing.preference.map((p) => (
              <tr key={p.complexity} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: '10px 12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {COMPLEXITY_ICONS[p.complexity] || '•'} {p.complexity}
                </td>
                <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--accent-green)', fontWeight: 600 }}>
                    {providerIcon(p.winner.split('/')[0])} {p.winner}
                  </span>
                </td>
                <td style={{ padding: '10px 12px', fontFamily: "'SFMono-Regular', Consolas, monospace", color: 'var(--text-secondary)' }}>
                  {p.score.toFixed(3)}
                </td>
                <td style={{ padding: '10px 12px', minWidth: 300 }}>
                  {p.providers.map((prov, i) => (
                    <div key={prov.provider} style={{ marginBottom: 5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>{i + 1}.</span>
                        <span style={{ width: 90, color: 'var(--text-primary)', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {providerIcon(prov.provider)} {providerLabel(prov.provider).split(' ')[0]}
                        </span>
                        <ScoreBar value={prov.score} color={i === 0 ? 'var(--accent-green)' : 'var(--accent-blue)'} />
                        <span style={{ width: 40, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: 'var(--text-secondary)' }}>
                          {prov.score.toFixed(2)}
                        </span>
                      </div>
                      {/* v1.58.0 M2.x chips — same guarantees as the CLI `model explain` output.
                          Rendered only when at least one chip applies, so rows under gates-off
                          configs don't leave an empty strip. */}
                      {(prov.capabilityFit !== undefined || prov.costSource || prov.contextUtilization !== undefined) && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingLeft: 16, marginTop: 2 }}>
                          {prov.capabilityFit !== undefined && (
                            <span style={chipStyle('var(--bg-tertiary)', 'var(--border-hover)')}>🎯 fit {prov.capabilityFit}%</span>
                          )}
                          {prov.costSource === 'measured' && prov.costBasis ? (
                            <span style={chipStyle('var(--ok-soft)', 'var(--accent-green)', 'var(--accent-green)')}>
                              📏 measured {formatCount(prov.costBasis.inputTokens)}→{formatCount(prov.costBasis.outputTokens)} tok
                            </span>
                          ) : (
                            <span style={chipStyle('var(--bg-tertiary)', 'var(--border-hover)')}>📐 estimated</span>
                          )}
                          {prov.contextUtilization !== undefined && prov.contextWindowTokens !== undefined && (
                            <span style={chipStyle('var(--bg-tertiary)', 'var(--accent-blue)', 'var(--accent-blue)')}>
                              ⏳ ctx {prov.contextUtilization}% ({formatCount(prov.contextWindowTokens)} tok)
                            </span>
                          )}
                        </div>
                      )}
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
            <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Provider</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Runs</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Avg Quality</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Pass Rate</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {routing.providers.map((p) => (
              <tr key={p.provider} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: '10px 12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {providerIcon(p.provider)} {providerLabel(p.provider)}
                </td>
                <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>{p.runs}</td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ScoreBar value={p.avgQuality} color="var(--accent-blue)" />
                    <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: 'var(--text-secondary)', width: 44, textAlign: 'right' }}>
                      {pct(p.avgQuality)}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '10px 12px', color: p.passRate >= 0.8 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                  {pct(p.passRate)}
                </td>
                <td style={{ padding: '10px 12px', fontFamily: "'SFMono-Regular', Consolas, monospace", color: 'var(--text-secondary)' }}>
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
  if (rate >= 0.7) return 'var(--accent-green)';
  if (rate >= 0.45) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
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
            <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
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
              <tr key={provider} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: '8px 10px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                  {providerIcon(provider)} {providerLabel(provider).split(' ')[0]}
                </td>
                {BANDIT_BUCKETS.map((bucket) => {
                  const prior = bandit.priors[provider]?.[bucket];
                  if (!prior || (prior.alpha === 0 && prior.beta === 0)) {
                    return <td key={bucket} style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--text-muted)' }}>·</td>;
                  }
                  return (
                    <td key={bucket} style={{ padding: '8px 10px', textAlign: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: banditWinColor(prior.expectedWinRate), fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                        {(prior.expectedWinRate * 100).toFixed(0)}%
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
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
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Recent learning history</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', paddingRight: 4 }}>
            {recentHistory.map((h, i) => {
              const icon = h.outcome === 'success' ? '✅' : h.outcome === 'escalated' ? '🔄' : '❌';
              const ts = new Date(h.timestamp).toLocaleTimeString();
              return (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 4px', borderBottom: '1px solid var(--border-light)' }}>
                  <span>{icon}</span>
                  <span style={{ color: 'var(--text-primary)', fontSize: 12, width: 110, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={h.provider}>
                    {h.provider}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 80 }}>{h.complexity}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                    reward {h.reward.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{ts}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Cold-start Beta(1,1) behaves like the heuristic router until outcomes accumulate.
        Enable learning with <code style={{ color: 'var(--accent-blue)' }}>buff config set routing.bandit true</code>.
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
    pass: { bg: 'var(--ok-soft)', border: 'var(--accent-green)', color: 'var(--accent-green)', label: '✓ pass' },
    fail: { bg: 'var(--danger-soft)', border: 'var(--accent-red)', color: 'var(--accent-red)', label: '✗ fail' },
    neutral: { bg: 'var(--bg-tertiary)', border: 'var(--border-hover)', color: 'var(--text-secondary)', label: '○ neutral' },
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
    ? { icon: '🎖️', label: 'Promoted — the bandit beats the heuristic', color: 'var(--accent-green)' }
    : promotion.sufficient
      ? { icon: '⚠️', label: 'Not promoted — the bandit is not (yet) better', color: 'var(--accent-yellow)' }
      : { icon: '⏳', label: 'Collecting data — need more diverged decisions', color: 'var(--accent-blue)' };

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
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 5 }}>
          <span>{promotion.divergedCount} diverged decisions</span>
          <span>need {promotion.minDecisions} for a verdict</span>
        </div>
        <div style={{ background: 'var(--bg-primary)', borderRadius: 4, height: 8, overflow: 'hidden', border: '1px solid var(--border-light)' }}>
          <div style={{ width: `${progress}%`, background: promotion.sufficient ? 'var(--accent-green)' : 'var(--accent-blue)', height: '100%', transition: 'width 0.4s ease' }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          {promotion.decisionCount} total decisions logged
        </div>
      </div>

      {rows.map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border-light)' }}>
          <span style={{ width: 70, fontSize: 12, color: 'var(--text-primary)' }}>{row.label}</span>
          <span style={{ width: 92, fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: 'var(--text-secondary)' }}>
            {deltaPct(row.delta)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>{row.note}</span>
          <PassChip state={row.state} />
        </div>
      ))}

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Run auto-routed tasks with <code style={{ color: 'var(--accent-blue)' }}>routing.bandit true</code> to accumulate A/B
        decisions. The gate does not disable the bandit — it tells you whether it's actually winning.
      </div>
    </SectionCard>
  );
}

// ─── ML Task-Similarity Router (v1.71.0, ruflo neural-router analog) ────────

function MlSection({ ml }: { ml: MlInsights }) {
  if (!ml.enabled || ml.recordCount === 0) return null;

  const trusted = ml.providers.filter((p) => p.trusted);
  const learning = ml.providers.filter((p) => !p.trusted);

  return (
    <SectionCard
      icon="🧠"
      title="ML Router — learned from similar tasks"
      subtitle="Task-feature kNN (ruflo neural-router analog): outcomes of the most similar PAST tasks nudge each provider's score. Win rate is similarity-weighted; factor = 1 + 0.5 × (winRate − 0.5), trusted only after 5 similar-task samples."
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(ml.recordCount)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>learned tasks</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent-green)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {trusted.length}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>trusted providers</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent-yellow)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-yellow)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {learning.length}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>still learning</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ml.providers.map((p) => (
          <div key={p.provider} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span>{providerIcon(p.provider)}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{providerLabel(p.provider)}</span>
              {p.trusted ? (
                <span style={chipStyle('color-mix(in srgb, var(--accent-green) 15%, transparent)', 'var(--accent-green)', 'var(--accent-green)')}>trusted · {p.samples} samples</span>
              ) : (
                <span style={chipStyle('color-mix(in srgb, var(--accent-yellow) 15%, transparent)', 'var(--accent-yellow)', 'var(--accent-yellow)')}>{p.samples}/5 samples</span>
              )}
              {p.model && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SFMono-Regular', Consolas, monospace", marginLeft: 'auto' }}>
                  {p.model.length > 30 ? p.model.slice(0, 27) + '…' : p.model}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 70, fontSize: 11, color: 'var(--text-secondary)' }}>
                win {pct(p.winRate, 0)}
              </div>
              <ScoreBar
                value={p.winRate}
                color={p.winRate >= 0.5 ? 'var(--accent-green)' : 'var(--accent-red)'}
              />
              <div style={{ width: 74, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>
                factor <span style={{ color: p.trusted && p.factor !== 1 ? 'var(--accent-blue)' : 'var(--text-muted)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                  {p.factor.toFixed(2)}×
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Enabled with <code style={{ color: 'var(--accent-blue)' }}>buff config set routing.mlRouter true</code> — the factor only
        adjusts scores when the provider has ≥ 5 similar-task wins (cold start is neutral).
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
              background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10,
              padding: '12px 14px', minWidth: 200, flex: '1 1 200px',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-green)';
              e.currentTarget.style.boxShadow = '0 2px 10px color-mix(in srgb, var(--accent-green) 13%, transparent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-light)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {providerIcon(b.model.split('/')[0])} {b.agentType}
            </div>
            <div style={{
              fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
              fontFamily: "'SFMono-Regular', Consolas, monospace",
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={b.model}>
              {b.model.length > 34 ? b.model.slice(0, 31) + '…' : b.model}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              <span style={{ color: b.successRate >= 0.8 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
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
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent-green)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(saved)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>tokens saved</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {avgReduction.toFixed(1)}%
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>avg context reduction</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent-yellow)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-yellow)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(retrieval.repoChunks)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>repo chunks indexed</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14 }}>
        <span>📞 {totalCalls} context calls · 🧠 {totalRetrievals} retrievals used · ⚠️ {failovers} failovers (full-context fallback)</span>
        {retrieval.dimensions > 0 && <span>· {retrieval.dimensions}-dim embeddings</span>}
      </div>

      {lastCall && lastCall.used !== false && lastCall.hits?.length > 0 && (
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            Latest retrieval — {formatCount(lastCall.originalTokens)} → {formatCount(lastCall.reducedTokens)} tokens
            <span style={{ color: 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}> (−{lastCall.pctReduced?.toFixed(0)}%)</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {lastCall.hits.slice(0, 5).map((h) => (
              <div key={h.filePath} style={{ marginTop: 3 }}>
                <span style={{ color: 'var(--accent-blue)' }}>▸</span> {h.filePath}{' '}
                <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace" }}>(sim {h.similarity.toFixed(3)})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Pre-index your repo with <code style={{ color: 'var(--accent-blue)' }}>buff retrieval index &lt;dir&gt;</code>, query it with{' '}
        <code style={{ color: 'var(--accent-blue)' }}>buff retrieval query "&lt;question&gt;"</code>, and see the same stats with{' '}
        <code style={{ color: 'var(--accent-blue)' }}>buff retrieval stats</code>.
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
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(totalTokens)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>tokens tracked</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{totalRequests}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>requests</div>
        </div>
        <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '12px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: parkedCount > 0 ? 'var(--accent-yellow)' : 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{parkedCount}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>parked</div>
        </div>
      </div>

      {/* Cost transparency: free/local tokens saved vs paid spend triggered */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{
          flex: '1 1 200px', background: 'var(--bg-primary)', borderRadius: 10, padding: '12px 16px',
          border: '1px solid var(--accent-green)',
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent-green)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(freeTokens)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            tokens on free/local · {freePct.toFixed(0)}% of usage
          </div>
          <div style={{ fontSize: 12, color: 'var(--accent-green)', marginTop: 4, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            💰 est. ${estimatedSavedUsd.toFixed(4)} saved
          </div>
        </div>
        <div style={{
          flex: '1 1 200px', background: 'var(--bg-primary)', borderRadius: 10, padding: '12px 16px',
          border: '1px solid var(--accent-yellow)',
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: paidTokens > 0 ? 'var(--accent-yellow)' : 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
            {formatCount(paidTokens)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
            tokens on paid providers (spend triggered)
          </div>
          <div style={{ fontSize: 12, color: paidTokens > 0 ? 'var(--accent-yellow)' : 'var(--text-secondary)', marginTop: 4 }}>
            {quota.paidRequests ?? 0} paid request{quota.paidRequests === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500 }}>Provider / Model</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Tokens</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Requests</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 500 }}>Resets in</th>
              <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 500 }}>State</th>
            </tr>
          </thead>
          <tbody>
            {quota.entries.map((e) => (
              <tr key={`${e.provider}|${e.model}`} style={{ borderBottom: '1px solid var(--border-light)' }}>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--text-primary)' }}>{providerIcon(e.provider)} {providerLabel(e.provider).split(' ')[0]}</span>
                  <span style={{ color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                    {' / '}{e.model.length > 24 ? e.model.slice(0, 21) + '…' : e.model}
                  </span>
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", color: 'var(--text-secondary)' }}>
                  {formatCount(e.tokensConsumed)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", color: 'var(--text-secondary)' }}>
                  {e.requests}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'right', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  {fmtDuration(e.resetsInMs)}
                </td>
                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                  {e.parked ? (
                    <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--danger-soft)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)' }}>
                      ⏸ parked
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--ok-soft)', border: '1px solid var(--accent-green)', color: 'var(--accent-green)' }}>
                      ✓ available
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
        Configure limits with <code style={{ color: 'var(--accent-blue)' }}>buff config set routing.quota.gemini.requestsPerWindow 1500</code>;
        the ledger always tracks usage but only parks when limits are set.
      </div>

      {/* M2.3/M2.4: parked multi-account keys — makes key rotation visible. */}
      {quota.parkedAccounts && quota.parkedAccounts.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            🔑 Parked Accounts — multi-account key rotation
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
            Accounts skipped predictively by the failover walk (rate-limit / auth). Fingerprints only — raw keys are never stored.
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '8px 0' }}>
            {quota.parkedAccounts.map((acct, i) => {
              const reason = acct.reason === 'auth' ? 'auth' : acct.reason === 'rate-limit' ? 'rate-limit' : acct.reason || 'cooldown';
              const color = acct.reason === 'rate-limit' ? 'var(--accent-yellow)' : 'var(--accent-red)';
              return (
                <div key={`${acct.provider}-${acct.accountId}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderBottom: i < quota.parkedAccounts!.length - 1 ? '1px solid var(--bg-card)' : 'none' }}>
                  <span style={{ fontSize: 13 }}>🔒</span>
                  <span style={{ width: 90, flexShrink: 0, fontSize: 12, color: 'var(--text-primary)' }}>
                    {providerIcon(acct.provider)} {providerLabel(acct.provider).split(' ')[0]}
                  </span>
                  <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: 'var(--text-secondary)' }} title={acct.accountId}>
                    #{acct.accountId.slice(0, 8)}
                  </span>
                  <span style={{ fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--bg-card)', border: `1px solid ${color}`, color, textAlign: 'center' }}>
                    {reason}
                  </span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
            🛟 Failover Timeline — quota management & mid-session swaps
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 10, padding: '8px 0' }}>
            {quota.events.map((ev, i) => {
              const icon = ev.type === 'parked' ? '⏸' : ev.type === 're-enabled' ? '🔁' : ev.type === 'released' ? '✅' : '⚡';
              const color = ev.type === 'parked' ? 'var(--accent-red)' : ev.type === 're-enabled' ? 'var(--accent-green)' : ev.type === 'released' ? 'var(--accent-green)' : 'var(--accent-yellow)';
              const label = ev.type === 'parked' ? 'parked' : ev.type === 're-enabled' ? 're-enabled' : ev.type === 'released' ? 'released' : 'failover';
              return (
                <div key={`${ev.timestamp}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderBottom: i < quota.events!.length - 1 ? '1px solid var(--bg-card)' : 'none' }}>
                  <span style={{ fontSize: 13 }}>{icon}</span>
                  <span style={{ width: 80, flexShrink: 0, fontSize: 11, padding: '1px 8px', borderRadius: 10, background: 'var(--bg-card)', border: `1px solid ${color}`, color, textAlign: 'center' }}>
                    {label}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {providerIcon(ev.provider)} {providerLabel(ev.provider)}
                  </span>
                  {ev.reason && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{ev.reason}</span>}
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(ev.timestamp)}</span>
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

// ─── Admin Governance Policy (P6 M6.5) ─────────────────────────────────────
// The allow/deny + cap rules the Auto router enforces as HARD constraints on
// every pick — mirrored from `buff admin policy` so policy is visible exactly
// where routing decisions are made (violating providers are eliminated, never
// just scored lower).

function RuleChip({ ok, children }: { ok?: boolean; children: ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 11, padding: '3px 9px', borderRadius: 8,
      background: ok === false ? 'var(--danger-soft)' : 'var(--ok-soft)',
      border: `1px solid ${ok === false ? 'var(--accent-red)' : 'var(--accent-green)'}`,
      color: ok === false ? 'var(--accent-red)' : 'var(--accent-green)',
      whiteSpace: 'nowrap' as const,
    }}>
      {children}
    </span>
  );
}

export function GovernanceSection({ governance }: { governance: GovernanceInsights }) {
  if (!governance.enabled) {
    return (
      <SectionCard
        icon="⚖️"
        title="Admin Governance Policy"
        subtitle="Hard-constraint rules the Auto router enforces on every pick"
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--accent-green)' }}>Fully permissive</span> — no governance rules active; any provider × model is eligible.
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            Add rules with <code style={{ color: 'var(--accent-blue)' }}>buff admin allow &lt;provider&gt;</code> ·{' '}
            <code style={{ color: 'var(--accent-blue)' }}>buff admin deny &lt;provider&gt;</code> ·{' '}
            <code style={{ color: 'var(--accent-blue)' }}>buff admin max-cost &lt;usd&gt;</code>
          </div>
        </div>
      </SectionCard>
    );
  }

  const rules: Array<{ label: string; items: string[]; deny?: boolean }> = [];
  if (governance.allowProviders?.length) rules.push({ label: 'allow providers', items: governance.allowProviders });
  if (governance.denyProviders?.length) rules.push({ label: 'deny providers', items: governance.denyProviders, deny: true });
  if (governance.allowModels?.length) rules.push({ label: 'allow models', items: governance.allowModels });
  if (governance.denyModels?.length) rules.push({ label: 'deny models', items: governance.denyModels, deny: true });
  const extras: string[] = [];
  if (governance.maxCostUsd !== undefined) extras.push(`max cost $${governance.maxCostUsd}`);
  if (governance.minPrivacyForPii !== undefined && governance.minPrivacyForPii < 1) {
    extras.push(`PII min privacy ${governance.minPrivacyForPii}`);
  }
  if (governance.piiPatterns?.length) extras.push(`PII guard (${governance.piiPatterns.length} patterns)`);
  if (governance.allowUnblock === false) extras.push('unblock admin-hard');

  return (
    <SectionCard
      icon="⚖️"
      title="Admin Governance Policy"
      subtitle="Hard-constraint rules — violating providers are eliminated, never just scored lower"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {rules.map((r) => (
          <RuleChip key={r.label} ok={!r.deny}>
            {r.deny ? '⛔' : '✅'} {r.label}: {r.items.join(', ')}
          </RuleChip>
        ))}
        {extras.map((e) => <RuleChip key={e}>{e}</RuleChip>)}
        {rules.length === 0 && extras.length === 0 && (
          <RuleChip ok={false}>policy configured but no rules active</RuleChip>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Managed via <code style={{ color: 'var(--accent-blue)' }}>buff admin</code> — the same policy the CLI&rsquo;s{' '}
        <code>model explain</code> surfaces as governance-blocked.
      </div>
    </SectionCard>
  );
}

/**
 * P6 M6.1 RBAC identity card — who is viewing, what role they hold, and the
 * full user→role map from ~/.buff/rbac.json (mirrors `buff admin whoami` /
 * `buff admin role list`). Legacy single-user mode (no roles assigned) shows
 * the permissive notice; once roles exist, policy writes require admin.
 */
export function RbacSection({ rbac }: { rbac: RbacInsights }) {
  const roleColor = (role: string): string =>
    role === 'admin' ? 'var(--accent-yellow)' : role === 'operator' ? 'var(--accent-green)' : 'var(--text-secondary)';
  return (
    <SectionCard
      icon="🔐"
      title="RBAC Identity"
      subtitle="Who may write policy — role file ~/.buff/rbac.json"
    >
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        <span style={{ color: 'var(--text-secondary)' }}>You are </span>
        <code style={{ color: 'var(--accent-blue)' }}>{rbac.identity}</code>
        <span style={{ color: 'var(--text-secondary)' }}> as </span>
        {rbac.role ? (
          <span style={{ color: roleColor(rbac.role), fontWeight: 600 }}>{rbac.role}</span>
        ) : (
          <span style={{ color: 'var(--text-secondary)' }}>unassigned</span>
        )}
      </div>
      {rbac.legacy ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          <span style={{ color: 'var(--accent-green)' }}>Legacy single-user mode</span> — no roles assigned; policy writes are
          open to every user. Assign roles with{' '}
          <code style={{ color: 'var(--accent-blue)' }}>buff admin role add &lt;you&gt; admin</code>.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {rbac.users.map((u) => (
            <RuleChip key={u.user} ok={u.role !== 'viewer'}>
              {u.user} · {u.role}
              {u.via === 'oidc' ? ' (oidc)' : ''}
            </RuleChip>
          ))}
          <div style={{ width: '100%', fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            Policy <em>writes</em> require <code style={{ color: 'var(--accent-blue)' }}>admin</code>; reads are open to every role.
          </div>
        </div>
      )}
    </SectionCard>
  );
}

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
  const hasMl = !!routing?.ml?.enabled && (routing.ml.recordCount ?? 0) > 0;
  const hasQuota = !!routing?.quota?.enabled;
  const hasRetrieval = !!routing?.retrieval?.enabled || !!routing?.retrieval?.repoChunks;
  const hasGovernance = !!routing?.governance;
  const hasRbac = !!routing?.rbac;

  return (
    <>
      <PageHeader icon="🤖" title="Auto Routing Insights" />
      <p className="section-description">
        Which providers and models the Auto router prefers — from real pricing, benchmark
        quality, per-agent success stats, and the Thompson-sampling bandit. Run{' '}
        <code>buff benchmark</code> and use Auto routing to build this up over time.
      </p>

      {!hasAny && !hasUsage && !hasHistory && !hasBandit && !hasPromotion && !hasMl && !hasQuota && !hasRetrieval && !hasGovernance && !hasRbac ? (
        <EmptyNote />
      ) : (
        <>
          {hasWalkthrough && routing && <RoutingWalkthroughSection routing={routing} />}
          {hasGovernance && routing!.governance && <GovernanceSection governance={routing!.governance} />}
          {routing?.rbac && <RbacSection rbac={routing.rbac} />}
          {hasUsage && <UsageSection usage={routing!.usage!} />}
          {hasHistory && <AuditTimelineSection history={routing!.history!} />}
          {hasBandit && <BanditSection bandit={routing!.bandit!} />}
          {hasPromotion && <PromotionGateSection promotion={routing!.promotion!} />}
          {hasMl && routing!.ml && <MlSection ml={routing!.ml} />}
          {hasQuota && <QuotaSection quota={routing!.quota!} />}
          {hasRetrieval && <RetrievalSection retrieval={routing!.retrieval!} />}
          <PreferenceSection routing={routing!} />
          <ProviderQualitySection routing={routing!} />
          <BestModelsSection routing={routing!} />
        </>
      )}

      {routing && routing.providers.length === 0 && routing.bestModels.length === 0 && routing.preference.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Auto-router preference is always available (static profiles + real pricing); quality
          metrics appear once you run benchmarks and agent tasks.
        </div>
      )}
    </>
  );
}
