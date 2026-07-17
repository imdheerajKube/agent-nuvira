import { useState, useEffect, useRef } from 'react';
import type { ModelsHealthData, ProviderHealth, ModelStatus } from '../types';

// ─── Status Badge ───────────────────────────────────────────────────────────

const STATUS_STYLES: Record<ModelStatus, { bg: string; text: string; dot: string }> = {
  available: { bg: '#0a2e1a', text: '#3fb950', dot: '#3fb950' },
  limited: { bg: '#2d1f00', text: '#d29922', dot: '#d29922' },
  unavailable: { bg: '#2d0f0f', text: '#f85149', dot: '#f85149' },
};

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

// ─── Provider Card ──────────────────────────────────────────────────────────

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
      {/* Header - clickable to expand */}
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
              label={
                provider.overallStatus === 'available' ? 'Available' :
                provider.overallStatus === 'limited' ? 'Limited' : 'Unavailable'
              }
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

      {/* Expanded details */}
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

          {/* Model table */}
          <div style={{ overflowX: 'auto', borderTop: '1px solid #21262d' }}>              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
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
                      <StatusBadge
                        status={model.status}
                        label={model.status === 'available' ? 'Ready' : model.status === 'limited' ? 'Limited' : 'Down'}
                      />
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
        <div style={{ fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>Provider Key Info</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
          <span>🟢 <strong>Groq</strong> — Free: 30 req/min, 14400/day. <code style={{ color: '#58a6ff' }}>GROQ_API_KEY</code></span>
          <span>🔶 <strong>NVIDIA NIM</strong> — Free: 1000 req/day. <code style={{ color: '#58a6ff' }}>NVIDIA_NIM_API_KEY</code></span>
          <span>🔷 <strong>Gemini</strong> — Free: 60 req/min, 1500/day. <code style={{ color: '#58a6ff' }}>GEMINI_API_KEY</code></span>
          <span>🟣 <strong>OpenRouter</strong> — Pay-per-use ($1 free trial). <code style={{ color: '#58a6ff' }}>OPENROUTER_API_KEY</code></span>
          <span>💻 <strong>Ollama</strong> — Fully free, local. No API key needed.</span>
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

  return (
    <>
      <h2 className="section-title">🧠 Model Provider Status</h2>
      <p className="section-description">
        Real-time health check of all AI providers and their available models.
        Tests each provider's API key and connectivity.
      </p>

      <ActionBar onRefresh={fetchModels} loading={loading} />
      <Legend />

      {loading && !modelsData && (
        <div className="loading-state">
          <div className="loading-spinner" />
          <p>Testing all provider connections...</p>
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

          {modelsData.providers.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} />
          ))}

          <div style={{ textAlign: 'center', fontSize: 12, color: '#484f58', marginTop: 16 }}>
            Last checked: {new Date(modelsData.lastChecked).toLocaleTimeString()}
            {' · '}Auto-refreshes every 60s
          </div>
        </>
      )}
    </>
  );
}
