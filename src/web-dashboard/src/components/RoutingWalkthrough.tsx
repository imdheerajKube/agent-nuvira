/**
 * RoutingWalkthrough — "Why did the router pick this?"
 *
 * A narrated, step-by-step playback of a single routing decision, inspired by
 * llm-viz's guided walkthrough. Replays a decision in 4 steps:
 *
 *   1. 🎯 Request   — the task, its complexity, and who asked
 *   2. ⚖️ Candidates — every provider the router scored, with score + reason
 *   3. 🚫 Exclusions — providers the router skipped, and why
 *   4. ✅ Pick      — the winner, its score, and the reason it won
 *
 * Decisions come from two sources:
 *   - Real decisions from `routing.history` (the audit trail) — what actually
 *     happened in live chat / orchestrator / explain / benchmark / eval runs.
 *   - Complexity profiles from `routing.preference` — what the router WOULD
 *     pick right now for each complexity, when no real history exists yet.
 *
 * The playback is scrubbable (Prev/Next + step dots) and can auto-play.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { RoutingHistoryEntry, RoutingInsights } from '../types';

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

const COMPLEXITY_LABELS: Record<string, string> = {
  trivial: '🟢 trivial', simple: '🔵 simple', moderate: '🟡 moderate',
  complex: '🟠 complex', critical: '🔴 critical',
};

const SOURCE_LABELS: Record<string, string> = {
  chat: '💬 chat', orchestrator: '🔀 orchestrator', explain: '🔍 explain',
  benchmark: '📈 benchmark', eval: '🎯 eval',
};

const STEP_ORDER = [
  { key: 'request', icon: '🎯', title: 'Request' },
  { key: 'candidates', icon: '⚖️', title: 'Candidates' },
  { key: 'exclusions', icon: '🚫', title: 'Exclusions' },
  { key: 'pick', icon: '✅', title: 'Pick' },
] as const;

type StepKey = typeof STEP_ORDER[number]['key'];

/** Auto-play advance interval (ms per step). */
const PLAY_STEP_MS = 2400;

function providerIcon(provider: string): string {
  return PROVIDER_ICONS[provider] || '🔌';
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] || provider;
}

