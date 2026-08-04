import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DAGData, PipelinePhase, PipelineRun } from '../types';

// ─── Agent Visual Constants (mirrors DAGView so colors/legends stay consistent) ─

const AGENT_ICONS: Record<string, string> = {
  planner: '📋',
  'context-gatherer': '📂',
  writer: '✏️',
  reviewer: '👁️',
  tester: '🧪',
  debugger: '🐛',
  runner: '▶️',
  git: '🔀',
  package: '📦',
  'github-release': '🏷️',
  security: '🔒',
  orchestrator: '🎯',
};

const AGENT_COLORS: Record<string, string> = {
  planner: '#58a6ff',
  'context-gatherer': '#39d2c0',
  writer: '#d29922',
  reviewer: '#bc8cff',
  tester: '#3fb950',
  debugger: '#f85149',
  runner: '#58a6ff',
  git: '#f0883e',
  package: '#db6d28',
  'github-release': '#3fb950',
  security: '#f85149',
  orchestrator: '#f0883e',
};

const AGENT_LABELS: Record<string, string> = {
  planner: 'Planner',
  'context-gatherer': 'Context',
  writer: 'Writer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  debugger: 'Debugger',
  runner: 'Runner',
  git: 'Git',
  package: 'Package',
  'github-release': 'Release',
  security: 'Security',
  orchestrator: 'Orchestrator',
};

const STATUS_BADGES: Record<PipelinePhase['status'], { icon: string; label: string }> = {
  pending: { icon: '⏳', label: 'Pending' },
  running: { icon: '▶️', label: 'Running' },
  completed: { icon: '✅', label: 'Done' },
  failed: { icon: '❌', label: 'Failed' },
};

const STATUS_COLORS: Record<PipelinePhase['status'], string> = {
  pending: '#6e7681',
  running: '#58a6ff',
  completed: '#3fb950',
  failed: '#f85149',
};

// ─── Run derivation helpers (shared with DAGView) ────────────────────────────

/**
 * Convert a live DAG into a PipelineRun shape so the active execution can be
 * scrubbed in real time alongside historical runs. Returns null when there is
 * nothing to show (no nodes).
 */
export function dagToPipelineRun(dag: DAGData | null | undefined): PipelineRun | null {
  if (!dag || dag.nodes.length === 0) return null;
  const starts = dag.nodes.map((n) => n.startedAt || 0).filter(Boolean) as number[];
  const ends = dag.nodes.map((n) => n.completedAt || 0).filter(Boolean) as number[];
  const started = starts.length > 0 ? Math.min(...starts) : Date.now();
  const ended = ends.length > 0 ? Math.max(...ends) : Date.now();
  return {
    id: `live-${started}`,
    goal: dag.pipeline || 'Active execution',
    startedAt: started,
    endedAt: ends.length > 0 ? ended : undefined,
    success: dag.nodes.length > 0 && dag.nodes.every((n) => n.status === 'completed'),
    totalDurationMs: Math.max(0, ended - started),
    phases: dag.nodes.map((n) => ({
      id: n.id,
      agentType: n.agentType,
      status: n.status,
      description: n.description,
      complexity: n.complexity,
      summary: n.summary,
      startedAt: n.startedAt,
      completedAt: n.completedAt,
      durationMs: n.startedAt && n.completedAt ? n.completedAt - n.startedAt : undefined,
    })),
  };
}

/**
 * Merge the live run (from the DAG) with persisted runs (from the server),
 * de-duplicated by id, most relevant first (live, then newest).
 */
export function collectPipelineRuns(
  dag: DAGData | null | undefined,
  stored: { total: number; runs: PipelineRun[] } | undefined,
): PipelineRun[] {
  const runs: PipelineRun[] = [];
  const seen = new Set<string>();
  const live = dagToPipelineRun(dag);
  if (live) {
    runs.push(live);
    seen.add(live.id);
  }
  for (const run of stored?.runs || []) {
    if (!seen.has(run.id)) {
      runs.push(run);
      seen.add(run.id);
    }
  }
  return runs;
}

// ─── Time formatting ─────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatClock(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Timeline layout model ───────────────────────────────────────────────────

interface LaidPhase extends PipelinePhase {
  /** Fraction [0,1) of the track this phase occupies. */
  start: number;
  /** Width fraction (0,1]. */
  width: number;
  /** Computed duration used for proportional sizing (ms). */
  dur: number;
}

