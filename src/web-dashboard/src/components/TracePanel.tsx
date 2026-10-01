import { useEffect, useState, useCallback } from 'react';
import { dashboardAPI } from '../api';
import type { TraceEntry, TraceFinding, TraceStep } from '../types';
import PageHeader from './PageHeader';

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

/**
 * The honest-action badge. `success` only means "a reply was generated"; this
 * says whether the reply actually DID anything — so a hallucinated
 * "I have sent it" is visibly flagged instead of looking like a delivery.
 */
function outcomeBadge(outcome: TraceEntry['outcome']): { text: string; color: string; bg: string; border: string } | null {
  if (!outcome) return null;
  const base = { bg: 'var(--bg-primary)', border: 'var(--border)' };
  if (outcome.unverifiedClaim) {
    return { text: '⚠️ unverified claim — said it acted, but no tool ran', color: 'var(--accent-yellow)', bg: 'var(--warn-soft)', border: 'var(--accent-yellow)' };
  }
  if (outcome.unfulfilledPromise) {
    return { text: '⚠️ unfulfilled promise — announced an action it never performed', color: 'var(--accent-yellow)', bg: 'var(--warn-soft)', border: 'var(--accent-yellow)' };
  }
  // G1 + G2 — edit honesty. A claimed fix that nothing verified outranks the
  // generic "acted" badge: `success` only means a reply was generated, and a
  // botched edit_file is not evidence the change works.
  if (outcome.unverifiedEditClaim) {
    return {
      text: '⚠️ unverified edit claim — asserted a fix, but nothing verified it',
      color: 'var(--accent-yellow)', bg: 'var(--warn-soft)', border: 'var(--accent-yellow)',
    };
  }
  if (outcome.unverifiedEdit) {
    return {
      text: `⚠️ unverified edit — ${outcome.tools?.length ?? 0} tool(s), no test/typecheck/browser run`,
      color: 'var(--accent-yellow)', bg: 'var(--warn-soft)', border: 'var(--accent-yellow)',
    };
  }
  if (outcome.kind === 'acted') {
    return {
      text: outcome.delivered ? '✅ action performed — message sent' : `🔧 acted — ${outcome.tools?.length ?? 0} tool(s)`,
      color: 'var(--accent-green)', bg: 'var(--ok-soft)', border: 'var(--accent-green)',
    };
  }
  if (outcome.kind === 'answered') return { text: '💬 answered — no action taken', color: 'var(--text-secondary)', ...base };
  if (outcome.kind === 'cancelled') return { text: '⏹ cancelled', color: 'var(--text-secondary)', ...base };
  return { text: '❌ generation failed', color: 'var(--accent-red)', bg: 'var(--danger-soft)', border: 'var(--accent-red)' };
}

/**
 * WS1 (#23) — how many of a run's findings were actually CONFIRMED.
 *
 * The split is computed here rather than trusted from a count field for the same
 * reason `summarizeVerdicts` exists: "4 findings" reads as four facts, while
 * "4 findings (1 confirmed, 3 plausible)" cannot. A CONFIRMED verdict with no
 * usable evidence is counted as PLAUSIBLE — the gate forbids it, and a renderer
 * must not be the place the rule gets relaxed.
 */
function findingsSummary(findings: TraceFinding[]): string {
  const confirmed = findings.filter((f) => f.verdict === 'CONFIRMED' && findingEvidence(f).length > 0).length;
  return `${findings.length} finding${findings.length === 1 ? '' : 's'}: ${confirmed} confirmed, ${findings.length - confirmed} plausible`;
}

/** The checks behind a finding — a blank `ref` is not a check (see verdicts.ts). */
function findingEvidence(finding: TraceFinding): NonNullable<TraceFinding['evidence']> {
  return (finding.evidence ?? []).filter((e) => typeof e?.ref === 'string' && e.ref.trim().length > 0);
}

