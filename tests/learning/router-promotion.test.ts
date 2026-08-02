/**
 * Tests for RouterPromotion — the promotion gate / A/B validation for the
 * learning router (mirror of ruflo's router-parallel-analyze.mjs).
 *
 * Coverage:
 * - noteParallelDecision + recordOutcome finalize a trajectory entry
 * - trajectory persists to BUFF_MEMORY_DIR (JSONL)
 * - evaluate() three promotion criteria (quality > +2%, cost < +1%, p95
 *   latency < +5%) with sufficient/insufficient and promoted verdicts
 * - diverged-only A/B signal (identical picks carry no signal)
 * - reset() clears the trajectory
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RouterPromotion,
  resetRouterPromotion,
  getRouterPromotion,
  DEFAULT_MIN_PROMOTION_DECISIONS,
  type ParallelPick,
} from '../../src/learning/router-promotion.js';

// ─── Sample isolation: point BUFF_MEMORY_DIR at a fresh temp dir ───────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-promotion-test-'));
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetRouterPromotion();
});

afterEach(() => {
  delete process.env.BUFF_MEMORY_DIR;
  resetRouterPromotion();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Fixtures ──────────────────────────────────────────────────────────────

function pick(provider: string, model: string, quality: number, costUsd: number, latencyMs: number): ParallelPick {
  return { provider, model, predictedQuality: quality, predictedCostUsd: costUsd, estimatedLatencyMs: latencyMs };
}

/** Record one finalized diverged decision (bandit picked differently from heuristic). */
function recordDiverged(
  p: RouterPromotion,
  opts: {
    heuristicQuality: number;
    banditOutcome: 'success' | 'failure';
    banditQuality?: number;
    heuristicCostUsd?: number;
    banditCostUsd?: number;
    heuristicLatencyMs?: number;
    banditLatencyMs?: number;
  },
): void {
  p.noteParallelDecision(
    'writer',
    'implement a feature',
    pick('gemini', 'gemini-2.5-flash', opts.heuristicQuality, opts.heuristicCostUsd ?? 0.003, opts.heuristicLatencyMs ?? 6000),
    pick('groq', 'llama-3.3-70b-versatile', 0.5, 0.001, 2000),
  );
  p.recordOutcome('writer', 'implement a feature', opts.banditOutcome, {
    qualityScore: opts.banditQuality,
    costUsd: opts.banditCostUsd ?? 0.001,
    latencyMs: opts.banditLatencyMs ?? 2000,
  });
}

// ─── Trajectory recording ──────────────────────────────────────────────────

describe('trajectory recording', () => {
  it('noteParallelDecision + recordOutcome appends a finalized decision', () => {
    const p = getRouterPromotion();
    recordDiverged(p, { heuristicQuality: 0.7, banditOutcome: 'success' });
    const decisions = p.getDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].heuristic.provider).toBe('gemini');
    expect(decisions[0].bandit.provider).toBe('groq');
    expect(decisions[0].outcome).toBe('success');
    expect(decisions[0].task).toBe('implement a feature');
  });

  it('persists the trajectory to BUFF_MEMORY_DIR as JSONL', () => {
    const p = getRouterPromotion();
    recordDiverged(p, { heuristicQuality: 0.7, banditOutcome: 'failure' });
    expect(existsSync(join(tempDir, 'router-promotion.jsonl'))).toBe(true);
    // A NEW singleton reads the same file (persistence round-trip)
    resetRouterPromotion();
    expect(getRouterPromotion().getDecisions().length).toBe(1);
  });

  it('recordOutcome without a pending decision writes nothing', () => {
    const p = getRouterPromotion();
    p.recordOutcome('writer', 'implement a feature', 'success');
    expect(p.getDecisions().length).toBe(0);
  });

  it('keeps decisions where both routers agreed (decisionCount is truthful)', () => {
    const p = getRouterPromotion();
    // Same provider+model for both picks → no divergence
    p.noteParallelDecision(
      'writer',
      'format this code',
      pick('groq', 'llama-3.3-70b-versatile', 0.8, 0.001, 2000),
      pick('groq', 'llama-3.3-70b-versatile', 0.8, 0.001, 2000),
    );
    p.recordOutcome('writer', 'format this code', 'success');
    const status = p.evaluate();
    expect(status.decisionCount).toBe(1);
    expect(status.divergedCount).toBe(0);
    expect(status.sufficient).toBe(false);
  });
});

// ─── Promotion gate evaluation ─────────────────────────────────────────────

