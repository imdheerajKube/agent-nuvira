/**
 * Decision Diff — `model explain --since <ref>` (Nuvira-Router P3-M3.3).
 *
 * Compares two routing-decision snapshots (captured by the explain path and
 * persisted in routing-history.json): what changed between a previous decision
 * and the current one — the winner, per-candidate scores (bandit shift), the
 * dimension weights, governance eliminations, and the capability/context gate
 * states.
 *
 * PURE module: no I/O, no singletons — unit-testable in isolation.
 */

import type { RoutingSnapshot } from './routing-history.js';

/** One candidate's before/after. */
export interface CandidateDiff {
  provider: string;
  /** Highest score for this provider in the previous decision. */
  prevScore?: number;
  /** Highest score for this provider in the current decision. */
  curScore?: number;
  /** cur − prev when the provider ranked in both, else null. */
  delta: number | null;
  /** Human classification of the change. */
  change: 'new' | 'dropped' | 'improved' | 'regressed' | 'unchanged';
  /** Current decision reason for this provider (when present). */
  reason?: string;
}

/** Structured before → after diff of two routing decisions. */
export interface DecisionDiff {
  prevWinner: { provider: string; model: string; score: number } | null;
  curWinner: { provider: string; model: string; score: number } | null;
  winnerChanged: boolean;
  /** Candidate score deltas, changed first then by |Δ| desc. */
  candidates: CandidateDiff[];
  /** Dimension weight deltas (bandit shift) — non-zero only. */
  weightDeltas: Record<string, number>;
  /** Governance policy changes (M2.4). */
  governance: {
    added: Array<{ provider: string; reason: string }>;
    removed: Array<{ provider: string; reason: string }>;
  };
  /** Gate transitions: capability fit / context fit on the winner. */
  gates: Array<{
    dimension: string;
    prev: string | undefined;
    cur: string | undefined;
    change: 'on' | 'off' | 'same';
  }>;
}

const EPS = 0.0005;

function topScoreFor(snapshot: RoutingSnapshot, provider: string): number | undefined {
  const rows = snapshot.ranked.filter((r) => r.provider === provider);
  if (rows.length === 0) return undefined;
  return Math.max(...rows.map((r) => r.score));
}

function gateLabel(snapshot: RoutingSnapshot, dimension: 'capabilityFit' | 'contextFit'): string | undefined {
  const winner = snapshot.ranked.find((r) => r.provider === snapshot.winner.provider);
  const v = winner?.[dimension];
  return v !== undefined ? `${Math.round(v * 100)}%` : undefined;
}

/**
 * Pure diff of two decision snapshots. Handles any combination of missing
 * snapshots at the CALLER level (null prev → treated as "new decision").
 */
export function diffRoutingDecisions(prev: RoutingSnapshot, cur: RoutingSnapshot): DecisionDiff {
  const prevW = prev.winner;
  const curW = cur.winner;
  const winnerChanged = prevW.provider !== curW.provider || prevW.model !== curW.model;

  // ── Candidate score deltas ────────────────────────────────────────────────
  const providers = new Set<string>();
  for (const r of prev.ranked) providers.add(r.provider);
  for (const r of cur.ranked) providers.add(r.provider);

  const candidates: CandidateDiff[] = [];
  for (const provider of providers) {
    const prevScore = topScoreFor(prev, provider);
    const curScore = topScoreFor(cur, provider);
    let change: CandidateDiff['change'] = 'unchanged';
    let delta: number | null = null;
    if (prevScore === undefined && curScore !== undefined) {
      change = 'new';
    } else if (prevScore !== undefined && curScore === undefined) {
      change = 'dropped';
    } else if (prevScore !== undefined && curScore !== undefined) {
      delta = curScore - prevScore;
      if (Math.abs(delta) <= EPS) change = 'unchanged';
      else change = delta > 0 ? 'improved' : 'regressed';
    }
    const reason = cur.ranked.find((r) => r.provider === provider)?.reason;
    candidates.push({ provider, prevScore, curScore, delta, change, reason });
  }
  candidates.sort((a, b) => {
    const order = { new: 0, dropped: 0, improved: 1, regressed: 1, unchanged: 2 };
    const oa = order[a.change];
    const ob = order[b.change];
    if (oa !== ob) return oa - ob;
    const da = Math.abs(a.delta ?? (a.curScore ?? a.prevScore ?? 0));
    const db = Math.abs(b.delta ?? (b.curScore ?? b.prevScore ?? 0));
    return db - da;
  });

  // ── Dimension weight deltas (bandit shift) ────────────────────────────────
  const weightDeltas: Record<string, number> = {};
  const dims = new Set<string>([...Object.keys(prev.weights || {}), ...Object.keys(cur.weights || {})]);
  for (const dim of dims) {
    const d = Math.round(((cur.weights?.[dim] ?? 0) - (prev.weights?.[dim] ?? 0)) * 1000) / 1000;
    if (Math.abs(d) > EPS) weightDeltas[dim] = d;
  }

  // ── Governance changes ────────────────────────────────────────────────────
  const prevGov = new Map((prev.governanceBlocked || []).map((b) => [b.provider, b.reason]));
  const curGov = new Map((cur.governanceBlocked || []).map((b) => [b.provider, b.reason]));
  const added = [...curGov.entries()]
    .filter(([p]) => !prevGov.has(p))
    .map(([provider, reason]) => ({ provider, reason }));
  const removed = [...prevGov.entries()]
    .filter(([p]) => !curGov.has(p))
    .map(([provider, reason]) => ({ provider, reason }));

  // ── Gate transitions on the winner ────────────────────────────────────────
  const gates: DecisionDiff['gates'] = [];
  for (const dim of ['capabilityFit', 'contextFit'] as const) {
    const label = dim === 'capabilityFit' ? 'capability-fit' : 'context-fit';
    const prevV = gateLabel(prev, dim);
    const curV = gateLabel(cur, dim);
    const change: DecisionDiff['gates'][number]['change'] =
      prevV === undefined && curV !== undefined ? 'on'
      : prevV !== undefined && curV === undefined ? 'off'
      : 'same';
    if (change !== 'same' || prevV !== curV) {
      gates.push({ dimension: label, prev: prevV, cur: curV, change });
    }
  }

  return {
    prevWinner: { provider: prevW.provider, model: prevW.model, score: prevW.score },
    curWinner: { provider: curW.provider, model: curW.model, score: curW.score },
    winnerChanged,
    candidates,
    weightDeltas,
    governance: { added, removed },
    gates,
  };
}

