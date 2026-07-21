import { useState, useEffect, useRef } from 'react';
import type { ModelsHealthData, ProviderHealth, ModelStatus, TestedModel } from '../types';

// ─── Constants ──────────────────────────────────────────────────────────────

const LOCAL_PROVIDERS = new Set(['local', 'lmstudio', 'vllm']);

const STATUS_STYLES: Record<ModelStatus, { bg: string; text: string; dot: string; cardBorder: string; cardBg: string }> = {
  available: { bg: '#0a2e1a', text: '#3fb950', dot: '#3fb950', cardBorder: '#3fb950', cardBg: '#0d2818' },
  limited: { bg: '#2d1f00', text: '#d29922', dot: '#d29922', cardBorder: '#d29922', cardBg: '#1f1700' },
  unavailable: { bg: '#2d0f0f', text: '#f85149', dot: '#f85149', cardBorder: '#f85149', cardBg: '#1f0a0a' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getStatusLabel(status: ModelStatus): string {
  return status === 'available' ? 'Available' : status === 'limited' ? 'Limited' : 'Unavailable';
}

function getStatusBadgeLabel(status: ModelStatus): string {
  return status === 'available' ? 'Ready' : status === 'limited' ? 'Limited' : 'Down';
}

function getProviderIcon(provider: string): string {
  const iconMap: Record<string, string> = {
    local: '💻', groq: '🟢', nim: '🔶', gemini: '🔷', openrouter: '🟣',
    openai: '🤖', anthropic: '🔮', mistral: '🌀', cohere: '🧠',
    together: '🟢', deepinfra: '🌐', fireworks: '🎆', perplexity: '❓',
    azure: '🔵', anyscale: '🔷', lmstudio: '🎨', vllm: '⚡',
  };
  return iconMap[provider] || '🔌';
}

function getProviderLabel(provider: string): string {
  const labelMap: Record<string, string> = {
    local: 'Ollama', groq: 'Groq', nim: 'NVIDIA NIM', gemini: 'Gemini',
    openrouter: 'OpenRouter', openai: 'OpenAI', anthropic: 'Anthropic',
    mistral: 'Mistral', cohere: 'Cohere', together: 'Together AI',
    deepinfra: 'DeepInfra', fireworks: 'Fireworks AI', perplexity: 'Perplexity',
    azure: 'Azure OpenAI', anyscale: 'Anyscale', lmstudio: 'LM Studio',
    vllm: 'vLLM / TGI',
  };
  return labelMap[provider] || provider;
}

// ─── Status Badge ───────────────────────────────────────────────────────────

function StatusBadge({ status, label }: { status: ModelStatus; label: string }) {
  const s = STATUS_STYLES[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: s.bg, color: s.text, padding: '3px 10px',
      borderRadius: 12, fontSize: 12, fontWeight: 500,
      border: `1px solid ${s.text}22`,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot }} />
      {label}
    </span>
  );
}

// ─── Action Bar ─────────────────────────────────────────────────────────────

function ActionBar({ onRefresh, loading }: { onRefresh: () => void; loading: boolean }) {
  return (
    <div className="stats-grid mini" style={{ marginBottom: 16 }}>
      <button
        onClick={onRefresh}
        disabled={loading}
        className="stat-card"
        style={{
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          border: '1px solid #30363d',
          justifyContent: 'center',
          fontSize: 13,
        }}
      >
        {loading ? '⏳ Testing...' : '🔄 Refresh Status'}
      </button>
      <div className="stat-card" style={{ border: '1px solid #30363d' }}>
        <div style={{ fontSize: 13, color: '#8b949e', textAlign: 'center', width: '100%' }}>
          Tests all configured providers and their API keys in real time
        </div>
      </div>
    </div>
  );
}

// ─── Progress Bar ───────────────────────────────────────────────────────────

function ProgressBar({ data }: { data: ModelsHealthData }) {
  const total = data.totalModels;
  if (total === 0) return null;

  const available = data.available || 0;
  const limited = data.limited || 0;
  const unavailable = data.unavailable || 0;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        background: '#0d1117', borderRadius: 8, overflow: 'hidden',
        height: 10, display: 'flex', border: '1px solid #21262d',
      }}>
        {available > 0 && <div style={{ width: `${(available / total) * 100}%`, background: '#3fb950', transition: 'width 0.5s' }} title={`${available} available`} />}
        {limited > 0 && <div style={{ width: `${(limited / total) * 100}%`, background: '#d29922', transition: 'width 0.5s' }} title={`${limited} limited`} />}
        {unavailable > 0 && <div style={{ width: `${(unavailable / total) * 100}%`, background: '#f85149', transition: 'width 0.5s' }} title={`${unavailable} unavailable`} />}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12, color: '#8b949e' }}>
        <span><span style={{ color: '#3fb950' }}>●</span> Ready</span>
        <span><span style={{ color: '#d29922' }}>●</span> Limited</span>
        <span><span style={{ color: '#f85149' }}>●</span> Unavailable</span>
      </div>
    </div>
  );
}

