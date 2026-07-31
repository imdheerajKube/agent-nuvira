import type { ReactNode } from 'react';
import type { DashboardData, RoutingInsights } from '../types';

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

  return (
    <>
      <h2 className="section-title">🤖 Auto Routing Insights</h2>
      <p className="section-description">
        Which providers and models the Auto router prefers — from real pricing, benchmark
        quality, and per-agent success stats. Run <code>buff benchmark</code> and use
        Auto routing to build this up over time.
      </p>

      {!hasAny ? (
        <EmptyNote />
      ) : (
        <>
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
