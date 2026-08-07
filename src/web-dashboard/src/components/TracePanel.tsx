import { useEffect, useState, useCallback } from 'react';
import { dashboardAPI } from '../api';
import type { TraceEntry, TraceStep } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, string> = {
  local: '💻', groq: '🟢', nim: '🔶', gemini: '🔷', openrouter: '🟣',
};

const AGENT_ICONS: Record<string, string> = {
  planner: '🗺️', writer: '✍️', reviewer: '🔎', tester: '🧪', debugger: '🐛',
  runner: '🏃', 'context-gatherer': '📂', memory: '🧠', 'self-improver': '📈',
};

function providerIcon(provider: string): string {
  return PROVIDER_ICONS[provider] || '🔌';
}

function agentIcon(agent: string): string {
  return AGENT_ICONS[agent] || '🤖';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${new Date(ts).toLocaleDateString()}`;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SectionCard({ icon, title, subtitle, children }: {
  icon: string; title: string; subtitle?: string; children: React.ReactNode;
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

function EmptyNote() {
  return (
    <div style={{
      background: '#0d1117', border: '1px dashed #30363d', borderRadius: 10,
      padding: '18px 20px', color: '#8b949e', fontSize: 13, textAlign: 'center',
    }}>
      🔍 No reasoning traces yet — every LLM call in a <code style={{ color: '#58a6ff' }}>buff execute</code> pipeline
      is recorded to <code style={{ color: '#58a6ff' }}>reasoning-traces.json</code>. Run a pipeline, then replay
      it here or with <code style={{ color: '#58a6ff' }}>buff trace replay &lt;id&gt;</code>.
    </div>
  );
}

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const statusColor = step.success ? '#3fb950' : '#f85149';
  const statusLabel = step.success ? 'ok' : 'failed';

  return (
    <div style={{
      background: '#0d1117', border: '1px solid #21262d', borderRadius: 8,
      marginBottom: 8, overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          padding: '10px 14px', textAlign: 'left', display: 'flex',
          alignItems: 'center', gap: 10, color: 'inherit',
        }}
      >
        <span style={{ width: 26, fontSize: 16 }}>{agentIcon(step.agentType)}</span>
        <span style={{
          width: 130, fontSize: 12, fontWeight: 600, color: '#e6edf3',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={step.agentType}>
          {step.agentType}
        </span>
        <span style={{
          flex: 1, fontSize: 12, color: '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace",
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={`${step.provider}/${step.model}`}>
          {providerIcon(step.provider)} {step.provider}/{step.model}
        </span>
        <span style={{ width: 70, fontSize: 11, color: '#6e7681', textAlign: 'right' }}>
          {fmtDuration(step.latencyMs)}
        </span>
        <span style={{
          width: 86, fontSize: 11, color: '#6e7681', fontFamily: "'SFMono-Regular', Consolas, monospace", textAlign: 'right',
        }}>
          {fmtTokens(step.inputTokens)}→{fmtTokens(step.outputTokens)} tok
        </span>
        <span style={{ width: 46, fontSize: 11, color: statusColor, textAlign: 'right' }}>
          {statusLabel}
        </span>
        <span style={{ width: 22, fontSize: 11, textAlign: 'right' }}>
          {step.escalated ? <span title="Repair escalated to a stronger routed model (v1.60.4)">🚀</span> : ''}
        </span>
        <span style={{ fontSize: 11, color: '#6e7681' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px 50px', fontSize: 12 }}>
          {step.taskId && (
            <div style={{ color: '#6e7681', marginBottom: 4 }}>
              Task: <span style={{ color: '#8b949e', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{step.taskId}</span>
            </div>
          )}
          {step.description && (
            <div style={{ color: '#8b949e', marginBottom: 6 }}>{step.description}</div>
          )}
          {step.routing && (
            <div style={{ marginBottom: 6 }}>
              <span style={{
                fontSize: 10, padding: '1px 8px', borderRadius: 10,
                background: step.escalated ? '#3d2c00' : '#1c2128',
                border: step.escalated ? '1px solid #d29922' : '1px solid #58a6ff',
                color: step.escalated ? '#d29922' : '#58a6ff',
              }}>
                {step.escalated ? '🚀 escalated auto → ' : '🤖 auto → '}{step.routing.provider}/{step.routing.model} · score {step.routing.score.toFixed(3)} · {step.routing.complexity}
              </span>
              {step.escalated && (
                <div style={{ color: '#d29922', marginTop: 4, fontSize: 11 }}>
                  Repair escalated to a stronger routed model (next complexity level).
                </div>
              )}
              {step.routing.explanation && (
                <div style={{ color: '#6e7681', marginTop: 4, fontSize: 11 }}>
                  {step.routing.explanation}
                </div>
              )}
            </div>
          )}
          {step.error && (
            <div style={{ color: '#f85149', marginBottom: 6 }}>⚠️ {step.error.slice(0, 300)}</div>
          )}
          <div style={{ color: '#6e7681', margin: '6px 0 3px 0' }}>
            Prompt <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace" }}>#{step.promptDigest}</span> · {step.promptPreview.length}+ chars:
          </div>
          <pre style={{
            background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
            padding: 8, margin: 0, color: '#8b949e', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto',
            fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11,
          }}>
            {step.promptPreview.slice(0, 900)}
          </pre>
          <div style={{ color: '#6e7681', margin: '8px 0 3px 0' }}>
            Response ({fmtTokens(step.responseLength)} chars):
          </div>
          <pre style={{
            background: '#161b22', border: '1px solid #21262d', borderRadius: 6,
            padding: 8, margin: 0, color: '#c9d1d9', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto',
            fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11,
          }}>
            {step.responsePreview.slice(0, 1200)}
          </pre>
        </div>
      )}
    </div>
  );
}

function TraceDetail({ trace }: { trace: TraceEntry }) {
  const [steps, setSteps] = useState<TraceStep[] | null>(trace.steps ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (trace.steps) {
      setSteps(trace.steps);
      return;
    }
    let cancelled = false;
    dashboardAPI.fetchTraceDetail(trace.id).then((detail) => {
      if (cancelled) return;
      if (detail?.steps) setSteps(detail.steps);
      else setError(true);
    });
    return () => { cancelled = true; };
  }, [trace.id, trace.steps]);

  const statusIcon = trace.success === true ? '✅' : trace.success === false ? '❌' : '⏳';
  const statusLabel = trace.success === true ? 'success' : trace.success === false ? 'failed' : 'in progress';

  return (
    <SectionCard
      icon={statusIcon}
      title={`${trace.id} — ${statusLabel}`}
      subtitle={trace.goal}
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: '#0d1117', border: '1px solid #30363d', color: '#8b949e' }}>
          🕓 {timeAgo(trace.startedAt)}
        </span>
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: '#0d1117', border: '1px solid #30363d', color: '#8b949e' }}>
          ⏱ {fmtDuration(trace.durationMs)}
        </span>
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: '#0d1117', border: '1px solid #30363d', color: '#8b949e' }}>
          🔢 {steps?.length ?? '?'} call(s)
        </span>
        {steps && steps.some((s) => s.escalated) && (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: '#3d2c00', border: '1px solid #d29922', color: '#d29922' }}>
            🚀 {steps.filter((s) => s.escalated).length} escalated repair(s)
          </span>
        )}
        {trace.totalTokens !== undefined && (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: '#0d1117', border: '1px solid #30363d', color: '#8b949e' }}>
            🧮 {fmtTokens(trace.totalTokens)} tok
          </span>
        )}
      </div>

      {error && (
        <div style={{ color: '#f85149', fontSize: 12, marginBottom: 10 }}>
          Could not load trace steps (trace may have been deleted).
        </div>
      )}
      {steps === null && !error && (
        <div style={{ color: '#8b949e', fontSize: 12 }}>Loading steps…</div>
      )}
      {steps && steps.length === 0 && (
        <div style={{ color: '#8b949e', fontSize: 12 }}>No LLM calls recorded in this trace.</div>
      )}
      {steps && steps.map((step) => <StepRow key={step.seq} step={step} />)}
    </SectionCard>
  );
}

function TraceList({ traces }: { traces: TraceEntry[] }) {
  const [selected, setSelected] = useState<TraceEntry | null>(null);

  if (selected) {
    return (
      <>
        <button
          onClick={() => setSelected(null)}
          style={{
            background: '#21262d', border: '1px solid #30363d', color: '#e6edf3',
            borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          ← Back to traces
        </button>
        <TraceDetail trace={selected} />
      </>
    );
  }

  return (
    <div>
      {traces.map((trace) => {
        const icon = trace.success === true ? '✅' : trace.success === false ? '❌' : '⏳';
        const agents = trace.steps ? [...new Set(trace.steps.map((s) => s.agentType))].join(', ') : '';
        return (
          <button
            key={trace.id}
            onClick={() => setSelected(trace)}
            style={{
              width: '100%', background: '#0d1117', border: '1px solid #21262d',
              borderRadius: 10, padding: '12px 16px', marginBottom: 8,
              cursor: 'pointer', textAlign: 'left', color: 'inherit',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#58a6ff';
              e.currentTarget.style.boxShadow = '0 2px 10px #58a6ff22';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#21262d';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span>{icon}</span>
              <span style={{
                fontSize: 11, color: '#58a6ff', fontFamily: "'SFMono-Regular', Consolas, monospace",
              }}>
                {trace.id}
              </span>
              <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 'auto' }}>
                {timeAgo(trace.startedAt)}
              </span>
            </div>
            <div style={{ fontSize: 13, color: '#e6edf3', marginBottom: 6 }}>{trace.goal}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: '#8b949e' }}>
              <span>🔢 {trace.stepCount ?? 0} call(s)</span>
              <span>⏱ {fmtDuration(trace.durationMs)}</span>
              {trace.failedSteps ? <span style={{ color: '#f85149' }}>❌ {trace.failedSteps} failed</span> : <span style={{ color: '#3fb950' }}>✓ all ok</span>}
              {trace.totalTokens !== undefined && <span>🧮 {fmtTokens(trace.totalTokens)} tok</span>}
              {agents && <span>🤖 {agents.slice(0, 60)}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default function TracePanel() {
  const [traces, setTraces] = useState<TraceEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(() => {
    dashboardAPI.fetchTraces().then((t) => {
      if (t) {
        setTraces(t);
        setLoadError(false);
      } else {
        // Server unreachable or empty payload — surface a clear error state
        // instead of showing the spinner forever.
        setLoadError(true);
      }
    });
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="panel">
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: '#e6edf3' }}>
          🔍 Reasoning Traces
        </h2>
        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#8b949e' }}>
          Every LLM call in each pipeline — agent × model × prompt digest × response × tokens × latency × routing snapshot (assessment P0).
        </p>
      </div>

      {traces === null && !loadError && (
        <SectionCard icon="⏳" title="Loading…">
          <div style={{ color: '#8b949e', fontSize: 13 }}>Fetching reasoning traces…</div>
        </SectionCard>
      )}
      {loadError && traces === null && (
        <SectionCard icon="⚠️" title="Could not reach the dashboard server">
          <div style={{ color: '#8b949e', fontSize: 13 }}>
            The traces endpoint is unavailable right now — retrying automatically. Run{' '}
            <code style={{ color: '#58a6ff' }}>buff trace list</code> in the terminal to inspect traces directly.
          </div>
        </SectionCard>
      )}
      {traces !== null && traces.length === 0 && <EmptyNote />}
      {traces !== null && traces.length > 0 && <TraceList traces={traces} />}
    </div>
  );
}