/** One recorded finding: the claim, the gate's verdict, and the evidence behind it. */
function FindingRow({ finding }: { finding: TraceFinding }) {
  const evidence = findingEvidence(finding);
  const confirmed = finding.verdict === 'CONFIRMED' && evidence.length > 0;
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px solid var(--border-light)',
      borderLeft: `3px solid ${confirmed ? 'var(--accent-green)' : 'var(--accent-yellow)'}`,
      borderRadius: 8, padding: '8px 12px', marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13 }}>{confirmed ? '✅' : '🔎'}</span>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{finding.claim}</span>
        <span style={{
          fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', padding: '1px 7px',
          borderRadius: 10, border: '1px solid',
          color: confirmed ? 'var(--accent-green)' : 'var(--accent-yellow)',
          background: confirmed ? 'var(--ok-soft)' : 'var(--warn-soft)',
          borderColor: confirmed ? 'var(--accent-green)' : 'var(--accent-yellow)',
        }}>
          {confirmed ? 'CONFIRMED' : 'PLAUSIBLE'}
        </span>
      </div>
      {finding.outcome ? (
        <div style={{ marginTop: 3, fontSize: 11.5, color: 'var(--text-secondary)' }}>{finding.outcome}</div>
      ) : null}
      {evidence.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: '5px 0 0', padding: 0 }}>
          {evidence.map((e, i) => (
            <li key={i} style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3 }}>
              <span style={{
                fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.04em',
                color: 'var(--accent-blue)', marginRight: 5,
              }}>
                {e.kind}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{e.ref}</span>
              {e.detail ? <span style={{ marginLeft: 5 }}>({e.detail})</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div style={{ marginTop: 5, fontSize: 11, color: 'var(--accent-yellow)' }}>
          no evidence — reported as PLAUSIBLE, not verified
        </div>
      )}
      {finding.source ? (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>source: {finding.source}</div>
      ) : null}
    </div>
  );
}

function SectionCard({ icon, title, subtitle, children }: {
  icon: string; title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', borderRadius: 12,
      border: '1px solid var(--border-light)', padding: '18px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        {/* h2: a SectionCard IS a section of the page, whose title is the h1. */}
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{title}</h2>
      </div>
      {subtitle && <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '2px 0 12px 0' }}>{subtitle}</p>}
      {!subtitle && <div style={{ height: 6 }} />}
      {children}
    </div>
  );
}