// ─── Provider Card (same as before) ────────────────────────────────────────

function ProviderCard({ provider }: { provider: ProviderHealth }) {
  const [expanded, setExpanded] = useState(false);

  const borderColor = STATUS_STYLES[provider.overallStatus].text;
  const counts = {
    available: provider.models.filter((m) => m.status === 'available').length,
    limited: provider.models.filter((m) => m.status === 'limited').length,
    unavailable: provider.models.filter((m) => m.status === 'unavailable').length,
  };

  return (
    <div style={{
      background: '#161b22', borderRadius: 12,
      border: `1px solid ${borderColor}44`,
      borderLeft: `4px solid ${borderColor}`,
      marginBottom: 12, overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 18px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 14,
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 24 }}>{provider.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>
              {provider.providerLabel}
            </span>
            <StatusBadge
              status={provider.overallStatus}
              label={getStatusLabel(provider.overallStatus)}
            />
          </div>
          <div style={{ fontSize: 13, color: '#8b949e' }}>
            {provider.models.length} model{provider.models.length !== 1 ? 's' : ''}
            {counts.available > 0 && <span style={{ color: '#3fb950' }}> · {counts.available} ready</span>}
            {counts.limited > 0 && <span style={{ color: '#d29922' }}> · {counts.limited} limited</span>}
            {counts.unavailable > 0 && <span style={{ color: '#f85149' }}> · {counts.unavailable} unavailable</span>}
          </div>
        </div>
        <div style={{ fontSize: 12, color: '#8b949e', textAlign: 'right' }}>
          <div style={{ marginBottom: 2, color: provider.apiConfigured ? '#3fb950' : '#f85149' }}>
            {provider.apiConfigured ? '✅ Key set' : '❌ No key'}
          </div>
          <div style={{ color: provider.apiAccessible ? '#3fb950' : '#f85149' }}>
            {provider.apiAccessible ? '✅ Connected' : '❌ Offline'}
          </div>
        </div>
        <span style={{
          color: '#8b949e', fontSize: 18,
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
      </div>

      {expanded && (
        <>
          <div style={{
            padding: '10px 18px', background: '#0d1117', fontSize: 13, color: '#8b949e',
            display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
            borderTop: '1px solid #21262d',
          }}>
            <span>{provider.notes}</span>
            {provider.freeTierInfo && (
              <span style={{ color: '#d29922' }}>🎁 {provider.freeTierInfo}</span>
            )}
          </div>
          <div style={{ overflowX: 'auto', borderTop: '1px solid #21262d' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
                  <th style={{ padding: '8px 18px', textAlign: 'left', fontWeight: 500 }}>Model</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Quota</th>
                  <th style={{ padding: '8px 18px', textAlign: 'left', fontWeight: 500 }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model, i) => (
                  <tr key={model.id} style={{
                    borderBottom: i < provider.models.length - 1 ? '1px solid #21262d' : 'none',
                    background: model.status === 'unavailable' ? '#0d1117' : 'transparent',
                  }}>
                    <td style={{
                      padding: '8px 18px', color: '#e6edf3',
                      fontFamily: "'SFMono-Regular', Consolas, monospace",
                      fontSize: 12,
                    }}>
                      <span style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        background: STATUS_STYLES[model.status].dot, marginRight: 8,
                      }} />
                      {model.name}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <StatusBadge status={model.status} label={getStatusBadgeLabel(model.status)} />
                    </td>
                    <td style={{ padding: '8px 12px', color: '#8b949e', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                      {model.rateLimitRemaining !== undefined
                        ? model.rateLimitTotal
                          ? `${model.rateLimitRemaining}/${model.rateLimitTotal}`
                          : `${model.rateLimitRemaining} left`
                        : '—'}
                    </td>
                    <td style={{ padding: '8px 18px', color: '#8b949e', fontSize: 12 }}>
                      {model.statusReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({ icon, title, count }: { icon: string; title: string; count: number }) {
  if (count === 0) return null;
  return (
    <h3 style={{
      fontSize: 15, fontWeight: 600, color: '#e6edf3',
      margin: '24px 0 12px 0', display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span>{icon}</span> {title}
      <span style={{
        fontSize: 12, color: '#8b949e', fontWeight: 400,
        background: '#161b22', padding: '1px 8px', borderRadius: 8,
      }}>
        {count}
      </span>
    </h3>
  );
}

// ─── Model Card Grid ────────────────────────────────────────────────────────

function ModelCard({ model, provider }: { model: TestedModel; provider: string }) {
  const s = STATUS_STYLES[model.status];
  const quotaText = model.rateLimitRemaining !== undefined
    ? model.rateLimitTotal
      ? `${model.rateLimitRemaining} / ${model.rateLimitTotal}`
      : `${model.rateLimitRemaining} left`
    : 'Unlimited';

  return (
    <div style={{
      background: s.cardBg,
      border: `1px solid ${s.cardBorder}44`,
      borderRadius: 12,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      transition: 'all 0.2s ease',
      cursor: 'default',
      position: 'relative',
      overflow: 'hidden',
    }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = s.cardBorder; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 4px 16px ${s.cardBorder}22`; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = `${s.cardBorder}44`; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Top accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: s.cardBorder,
        opacity: 0.6,
      }} />

      {/* Model name */}
      <div style={{
        fontSize: 14, fontWeight: 600, color: '#e6edf3',
        fontFamily: "'SFMono-Regular', Consolas, monospace",
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        paddingTop: 4,
      }}>
        {model.name.length > 30 ? model.name.slice(0, 28) + '…' : model.name}
      </div>

      {/* Provider */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8b949e' }}>
        <span>{getProviderIcon(provider)}</span>
        <span>{getProviderLabel(provider)}</span>
      </div>

      {/* Health status - color box */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: s.bg, color: s.text,
        padding: '4px 10px', borderRadius: 8,
        fontSize: 12, fontWeight: 600,
        alignSelf: 'flex-start',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot }} />
        {model.status === 'available' ? 'Available' : model.status === 'limited' ? 'Limited' : 'Unavailable'}
      </div>

      {/* Token / Quota */}
      <div style={{ fontSize: 11, color: '#6e7681', marginTop: 'auto' }}>
        <span style={{ color: '#8b949e' }}>Quota:</span>{' '}
        <span style={{
          color: model.rateLimitRemaining !== undefined && model.rateLimitRemaining <= 10
            ? '#d29922' : '#8b949e',
          fontFamily: "'SFMono-Regular', Consolas, monospace",
        }}>
          {quotaText}
        </span>
      </div>

      {/* Reason tooltip on hover */}
      {model.statusReason && model.status !== 'available' && (
        <div style={{ fontSize: 10, color: '#6e7681', marginTop: 2 }}>
          {model.statusReason.length > 40 ? model.statusReason.slice(0, 38) + '…' : model.statusReason}
        </div>
      )}
    </div>
  );
}

// ─── Models Grid Section ────────────────────────────────────────────────────

function ModelsGrid({ providers }: { providers: ProviderHealth[] }) {
  // Flatten all models with their provider info
  const allModels: Array<{ model: TestedModel; provider: string }> = [];
  for (const p of providers) {
    for (const m of p.models) {
      allModels.push({ model: m, provider: p.provider });
    }
  }

  if (allModels.length === 0) return null;

  // Sort: available first, then limited, then unavailable
  const statusOrder: Record<ModelStatus, number> = { available: 0, limited: 1, unavailable: 2 };
  allModels.sort((a, b) => statusOrder[a.model.status] - statusOrder[b.model.status]);

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 36 }}>📋 Model Health Overview</h2>
      <p className="section-description">
        All models across all providers, color-coded by health status.
        Green = ready, Amber = limited quota, Red = unavailable.
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 14,
      }}>
        {allModels.map(({ model, provider }) => (
          <ModelCard key={`${provider}-${model.id}`} model={model} provider={provider} />
        ))}
      </div>
    </>
  );
}

// ─── Legend ─────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div style={{
      background: '#0d1117', borderRadius: 10, padding: 14, marginBottom: 20,
      border: '1px solid #21262d', fontSize: 13, color: '#8b949e',
      display: 'flex', flexWrap: 'wrap', gap: 20,
    }}>
      <div>
        <div style={{ fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>Color Coding</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span><span style={{ color: '#3fb950' }}>●</span> <strong style={{ color: '#e6edf3' }}>Green</strong> — Working with rate limit available</span>
          <span><span style={{ color: '#d29922' }}>●</span> <strong style={{ color: '#e6edf3' }}>Amber</strong> — Slow / low rate limit / needs action</span>
          <span><span style={{ color: '#f85149' }}>●</span> <strong style={{ color: '#e6edf3' }}>Red</strong> — API key missing / payment needed / unreachable</span>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>Provider Sections</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
          <span>✅ <strong>Cloud</strong> — Online providers with active API keys</span>
          <span>🏠 <strong>Local</strong> — Locally running inference servers</span>
          <span>⛔ <strong>Unavailable</strong> — Missing keys or unreachable endpoints</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ModelsPanel() {
  const [modelsData, setModelsData] = useState<ModelsHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  async function fetchModels() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/models');
      if (!mountedRef.current) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ModelsHealthData;
      if (mountedRef.current) setModelsData(data);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch model status');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    fetchModels();
    const interval = setInterval(fetchModels, 60_000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, []);

  // Sort providers into sections
  function sortProviders(data: ModelsHealthData) {
    const available: ProviderHealth[] = [];
    const local: ProviderHealth[] = [];
    const unavailable: ProviderHealth[] = [];

    // Sort order for non-local providers
    const availabilityOrder: Record<ModelStatus, number> = { available: 0, limited: 1, unavailable: 2 };

    for (const p of data.providers) {
      if (LOCAL_PROVIDERS.has(p.provider)) {
        local.push(p);
      } else if (p.overallStatus === 'available') {
        available.push(p);
      } else {
        unavailable.push(p);
      }
    }

    // Sort each section by status
    available.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);
    local.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);
    unavailable.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);

    return { available, local, unavailable };
  }

  return (
    <>
      <h2 className="section-title">🧠 Model Provider Status</h2>
      <p className="section-description">
        Real-time health check of all AI providers and their available models.
        Providers are grouped into sections: Available cloud → Local → Unavailable.
      </p>

      <ActionBar onRefresh={fetchModels} loading={loading} />
      <Legend />

      {loading && !modelsData && (
        <div className="loading-state">
          <div className="loading-spinner" />
          <p>Testing all 17 provider connections...</p>
        </div>
      )}

      {error && (
        <div className="empty-state" style={{ color: '#f85149', border: '1px solid #f8514944', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {modelsData && (
        <>
          {/* Summary stats cards */}
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <span className="stat-icon">🧠</span>
              <div className="stat-body">
                <div className="stat-value">{modelsData.totalModels}</div>
                <div className="stat-label">Total Models</div>
              </div>
            </div>
            <div className="stat-card">
              <span className="stat-icon">✅</span>
              <div className="stat-body">
                <div className="stat-value" style={{ color: '#3fb950' }}>{modelsData.available}</div>
                <div className="stat-label">Available</div>
              </div>
            </div>
            <div className="stat-card">
              <span className="stat-icon">🟡</span>
              <div className="stat-body">
                <div className="stat-value" style={{ color: '#d29922' }}>{modelsData.limited}</div>
                <div className="stat-label">Limited</div>
              </div>
            </div>
            <div className="stat-card">
              <span className="stat-icon">🔴</span>
              <div className="stat-body">
                <div className="stat-value" style={{ color: '#f85149' }}>{modelsData.unavailable}</div>
                <div className="stat-label">Unavailable</div>
              </div>
            </div>
            <div className="stat-card">
              <span className="stat-icon">🔌</span>
              <div className="stat-body">
                <div className="stat-value">{modelsData.providers.length}</div>
                <div className="stat-label">Providers</div>
              </div>
            </div>
          </div>

          <ProgressBar data={modelsData} />

          {/* ── Sectioned Provider Cards ── */}
          {(() => {
            const { available, local, unavailable } = sortProviders(modelsData);

            return (
              <>
                {/* Section 1: Available Cloud Providers */}
                <SectionHeader icon="✅" title="Available Cloud Providers" count={available.length} />
                {available.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}

                {/* Section 2: Local Providers */}
                <SectionHeader icon="🏠" title="Local Providers" count={local.length} />
                {local.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}

                {/* Section 3: Unavailable Providers */}
                <SectionHeader icon="⛔" title="Unavailable Providers" count={unavailable.length} />
                {unavailable.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}
              </>
            );
          })()}

          {/* ── Model Cards Grid ── */}
          <ModelsGrid providers={modelsData.providers} />

          <div style={{ textAlign: 'center', fontSize: 12, color: '#484f58', marginTop: 16 }}>
            Last checked: {new Date(modelsData.lastChecked).toLocaleTimeString()}
            {' · '}Auto-refreshes every 60s
          </div>
        </>
      )}
    </>
  );
}