function sourceLabel(source?: string): string {
  return (source && SOURCE_LABELS[source]) || source || 'unknown';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtCooldown(ms: number): string {
  const mins = Math.ceil(ms / 60_000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

// ─── Decision model ─────────────────────────────────────────────────────────

export interface WalkthroughCandidate {
  provider: string;
  score: number;
  reason?: string;
}

export interface WalkthroughExclusion {
  provider: string;
  reason: string;
}

export interface WalkthroughDecision {
  id: string;
  /** Short selector label */
  label: string;
  /** True = a real recorded decision, false = a complexity profile preview */
  real: boolean;
  complexity: string;
  task: string;
  agentType: string;
  source?: string;
  timestamp?: number;
  /** Winner as "provider/model" */
  winner: string;
  winnerScore: number;
  winnerReason?: string;
  candidates: WalkthroughCandidate[];
  exclusions: WalkthroughExclusion[];
}

/** Cap on how many real decisions we replay (most recent first). */
const MAX_REAL_DECISIONS = 8;

/** Why a provider was excluded from a decision's candidate list. */
function exclusionReason(provider: string, routing: RoutingInsights): string {
  const quota = routing.quota;
  const entry = quota?.entries.find((e) => e.provider === provider);
  if (entry?.parked) {
    return entry.resetsInMs > 0
      ? `quota exhausted — auto re-enables in ${fmtCooldown(entry.resetsInMs)}`
      : 'quota exhausted — parked';
  }
  if (entry && entry.cooldownRemaining > 0) {
    return `circuit-breaker cooldown — ${fmtCooldown(entry.cooldownRemaining)} remaining`;
  }
  const registered = routing.providers.some((p) => p.provider === provider);
  if (!registered) {
    return 'not scored for this complexity (no benchmark quality data)';
  }
  return 'ranked below the candidate cutoff for this complexity';
}

/**
 * Build the replayable decision list.
 * 1. Real decisions from routing history (most recent first, capped).
 * 2. If no history exists, fall back to complexity profiles from preference
 *    (what the router would pick right now).
 */
export function buildWalkthroughDecisions(routing: RoutingInsights): WalkthroughDecision[] {
  const knownProviders = new Set<string>();
  for (const p of routing.providers) knownProviders.add(p.provider);
  if (routing.usage) for (const p of Object.keys(routing.usage.byProvider)) knownProviders.add(p);
  if (routing.bestModels) for (const b of routing.bestModels) knownProviders.add(b.model.split('/')[0]);
  if (routing.quota) for (const e of routing.quota.entries) knownProviders.add(e.provider);

  const prefByComplexity = new Map(routing.preference.map((p) => [p.complexity, p]));
  const decisions: WalkthroughDecision[] = [];

  // 1. Real recorded decisions (most recent first, capped)
  const history: RoutingHistoryEntry[] = [...(routing.history ?? [])]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  for (const h of history.slice(0, MAX_REAL_DECISIONS)) {
    const profile = prefByComplexity.get(h.complexity);
    const candidates: WalkthroughCandidate[] = profile?.providers?.length
      ? profile.providers.map((c) => ({ provider: c.provider, score: c.score, reason: c.reason }))
      : [{ provider: h.provider, score: h.score, reason: 'actual pick recorded' }];

    // The walkthrough must show the winner in the scored list — if the real
    // pick's provider isn't in the current profile candidates (profile drifted
    // since the decision), append it so the replay stays coherent.
    if (!candidates.some((c) => c.provider === h.provider)) {
      candidates.push({ provider: h.provider, score: h.score, reason: 'actual pick recorded' });
    }

    const candidateSet = new Set(candidates.map((c) => c.provider));
    const exclusions: WalkthroughExclusion[] = [...knownProviders]
      .filter((p) => !candidateSet.has(p))
      .map((p) => ({ provider: p, reason: exclusionReason(p, routing) }));

    const winnerReason = candidates.find((c) => c.provider === h.provider)?.reason;

    decisions.push({
      id: h.id,
      label: `${sourceLabel(h.source)} · ${h.complexity} · ${(h.task || h.agentType).slice(0, 26)}`,
      real: true,
      complexity: h.complexity,
      task: h.task || h.agentType,
      agentType: h.agentType,
      source: h.source,
      timestamp: h.timestamp,
      winner: `${h.provider}/${h.model}`,
      winnerScore: h.score,
      winnerReason,
      candidates,
      exclusions,
    });
  }

  // 2. Fallback: complexity profiles (what the router would pick now)
  if (decisions.length === 0) {
    for (const p of routing.preference) {
      const winnerParts = p.winner.split('/');
      const candidates: WalkthroughCandidate[] = p.providers.map((c) => ({
        provider: c.provider, score: c.score, reason: c.reason,
      }));
      const candidateSet = new Set(candidates.map((c) => c.provider));
      const exclusions: WalkthroughExclusion[] = [...knownProviders]
        .filter((prov) => !candidateSet.has(prov))
        .map((prov) => ({ provider: prov, reason: exclusionReason(prov, routing) }));

      const winnerProvider = winnerParts[0];
      decisions.push({
        id: `profile-${p.complexity}`,
        label: `${COMPLEXITY_LABELS[p.complexity] || p.complexity} — what the router would pick`,
        real: false,
        complexity: p.complexity,
        task: winnerProvider ? `A ${p.complexity} task (auto-routed)` : `A ${p.complexity} task`,
        agentType: 'chat',
        winner: p.winner,
        winnerScore: p.score,
        winnerReason: candidates.find((c) => c.provider === winnerProvider)?.reason,
        candidates,
        exclusions,
      });
    }
  }

  return decisions;
}

// ─── Step narration ─────────────────────────────────────────────────────────

function narration(step: StepKey, d: WalkthroughDecision): string {
  switch (step) {
    case 'request':
      return `A ${d.complexity} task arrives${d.source ? ` from ${sourceLabel(d.source)}` : ''} and must be routed.`;
    case 'candidates':
      return `${d.candidates.length} provider${d.candidates.length !== 1 ? 's' : ''} are scored against the ${d.complexity} weight profile.`;
    case 'exclusions':
      return d.exclusions.length > 0
        ? `${d.exclusions.length} provider${d.exclusions.length !== 1 ? 's' : ''} known to the system are skipped before scoring.`
        : 'Every known provider was scored — nothing was skipped.';
    case 'pick':
      return d.winnerReason
        ? `The top score wins: ${d.winner.split('/')[0]} ranked first — ${d.winnerReason}.`
        : `The top score wins: ${d.winner}.`;
  }
}

// ─── Small render pieces ────────────────────────────────────────────────────

function ScoreBar({ value, color }: { value: number; color: string }) {
  const pctWidth = Math.min(100, Math.max(0, value * 100));
  return (
    <div style={{
      flex: 1, background: '#0d1117', borderRadius: 4, height: 6,
      overflow: 'hidden', border: '1px solid #21262d',
    }}>
      <div style={{ width: `${pctWidth}%`, background: color, height: '100%', transition: 'width 0.4s ease' }} />
    </div>
  );
}

function StepHeader({ icon, title, narration }: { icon: string; title: string; narration: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
      <span style={{ fontSize: 20, lineHeight: '24px' }}>{icon}</span>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3' }}>{title}</div>
        <div style={{ fontSize: 12, color: '#8b949e', marginTop: 2 }}>{narration}</div>
      </div>
    </div>
  );
}

// ─── Walkthrough section ────────────────────────────────────────────────────

export default function RoutingWalkthroughSection({ routing }: { routing: RoutingInsights }) {
  const decisions = useMemo(() => buildWalkthroughDecisions(routing), [routing]);

  const [activeId, setActiveId] = useState<string>('');
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Select the first decision by default (or when the active one disappears).
  useEffect(() => {
    if (decisions.length === 0) return;
    if (!decisions.some((d) => d.id === activeId)) {
      setActiveId(decisions[0].id);
      setStepIdx(0);
    }
  }, [decisions, activeId]);

  // Auto-play loop — advances one step per PLAY_STEP_MS and loops.
  useEffect(() => {
    if (!playing || decisions.length === 0) return;
    const timer = setInterval(() => {
      setStepIdx((s) => (s + 1) % STEP_ORDER.length);
    }, PLAY_STEP_MS);
    return () => clearInterval(timer);
  }, [playing, decisions.length]);

  if (decisions.length === 0) return null;

  const active = decisions.find((d) => d.id === activeId) ?? decisions[0];
  const step = STEP_ORDER[stepIdx];

  const prevStep = () => {
    setStepIdx((s) => (s + STEP_ORDER.length - 1) % STEP_ORDER.length);
    setPlaying(false);
  };
  const nextStep = () => {
    setStepIdx((s) => (s + 1) % STEP_ORDER.length);
    setPlaying(false);
  };
  const togglePlay = () => setPlaying((p) => !p);

  return (
    <div style={{
      background: '#161b22', borderRadius: 12, border: '1px solid #21262d',
      padding: '18px 20px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 20 }}>🎬</span>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: '#e6edf3', margin: 0 }}>
          Why did the router pick this?
        </h3>
        {active.real && (
          <span style={{
            fontSize: 11, padding: '1px 8px', borderRadius: 10,
            background: '#12291a', border: '1px solid #238636', color: '#3fb950',
          }}>
            ✓ real decision
          </span>
        )}
      </div>
      <p style={{ fontSize: 12, color: '#8b949e', margin: '2px 0 12px 0' }}>
        Narrated step-by-step replay of a routing decision — request, candidates,
        exclusions, and the pick. Scrubbable, or hit play.
      </p>

      {/* Decision selector */}
      <select
        aria-label="Routing decision to replay"
        value={activeId}
        onChange={(e) => { setActiveId(e.target.value); setStepIdx(0); setPlaying(false); }}
        style={{
          width: '100%', marginBottom: 16, padding: '8px 10px',
          background: '#0d1117', color: '#e6edf3', fontSize: 12,
          border: '1px solid #30363d', borderRadius: 8, outline: 'none',
        }}
      >
        {decisions.map((d) => (
          <option key={d.id} value={d.id} style={{ background: '#0d1117', color: '#e6edf3' }}>
            {d.real ? '● ' : '○ '}{d.label}
          </option>
        ))}
      </select>

      {/* Step header + narration */}
      <StepHeader
        icon={step.icon}
        title={`${stepIdx + 1}. ${step.title}${stepIdx > 0 ? ` — ${active.complexity}` : ''}`}
        narration={narration(step.key, active)}
      />

      {/* Step content */}
      {step.key === 'request' && (
        <div style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: '#161b22', border: '1px solid #30363d', color: '#e6edf3' }}>
              {COMPLEXITY_ICONS[active.complexity] || '•'} {COMPLEXITY_LABELS[active.complexity] || active.complexity}
            </span>
            <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: '#161b22', border: '1px solid #30363d', color: '#8b949e' }}>
              🤖 {active.agentType}
            </span>
            {active.source && (
              <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: '#161b22', border: '1px solid #30363d', color: '#8b949e' }}>
                {sourceLabel(active.source)}
              </span>
            )}
            {active.timestamp && (
              <span style={{ fontSize: 11, color: '#6e7681', marginLeft: 'auto' }}>
                {timeAgo(active.timestamp)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: '#e6edf3' }}>{active.task}</div>
        </div>
      )}

      {step.key === 'candidates' && (
        <div>
          {active.candidates.map((c, i) => {
            const isWinner = c.provider === active.winner.split('/')[0];
            return (
              <div key={c.provider} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: isWinner ? '#12291a' : '#0d1117',
                border: `1px solid ${isWinner ? '#238636' : '#21262d'}`,
                borderRadius: 8, marginBottom: 6,
              }}>
                <span style={{ width: 18, fontSize: 11, color: '#6e7681', textAlign: 'right' }}>{i + 1}.</span>
                <span style={{ width: 104, color: isWinner ? '#3fb950' : '#e6edf3', fontWeight: isWinner ? 600 : 400, whiteSpace: 'nowrap', fontSize: 12 }}>
                  {providerIcon(c.provider)} {providerLabel(c.provider).split(' ')[0]}
                  {isWinner && ' 👑'}
                </span>
                <ScoreBar value={c.score} color={isWinner ? '#3fb950' : '#58a6ff'} />
                <span style={{ width: 44, textAlign: 'right', fontFamily: "'SFMono-Regular', Consolas, monospace", fontSize: 11, color: '#8b949e' }}>
                  {c.score.toFixed(3)}
                </span>
              </div>
            );
          })}
          {active.candidates.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: '#6e7681', marginBottom: 4 }}>Why each ranked where it did</div>
              {active.candidates.map((c) => (
                <div key={c.provider} style={{ fontSize: 12, color: '#8b949e', marginBottom: 3 }}>
                  <span style={{ color: '#e6edf3' }}>{c.provider}</span>: {c.reason || 'scored'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {step.key === 'exclusions' && (
        active.exclusions.length > 0 ? (
          <div>
            {active.exclusions.map((ex) => (
              <div key={ex.provider} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: '#0d1117', border: '1px solid #21262d', borderRadius: 8, marginBottom: 6,
              }}>
                <span style={{ fontSize: 13 }}>🚫</span>
                <span style={{ width: 110, color: '#e6edf3', whiteSpace: 'nowrap', fontSize: 12 }}>
                  {providerIcon(ex.provider)} {providerLabel(ex.provider).split(' ')[0]}
                </span>
                <span style={{ flex: 1, fontSize: 12, color: '#8b949e' }}>{ex.reason}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{
            background: '#0d1117', border: '1px dashed #30363d', borderRadius: 10,
            padding: '14px 16px', color: '#8b949e', fontSize: 13,
          }}>
            ✅ No exclusions — every provider known to the system was scored for this decision.
          </div>
        )
      )}

      {step.key === 'pick' && (
        <div style={{
          background: '#12291a', border: '1px solid #238636', borderRadius: 10,
          padding: '16px 18px',
        }}>
          <div style={{ fontSize: 12, color: '#3fb950', fontWeight: 600, marginBottom: 6 }}>
            🏆 ROUTER PICK
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3', fontFamily: "'SFMono-Regular', Consolas, monospace", marginBottom: 4 }}>
            {providerIcon(active.winner.split('/')[0])} {active.winner}
          </div>
          <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 10 }}>
            composite score <span style={{ fontFamily: "'SFMono-Regular', Consolas, monospace", color: '#3fb950' }}>{active.winnerScore.toFixed(3)}</span>
            {!active.real && ' · profile preview'}
          </div>
          {active.winnerReason && (
            <div style={{ fontSize: 12, color: '#8b949e', borderTop: '1px solid #23863655', paddingTop: 8 }}>
              <span style={{ color: '#e6edf3' }}>Why:</span> {active.winnerReason}
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button
          onClick={prevStep}
          aria-label="Previous step"
          style={btnStyle}
        >
          ◀
        </button>
        <button
          onClick={togglePlay}
          aria-label={playing ? 'Pause playback' : 'Play playback'}
          style={{ ...btnStyle, minWidth: 84, color: playing ? '#d29922' : '#3fb950' }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          onClick={nextStep}
          aria-label="Next step"
          style={btnStyle}
        >
          ▶
        </button>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
          {STEP_ORDER.map((s, i) => (
            <button
              key={s.key}
              aria-label={`Go to step ${i + 1}: ${s.title}`}
              onClick={() => { setStepIdx(i); setPlaying(false); }}
              style={{
                width: 22, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                fontSize: 10, lineHeight: '22px', padding: 0,
                background: i === stepIdx ? '#58a6ff' : '#21262d',
                color: i === stepIdx ? '#0d1117' : '#8b949e',
              }}
              title={s.title}
            >
              {s.icon}
            </button>
          ))}
        </div>

        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6e7681' }}>
          step {stepIdx + 1}/{STEP_ORDER.length}
        </span>
      </div>
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: '#21262d', color: '#e6edf3', border: '1px solid #30363d',
  borderRadius: 8, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
  transition: 'background 0.15s',
};