function layoutPhases(phases: PipelinePhase[], totalMs: number): { laid: LaidPhase[]; total: number } {
  if (phases.length === 0) return { laid: [], total: 0 };
  const len = phases.length;
  // Known durations stay proportional; unknown phases split an equal share of
  // the remaining span so the track is always fully covered (never a gap that
  // cannot be scrubbed — e.g. parallel nodes whose durations exceed the span).
  const known = phases.map((p) => (p.durationMs && p.durationMs > 0 ? p.durationMs : 0));
  const knownSum = known.reduce((a, d) => a + d, 0);
  const raw = knownSum > 0
    ? phases.map((p, i) => (known[i] > 0 ? known[i] : knownSum / len))
    : phases.map(() => 1);
  // Normalize so widths always sum to exactly 1 — edge-to-edge, no drift.
  const rawSum = raw.reduce((a, d) => a + d, 0) || 1;
  let cursor = 0;
  const laid: LaidPhase[] = phases.map((p, i) => {
    const width = raw[i] / rawSum;
    const start = cursor;
    cursor += width;
    return { ...p, start, width, dur: raw[i] };
  });
  // Scrub range: the real run span when known, else the synthetic total.
  const total = totalMs > 0 ? totalMs : rawSum;
  return { laid, total };
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface PhaseTimelineProps {
  /** Runs to choose from (live first). The active run to scrub defaults to runs[0]. */
  runs: PipelineRun[];
  /** Optional external control: which run is selected (id). */
  selectedRunId?: string;
  onSelectRun?: (id: string) => void;
  /** Called when the scrub position enters a phase (or leaves with null). */
  onScrub?: (phaseId: string | null) => void;
}

/**
 * A scrubbable phase timeline for a pipeline run — the phase-bars + draggable
 * caret pattern inspired by llm-viz's PhaseTimeline, applied to agent pipeline
 * executions (plan → gather → write → review → test).
 */
export default function PhaseTimeline({
  runs,
  selectedRunId,
  onSelectRun,
  onScrub,
}: PhaseTimelineProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const run = runs.find((r) => r.id === (selectedRunId ?? activeId)) ?? runs[0] ?? null;

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // Keep the latest onScrub in a ref so the notification effect below never
  // goes stale if a parent passes an inline callback.
  const onScrubRef = useRef(onScrub);
  useEffect(() => {
    onScrubRef.current = onScrub;
  }, [onScrub]);

  // Switch back to a valid run when the available set changes.
  useEffect(() => {
    if (!run && runs.length > 0) setActiveId(runs[0].id);
    else if (run && !runs.some((r) => r.id === run.id)) setActiveId(runs[0]?.id ?? null);
  }, [runs, run]);

  const { laid, total } = useMemo(() => layoutPhases(run?.phases || [], run?.totalDurationMs || 0), [run]);

  const frac = total > 0 ? Math.min(1, Math.max(0, t / total)) : 0;

  const currentPhase = useMemo(() => {
    if (total <= 0) return null;
    const at = frac * total;
    return laid.find((p) => at >= p.start * total && at < (p.start + p.width) * total) || null;
  }, [laid, frac, total]);

  // Notify the parent (DAG highlight) whenever the scrubbed phase changes.
  useEffect(() => {
    onScrubRef.current?.(currentPhase?.id ?? null);
  }, [currentPhase?.id]);

  // Playback loop: sweep the full duration in ~2s. The end-of-sweep reset lives
  // in a separate watcher — side effects must never run inside a state updater.
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      setT((prev) => prev + (total / 2000) * 50);
    }, 50);
    return () => clearInterval(interval);
  }, [playing, total]);

  // Reach the end → stop and rewind to the start (sweep completes, then rests).
  useEffect(() => {
    if (playing && total > 0 && t >= total) {
      setPlaying(false);
      setT(0);
    }
  }, [playing, total, t]);

  const setFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || total <= 0) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width || 1;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / width));
    setT(frac * total);
  }, [total]);

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

  if (!run) {
    return (
      <div className="phase-timeline phase-timeline-empty">
        <p>No pipeline runs yet. Run an agent task to see its phase timeline here.</p>
      </div>
    );
  }

  const isLive = run.id.startsWith('live-');
  const completedCount = run.phases.filter((p) => p.status === 'completed').length;
  const failedCount = run.phases.filter((p) => p.status === 'failed').length;

  return (
    <div className="phase-timeline">
      {/* Run selector + meta */}
      <div className="phase-timeline-header">
        <div className="phase-timeline-runs">
          {runs.map((r) => (
            <button
              key={r.id}
              className={`phase-run-chip ${r.id === run.id ? 'active' : ''} ${r.id.startsWith('live-') ? 'live' : ''}`}
              onClick={() => {
                setActiveId(r.id);
                setT(0);
                setPlaying(false);
                onSelectRun?.(r.id);
              }}
              title={r.goal}
            >
              {r.id.startsWith('live-') && <span className="dag-live-dot" />}
              {r.goal.length > 32 ? r.goal.slice(0, 30) + '…' : r.goal}
              <span className="phase-run-chip-time">{formatClock(r.startedAt)}</span>
            </button>
          ))}
        </div>
        <div className="phase-timeline-meta">
          {isLive && <span className="dag-live-badge">LIVE</span>}
          <span className="phase-meta-item">{run.phases.length} steps</span>
          <span className="phase-meta-item phase-meta-ok">✅ {completedCount}</span>
          {failedCount > 0 && <span className="phase-meta-item phase-meta-bad">❌ {failedCount}</span>}
          <span className="phase-meta-item">⏱ {formatMs(total)}</span>
        </div>
      </div>

      {/* Scrub controls */}
      <div className="phase-timeline-controls">
        <button
          className={`phase-play-btn ${playing ? 'paused' : ''}`}
          onClick={() => {
            if (playing) {
              setPlaying(false);
            } else {
              if (t >= total) setT(0);
              setPlaying(true);
            }
          }}
          aria-label={playing ? 'Pause scrub' : 'Play scrub'}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <span className="phase-time-label">{formatMs(t)} / {formatMs(total)}</span>
        <input
          className="phase-range"
          type="range"
          min={0}
          max={total || 1}
          step={1}
          value={Math.min(t, total || 1)}
          onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
          aria-label="Scrub pipeline timeline"
        />
      </div>

      {/* Phase track + caret */}
      <div className="phase-track-wrap">
        <div
          ref={trackRef}
          className="phase-track"
          onPointerDown={handlePointerDown}
          style={{ cursor: 'grab' }}
        >
          {laid.map((p) => {
            const color = AGENT_COLORS[p.agentType] || '#58a6ff';
            const statusColor = STATUS_COLORS[p.status];
            const isActive = currentPhase?.id === p.id;
            return (
              <button
                key={p.id}
                className={`phase-block phase-block-${p.status} ${isActive ? 'active' : ''}`}
                style={{
                  left: `${p.start * 100}%`,
                  width: `${Math.max(p.width * 100, 2)}%`,
                  background: `linear-gradient(180deg, ${color}cc, ${color}66)`,
                  boxShadow: isActive ? `0 0 0 2px ${statusColor}` : undefined,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPlaying(false);
                  setT((p.start + p.width / 2) * total);
                }}
                title={`${AGENT_LABELS[p.agentType] || p.agentType}: ${p.description}`}
              >
                <span className="phase-block-icon">{AGENT_ICONS[p.agentType] || '⚙️'}</span>
                <span className="phase-block-label">{AGENT_LABELS[p.agentType] || p.agentType}</span>
              </button>
            );
          })}
          {/* Caret */}
          <div
            className="phase-caret"
            style={{ left: `${frac * 100}%` }}
            onPointerDown={(e) => { e.stopPropagation(); handlePointerDown(e); }}
            title={`${formatMs(t)} elapsed`}
          />
        </div>
        {/* Ticks */}
        <div className="phase-ticks">
          <span>0</span>
          <span>{formatMs(Math.round(total / 2))}</span>
          <span>{formatMs(total)}</span>
        </div>
      </div>

      {/* Detail panel: the phase under the caret */}
      <div className="phase-detail">
        {currentPhase ? (
          <>
            <div className="phase-detail-title">
              <span className="phase-detail-icon">{AGENT_ICONS[currentPhase.agentType] || '⚙️'}</span>
              <span className="phase-detail-agent" style={{ color: AGENT_COLORS[currentPhase.agentType] || '#58a6ff' }}>
                {AGENT_LABELS[currentPhase.agentType] || currentPhase.agentType}
              </span>
              <span className={`phase-status-badge phase-status-${currentPhase.status}`}>
                {STATUS_BADGES[currentPhase.status].icon} {STATUS_BADGES[currentPhase.status].label}
              </span>
            </div>
            <p className="phase-detail-desc">{currentPhase.description}</p>
            <div className="phase-detail-meta">
              {/* Known duration → exact; reconstructed (unknown) → approximate */}
              <span>⏱ {currentPhase.durationMs ? formatMs(currentPhase.dur) : `~${formatMs(currentPhase.dur)}`}</span>
              {currentPhase.startedAt ? <span>🕐 {formatClock(currentPhase.startedAt)}</span> : null}
              {currentPhase.complexity ? <span>🎯 {currentPhase.complexity}</span> : null}
            </div>
            {currentPhase.summary && <p className="phase-detail-summary">{currentPhase.summary}</p>}
          </>
        ) : (
          <div className="phase-detail-gap">
            <span className="phase-detail-icon">⏳</span>
            <span>Between steps — waiting for the next agent.</span>
          </div>
        )}
      </div>
    </div>
  );
}
