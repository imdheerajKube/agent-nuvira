import { useState, useEffect, useRef, useCallback } from 'react';
import { parseJsonOrNull } from '../jsonOrNull';
import type { AcceptanceData, ModelsHealthData, ProviderHealth, ModelStatus, TestedModel, ModelRegistryInsights, RegistryModelEntry, ActionTelemetryInsights } from '../types';
import { dashboardAPI } from '../api';
import { formatCount } from '../format';
import { useModelCounts } from '../useModelCounts';
import MetricTiles, { type MetricTile } from './MetricTiles';
import PageHeader from './PageHeader';

// ─── Constants ──────────────────────────────────────────────────────────────

const LOCAL_PROVIDERS = new Set(['local', 'lmstudio', 'vllm']);
/** Future speech/TTS providers — always appear last when implemented */
const SPEECH_PROVIDERS = new Set<string>([]);

const STATUS_STYLES: Record<ModelStatus, { bg: string; text: string; dot: string; cardBorder: string; cardBg: string }> = {
  available: { bg: 'var(--ok-soft)', text: 'var(--accent-green)', dot: 'var(--accent-green)', cardBorder: 'var(--accent-green)', cardBg: 'var(--ok-soft)' },
  limited: { bg: 'var(--warn-soft)', text: 'var(--accent-yellow)', dot: 'var(--accent-yellow)', cardBorder: 'var(--accent-yellow)', cardBg: 'var(--warn-soft)' },
  unavailable: { bg: 'var(--danger-soft)', text: 'var(--accent-red)', dot: 'var(--accent-red)', cardBorder: 'var(--accent-red)', cardBg: 'var(--danger-soft)' },
};

const COL_OPTIONS = [3, 4, 5] as const;

// ─── Resilient fetch helpers ────────────────────────────────────────────────
// The Models page must never die to a single transient network hiccup (browser
// socket-pool contention with the SSE feed, tab throttling, a slow provider
// probe, an IPv4/IPv6 race on `localhost`). Each fetch gets a hard
// AbortController timeout, the two endpoints are fetched INDEPENDENTLY (a
// failure on one must never hide the other), and network-level failures
// auto-retry with backoff before the panel ever shows an error.

/** Hard ceiling for one fetch — the server probes providers with a 5s budget. */
const FETCH_TIMEOUT_MS = 12_000;
/** Backoff before retrying a TRANSIENT (network-level) failure. */
const RETRY_BACKOFF_MS = [300, 700];
/** Healthy auto-refresh cadence. */
const POLL_INTERVAL_MS = 60_000;
/** After a failed load, re-poll this quickly so the panel self-heals. */
const FAILED_REPOLL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isTransientNetworkError(err: unknown): boolean {
  // TypeError("Failed to fetch") or an AbortError (a DOMException in browsers,
  // a plain Error with name 'AbortError' in Node/undici) means the server never
  // answered — a transient hiccup worth retrying. HTTP errors / parse failures
  // are definitive (the server answered) and are NOT retried.
  return err instanceof TypeError
    || (err instanceof Error && err.name === 'AbortError');
}

/**
 * GET /api/models with timeout + retry. Throws after retries are exhausted.
 * `onTransient` fires whenever a network-level (transient) failure occurred,
 * so the caller can trigger a fast self-healing re-poll. Returns the parsed
 * health payload, or throws "unexpected response" if the server answered with
 * something that isn't a health payload (stale server — definitive, no retry).
 */
async function fetchHealthWithRetry(onTransient?: () => void): Promise<ModelsHealthData> {
  let lastStatus: number | null = null;
  let sawTransient = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout('/api/models', FETCH_TIMEOUT_MS);
      if (!res.ok) {
        lastStatus = res.status;
      } else {
        const data = await parseJsonOrNull(res) as ModelsHealthData | null;
        if (data && Array.isArray(data.providers)) return data;
        // Answered, but not a health payload → stale/incompatible dashboard server.
        throw new Error('Model health endpoint returned an unexpected response — is the dashboard server up to date?');
      }
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      sawTransient = true;
      onTransient?.();
    }
    if (attempt >= RETRY_BACKOFF_MS.length) {
      throw new Error(
        sawTransient
          ? 'Dashboard server unreachable — is it still running? Retrying automatically…'
          : `Model health endpoint failed (HTTP ${lastStatus})`,
      );
    }
    await sleep(RETRY_BACKOFF_MS[attempt]);
  }
}

/**
 * GET /api/model-registry, best-effort: null on ANY failure, never throws.
 * Retries a transient network failure once; onTransient lets the caller
 * schedule a fast re-poll so the optional section self-heals quickly too.
 */