describe('evaluate', () => {
  it('returns an empty status with no trajectory', () => {
    const status = getRouterPromotion().evaluate();
    expect(status.decisionCount).toBe(0);
    expect(status.divergedCount).toBe(0);
    expect(status.sufficient).toBe(false);
    expect(status.promoted).toBe(false);
  });

  it('needs the minimum number of diverged decisions to be sufficient', () => {
    const p = getRouterPromotion();
    for (let i = 0; i < 10; i++) {
      recordDiverged(p, { heuristicQuality: 0.7, banditOutcome: 'success' });
    }
    const status = p.evaluate(20);
    expect(status.divergedCount).toBe(10);
    expect(status.sufficient).toBe(false);
    expect(status.promoted).toBe(false);
  });

  it('promotes when the bandit clearly beats the heuristic on all three criteria', () => {
    const p = getRouterPromotion();
    // Heuristic predicted ~0.5 quality; bandit outcomes ~0.9 → +80% quality.
    // Bandit cost 0.001 vs heuristic 0.003 → −66%. Bandit latency 2000 vs 6000.
    for (let i = 0; i < DEFAULT_MIN_PROMOTION_DECISIONS; i++) {
      recordDiverged(p, {
        heuristicQuality: 0.5,
        banditOutcome: 'success',
        banditQuality: 0.9,
      });
    }
    const status = p.evaluate();
    expect(status.sufficient).toBe(true);
    expect(status.criteria.quality).toBe(true);
    expect(status.criteria.cost).toBe(true);
    expect(status.criteria.latency).toBe(true);
    expect(status.promoted).toBe(true);
  });

  it('rejects when quality does not improve', () => {
    const p = getRouterPromotion();
    for (let i = 0; i < DEFAULT_MIN_PROMOTION_DECISIONS; i++) {
      recordDiverged(p, {
        heuristicQuality: 0.9,
        banditOutcome: 'failure',
        banditQuality: 0.1,
      });
    }
    const status = p.evaluate();
    expect(status.criteria.quality).toBe(false);
    expect(status.promoted).toBe(false);
  });

  it('rejects when cost regresses by more than 1%', () => {
    const p = getRouterPromotion();
    for (let i = 0; i < DEFAULT_MIN_PROMOTION_DECISIONS; i++) {
      recordDiverged(p, {
        heuristicQuality: 0.5,
        banditOutcome: 'success',
        banditQuality: 0.9,
        heuristicCostUsd: 0.001,
        banditCostUsd: 0.005, // 5× the heuristic → huge cost regression
      });
    }
    const status = p.evaluate();
    expect(status.criteria.quality).toBe(true);
    expect(status.criteria.cost).toBe(false);
    expect(status.promoted).toBe(false);
  });

  it('rejects when p95 latency regresses by more than 5%', () => {
    const p = getRouterPromotion();
    for (let i = 0; i < DEFAULT_MIN_PROMOTION_DECISIONS; i++) {
      recordDiverged(p, {
        heuristicQuality: 0.5,
        banditOutcome: 'success',
        banditQuality: 0.9,
        heuristicLatencyMs: 2000,
        banditLatencyMs: 8000, // 4× the heuristic → huge latency regression
      });
    }
    const status = p.evaluate();
    expect(status.criteria.quality).toBe(true);
    expect(status.criteria.latency).toBe(false);
    expect(status.promoted).toBe(false);
  });

  it('uses actual cost/latency when provided, else predicted values', () => {
    const p = getRouterPromotion();
    // No latency measured → latency criterion treated as neutral (passes)
    p.noteParallelDecision(
      'writer',
      'implement a feature',
      pick('gemini', 'gemini-2.5-flash', 0.5, 0.003, 6000),
      pick('groq', 'llama-3.3-70b-versatile', 0.5, 0.001, 2000),
    );
    p.recordOutcome('writer', 'implement a feature', 'success', { qualityScore: 0.9 });
    const status = p.evaluate(1);
    expect(status.criteria.quality).toBe(true);
    expect(status.criteria.latency).toBe(true); // no latency data → neutral
  });
});

// ─── Reset ─────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('clears the trajectory and pending decisions', () => {
    const p = getRouterPromotion();
    recordDiverged(p, { heuristicQuality: 0.7, banditOutcome: 'success' });
    expect(p.getDecisions().length).toBe(1);
    p.reset();
    expect(p.getDecisions().length).toBe(0);
    // Pending decisions are also dropped — a late recordOutcome writes nothing
    p.noteParallelDecision(
      'writer',
      'implement a feature',
      pick('gemini', 'gemini-2.5-flash', 0.5, 0.003, 6000),
      pick('groq', 'llama-3.3-70b-versatile', 0.5, 0.001, 2000),
    );
    p.reset();
    p.recordOutcome('writer', 'implement a feature', 'success');
    expect(p.getDecisions().length).toBe(0);
  });
});
