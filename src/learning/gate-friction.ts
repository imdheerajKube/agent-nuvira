/**
 * Gate friction — how much the harness speaks to the model in a turn, summarized
 * from reasoning traces so the dashboard can show the number.
 *
 * Counts every `gate` event (a bounded nudge: plan / verification / deliverable /
 * permission / repeat / action / promise / self-review / diagnosis /
 * malformed-call / prerequisite) and every `refusal` event (a tool declined a
 * call). The per-turn distribution is the number Bundle 37b ("deliver gate text
 * as an acted-on instruction") exists to reduce. This module is the READ side of
 * `scripts/measure-gate-friction.mjs`, so the dashboard and the CLI report the
 * same figure from the same rule.
 *
 * It also counts narration (Bundle 39): a turn whose final answer reuses the
 * harness's own distinctive vocabulary — see `harness-narration.ts`.
 */

import { detectHarnessNarration } from './harness-narration.js';

export interface GateFrictionSummary {
  traces: number;
  /** Total gate + refusal events across all traces. */
  events: number;
  perTurn: {
    mean: number;
    median: number;
    p90: number;
    max: number;
    turnsWithAny: number;
  };
  /** Per-gate counts, highest first. */
  byGate: Array<{ key: string; count: number }>;
  /** Turns whose answer narrated the harness (Bundle 39). */
  narration: { turns: number; echoedMarker: number };
}

interface RawTrace {
  events?: Array<{ kind?: string; gate?: string; tool?: string; summary?: string; result?: string }>;
  steps?: Array<{ responsePreview?: string }>;
}

function normalize(raw: unknown): RawTrace[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { traces?: unknown[] }).traces)
      ? ((raw as { traces: unknown[] }).traces as unknown[])
      : [];
  return list.filter((t): t is RawTrace => Boolean(t) && typeof t === 'object');
}

function finalText(trace: RawTrace): string {
  const steps = trace.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const t = steps[i]?.responsePreview;
    if (t && String(t).trim()) return String(t);
  }
  return '';
}

export function summarizeGateFriction(raw: unknown): GateFrictionSummary {
  const traces = normalize(raw);
  const byKey = new Map<string, number>();
  const perTurn: number[] = [];
  let narrated = 0;
  let echoed = 0;

  for (const trace of traces) {
    let total = 0;
    const harnessTexts: string[] = [];
    for (const e of trace.events ?? []) {
      if (!e) continue;
      if (e.kind === 'gate') {
        const key = `gate:${e.gate || 'unknown'}`;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
        total += 1;
        if (e.summary) harnessTexts.push(e.summary);
      } else if (e.kind === 'refusal') {
        const key = `refusal:${e.gate || e.tool || 'unknown'}`;
        byKey.set(key, (byKey.get(key) ?? 0) + 1);
        total += 1;
        if (e.summary) harnessTexts.push(e.summary);
        if (e.result) harnessTexts.push(e.result);
      }
    }
    perTurn.push(total);

    if (harnessTexts.length > 0) {
      const text = finalText(trace);
      if (text.includes('[harness]')) echoed += 1;
      if (detectHarnessNarration(text, harnessTexts).narrated) narrated += 1;
    }
  }

  const sorted = [...perTurn].sort((a, b) => a - b);
  const sum = sorted.reduce((n, v) => n + v, 0);
  const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

  return {
    traces: traces.length,
    events: sum,
    perTurn: {
      mean: sorted.length ? Math.round((sum / sorted.length) * 100) / 100 : 0,
      median: at(0.5),
      p90: at(0.9),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      turnsWithAny: perTurn.filter((n) => n > 0).length,
    },
    byGate: [...byKey.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count),
    narration: { turns: narrated, echoedMarker: echoed },
  };
}