async function fetchRegistryBestEffort(onTransient?: () => void): Promise<ModelRegistryInsights | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchWithTimeout('/api/model-registry', FETCH_TIMEOUT_MS);
      if (!res.ok) return null;
      return await parseJsonOrNull(res) as ModelRegistryInsights | null;
    } catch (err) {
      if (!isTransientNetworkError(err) || attempt >= 1) return null;
      onTransient?.();
    }
  }
}

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
          border: '1px solid var(--border)',
          justifyContent: 'center',
          fontSize: 13,
        }}
      >
        {loading ? '⏳ Testing...' : '🔄 Refresh Status'}
      </button>
      <div className="stat-card" style={{ border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', width: '100%' }}>
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
        background: 'var(--bg-primary)', borderRadius: 8, overflow: 'hidden',
        height: 10, display: 'flex', border: '1px solid var(--border-light)',
      }}>
        {available > 0 && <div style={{ width: `${(available / total) * 100}%`, background: 'var(--accent-green)', transition: 'width 0.5s' }} title={`${available} available`} />}
        {limited > 0 && <div style={{ width: `${(limited / total) * 100}%`, background: 'var(--accent-yellow)', transition: 'width 0.5s' }} title={`${limited} limited`} />}
        {unavailable > 0 && <div style={{ width: `${(unavailable / total) * 100}%`, background: 'var(--accent-red)', transition: 'width 0.5s' }} title={`${unavailable} unavailable`} />}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
        <span><span style={{ color: 'var(--accent-green)' }}>●</span> Ready</span>
        <span><span style={{ color: 'var(--accent-yellow)' }}>●</span> Limited</span>
        <span><span style={{ color: 'var(--accent-red)' }}>●</span> Unavailable</span>
      </div>
      {/*
        Reconciliation. The bar above is a LISTING breakdown — it says a provider
        offers these ids, not that the router can use them. Stating both numbers
        together is what stops this section from contradicting both the registry
        card below it and the router's actual behaviour.
      */}
      {typeof data.routable === 'number' && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{total}</strong> listed by providers ·{' '}
          <strong style={{ color: data.routable > 0 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{data.routable}</strong>{' '}
          routable right now (verified, un-parked, not stale)
          {typeof data.registryTotal === 'number' && data.registryTotal > 0 && (
            <>
              {' '}· registry tracks{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{data.registryVerified ?? 0}</strong> of{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{data.registryTotal}</strong> verified
            </>
          )}
        </div>
      )}
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
      background: 'var(--bg-card)', borderRadius: 12,
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
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
              {provider.providerLabel}
            </span>
            <StatusBadge
              status={provider.overallStatus}
              label={getStatusLabel(provider.overallStatus)}
            />
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {provider.models.length} model{provider.models.length !== 1 ? 's' : ''}
            {counts.available > 0 && <span style={{ color: 'var(--accent-green)' }}> · {counts.available} ready</span>}
            {counts.limited > 0 && <span style={{ color: 'var(--accent-yellow)' }}> · {counts.limited} limited</span>}
            {counts.unavailable > 0 && <span style={{ color: 'var(--accent-red)' }}> · {counts.unavailable} unavailable</span>}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right' }}>
          <div style={{ marginBottom: 2, color: provider.apiConfigured ? 'var(--accent-green)' : 'var(--accent-red)' }}>
            {provider.apiConfigured ? '✅ Key set' : '❌ No key'}
          </div>
          <div style={{ color: provider.apiAccessible ? 'var(--accent-green)' : 'var(--accent-red)' }}>
            {provider.apiAccessible ? '✅ Connected' : '❌ Offline'}
          </div>
        </div>
        <span style={{
          color: 'var(--text-secondary)', fontSize: 18,
          transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>▶</span>
      </div>

      {expanded && (
        <>
          <div style={{
            padding: '10px 18px', background: 'var(--bg-primary)', fontSize: 13, color: 'var(--text-secondary)',
            display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
            borderTop: '1px solid var(--border-light)',
          }}>
            <span>{provider.notes}</span>
            {provider.freeTierInfo && (
              <span style={{ color: 'var(--accent-yellow)' }}>🎁 {provider.freeTierInfo}</span>
            )}
          </div>
          <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border-light)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
                  <th style={{ padding: '8px 18px', textAlign: 'left', fontWeight: 500 }}>Model</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Status</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>Quota</th>
                  <th style={{ padding: '8px 18px', textAlign: 'left', fontWeight: 500 }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model, i) => (
                  <tr key={model.id} style={{
                    borderBottom: i < provider.models.length - 1 ? '1px solid var(--border-light)' : 'none',
                    background: model.status === 'unavailable' ? 'var(--bg-primary)' : 'transparent',
                  }}>
                    <td style={{
                      padding: '8px 18px', color: 'var(--text-primary)',
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
                    <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
                      {model.rateLimitRemaining !== undefined
                        ? model.rateLimitTotal
                          ? `${model.rateLimitRemaining}/${model.rateLimitTotal}`
                          : `${model.rateLimitRemaining} left`
                        : '—'}
                    </td>
                    <td style={{ padding: '8px 18px', color: 'var(--text-secondary)', fontSize: 12 }}>
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
  if (status === 'verified') return { text: 'var(--accent-green)', bg: 'var(--ok-soft)', dot: 'var(--accent-green)' };
  if (status === 'unavailable') return { text: 'var(--accent-red)', bg: 'var(--danger-soft)', dot: 'var(--accent-red)' };
  return { text: 'var(--text-secondary)', bg: 'var(--bg-hover)', dot: 'var(--bg-hover)' };
}

/**
 * P4 M4.4 — mid-stream flakiness chip (violet ⏸). Mirrors the CLI's `⏸ flaky
 * N%` chip: this model started streaming then died before finishing, so the
 * router scales its reliability down (capped 40%) and it ranks below
 * otherwise-identical healthy models. `rate` is the 0-1 EMA from the registry.
 */
export function FlakinessChip({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  return (
    <span
      title={`⏸ flaky mid-stream ${pct}% — started streaming, died before finish; the router deprioritizes flaky models (P4 M4.4)`}
      style={{
        marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
        background: 'var(--purple-soft)', border: '1px solid var(--accent-purple)', color: 'var(--accent-purple)',
      }}
    >
      ⏸ flaky {pct}%
    </span>
  );
}

/**
 * v1.60.1/1.60.2 — live context-window chip (⏳). The provider-advertised
 * input window the model probe recorded into the registry (Ollama /api/tags +
 * /api/show fallback, OpenRouter /models, Gemini inputTokenLimit, NIM
 * max_model_len) — the REAL spec the router's context preflight prefers over
 * static estimates. Mirrors the CLI's `⏳ ctx` chip and the Routing Insights
 * preference panel. Renders compact (128K / 1M) with the exact tokens in the
 * tooltip.
 */
export function ContextWindowChip({ tokens }: { tokens: number }) {
  const compact = tokens >= 1_048_576
    ? `${(tokens / 1_048_576).toFixed(1).replace(/\.0$/, '')}M`
    : tokens >= 1024
      ? `${(tokens / 1024).toFixed(0)}K`
      : `${tokens}`;
  return (
    <span
      title={`⏳ context window ${formatCount(tokens)} tokens — live from the provider's model list (v1.60.x); feeds the router's context preflight`}
      style={{
        marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
        background: 'var(--info-soft)', border: '1px solid var(--accent-blue)', color: 'var(--accent-blue)',
      }}
    >
      ⏳ {compact}
    </span>
  );
}

/**
 * P4 M4.4 — flakiness-over-time mini sparkline (violet). Plots the entry's
 * partialRate EMA trajectory: a trend toward 0 = the provider is HEALING via
 * clean successes (each decay point recorded by recordCall); climbing =
 * flakiness accumulating (each partial bump recorded by recordPartial).
 * Renders only when >= 2 samples exist. Tooltip calls out the direction.
 */
export function FlakinessSparkline({ history }: { history?: Array<{ t: number; rate: number }> }) {
  if (!history || history.length < 2) return null;
  const W = 46;
  const H = 14;
  const PAD = 1.5;
  const max = Math.max(0.01, ...history.map((p) => p.rate));
  const pts = history.map((p, i) => {
    const x = PAD + (i / (history.length - 1)) * (W - PAD * 2);
    const y = H - PAD - (p.rate / max) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const first = history[0].rate;
  const last = history[history.length - 1].rate;
  const healing = last < first;
  const pct = Math.round(last * 100);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ marginLeft: 8, verticalAlign: 'middle', cursor: 'default' }}
      aria-label="Flakiness trend"
    >
      <title>
        {healing
          ? `Flakiness healing — ${pct}% now, trending down (clean successes decay the signal)`
          : `Flakiness climbing — ${pct}% now (recent mid-stream interruptions)`}
      </title>
      <polyline points={pts} fill="none" style={{ stroke: 'var(--accent-purple)' }} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
      <circle
        cx={W - PAD}
        cy={H - PAD - (last / max) * (H - PAD * 2)}
        r={2}
        style={{ fill: healing ? 'var(--accent-green)' : 'var(--accent-purple)' }}
      />
    </svg>
  );
}

function RegistryEntryRow({ entry }: { entry: RegistryModelEntry }) {
  const style = registryStatusStyle(entry.status);
  const tokens = entry.remainingTokens >= 0
    ? `${formatCount(entry.remainingTokens)} left`
    : 'unlimited';
  return (
    <tr style={{ borderBottom: '1px solid var(--border-light)' }}>
      <td style={{ padding: '8px 12px', color: 'var(--text-primary)', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: style.dot, marginRight: 8 }} />
        {entry.model.length > 32 ? entry.model.slice(0, 29) + '…' : entry.model}
        {(entry.partialRate ?? 0) > 0 && <FlakinessChip rate={entry.partialRate ?? 0} />}
        {entry.partialHistory && entry.partialHistory.length >= 2 && <FlakinessSparkline history={entry.partialHistory} />}
        {entry.parked && (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8,
            background: 'var(--danger-soft)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)',
          }}>⏸ parked</span>
        )}
        {entry.measuredSamples ? (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
            background: 'var(--ok-soft)', border: '1px solid var(--accent-green)', color: 'var(--accent-green)',
          }}>
            📏 {entry.measuredInputTokens}→{entry.measuredOutputTokens} tok
          </span>
        ) : (
          <span style={{
            marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 8, whiteSpace: 'nowrap',
            background: 'var(--bg-hover)', border: '1px solid var(--border-hover)', color: 'var(--text-secondary)',
          }}>📐 est</span>
        )}
        {entry.contextWindowTokens && <ContextWindowChip tokens={entry.contextWindowTokens} />}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
          background: style.bg, color: style.text, padding: '2px 8px', borderRadius: 6,
        }}>
          {entry.status === 'verified' ? '✓ Verified' : entry.status === 'unavailable' ? '✗ Unavailable' : '◌ Unverified'}
        </span>
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 12, color: entry.remainingTokens >= 0 && entry.remainingTokens <= 100 ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
        {tokens}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
        {entry.resetsInMs > 0 ? fmtDuration(entry.resetsInMs) : '—'}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-secondary)', fontSize: 12, fontFamily: "'SFMono-Regular', Consolas, monospace" }}>
        {entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : '—'}
      </td>
      <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.lastError || (entry.source ? `learned via ${entry.source}` : '')}
      </td>
    </tr>
  );
}