function EmptyNote() {
  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px dashed var(--border)', borderRadius: 10,
      padding: '18px 20px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center',
    }}>
      🔍 No reasoning traces yet — every LLM call in a <code style={{ color: 'var(--accent-blue)' }}>buff execute</code> pipeline
      is recorded to <code style={{ color: 'var(--accent-blue)' }}>reasoning-traces.json</code>. Run a pipeline, then replay
      it here or with <code style={{ color: 'var(--accent-blue)' }}>buff trace replay &lt;id&gt;</code>.
    </div>
  );
}

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const statusColor = step.success ? 'var(--accent-green)' : 'var(--accent-red)';
  const statusLabel = step.success ? 'ok' : 'failed';

  return (
    <div style={{
      background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 8,
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
          width: 130, fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={step.agentType}>
          {step.agentType}
        </span>
        <span style={{
          flex: 1, fontSize: 12, color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace",
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }} title={`${step.provider}/${step.model}`}>
          {providerIcon(step.provider)} {step.provider}/{step.model}
        </span>
        <span style={{ width: 70, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
          {fmtDuration(step.latencyMs)}
        </span>
        <span style={{
          width: 86, fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SFMono-Regular', Consolas, monospace", textAlign: 'right',
        }}>
          {fmtTokens(step.inputTokens)}→{fmtTokens(step.outputTokens)} tok
        </span>
        <span style={{ width: 46, fontSize: 11, color: statusColor, textAlign: 'right' }}>
          {statusLabel}
        </span>
        <span style={{ width: 22, fontSize: 11, textAlign: 'right' }}>
          {step.escalated ? <span title="Repair escalated to a stronger routed model (v1.60.4)">🚀</span> : ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px 50px', fontSize: 12 }}>
          {step.taskId && (
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
              Task: <span style={{ color: 'var(--text-secondary)', fontFamily: "'SFMono-Regular', Consolas, monospace" }}>{step.taskId}</span>
            </div>
          )}
          {step.description && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>{step.description}</div>
          )}
          {step.routing && (
            <div style={{ marginBottom: 6 }}>
              <span style={{
                fontSize: 10, padding: '1px 8px', borderRadius: 10,
                background: step.escalated ? 'var(--warn-soft)' : 'var(--bg-tertiary)',
                border: step.escalated ? '1px solid var(--accent-yellow)' : '1px solid var(--accent-blue)',
                color: step.escalated ? 'var(--accent-yellow)' : 'var(--accent-blue)',
              }}>
                {step.escalated ? '🚀 escalated auto → ' : '🤖 auto → '}{step.routing.provider}/{step.routing.model} · score {step.routing.score.toFixed(3)} · {step.routing.complexity}
              </span>
              {step.escalated && (
                <div style={{ color: 'var(--accent-yellow)', marginTop: 4, fontSize: 11 }}>
                  Repair escalated to a stronger routed model (next complexity level).
                </div>
              )}
              {step.routing.explanation && (
                <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: 11 }}>
                  {step.routing.explanation}
                </div>
              )}
            </div>
          )}
          {step.layers && (
            <div style={{
              marginBottom: 6, fontSize: 11, color: 'var(--text-muted)',
              fontFamily: "'SFMono-Regular', Consolas, monospace",
            }}>
              <span style={{ color: 'var(--accent-blue)' }}>sys</span> {step.layers.systemChars}c/#{step.layers.systemDigest} ·{' '}
              <span style={{ color: 'var(--accent-green)' }}>ctx</span> {step.layers.contextChars}c/#{step.layers.contextDigest} ·{' '}
              <span style={{ color: 'var(--accent-yellow)' }}>vol</span> {step.layers.volatileChars}c/#{step.layers.volatileDigest}
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                a constant <span style={{ color: 'var(--accent-blue)' }}>sys</span> digest across steps ⇒ the stable layer is prompt-cacheable
              </div>
            </div>
          )}
          {step.error && (
            <div style={{ color: 'var(--accent-red)', marginBottom: 6 }}>⚠️ {step.error.slice(0, 300)}</div>
          )}
          <div style={{ color: 'var(--text-muted)', margin: '6px 0 3px 0' }}>
            Prompt <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace" }}>#{step.promptDigest}</span> · {step.promptPreview.length}+ chars:
          </div>
          <pre style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6,
            padding: 8, margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto',
            fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11,
          }}>
            {step.promptPreview.slice(0, 900)}
          </pre>
          <div style={{ color: 'var(--text-muted)', margin: '8px 0 3px 0' }}>
            Response ({fmtTokens(step.responseLength)} chars):
          </div>
          <pre style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6,
            padding: 8, margin: 0, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
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
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          🕓 {timeAgo(trace.startedAt)}
        </span>
        {(() => {
          const b = outcomeBadge(trace.outcome);
          if (!b) return null;
          return (
            <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: b.bg, border: `1px solid ${b.border}`, color: b.color }}>
              {b.text}
            </span>
          );
        })()}
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          ⏱ {fmtDuration(trace.durationMs)}
        </span>
        <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          🔢 {steps?.length ?? '?'} call(s)
        </span>
        {steps && steps.some((s) => s.escalated) && (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--warn-soft)', border: '1px solid var(--accent-yellow)', color: 'var(--accent-yellow)' }}>
            🚀 {steps.filter((s) => s.escalated).length} escalated repair(s)
          </span>
        )}
        {trace.totalTokens !== undefined && (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            🧮 {fmtTokens(trace.totalTokens)} tok
          </span>
        )}
        {trace.findings && trace.findings.length > 0 && (
          <span style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
            {`🔎 ${findingsSummary(trace.findings)}`}
          </span>
        )}
      </div>

      {/* WS1 (#23) — the run's recorded findings, above the steps: a verdict is
          the FIRST thing a reader wants, and burying it under a dozen LLM calls
          would let a CONFIRMED claim and a PLAUSIBLE guess read the same. */}
      {trace.findings && trace.findings.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {`🔎 Findings — ${findingsSummary(trace.findings)}`}
          </div>
          {trace.findings.map((finding, i) => (
            <FindingRow key={`finding-${i}`} finding={finding} />
          ))}
        </div>
      ) : null}

      {trace.systemPrompt && (
        <details style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent-blue)' }}>
            🧬 System prompt — stable layer ({trace.systemPromptChars ?? trace.systemPrompt.length} chars)
          </summary>
          <pre style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: 6,
            padding: 10, margin: '8px 0 0 0', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
            fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11,
          }}>
            {trace.systemPrompt}
          </pre>
        </details>
      )}

      {error && (
        <div style={{ color: 'var(--accent-red)', fontSize: 12, marginBottom: 10 }}>
          Could not load trace steps (trace may have been deleted).
        </div>
      )}
      {steps === null && !error && (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Loading steps…</div>
      )}
      {steps && steps.length === 0 && (
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No LLM calls recorded in this trace.</div>
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
            background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-primary)',
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
              width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-light)',
              borderRadius: 10, padding: '12px 16px', marginBottom: 8,
              cursor: 'pointer', textAlign: 'left', color: 'inherit',
              transition: 'border-color 0.2s, box-shadow 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-blue)';
              e.currentTarget.style.boxShadow = '0 2px 10px color-mix(in srgb, var(--accent-blue) 13%, transparent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-light)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span>{icon}</span>
              <span style={{
                fontSize: 11, color: 'var(--accent-blue)', fontFamily: "'SFMono-Regular', Consolas, monospace",
              }}>
                {trace.id}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {timeAgo(trace.startedAt)}
              </span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 6 }}>{trace.goal}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
              <span>🔢 {trace.stepCount ?? 0} call(s)</span>
              <span>⏱ {fmtDuration(trace.durationMs)}</span>
              {trace.failedSteps ? <span style={{ color: 'var(--accent-red)' }}>❌ {trace.failedSteps} failed</span> : <span style={{ color: 'var(--accent-green)' }}>✓ all ok</span>}
              {trace.totalTokens !== undefined && <span>🧮 {fmtTokens(trace.totalTokens)} tok</span>}
              {trace.findings && trace.findings.length > 0 && (
                <span style={{ color: 'var(--accent-yellow)' }}>
                  {`🔎 ${trace.findings.filter((f) => f.verdict === 'CONFIRMED' && findingEvidence(f).length > 0).length}/${trace.findings.length} confirmed`}
                </span>
              )}
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
      <PageHeader
        icon="🔍"
        title="Reasoning Traces"
        description="Every LLM call in each pipeline — agent × model × prompt digest × response × tokens × latency × routing snapshot (assessment P0)."
      />

      {traces === null && !loadError && (
        <SectionCard icon="⏳" title="Loading…">
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Fetching reasoning traces…</div>
        </SectionCard>
      )}
      {loadError && traces === null && (
        <SectionCard icon="⚠️" title="Could not reach the dashboard server">
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            The traces endpoint is unavailable right now — retrying automatically. Run{' '}
            <code style={{ color: 'var(--accent-blue)' }}>buff trace list</code> in the terminal to inspect traces directly.
          </div>
        </SectionCard>
      )}
      {traces !== null && traces.length === 0 && <EmptyNote />}
      {traces !== null && traces.length > 0 && <TraceList traces={traces} />}
    </div>
  );
}
