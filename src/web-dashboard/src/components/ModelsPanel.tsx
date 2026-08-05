import { useState, useEffect, useRef, useCallback } from 'react';
import { parseJsonOrNull } from '../jsonOrNull';
import type { ModelsHealthData, ProviderHealth, ModelStatus, TestedModel, ModelRegistryInsights, RegistryModelEntry, ActionTelemetryInsights } from '../types';

// ─── Constants ──────────────────────────────────────────────────────────────

const LOCAL_PROVIDERS = new Set(['local', 'lmstudio', 'vllm']);
/** Future speech/TTS providers — always appear last when implemented */
const SPEECH_PROVIDERS = new Set<string>([]);

const STATUS_STYLES: Record<ModelStatus, { bg: string; text: string; dot: string; cardBorder: string; cardBg: string }> = {
  available: { bg: '#0a2e1a', text: '#3fb950', dot: '#3fb950', cardBorder: '#3fb950', cardBg: '#0d2818' },
  limited: { bg: '#2d1f00', text: '#d29922', dot: '#d29922', cardBorder: '#d29922', cardBg: '#1f1700' },
  unavailable: { bg: '#2d0f0f', text: '#f85149', dot: '#f85149', cardBorder: '#f85149', cardBg: '#1f0a0a' },
};

const COL_OPTIONS = [3, 4, 5] as const;

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

// ─── Model Availability Registry Section ────────────────────────────────────
// The UNIFIED enterprise read store: the exact sub-ms FAISS/JSON snapshot the
// Auto router consults on every pick. Shows verified / unavailable / parked
// availability + the quota telemetry (tokens remaining, reset windows) that
// syncQuota mirrors from the ledger — one card, one source of truth.

function fmtDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.ceil(ms / 1000)}s`;
}

function registryStatusStyle(status: string) {
  if (status === 'verified') return { text: '#3fb950', bg: '#0a2e1a', dot: '#3fb950' };
  if (status === 'unavailable') return { text: '#f85149', bg: '#2d0f0f', dot: '#f85149' };
  return { text: '#8b949e', bg: '#21262d', dot: '#8b949e' };
}

function RegistryEntryRow({ entry }: { entry: RegistryModelEntry }) {
  const style = registryStatusStyle(entry.status);
  const tokens = entry.remainingTokens >= 0
    ? `${entry.remainingTokens.toLocaleString()} left`
    : 'unlimited';
  return (
    <tr style={{ borderBottom: '1px solid #21262d' }}>
      <td style={{ padding: '8px 12px', color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: style.dot, marginRight: 8 }} />
        {entry.model.length > 32 ? entry.model.slice(0, 29) + '…' : entry.model}
        {entry.parked && (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8,
            background: '#2d1616', border: '1px solid #f85149', color: '#f85149',
          }}>⏸ parked</span>
        )}
        {entry.measuredSamples ? (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
            background: '#0a2e1a', border: '1px solid #3fb950', color: '#3fb950',
          }}>
            📏 {entry.measuredInputTokens}→{entry.measuredOutputTokens} tok
          </span>
        ) : (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
            background: '#21262d', border: '1px solid #8b949e', color: '#8b949e',
          }}>📐 est</span>
        )}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
          background: style.bg, color: style.text, padding: '2px 8px', borderRadius: 6,
        }}>
          {entry.status === 'verified' ? '✓ Verified' : entry.status === 'unavailable' ? '✗ Unavailable' : '◌ Unverified'}
        </span>
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: entry.remainingTokens >= 0 && entry.remainingTokens <= 100 ? '#d29922' : '#8b949e' }}>
        {tokens}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#8b949e', fontSize: 12, whiteSpace: 'nowrap' }}>
        {entry.resetsInMs > 0 ? fmtDuration(entry.resetsInMs) : '—'}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: '#8b949e', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
        {entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : '—'}
      </td>
      <td style={{ padding: '8px 12px', color: '#6e7681', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.lastError || (entry.source ? `learned via ${entry.source}` : '')}
      </td>
    </tr>
  );
}

function RegistryCard({ provider }: { provider: ModelRegistryInsights['providers'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = provider.verified > 0 ? '#3fb950' : provider.unavailable > 0 ? '#f85149' : '#8b949e';

  return (
    <div style={{
      background: '#161b22', borderRadius: 12,
      border: `1px solid ${borderColor}44`,
      borderLeft: `4px solid ${borderColor}`,
      marginBottom: 12, overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, userSelect: 'none' }}
      >
        <span style={{ fontSize: 24 }}>{getProviderIcon(provider.provider)}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: '#e6edf3' }}>{getProviderLabel(provider.provider)}</span>
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              background: provider.parked > 0 ? '#2d1616' : '#12291a',
              border: `1px solid ${provider.parked > 0 ? '#f85149' : '#238636'}`,
              color: provider.parked > 0 ? '#f85149' : '#3fb950',
            }}>
              {provider.parked > 0 ? `${provider.parked} parked` : 'routable'}
            </span>
          </div>
          <div style={{ fontSize: 13, color: '#8b949e' }}>
            {provider.verified} verified · {provider.unverified} unverified · {provider.unavailable} unavailable
          </div>
        </div>
        <span style={{ color: '#8b949e', fontSize: 18, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
      </div>
      {expanded && (
        <div style={{ overflowX: 'auto', borderTop: '1px solid #21262d' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #21262d', color: '#8b949e' }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Model</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Availability</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>Tokens left</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>Resets in</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>Latency</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Reason / Source</th>
              </tr>
            </thead>
            <tbody>
              {provider.models.map((entry) => (
                <RegistryEntryRow key={entry.model} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModelRegistrySection({ data }: { data: ModelRegistryInsights }) {
  if (!data.enabled) {
    return (
      <div style={{
        background: '#161b22', borderRadius: 12, border: '1px dashed #30363d',
        padding: '20px 24px', marginTop: 24, textAlign: 'center' as const,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>
          Model Availability Registry
        </div>
        <div style={{ fontSize: 12, color: '#6e7681' }}>
          No registry data yet — run <code style={{ color: '#58a6ff' }}>buff models refresh</code> or use Auto routing;
          the registry learns from real usage and probes.
        </div>
      </div>
    );
  }

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 36 }}>📦 Model Availability Registry — the store routing reads</h2>
      <p className="section-description">
        The unified sub-ms FAISS/JSON snapshot the Auto router consults on every pick:
        verified vs unavailable models plus quota telemetry (tokens remaining, reset
        windows) mirrored from the ledger. State changes during a session are reported
        to the watch daemon and recorded here immediately.
      </p>

      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <span className="stat-icon">📦</span>
          <div className="stat-body">
            <div className="stat-value">{data.total}</div>
            <div className="stat-label">Tracked models</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">✅</span>
          <div className="stat-body">
            <div className="stat-value" style={{ color: '#3fb950' }}>{data.verified}</div>
            <div className="stat-label">Verified</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">◌</span>
          <div className="stat-body">
            <div className="stat-value" style={{ color: '#8b949e' }}>{data.unverified}</div>
            <div className="stat-label">Unverified</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">⛔</span>
          <div className="stat-body">
            <div className="stat-value" style={{ color: '#f85149' }}>{data.unavailable}</div>
            <div className="stat-label">Unavailable</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">⏸</span>
          <div className="stat-body">
            <div className="stat-value" style={{ color: '#d29922' }}>{data.parked}</div>
            <div className="stat-label">Quota-parked</div>
          </div>
        </div>
      </div>

      {data.providers.map((provider) => (
        <RegistryCard key={provider.provider} provider={provider} />
      ))}

      <div style={{ textAlign: 'center', fontSize: 12, color: '#484f58', marginTop: 12 }}>
        Backend snapshot · auto-refreshes every 60s
      </div>
    </>
  );
}

// ─── Learned-from-real-usage Telemetry (per action) ─────────────────────────
// Every LLM call writes through to the health store WITH its action tag (chat /
// execute / plan / edit / ...). This section shows which provider × model each
// action verified or killed — making the predictive skips routing performs
// visible: a provider killed by ANY action is skipped by all others.

const ACTION_ICONS: Record<string, string> = {
  chat: '💬', execute: '⚙️', plan: '🗺️', edit: '✏️', skill: '🧩', learn: '📚',
  ci: '🔁', doctor: '🩺', probe: '🔭', 'spot-check': '🧪', telemetry: '📡', usage: '🧮',
};

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    chat: 'Chat', execute: 'Execute', plan: 'Plan', edit: 'Edit', skill: 'Skill',
    learn: 'Learn', ci: 'CI Review', doctor: 'Doctor Probe', probe: 'Probe',
    'spot-check': 'Spot-check', telemetry: 'Usage mirror',
  };
  return map[action] || action.charAt(0).toUpperCase() + action.slice(1);
}

function actionIcon(action: string): string {
  return ACTION_ICONS[action] || '🎯';
}

function fmtShortTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString() + ' ' +
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ModelLearnChip({ provider, model, reason, killed, transient }: {
  provider: string;
  model: string;
  reason?: string;
  killed?: boolean;
  transient?: boolean;
}) {
  const isKilled = killed === true;
  const isTransient = transient === true;
  const color = isTransient ? '#d29922' : isKilled ? '#f85149' : '#3fb950';
  const bg = isTransient ? '#2d1f00' : isKilled ? '#2d0f0f' : '#0a2e1a';
  return (
    <span
      title={isTransient
        ? `Transient failure — health decayed, no flip${reason ? ` · ${reason}` : ''}`
        : isKilled
          ? `Killed by this action — predictively skipped by routing${reason ? ` · ${reason}` : ''}`
          : 'Verified by this action — trusted by routing'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: bg, border: `1px solid ${color}`,
        color, padding: '3px 9px', borderRadius: 8, fontSize: 11,
        fontFamily: "'SFMono-Regular', Consolas, monospace", whiteSpace: 'nowrap',
        transition: 'transform 0.15s',
        cursor: 'default',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <span style={{ opacity: 0.85 }}>{isTransient ? '~' : isKilled ? '✗' : '✓'}</span>
      {provider}/{model.length > 30 ? model.slice(0, 27) + '…' : model}
      {isKilled && reason && (
        <span style={{ color: `${color}99`, fontSize: 10, fontWeight: 400 }}>· {reason}</span>
      )}
    </span>
  );
}

// ─── Per-action timeline chart (verified vs killed vs transient over time) ──
// Daily stacked bars for the last 14 days: each bar's height is the day's
// total events, split into verified (green) / killed (red) / transient (amber)
// segments. Scrub across days (drag the track, click a bar, or use the range
// slider) to see that day's exact chips — which provider × model the action
// killed or verified — matching the Run Timeline's draggable-caret pattern.

/** One raw learned event inside a day bucket (what the scrubber shows). */
export type ActionDayEvent = {
  provider: string;
  model: string;
  outcome: 'verified' | 'unavailable' | 'error';
  errorType?: string;
  /** Epoch ms of the event. */
  at: number;
};

/** One day bucket in the per-action telemetry timeline. */
export type ActionDayBucket = {
  day: number;
  verified: number;
  killed: number;
  transient: number;
  events: ActionDayEvent[];
};

/**
 * One chip per provider × model × outcome for a day (latest event wins),
 * ordered killed → verified → transient so the most actionable learning
 * (predictive skips) surfaces first.
 */
export function dedupeDayEvents(events: ActionDayEvent[]): ActionDayEvent[] {
  const latest = new Map<string, ActionDayEvent>();
  for (const e of events) latest.set(`${e.provider}|${e.model}|${e.outcome}`, e);
  const priority: Record<ActionDayEvent['outcome'], number> = { unavailable: 0, verified: 1, error: 2 };
  return [...latest.values()].sort((a, b) => priority[a.outcome] - priority[b.outcome] || b.at - a.at);
}

/** Default scrub position: the most recent day with events (else the last day). */
function lastDayWithEvents(timeline: ActionDayBucket[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const b = timeline[i];
    if (b.verified + b.killed + b.transient > 0) return i;
  }
  return Math.max(0, timeline.length - 1);
}

export function ActionTimelineChart({ timeline }: { timeline: ActionDayBucket[] }) {
  const [dayIdx, setDayIdx] = useState(() => lastDayWithEvents(timeline || []));
  const [playing, setPlaying] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const len = timeline?.length ?? 0;
  const clamped = Math.max(0, Math.min(dayIdx, len - 1));

  // Clamp the selection when the timeline refreshes (60s poll) and resizes.
  useEffect(() => {
    setDayIdx((cur) => Math.min(cur, Math.max(0, len - 1)));
  }, [len]);

  // Drag: pointer-down on the track grabs it; window move/up drive the caret.
  const setFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || len <= 0) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width || 1;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / width));
    setDayIdx(Math.min(len - 1, Math.floor(frac * len)));
  }, [len]);

  const handlePointerDown = (e: React.PointerEvent) => {
    draggingRef.current = true;
    setPlaying(false);
    setFromClientX(e.clientX);
  };

  // Register the window listeners once; the drag flag lives in a ref so the
  // listeners don't churn on every caret tick during playback.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (draggingRef.current) setFromClientX(e.clientX);
    };
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [setFromClientX]);

  // Playback: sweep one day at a time (~300ms/day), then rewind + rest.
  useEffect(() => {
    if (!playing || len <= 1) return;
    const interval = setInterval(() => {
      setDayIdx((prev) => Math.min(len - 1, prev + 1));
    }, 300);
    return () => clearInterval(interval);
  }, [playing, len]);

  // Reached the last day during playback → stop and rewind to the start.
  // len > 1 guard keeps a single-day timeline from instantly stop/rewinding
  // (the interval effect already refuses to sweep for len <= 1).
  useEffect(() => {
    if (playing && len > 1 && dayIdx >= len - 1) {
      setPlaying(false);
      setDayIdx(0);
    }
  }, [playing, len, dayIdx]);

  if (!timeline || len === 0) return null;

  const max = Math.max(1, ...timeline.map((b) => b.verified + b.killed + b.transient));
  const dayLabel = (day: number): string =>
    new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const day = timeline[clamped];
  const chips = day ? dedupeDayEvents(day.events || []) : [];

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #21262d' }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 8,
        textTransform: 'uppercase', letterSpacing: 0.4,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      }}>
        <span>📈 Learned from real usage — last {len} days</span>
        <span style={{ fontWeight: 400, color: '#6e7681', letterSpacing: 0 }}>
          — drag across days · click a day · play to sweep
        </span>
      </div>

      {/* Scrub controls (matches the Run Timeline interaction) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button
          onClick={() => {
            if (playing) {
              setPlaying(false);
            } else {
              if (dayIdx >= len - 1) setDayIdx(0);
              setPlaying(true);
            }
          }}
          disabled={len <= 1}
          aria-label={playing ? 'Pause scrub' : 'Play scrub'}
          style={{
            background: '#21262d', border: `1px solid ${playing ? '#f85149' : '#30363d'}`,
            color: '#e6edf3', padding: '3px 10px', borderRadius: 6,
            cursor: len <= 1 ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
            transition: 'all 0.15s', whiteSpace: 'nowrap',
            opacity: len <= 1 ? 0.5 : 1,
          }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <span style={{ fontSize: 11, color: '#8b949e', whiteSpace: 'nowrap' }}>
          {dayLabel(day.day)} · ✓ {day.verified} · ✗ {day.killed}
          {day.transient > 0 ? ` · ~ ${day.transient}` : ''}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, len - 1)}
          step={1}
          value={clamped}
          onChange={(e) => { setPlaying(false); setDayIdx(Number(e.target.value)); }}
          aria-label="Scrub action timeline"
          style={{ flex: 1, accentColor: '#58a6ff', cursor: 'pointer', minWidth: 80 }}
        />
      </div>

      {/* Day bars — the scrub track */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        style={{
          position: 'relative', display: 'flex', alignItems: 'flex-end',
          gap: 3, height: 64, padding: '0 2px', cursor: 'grab',
          userSelect: 'none', touchAction: 'none',
        }}
      >
        {timeline.map((b, i) => {
          const total = b.verified + b.killed + b.transient;
          const hVerified = (b.verified / max) * 56;
          const hKilled = (b.killed / max) * 56;
          const hTransient = (b.transient / max) * 56;
          const isActive = i === clamped;
          return (
            <div
              key={b.day}
              onClick={() => { setPlaying(false); setDayIdx(i); }}
              title={`${dayLabel(b.day)} — ✓ ${b.verified} verified · ✗ ${b.killed} killed · ~ ${b.transient} transient`}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column-reverse',
                alignItems: 'center', gap: 0, cursor: 'pointer',
              }}
            >
              <div style={{
                position: 'relative', width: '100%', borderRadius: 3,
                overflow: isActive ? 'visible' : 'hidden',
                background: total === 0 ? '#21262d' : 'transparent',
                height: total === 0 ? 4 : 56,
                display: 'flex', flexDirection: 'column-reverse',
                boxShadow: isActive ? '0 0 0 1.5px #58a6ff' : undefined,
                opacity: total === 0 ? 0.5 : 1,
                transition: 'box-shadow 0.15s',
              }}>
                {/* Caret — pinned to the ACTIVE bar's own geometry (gap/padding exact) */}
                {isActive && (
                  <div style={{
                    position: 'absolute', top: -3, bottom: -3, width: 2, left: '50%',
                    transform: 'translateX(-50%)',
                    background: '#58a6ff', borderRadius: 2, pointerEvents: 'none',
                    boxShadow: '0 0 8px #58a6ff88', zIndex: 1,
                  }} />
                )}
                {b.verified > 0 && (
                  <div style={{ height: hVerified, background: '#3fb950', minHeight: 3 }} />
                )}
                {b.killed > 0 && (
                  <div style={{ height: hKilled, background: '#f85149', minHeight: 3 }} />
                )}
                {b.transient > 0 && (
                  <div style={{ height: hTransient, background: '#d29922', minHeight: 3 }} />
                )}
              </div>
              <div style={{
                fontSize: 9, color: isActive ? '#58a6ff' : '#6e7681', marginTop: 4,
                whiteSpace: 'nowrap', fontWeight: isActive ? 700 : 400,
              }}>
                {dayLabel(b.day)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: '#8b949e' }}>
        <span><span style={{ color: '#3fb950' }}>■</span> verified</span>
        <span><span style={{ color: '#f85149' }}>■</span> killed</span>
        <span><span style={{ color: '#d29922' }}>■</span> transient</span>
      </div>

      {/* Day detail — the chips for the scrubbed day */}
      <div style={{
        marginTop: 10, background: '#161b22', border: '1px solid #21262d',
        borderRadius: 8, padding: '10px 12px',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>
          {dayLabel(day.day)}{' '}
          <span style={{ color: '#8b949e', fontWeight: 400 }}>
            — what this action learned that day
          </span>
        </div>
        {chips.length === 0 ? (
          <div style={{ fontSize: 12, color: '#6e7681' }}>
            No learning recorded that day — nothing verified or killed.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((e) =>
              e.outcome === 'unavailable' ? (
                <ModelLearnChip
                  key={`${e.provider}|${e.model}|${e.outcome}`}
                  provider={e.provider}
                  model={e.model}
                  reason={e.errorType}
                  killed
                />
              ) : e.outcome === 'verified' ? (
                <ModelLearnChip
                  key={`${e.provider}|${e.model}|${e.outcome}`}
                  provider={e.provider}
                  model={e.model}
                />
              ) : (
                <ModelLearnChip
                  key={`${e.provider}|${e.model}|${e.outcome}`}
                  provider={e.provider}
                  model={e.model}
                  reason={e.errorType}
                  transient
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionTelemetryCard({ entry }: { entry: ActionTelemetryInsights['actions'][number] }) {
  const [expanded, setExpanded] = useState(true);
  const borderColor = entry.killed > 0 ? '#f85149' : entry.verified > 0 ? '#3fb950' : '#d29922';

  return (
    <div style={{
      background: '#161b22', borderRadius: 12,
      border: `1px solid ${borderColor}33`,
      borderLeft: `4px solid ${borderColor}`,
      marginBottom: 12, overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, userSelect: 'none' }}
      >
        <span style={{ fontSize: 20 }}>{actionIcon(entry.action)}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3', marginBottom: 2 }}>
            {actionLabel(entry.action)}
          </div>
          <div style={{ fontSize: 12, color: '#8b949e', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span><span style={{ color: '#3fb950' }}>✓ {entry.verified}</span> verified</span>
            <span><span style={{ color: '#f85149' }}>✗ {entry.killed}</span> killed</span>
            {entry.transient > 0 && <span><span style={{ color: '#d29922' }}>~ {entry.transient}</span> transient</span>}
          </div>
        </div>
        <span style={{ color: '#8b949e', fontSize: 16, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
      </div>
      {expanded && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid #21262d', background: '#0d1117' }}>
          {entry.killedModels.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 600, color: '#f85149', marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>
                ⛔ Killed — skipped predictively by routing
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {entry.killedModels.map((m) => (
                  <ModelLearnChip key={`${m.provider}|${m.model}`} provider={m.provider} model={m.model} reason={m.reason} killed />
                ))}
              </div>
            </>
          )}
          {entry.verifiedModels.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 600, color: '#3fb950', marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>
                ✅ Verified — trusted by routing
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {entry.verifiedModels.map((m) => (
                  <ModelLearnChip key={`${m.provider}|${m.model}`} provider={m.provider} model={m.model} />
                ))}
              </div>
            </>
          )}
          {entry.killedModels.length === 0 && entry.verifiedModels.length === 0 && (
            <div style={{ fontSize: 12, color: '#6e7681' }}>
              Only transient failures — health decayed, no model flipped.
            </div>
          )}
          <ActionTimelineChart timeline={entry.timeline} />
        </div>
      )}
    </div>
  );
}

function ActionTelemetrySection({ registry }: { registry: ModelRegistryInsights }) {
  const tele = registry.actionTelemetry;
  if (!tele) return null;
  if (!tele.enabled) {
    return (
      <div style={{
        background: '#161b22', borderRadius: 12, border: '1px dashed #30363d',
        padding: '18px 24px', marginTop: 24, textAlign: 'center' as const,
      }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🎓</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>
          Learned from real usage — per action
        </div>
        <div style={{ fontSize: 12, color: '#6e7681', lineHeight: 1.5 }}>
          No per-action telemetry yet. As you use <strong style={{ color: '#8b949e' }}>chat</strong>,{' '}
          <strong style={{ color: '#8b949e' }}>execute</strong>, <strong style={{ color: '#8b949e' }}>plan</strong>,
          and <strong style={{ color: '#8b949e' }}>edit</strong>, each action's verified / killed provider ×
          model combos appear here — showing exactly what routing learned from real usage.
        </div>
      </div>
    );
  }
  return (
    <>
      <h2 className="section-title" style={{ marginTop: 36 }}>🎓 Learned from real usage — per action</h2>
      <p className="section-description">
        Every LLM call writes through to the health store with its action tag. This panel shows which
        provider × model each action <span style={{ color: '#3fb950' }}>verified</span> (routable) or{' '}
        <span style={{ color: '#f85149' }}>killed</span> (predictively skipped) — the exact feed that turns
        &ldquo;fail gemini → fail nim → local&rdquo; into &ldquo;straight to local&rdquo;.
      </p>

      <div className="stats-grid mini" style={{ marginBottom: 16 }}>
        <div className="stat-card">
          <span className="stat-icon">📊</span>
          <div className="stat-body">
            <div className="stat-value">{tele.total}</div>
            <div className="stat-label">Telemetry events</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">🎯</span>
          <div className="stat-body">
            <div className="stat-value">{tele.actions.length}</div>
            <div className="stat-label">Actions learning</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">⏱️</span>
          <div className="stat-body">
            <div className="stat-value" style={{ fontSize: 15 }}>{fmtShortTime(tele.updatedAt)}</div>
            <div className="stat-label">Last update</div>
          </div>
        </div>
      </div>

      {tele.actions.map((a) => <ActionTelemetryCard key={a.action} entry={a} />)}

      <div style={{ textAlign: 'center', fontSize: 12, color: '#484f58', marginTop: 12 }}>
        All actions share one health store — a provider killed by any action is skipped by all others
      </div>
    </>
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

// ─── Search Bar ─────────────────────────────────────────────────────────────

function SearchBar({ value, onChange, totalCount }: { value: string; onChange: (v: string) => void; totalCount: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      marginBottom: 14,
    }}>
      <div style={{
        flex: 1, position: 'relative',
        display: 'flex', alignItems: 'center',
        background: '#161b22', borderRadius: 8,
        border: '1px solid #30363d',
        transition: 'border-color 0.2s',
      }}>
        <span style={{
          position: 'absolute', left: 12, fontSize: 14, color: '#6e7681',
          pointerEvents: 'none',
        }}>🔍</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search models by name or provider..."
          style={{
            width: '100%', padding: '10px 12px 10px 36px',
            background: 'transparent', border: 'none',
            color: '#e6edf3', fontSize: 13,
            outline: 'none',
            fontFamily: 'inherit',
          }}
          onFocus={(e) => { e.currentTarget.parentElement!.style.borderColor = '#58a6ff'; }}
          onBlur={(e) => { e.currentTarget.parentElement!.style.borderColor = '#30363d'; }}
        />
        {value && (
          <button
            onClick={() => onChange('')}
            style={{
              background: 'none', border: 'none', color: '#6e7681',
              cursor: 'pointer', padding: '8px 12px', fontSize: 14,
              lineHeight: 1,
            }}
          >✕</button>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#8b949e', whiteSpace: 'nowrap' }}>
        {totalCount} model{totalCount !== 1 ? 's' : ''}
      </div>
    </div>
  );
}

// ─── Column Count Toggle ────────────────────────────────────────────────────

function ColToggle({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 12, color: '#8b949e', marginBottom: 14,
    }}>
      <span>Columns:</span>
      {COL_OPTIONS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          style={{
            padding: '4px 12px', borderRadius: 6,
            background: value === c ? '#1f6feb' : '#21262d',
            color: value === c ? '#fff' : '#8b949e',
            border: `1px solid ${value === c ? '#1f6feb' : '#30363d'}`,
            cursor: 'pointer', fontSize: 12, fontWeight: value === c ? 600 : 400,
            transition: 'all 0.15s',
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

// ─── Model Table ─────────────────────────────────────────────────────────────

function ModelCell({ model, provider }: { model: TestedModel; provider: string }) {
  const s = STATUS_STYLES[model.status];
  const quotaText = model.rateLimitRemaining !== undefined
    ? model.rateLimitTotal
      ? `${model.rateLimitRemaining} / ${model.rateLimitTotal}`
      : `${model.rateLimitRemaining} left`
    : '—';

  return (
    <td style={{ padding: 10, verticalAlign: 'top' }}>
      <div style={{
        background: s.cardBg,
        border: `1px solid ${s.cardBorder}44`,
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        height: '100%',
        transition: 'all 0.2s ease',
        position: 'relative',
        overflow: 'hidden',
        cursor: 'default',
      }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = s.cardBorder;
          e.currentTarget.style.boxShadow = `0 2px 10px ${s.cardBorder}22`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = `${s.cardBorder}44`;
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        {/* Color accent bar on top */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3,
          background: s.cardBorder,
          opacity: 0.6,
        }} />

        {/* Line 1: Model name */}
        <div style={{
          fontSize: 13, fontWeight: 600, color: '#e6edf3',
          fontFamily: "'SFMono-Regular', Consolas, monospace",
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          paddingTop: 2,
        }}>
          {model.name.length > 28 ? model.name.slice(0, 25) + '…' : model.name}
        </div>

        {/* Line 2: Provider */}
        <div style={{ fontSize: 12, color: '#8b949e' }}>
          {getProviderIcon(provider)} {getProviderLabel(provider)}
        </div>

        {/* Line 3: Health status — color box */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          background: s.bg, color: s.text,
          padding: '3px 8px', borderRadius: 6,
          fontSize: 11, fontWeight: 600,
          alignSelf: 'flex-start',
        }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.dot }} />
          {model.status === 'available' ? 'Available' : model.status === 'limited' ? 'Limited' : 'Unavailable'}
        </div>

        {/* Line 4: Token remaining */}
        <div style={{ fontSize: 11, color: '#6e7681' }}>
          <span style={{ color: '#8b949e' }}>Tokens:</span>{' '}
          <span style={{
            color: model.rateLimitRemaining !== undefined && model.rateLimitRemaining <= 10
              ? '#d29922' : '#8b949e',
            fontFamily: "'SFMono-Regular', Consolas, monospace",
            fontWeight: 500,
          }}>
            {quotaText}
          </span>
        </div>

        {/* Extra: reason if limited/unavailable */}
        {model.status !== 'available' && model.statusReason && (
          <div style={{ fontSize: 10, color: '#6e7681', lineHeight: 1.3, marginTop: 2 }}>
            {model.statusReason.length > 45 ? model.statusReason.slice(0, 42) + '…' : model.statusReason}
          </div>
        )}
      </div>
    </td>
  );
}

// ─── Models Table Section ───────────────────────────────────────────────────

function ModelsGrid({ providers, colsPerRow, searchQuery }: {
  providers: ProviderHealth[];
  colsPerRow: number;
  searchQuery: string;
}) {
  // Flatten all models with their provider info
  const allModels: Array<{ model: TestedModel; provider: string }> = [];
  for (const p of providers) {
    for (const m of p.models) {
      allModels.push({ model: m, provider: p.provider });
    }
  }

  if (allModels.length === 0) return null;

  // Filter by search query
  let filtered = allModels;
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    filtered = allModels.filter(({ model, provider }) =>
      model.name.toLowerCase().includes(q) ||
      getProviderLabel(provider).toLowerCase().includes(q) ||
      provider.toLowerCase().includes(q)
    );
  }

  // Sort: available first, then limited, then unavailable
  const statusOrder: Record<ModelStatus, number> = { available: 0, limited: 1, unavailable: 2 };
  filtered.sort((a, b) => statusOrder[a.model.status] - statusOrder[b.model.status]);

  // Build table rows
  const rows: Array<Array<{ model: TestedModel; provider: string }>> = [];
  for (let i = 0; i < filtered.length; i += colsPerRow) {
    rows.push(filtered.slice(i, i + colsPerRow));
  }

  return (
    <>
      <h2 className="section-title" style={{ marginTop: 36 }}>📋 Model Health Overview</h2>
      <p className="section-description">
        All models across all providers, color-coded by health status.
        Each cell shows: Model · Provider · Health · Token Remaining.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 10,
          tableLayout: 'fixed',
        }}>
          <tbody>
            {rows.length > 0 ? (
              rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map(({ model, provider }) => (
                    <ModelCell key={`${provider}-${model.id}`} model={model} provider={provider} />
                  ))}
                  {row.length < colsPerRow && Array.from({ length: colsPerRow - row.length }).map((_, ei) => (
                    <td key={`empty-${ei}`} style={{ padding: 10 }} />
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={colsPerRow} style={{ textAlign: 'center', padding: 40, color: '#6e7681', fontSize: 13 }}>
                  No models match your search "{searchQuery}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {searchQuery.trim() && filtered.length > 0 && (
        <div style={{ textAlign: 'right', fontSize: 11, color: '#6e7681', marginTop: 4 }}>
          Showing {filtered.length} of {allModels.length} models
        </div>
      )}
    </>
  );
}

// ─── Speech Provider Section ───────────────────────────────────────────────

function SpeechProviderSection() {
  return (
    <div style={{
      background: '#161b22', borderRadius: 12,
      border: '1px dashed #30363d',
      padding: '20px 24px',
      marginTop: 24,
      textAlign: 'center' as const,
    }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🎙️</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3', marginBottom: 4 }}>
        Speech / TTS Provider
      </div>
      <div style={{ fontSize: 12, color: '#6e7681' }}>
        Speech/TTS provider support coming soon.
        {' '}<a
          href="https://github.com/imdheerajKube/agent-nuvira/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#58a6ff', textDecoration: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
        >
          Request a provider
        </a>
      </div>
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
        <div style={{ fontWeight: 600, color: '#e6edf3', marginBottom: 6 }}>Provider Sections</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
          <span>✅ <strong>Cloud</strong> — Online providers with active API keys</span>
          <span>🏠 <strong>Local</strong> — Locally running inference servers</span>
          <span>⛔ <strong>Unavailable</strong> — Missing keys or unreachable endpoints</span>
          <span>🎙️ <strong>Speech</strong> — Text-to-speech / speech-to-text providers (coming)</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ModelsPanel() {
  const [modelsData, setModelsData] = useState<ModelsHealthData | null>(null);
  const [registryData, setRegistryData] = useState<ModelRegistryInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [colsPerRow, setColsPerRow] = useState(4);
  const [searchQuery, setSearchQuery] = useState('');
  const mountedRef = useRef(true);

  async function fetchModels() {
    setLoading(true);
    setError(null);
    try {
      const [modelsRes, registryRes] = await Promise.all([
        fetch('/api/models'),
        fetch('/api/model-registry'),
      ]);
      if (!mountedRef.current) return;
      if (!modelsRes.ok) throw new Error(`Model health endpoint failed (HTTP ${modelsRes.status})`);
      const data = await parseJsonOrNull(modelsRes) as ModelsHealthData | null;
      if (!data || !Array.isArray(data.providers)) {
        throw new Error('Model health endpoint returned an unexpected response — is the dashboard server up to date?');
      }
      // Registry/telemetry are OPTIONAL: an older server (or a plain 404) must
      // hide those sections, never break the health grid.
      const registry = await parseJsonOrNull(registryRes) as ModelRegistryInsights | null;
      if (mountedRef.current) {
        setModelsData(data);
        setRegistryData(registry);
      }
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
    const speech: ProviderHealth[] = [];
    const unavailable: ProviderHealth[] = [];

    const availabilityOrder: Record<ModelStatus, number> = { available: 0, limited: 1, unavailable: 2 };

    for (const p of data.providers) {
      if (SPEECH_PROVIDERS.has(p.provider)) {
        speech.push(p);
      } else if (LOCAL_PROVIDERS.has(p.provider)) {
        local.push(p);
      } else if (p.overallStatus === 'available') {
        available.push(p);
      } else {
        unavailable.push(p);
      }
    }

    available.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);
    local.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);
    speech.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);
    unavailable.sort((a, b) => availabilityOrder[a.overallStatus] - availabilityOrder[b.overallStatus]);

    return { available, local, speech, unavailable };
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
            const { available, local, speech, unavailable } = sortProviders(modelsData);

            return (
              <>
                <SectionHeader icon="✅" title="Available Cloud Providers" count={available.length} />
                {available.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}

                <SectionHeader icon="🏠" title="Local Providers" count={local.length} />
                {local.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}

                <SectionHeader icon="⛔" title="Unavailable Providers" count={unavailable.length} />
                {unavailable.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}

                {/* Speech providers (always last) */}
                <SectionHeader icon="🎙️" title="Speech / TTS Providers" count={speech.length} />
                {speech.map((provider) => (
                  <ProviderCard key={provider.provider} provider={provider} />
                ))}
              </>
            );
          })()}

          {/* ── Search + Model Grid ── */}
          <SearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            totalCount={modelsData.providers.reduce((s, p) => s + p.models.length, 0)}
          />
          <ColToggle value={colsPerRow} onChange={setColsPerRow} />

          <ModelsGrid
            providers={modelsData.providers}
            colsPerRow={colsPerRow}
            searchQuery={searchQuery}
          />

          {/* Model Availability Registry — the unified store routing reads */}
          {registryData && <ModelRegistrySection data={registryData} />}

          {/* Learned-from-real-usage telemetry — per-action verified/killed visibility */}
          {registryData && <ActionTelemetrySection registry={registryData} />}

          {/* Older/mismatched server: registry data missing — explain why the
              sections above are absent instead of showing a blank gap. */}
          {modelsData && !registryData && (
            <div style={{
              background: '#161b22', borderRadius: 12, border: '1px dashed #30363d',
              padding: '14px 20px', marginTop: 24, fontSize: 12, color: '#8b949e',
              lineHeight: 1.6,
            }}>
              📦 Registry &amp; telemetry sections are hidden — this dashboard
              server did not return model-registry data (it may be an{' '}
              <strong style={{ color: '#e6edf3' }}>older version</strong>).
              Restart the dashboard from the latest install to see them.
            </div>
          )}

          {/* Speech provider coming-soon placeholder */}
          <SpeechProviderSection />

          <div style={{ textAlign: 'center', fontSize: 12, color: '#484f58', marginTop: 16 }}>
            Last checked: {new Date(modelsData.lastChecked).toLocaleTimeString()}
            {' · '}Auto-refreshes every 60s
          </div>
        </>
      )}
    </>
  );
}