function RegistryCard({ provider }: { provider: ModelRegistryInsights['providers'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = provider.verified > 0 ? 'var(--accent-green)' : provider.unavailable > 0 ? 'var(--accent-red)' : 'var(--border-hover)';

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 12,
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
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>{getProviderLabel(provider.provider)}</span>
            <span style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 10,
              background: provider.parked > 0 ? 'var(--danger-soft)' : 'var(--ok-soft)',
              border: `1px solid ${provider.parked > 0 ? 'var(--accent-red)' : 'var(--accent-green)'}`,
              color: provider.parked > 0 ? 'var(--accent-red)' : 'var(--accent-green)',
            }}>
              {provider.parked > 0 ? `${provider.parked} parked` : 'routable'}
            </span>
            {(provider.flaky ?? 0) > 0 && (
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                background: 'var(--purple-soft)', border: '1px solid var(--accent-purple)', color: 'var(--accent-purple)',
              }}>
                ⏸ {provider.flaky} flaky
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {provider.verified} verified · {provider.unverified} unverified · {provider.unavailable} unavailable
          </div>
        </div>
        <span style={{ color: 'var(--text-secondary)', fontSize: 18, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
      </div>
      {expanded && (
        <div style={{ overflowX: 'auto', borderTop: '1px solid var(--border-light)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-light)', color: 'var(--text-secondary)' }}>
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

// ISSUE-004: providers with consecutive 401/403 auth failures climbing toward
// the auto-clear threshold (3). Warns BEFORE the key is cleared so the user can
// fix it — and confirms the cleanup happened once it's past the threshold.
export function keyHygieneWarning(hygiene?: { threshold: number; consecutive: Record<string, number> }) {
  if (!hygiene) return null;
  const pending = Object.entries(hygiene.consecutive).filter(([, count]) => count > 0);
  if (pending.length === 0) return null;
  return (
    <div style={{
      background: 'color-mix(in srgb, var(--accent-yellow) 8%, transparent)', border: '1px solid var(--accent-yellow)',
      borderRadius: 10, padding: '10px 14px', marginBottom: 14,
      fontSize: 12, color: 'var(--accent-yellow)', display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      <span style={{ fontSize: 15, lineHeight: '18px' }}>🧹</span>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--accent-yellow)', marginBottom: 2 }}>Key hygiene in progress</div>
        <div>
          {pending.map(([provider, count]) => (
            <span key={provider} style={{ display: 'inline-block', marginRight: 12 }}>
              <code style={{ color: 'var(--text-primary)' }}>{provider}</code> {count}/{hygiene.threshold} consecutive auth failures
              {count >= hygiene.threshold ? ' — key auto-cleared 🚫' : ' — key will be auto-cleared at the threshold'}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 4, color: 'var(--accent-yellow)' }}>
          After {hygiene.threshold} consecutive 401/403s the invalid key is removed from config; run{' '}
          <code style={{ color: 'var(--accent-blue)' }}>buff config set providers.&lt;provider&gt;.apiKey &lt;real-key&gt;</code> to re-enable.
        </div>
      </div>
    </div>
  );
}

function ModelRegistrySection({ data }: { data: ModelRegistryInsights }) {
  if (!data.enabled) {
    return (
      <div style={{
        background: 'var(--bg-card)', borderRadius: 12, border: '1px dashed var(--border)',
        padding: '20px 24px', marginTop: 24, textAlign: 'center' as const,
      }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Model Availability Registry
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No registry data yet — run <code style={{ color: 'var(--accent-blue)' }}>buff models refresh</code> or use Auto routing;
          the registry learns from real usage and probes.
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader icon="📦" title="Model Availability Registry" />
      <p className="section-description">
        The unified sub-ms FAISS/JSON snapshot the Auto router consults on every pick:
        verified vs unavailable models plus quota telemetry (tokens remaining, reset
        windows) mirrored from the ledger. Each row's <strong>⏳ chip</strong> is the
        LIVE provider-advertised context window (v1.60.x) — the real spec the router's
        context preflight uses, recorded by the probe from each provider's model list
        (Ollama /api/tags + /api/show, OpenRouter, Gemini, NIM). State changes during a
        session are reported to the watch daemon and recorded here immediately.
      </p>

      <MetricTiles
        tiles={[
          { key: 'tracked-models', icon: '📦', value: String(data.total), label: 'Tracked models (registry)', tone: 'accent' },
          { key: 'verified', icon: '✅', value: String(data.verified), label: 'Verified', tone: 'ok' },
          { key: 'unverified', icon: '◌', value: String(data.unverified), label: 'Unverified', tone: 'accent' },
          { key: 'unavailable', icon: '⛔', value: String(data.unavailable), label: 'Unavailable', tone: 'danger' },
          { key: 'parked', icon: '⏸', value: String(data.parked), label: 'Quota-parked', tone: 'warn' },
          { key: 'flaky', icon: '⏸', value: String(data.flaky ?? 0), label: 'Flaky mid-stream', tone: 'warn' },
          { key: 'deleted-local', icon: '🗑️', value: String(data.deletedLocal ?? 0), label: 'Deleted locally', tone: 'accent' },
        ] satisfies MetricTile[]}
      />

      {keyHygieneWarning(data.keyHygiene)}

      {data.providers.map((provider) => (
        <RegistryCard key={provider.provider} provider={provider} />
      ))}

      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
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

function ModelLearnChip({ provider, model, reason, killed, transient, partial, streamedChunks }: {
  provider: string;
  model: string;
  reason?: string;
  killed?: boolean;
  transient?: boolean;
  /** P4 M4.4 mid-stream interruption — started streaming, died before finish. */
  partial?: boolean;
  /** P4 M4.4: how many chunks streamed before the interruption (tooltip detail). */
  streamedChunks?: number;
}) {
  const isKilled = killed === true;
  const isTransient = transient === true;
  const isPartial = partial === true;
  // Partial gets its own violet signal: distinct from a clean error (transient)
  // because a provider that starts-but-can't-finish is a worse reliability
  // signal — the router deprioritizes flaky mid-stream providers.
  const color = isPartial ? 'var(--accent-purple)' : isTransient ? 'var(--accent-yellow)' : isKilled ? 'var(--accent-red)' : 'var(--accent-green)';
  const bg = isPartial ? 'var(--purple-soft)' : isTransient ? 'var(--warn-soft)' : isKilled ? 'var(--danger-soft)' : 'var(--ok-soft)';
  return (
    <span
      title={isPartial
        ? `Mid-stream interruption — started streaming${typeof streamedChunks === 'number' ? ` ~${streamedChunks} chunks in` : ''}, died before finish (P4 M4.4); router deprioritizes flaky mid-stream providers${reason ? ` · ${reason}` : ''}`
        : isTransient
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
      <span style={{ opacity: 0.85 }}>{isPartial ? '⏸' : isTransient ? '~' : isKilled ? '✗' : '✓'}</span>
      {provider}/{model.length > 30 ? model.slice(0, 27) + '…' : model}
      {(isKilled || isPartial) && reason && (
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
  outcome: 'verified' | 'unavailable' | 'error' | 'partial';
  errorType?: string;
  /** Epoch ms of the event. */
  at: number;
  /** P4 M4.4: chunks streamed before a partial died (chip tooltip detail). */
  streamedChunks?: number;
};

/** One day bucket in the per-action telemetry timeline. */
export type ActionDayBucket = {
  day: number;
  verified: number;
  killed: number;
  transient: number;
  /** Mid-stream partial-interruption events that day (P4 M4.4). */
  partial: number;
  events: ActionDayEvent[];
};

/**
 * One chip per provider × model × outcome for a day (latest event wins),
 * ordered killed → partial → verified → transient so the most actionable
 * learning (predictive skips first, then flaky mid-stream providers) surfaces
 * first.
 */
export function dedupeDayEvents(events: ActionDayEvent[]): ActionDayEvent[] {
  const latest = new Map<string, ActionDayEvent>();
  for (const e of events) latest.set(`${e.provider}|${e.model}|${e.outcome}`, e);
  const priority: Record<ActionDayEvent['outcome'], number> = { unavailable: 0, partial: 1, verified: 2, error: 3 };
  return [...latest.values()].sort((a, b) => priority[a.outcome] - priority[b.outcome] || b.at - a.at);
}

/** Default scrub position: the most recent day with events (else the last day). */
function lastDayWithEvents(timeline: ActionDayBucket[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const b = timeline[i];
    if (b.verified + b.killed + b.transient + (b.partial || 0) > 0) return i;
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

  const max = Math.max(1, ...timeline.map((b) => b.verified + b.killed + b.transient + (b.partial || 0)));
  const dayLabel = (day: number): string =>
    new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const day = timeline[clamped];
  const chips = day ? dedupeDayEvents(day.events || []) : [];

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-light)' }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8,
        textTransform: 'uppercase', letterSpacing: 0.4,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      }}>
        <span>📈 Learned from real usage — last {len} days</span>
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', letterSpacing: 0 }}>
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
            background: 'var(--bg-hover)', border: `1px solid ${playing ? 'var(--accent-red)' : 'var(--border)'}`,
            color: 'var(--text-primary)', padding: '3px 10px', borderRadius: 6,
            cursor: len <= 1 ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
            transition: 'all 0.15s', whiteSpace: 'nowrap',
            opacity: len <= 1 ? 0.5 : 1,
          }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {dayLabel(day.day)} · ✓ {day.verified} · ✗ {day.killed}
          {day.transient > 0 ? ` · ~ ${day.transient}` : ''}
          {day.partial > 0 ? ` · ⏸ ${day.partial}` : ''}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, len - 1)}
          step={1}
          value={clamped}
          onChange={(e) => { setPlaying(false); setDayIdx(Number(e.target.value)); }}
          aria-label="Scrub action timeline"
          style={{ flex: 1, accentColor: 'var(--accent-blue)', cursor: 'pointer', minWidth: 80 }}
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
          const total = b.verified + b.killed + b.transient + (b.partial || 0);
          const hVerified = (b.verified / max) * 56;
          const hKilled = (b.killed / max) * 56;
          const hTransient = (b.transient / max) * 56;
          const hPartial = ((b.partial || 0) / max) * 56;
          const isActive = i === clamped;
          return (
            <div
              key={b.day}
              onClick={() => { setPlaying(false); setDayIdx(i); }}
              title={`${dayLabel(b.day)} — ✓ ${b.verified} verified · ✗ ${b.killed} killed · ~ ${b.transient} transient${(b.partial || 0) > 0 ? ` · ⏸ ${b.partial} partial` : ''}`}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column-reverse',
                alignItems: 'center', gap: 0, cursor: 'pointer',
              }}
            >
              <div style={{
                position: 'relative', width: '100%', borderRadius: 3,
                overflow: isActive ? 'visible' : 'hidden',
                background: total === 0 ? 'var(--bg-hover)' : 'transparent',
                height: total === 0 ? 4 : 56,
                display: 'flex', flexDirection: 'column-reverse',
                boxShadow: isActive ? '0 0 0 1.5px var(--accent-blue)' : undefined,
                opacity: total === 0 ? 0.5 : 1,
                transition: 'box-shadow 0.15s',
              }}>
                {/* Caret — pinned to the ACTIVE bar's own geometry (gap/padding exact) */}
                {isActive && (
                  <div style={{
                    position: 'absolute', top: -3, bottom: -3, width: 2, left: '50%',
                    transform: 'translateX(-50%)',
                    background: 'var(--accent-blue)', borderRadius: 2, pointerEvents: 'none',
                    boxShadow: '0 0 8px color-mix(in srgb, var(--accent-blue) 53%, transparent)', zIndex: 1,
                  }} />
                )}
                {b.verified > 0 && (
                  <div style={{ height: hVerified, background: 'var(--accent-green)', minHeight: 3 }} />
                )}
                {b.killed > 0 && (
                  <div style={{ height: hKilled, background: 'var(--accent-red)', minHeight: 3 }} />
                )}
                {b.transient > 0 && (
                  <div style={{ height: hTransient, background: 'var(--accent-yellow)', minHeight: 3 }} />
                )}
                {b.partial > 0 && (
                  <div style={{ height: hPartial, background: 'var(--accent-purple)', minHeight: 3 }} />
                )}
              </div>
              <div style={{
                fontSize: 9, color: isActive ? 'var(--accent-blue)' : 'var(--text-muted)', marginTop: 4,
                whiteSpace: 'nowrap', fontWeight: isActive ? 700 : 400,
              }}>
                {dayLabel(b.day)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
        <span><span style={{ color: 'var(--accent-green)' }}>■</span> verified</span>
        <span><span style={{ color: 'var(--accent-red)' }}>■</span> killed</span>
        <span><span style={{ color: 'var(--accent-yellow)' }}>■</span> transient</span>
        <span><span style={{ color: 'var(--accent-purple)' }}>■</span> partial</span>
      </div>

      {/* Day detail — the chips for the scrubbed day */}
      <div style={{
        marginTop: 10, background: 'var(--bg-card)', border: '1px solid var(--border-light)',
        borderRadius: 8, padding: '10px 12px',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
          {dayLabel(day.day)}{' '}
          <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
            — what this action learned that day
          </span>
        </div>
        {chips.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No learning recorded that day — nothing verified, killed, or partial.
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
              ) : e.outcome === 'partial' ? (
                <ModelLearnChip
                  key={`${e.provider}|${e.model}|${e.outcome}`}
                  provider={e.provider}
                  model={e.model}
                  reason={e.errorType}
                  partial
                  streamedChunks={e.streamedChunks}
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

export function ActionTelemetryCard({ entry }: { entry: ActionTelemetryInsights['actions'][number] }) {
  const [expanded, setExpanded] = useState(true);
  // Partial mid-stream interruptions are the strongest reliability signal —
  // violet border wins even over killed (a provider that starts-but-can't-
  // finish is worse than one that errors cleanly).
  const borderColor = (entry.partial || 0) > 0 ? 'var(--accent-purple)' : entry.killed > 0 ? 'var(--accent-red)' : entry.verified > 0 ? 'var(--accent-green)' : 'var(--accent-yellow)';

  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 12,
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
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
            {actionLabel(entry.action)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <span><span style={{ color: 'var(--accent-green)' }}>✓ {entry.verified}</span> verified</span>
            <span><span style={{ color: 'var(--accent-red)' }}>✗ {entry.killed}</span> killed</span>
            {entry.transient > 0 && <span><span style={{ color: 'var(--accent-yellow)' }}>~ {entry.transient}</span> transient</span>}
            {(entry.partial || 0) > 0 && <span><span style={{ color: 'var(--accent-purple)' }}>⏸ {entry.partial}</span> partial</span>}
          </div>
        </div>
        <span style={{ color: 'var(--text-secondary)', fontSize: 16, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
      </div>
      {expanded && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-light)', background: 'var(--bg-primary)' }}>
          {entry.killedModels.length > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--accent-red)', marginBottom: 6,
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
                fontSize: 11, fontWeight: 600, color: 'var(--accent-green)', marginBottom: 6,
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
          {(entry.partialModels?.length || 0) > 0 && (
            <>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--accent-purple)', marginBottom: 6,
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>
                ⏸ Partial — mid-stream interruption (flaky provider, deprioritized)
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {entry.partialModels.map((m) => (
                  <ModelLearnChip key={`${m.provider}|${m.model}`} provider={m.provider} model={m.model} reason={m.reason} partial streamedChunks={m.streamedChunks} />
                ))}
              </div>
            </>
          )}
          {entry.killedModels.length === 0 && entry.verifiedModels.length === 0 && (entry.partialModels?.length || 0) === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
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
        background: 'var(--bg-card)', borderRadius: 12, border: '1px dashed var(--border)',
        padding: '18px 24px', marginTop: 24, textAlign: 'center' as const,
      }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🎓</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Learned from real usage — per action
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          No per-action telemetry yet. As you use <strong style={{ color: 'var(--text-secondary)' }}>chat</strong>,{' '}
          <strong style={{ color: 'var(--text-secondary)' }}>execute</strong>, <strong style={{ color: 'var(--text-secondary)' }}>plan</strong>,
          and <strong style={{ color: 'var(--text-secondary)' }}>edit</strong>, each action's verified / killed provider ×
          model combos appear here — showing exactly what routing learned from real usage.
        </div>
      </div>
    );
  }
  // The 4th tile is conditional — it appears only when the log actually holds
  // test-origin records, because the point of the tile is to say how many were
  // excluded, and "0 excluded" would be a claim about a thing that never
  // happened rather than a number worth showing.
  const telemetryTiles: MetricTile[] = [
    { key: 'telemetry-events', icon: '📊', value: String(tele.total), label: 'Telemetry events', tone: 'accent' },
    { key: 'actions-learning', icon: '🎯', value: String(tele.actions.length), label: 'Actions learning', tone: 'accent' },
    { key: 'last-update', icon: '⏱️', value: fmtShortTime(tele.updatedAt), label: 'Last update', tone: 'accent' },
  ];
  if (tele.synthetic > 0) {
    telemetryTiles.push({
      key: 'synthetic',
      icon: '🧪',
      value: String(tele.synthetic),
      label: 'Test-origin, excluded',
      tone: 'warn',
    });
  }

  return (
    <>
      <h2 className="section-subtitle">🎓 Learned from real usage — per action</h2>
      <p className="section-description">
        Every LLM call writes through to the health store with its action tag. This panel shows which
        provider × model each action <span style={{ color: 'var(--accent-green)' }}>verified</span> (routable) or{' '}
        <span style={{ color: 'var(--accent-red)' }}>killed</span> (predictively skipped) — the exact feed that turns
        &ldquo;fail gemini → fail nim → local&rdquo; into &ldquo;straight to local&rdquo;.
      </p>

      {/* Provenance, stated rather than implied. A test suite once wrote real
          records into this log (one fake model was 2,110 of 3,436 lines), so the
          view excludes test-origin records AND says how many it excluded.
          Hiding them silently would be a different way of lying about the data. */}
      <MetricTiles tiles={telemetryTiles} />

      {tele.actions.map((a) => <ActionTelemetryCard key={a.action} entry={a} />)}

      <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
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
      fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
      margin: '24px 0 12px 0', display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span>{icon}</span> {title}
      <span style={{
        fontSize: 12, color: 'var(--text-secondary)', fontWeight: 400,
        background: 'var(--bg-card)', padding: '1px 8px', borderRadius: 8,
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
        background: 'var(--bg-card)', borderRadius: 8,
        border: '1px solid var(--border)',
        transition: 'border-color 0.2s',
      }}>
        <span style={{
          position: 'absolute', left: 12, fontSize: 14, color: 'var(--text-muted)',
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
            color: 'var(--text-primary)', fontSize: 13,
            outline: 'none',
            fontFamily: 'inherit',
          }}
          onFocus={(e) => { e.currentTarget.parentElement!.style.borderColor = 'var(--accent-blue)'; }}
          onBlur={(e) => { e.currentTarget.parentElement!.style.borderColor = 'var(--border)'; }}
        />
        {value && (
          <button
            onClick={() => onChange('')}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', padding: '8px 12px', fontSize: 14,
              lineHeight: 1,
            }}
          >✕</button>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
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
      fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14,
    }}>
      <span>Columns:</span>
      {COL_OPTIONS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          style={{
            padding: '4px 12px', borderRadius: 6,
            background: value === c ? 'var(--accent-blue)' : 'var(--bg-hover)',
            color: value === c ? 'var(--text-on-accent)' : 'var(--text-secondary)',
            border: `1px solid ${value === c ? 'var(--accent-blue)' : 'var(--border)'}`,
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
          fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
          fontFamily: "'SFMono-Regular', Consolas, monospace",
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          paddingTop: 2,
        }}>
          {model.name.length > 28 ? model.name.slice(0, 25) + '…' : model.name}
        </div>

        {/* Line 2: Provider */}
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
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

        {/* The old "Tokens:" line was removed: no value could ever populate it
            here (the probe does not carry a per-model token quota), so it
            rendered a permanent "—" that read as a broken field. */}

        {/* Routable (registry) vs listed (provider). The status box above is a
            PROVIDER-level verdict — identical for every model of that provider —
            so without this line a model the router never picks looks exactly like
            the one it picks for 87% of calls. */}
        {model.routable === false && (
          <div style={{ fontSize: 10, color: 'var(--accent-yellow)', lineHeight: 1.3, marginTop: 2 }}>
            {model.registryStatus === 'unavailable'
              ? model.registryDead
                ? '✗ Not served here — this id does not exist on the endpoint'
                : '✗ Your key cannot use this model (auth / entitlement / access)'
              : model.registryStatus === 'verified'
                ? '◌ Parked or gone stale — not routable now'
                : model.registryStatus === 'unverified'
                  ? '◌ Listed but never verified — the router cannot pick it'
                  : '◌ Not in the registry — never probed'}
          </div>
        )}

        {/* The learned reason, verbatim. Kept in the cell so "cannot use this
            model" is auditable — e.g. a 403 (repairable by the key's owner) reads
            differently from a 404 (the id is simply not served). */}
        {model.routable === false && model.registryError && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3, marginTop: 1 }}>
            {model.registryError.length > 60 ? model.registryError.slice(0, 57) + '…' : model.registryError}
          </div>
        )}

        {/* Cost/entitlement — LABELLED, never used to hide a model. A user who
            just bought credits must still see the models they paid for. */}
        {model.entitlement && model.entitlement.tier !== 'unknown' && (
          <div
            title={model.entitlement.basis}
            style={{
              fontSize: 10,
              lineHeight: 1.3,
              marginTop: 2,
              color: model.entitlement.tier === 'free' ? 'var(--accent-green)' : 'var(--text-secondary)',
            }}
          >
            {model.entitlement.tier === 'free' ? '🎁 free' : '💸 metered'}
          </div>
        )}

        {/* Extra: reason if limited/unavailable */}
        {model.status !== 'available' && model.statusReason && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3, marginTop: 2 }}>
            {model.statusReason.length > 45 ? model.statusReason.slice(0, 42) + '…' : model.statusReason}
          </div>
        )}

        {/* Quota reset time when parked */}
        {model.parked && model.resetsInMs !== undefined && model.resetsInMs > 0 && (
          <div style={{
            fontSize: 10, color: 'var(--accent-yellow)', lineHeight: 1.3, marginTop: 4,
            padding: '3px 6px', borderRadius: 4,
            background: 'var(--warn-soft)', border: '1px solid color-mix(in srgb, var(--accent-yellow) 27%, transparent)',
          }}>
            ⏳ Resets in {fmtDuration(model.resetsInMs)}
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
      <h2 className="section-subtitle">📋 Model Health Overview</h2>
      <p className="section-description">
        All models across all providers, color-coded by health status.
        Each cell shows: Model · Provider · Health.
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
                <td colSpan={colsPerRow} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
                  No models match your search "{searchQuery}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {searchQuery.trim() && filtered.length > 0 && (
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
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
      background: 'var(--bg-card)', borderRadius: 12,
      border: '1px dashed var(--border)',
      padding: '20px 24px',
      marginTop: 24,
      textAlign: 'center' as const,
    }}>
      <div style={{ fontSize: 24, marginBottom: 8 }}>🎙️</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
        Speech / TTS Provider
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Speech/TTS provider support coming soon.
        {' '}<a
          href="https://github.com/imdheerajKube/agent-nuvira-documentation/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent-blue)', textDecoration: 'none', cursor: 'pointer' }}
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
      background: 'var(--bg-primary)', borderRadius: 10, padding: 14, marginBottom: 20,
      border: '1px solid var(--border-light)', fontSize: 13, color: 'var(--text-secondary)',
      display: 'flex', flexWrap: 'wrap', gap: 20,
    }}>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Color Coding</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span><span style={{ color: 'var(--accent-green)' }}>●</span> <strong style={{ color: 'var(--text-primary)' }}>Green</strong> — Working with rate limit available</span>
          <span><span style={{ color: 'var(--accent-yellow)' }}>●</span> <strong style={{ color: 'var(--text-primary)' }}>Amber</strong> — Slow / low rate limit / needs action</span>
          <span><span style={{ color: 'var(--accent-red)' }}>●</span> <strong style={{ color: 'var(--text-primary)' }}>Red</strong> — API key missing / payment needed / unreachable</span>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>Provider Sections</div>
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

/**
 * Bundle 36 — the acceptance record and fit, READ-ONLY, on the Models page: the
 * label sits beside the pair you are already comparing. Same `acceptanceSummary`
 * the Trace tab and the CLI render, so the three cannot disagree. Hidden when the
 * server cannot answer.
 */
function AcceptanceSection() {
  const [data, setData] = useState<AcceptanceData | null>(null);
  useEffect(() => {
    let alive = true;
    dashboardAPI.fetchAcceptance().then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, []);
  if (!data) return null;
  const pairs = Object.entries(data.byPair);
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 12, padding: '14px 18px', marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px 0' }}>
        ⭐ Acceptance (read-only)
      </h2>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {data.labelled} labelled turn{data.labelled === 1 ? '' : 's'} — 👍 {data.accepted} / 👎 {data.rejected}
        {Object.keys(data.bySource).length > 0
          ? ` · by source: ${Object.entries(data.bySource).map(([k, v]) => `${k} ${v}`).join(', ')}`
          : ''}
      </div>
      {pairs.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          {pairs.map(([key, v]) => {
            const n = v.accepted + v.rejected;
            return (
              <div key={key}>
                {key}: 👍 {v.accepted} / 👎 {v.rejected} ({Math.round((100 * v.accepted) / n)}%, n={n})
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 12, color: data.fit.ok ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
        {data.fit.ok
          ? `fit TRAINED — P(accepted | features) n=${data.fit.n} (${data.fit.positives}👍/${data.fit.negatives}👎)`
          : `fit NOT trained — ${data.fit.reason ?? 'insufficient labels'} · rate a turn with \`nuvira rate good|bad\``}
      </div>
    </div>
  );
}

export default function ModelsPanel() {
  const [modelsData, setModelsData] = useState<ModelsHealthData | null>(null);
  const [registryData, setRegistryData] = useState<ModelRegistryInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [colsPerRow, setColsPerRow] = useState(4);
  const [searchQuery, setSearchQuery] = useState('');
  // Shared with Overview and the Timeline so the three tabs agree.
  const modelCounts = useModelCounts();
  const mountedRef = useRef(true);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when the LAST load hit a transient (network-level) failure — used to
  // decide whether a fast self-healing re-poll is warranted. Definitive errors
  // (stale server, persistent HTTP 5xx) fall back to the 60s cadence instead.
  const transientFailureRef = useRef(false);

  function scheduleRepoll() {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      if (mountedRef.current) fetchModels();
    }, FAILED_REPOLL_MS);
  }

  async function fetchModels() {
    setLoading(true);
    setError(null);
    transientFailureRef.current = false;
    try {
      // Health is REQUIRED (throws after retries); registry/telemetry are
      // OPTIONAL — an older server (or a plain 404) must hide those sections,
      // never break the health grid.
      const [data, registry] = await Promise.all([
        fetchHealthWithRetry(() => { transientFailureRef.current = true; }),
        fetchRegistryBestEffort(() => { transientFailureRef.current = true; }),
      ]);
      if (!mountedRef.current) return;
      setModelsData(data);
      setRegistryData(registry);
      // Recovered from a transient blip (or the optional registry flapped) —
      // re-check shortly so the panel settles into the fresh state.
      if (transientFailureRef.current) scheduleRepoll();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error && err.message ? err.message : 'Failed to fetch model status');
      // Self-heal only on TRANSIENT failures: re-poll quickly instead of
      // waiting the full 60s cadence. Definitive errors (stale server, hard
      // HTTP failures) are NOT hammered — they wait for the next poll.
      if (transientFailureRef.current) scheduleRepoll();
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    fetchModels();
    const interval = setInterval(fetchModels, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
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
      <PageHeader
        icon="🧠"
        title="Model Provider Status"
        description="Real-time health check of all AI providers and their available models. Providers are grouped into sections: Available cloud → Local → Unavailable."
      />

      <ActionBar onRefresh={fetchModels} loading={loading} />
      <Legend />

      <AcceptanceSection />

      {loading && !modelsData && (
        <div className="loading-state">
          <div className="loading-spinner" />
          {/* No hardcoded count: the real number is whatever the probe returns
              (currently 18 checks, and it drifts as providers are added), so
              naming one here was a value the panel could not know yet. */}
          <p>Testing provider connections…</p>
        </div>
      )}

      {error && (
        <div className="empty-state" style={{ color: 'var(--accent-red)', border: '1px solid color-mix(in srgb, var(--accent-red) 27%, transparent)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          ⚠️ {error}
        </div>
      )}

      {modelsData && (
        <>
          {/* Summary tiles. The registry pair comes from the SAME endpoint
              Overview and the Timeline read — so all three tabs agree instead
              of each headlining a differently-defined "models" number. */}
          <MetricTiles
            tiles={[
              { key: 'listed-models', icon: '🧠', value: String(modelsData.totalModels), label: 'Listed models (live probe)', tone: 'accent' },
              { key: 'tracked-models', icon: '📦', value: String(modelCounts?.trackedModels ?? registryData?.total ?? 0), label: 'Tracked models (registry)', tone: 'accent' },
              { key: 'available', icon: '✅', value: String(modelsData.available), label: 'Available', tone: 'ok' },
              { key: 'limited', icon: '🟡', value: String(modelsData.limited), label: 'Limited', tone: 'warn' },
              { key: 'unavailable', icon: '🔴', value: String(modelsData.unavailable), label: 'Unavailable', tone: 'danger' },
              { key: 'listed-providers', icon: '🔌', value: String(modelsData.providers.length), label: 'Listed providers (live probe)', tone: 'accent' },
              { key: 'tracked-providers', icon: '🗂️', value: String(modelCounts?.trackedProviders ?? registryData?.providers?.length ?? 0), label: 'Tracked providers (registry)', tone: 'accent' },
            ] satisfies MetricTile[]}
          />

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
              background: 'var(--bg-card)', borderRadius: 12, border: '1px dashed var(--border)',
              padding: '14px 20px', marginTop: 24, fontSize: 12, color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}>
              📦 Registry &amp; telemetry sections are hidden — this dashboard
              server did not return model-registry data (it may be an{' '}
              <strong style={{ color: 'var(--text-primary)' }}>older version</strong>).
              Restart the dashboard from the latest install to see them.
            </div>
          )}

          {/* Speech provider coming-soon placeholder */}
          <SpeechProviderSection />

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', marginTop: 16 }}>
            Last checked: {new Date(modelsData.lastChecked).toLocaleTimeString()}
            {' · '}Auto-refreshes every 60s
          </div>
        </>
      )}
    </>
  );
}