/** Compact human summary of a diff (used by `model explain --since`). */
export function formatDecisionDiff(
  diff: DecisionDiff,
  opts: { refLabel?: string; task?: string } = {},
): string {
  const lines: string[] = [];
  if (opts.task) lines.push(`Task: "${opts.task}"`);
  if (opts.refLabel) lines.push(`Compared against: ${opts.refLabel}`);

  const prev = diff.prevWinner;
  const cur = diff.curWinner;
  if (diff.winnerChanged && prev && cur) {
    lines.push(`Decision: ${prev.provider}/${prev.model} → ${cur.provider}/${cur.model}  (score ${prev.score.toFixed(3)} → ${cur.score.toFixed(3)})`);
  } else if (cur) {
    lines.push(`Decision: ${cur.provider}/${cur.model} (unchanged, score ${cur.score.toFixed(3)})`);
  }

  if (diff.candidates.length > 0) {
    lines.push('');
    lines.push('  ── Candidate score changes ──');
    for (const c of diff.candidates) {
      const mark = c.change === 'new' ? '🆕' : c.change === 'dropped' ? '🗑' : c.change === 'improved' ? '▲' : c.change === 'regressed' ? '▼' : '  ';
      const from = c.prevScore !== undefined ? c.prevScore.toFixed(3) : '—';
      const to = c.curScore !== undefined ? c.curScore.toFixed(3) : '—';
      const d = c.delta !== null ? `${c.delta > 0 ? '+' : ''}${c.delta.toFixed(3)}` : '—';
      lines.push(`   ${mark} ${c.provider.padEnd(12)} ${from} → ${to}  (${d})  ${c.change}`);
    }
  }

  const weightKeys = Object.keys(diff.weightDeltas);
  if (weightKeys.length > 0) {
    lines.push('');
    lines.push('  ── Dimension weights (bandit shift) ──');
    for (const dim of weightKeys) {
      const d = diff.weightDeltas[dim];
      lines.push(`   ${dim.padEnd(14)} ${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pp`);
    }
  }

  if (diff.governance.added.length > 0 || diff.governance.removed.length > 0) {
    lines.push('');
    lines.push('  ── Governance policy (M2.4) ──');
    for (const g of diff.governance.added) lines.push(`   ⛔ blocked ${g.provider}: ${g.reason}`);
    for (const g of diff.governance.removed) lines.push(`   ✅ unblocked ${g.provider}`);
  }

  if (diff.gates.length > 0) {
    lines.push('');
    lines.push('  ── Gate changes ──');
    for (const g of diff.gates) {
      const label = g.change === 'on' ? 'ON' : g.change === 'off' ? 'OFF' : 'same';
      lines.push(`   ${g.dimension.padEnd(14)} ${g.prev ?? '—'} → ${g.cur ?? '—'}  (${label})`);
    }
  }

  return lines.join('\n');
}
