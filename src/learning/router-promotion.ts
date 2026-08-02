/**
 * RouterPromotion — promotion gate / A/B validation for the learning router.
 *
 * Mirrors ruflo's `router-parallel-analyze.mjs` (ADR-150): the bandit router is
 * only considered an IMPROVEMENT over the deterministic heuristic if it meets
 * THREE promotion criteria on real trajectories:
 *
 *   (a) qualityScore improvement  > +2%   (relative)
 *   (b) usdPerDecision regression  < +1%  (relative)
 *   (c) p95 routing latency regression < +5% (relative)
 *
 * Mechanism:
 * - During resolve() with bandit enabled, AutoModelRouter calls
 *   `noteParallelDecision()` — recording BOTH the deterministic heuristic pick
 *   and the bandit pick (provider/model/predictedQuality/predictedCostUsd/
 *   estimatedLatencyMs) for the same task.
 * - When the orchestrator records the real outcome, `recordOutcome()` finalizes
 *   the pending decision into a JSONL trajectory file
 *   (`~/.buff/memory/router-promotion.jsonl`, honors BUFF_MEMORY_DIR) with the
 *   ACTUAL outcome (success/failure, latencyMs, costUsd, qualityScore).
 * - `evaluate(minDecisions)` computes the three criteria over the DIVERGED
 *   decisions (where the bandit pick differs from the heuristic pick — a pick
 *   both routers agree on carries no promotion signal).
 *
 * The gate does not forcibly disable the bandit at runtime; it answers the
 * question \"is the bandit actually better than the heuristic?\" and is surfaced
 * via `buff model bandit`. All writes are best-effort.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { BanditOutcome } from './router-bandit.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** One router's pick for a task (deterministic heuristic OR bandit). */
export interface ParallelPick {
  provider: string;
  model: string;
  /** Predicted quality from the router's score (0–1). */
  predictedQuality: number;
  /** Predicted USD cost for a typical call on this provider. */
  predictedCostUsd: number;
  /** Estimated latency (ms) derived from the provider's speed score. */
  estimatedLatencyMs: number;
}

/** A finalized A/B decision with the real outcome. */
export interface PromotionDecision {
  agentType: string;
  task: string;
  heuristic: ParallelPick;
  bandit: ParallelPick;
  outcome: BanditOutcome;
  /** Actual latency of the executed call (ms), when measured. */
  latencyMs?: number;
  /** Actual USD cost of the executed call, when measured. */
  costUsd?: number;
  /** Actual quality score (0–1), when measured; else derived from outcome. */
  qualityScore?: number;
  timestamp: string;
}

/** The promotion-gate evaluation result. */
export interface PromotionStatus {
  /** Total finalized decisions in the trajectory. */
  decisionCount: number;
  /** Decisions where the bandit diverged from the heuristic (the A/B signal). */
  divergedCount: number;
  /** Minimum diverged decisions required before the gate is meaningful. */
  minDecisions: number;
  /** Relative quality delta: (bandit − heuristic) / heuristic. */
  qualityDelta: number;
  /** Relative cost delta: (bandit − heuristic) / heuristic. */
  costDelta: number;
  /** Relative p95 latency delta: (bandit − heuristic) / heuristic. */
  latencyDelta: number;
  /** True when at least one decision had a measured latency (else latencyDelta is 0 / n/a). */
  latencyMeasured: boolean;
  /** Per-criterion pass/fail. */
  criteria: { quality: boolean; cost: boolean; latency: boolean };
  /** True when divergedCount >= minDecisions (enough data to judge). */
  sufficient: boolean;
  /** True when ALL criteria pass (bandit is a genuine improvement). */
  promoted: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
/** Default minimum diverged decisions before the gate evaluates. */
export const DEFAULT_MIN_PROMOTION_DECISIONS = 20;
/**
 * Cap on in-memory PENDING decisions. Keyed by agentType+task so parallel
 * execution can't misattribute outcomes; evicted oldest-first when exceeded
 * (chat never finalizes pending decisions, so this bounds memory).
 */
const MAX_PENDING = 64;

function pendingKey(agentType: string, task: string): string {
  return JSON.stringify([agentType, task]);
}
/** Relative quality improvement required (ruflo: > 2%). */
const QUALITY_THRESHOLD = 0.02;
/** Relative cost regression allowed (ruflo: < 1%). */
const COST_THRESHOLD = 0.01;
/** Relative p95 latency regression allowed (ruflo: < 5%). */
const LATENCY_THRESHOLD = 0.05;

function trajectoryPath(): string {
  return join(process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR, 'router-promotion.jsonl');
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

/** Actual quality of a decision: measured qualityScore, else outcome-derived. */
function actualQuality(d: PromotionDecision): number {
  if (d.qualityScore !== undefined) return d.qualityScore;
  return d.outcome === 'success' ? 1 : 0;
}

// ─── RouterPromotion ────────────────────────────────────────────────────────

export class RouterPromotion {
  /** Pending (not-yet-finalized) decisions keyed by agentType+task. */
  private pending = new Map<string, Omit<PromotionDecision, 'outcome' | 'timestamp'>>();

  /**
   * Record the deterministic-heuristic pick AND the bandit pick for a task.
   * Called by AutoModelRouter.resolve() when bandit learning is enabled.
   * The pending pair is finalized by recordOutcome() when the real result lands.
   * Keyed by agentType+task so PARALLEL tasks of the same agent type never
   * overwrite each other's attribution.
   */
  noteParallelDecision(
    agentType: string,
    task: string,
    heuristic: ParallelPick,
    bandit: ParallelPick,
  ): void {
    // Bound memory: chat notes decisions but never finalizes them, so evict
    // oldest-first when the pending map grows past the cap.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(pendingKey(agentType, task), { agentType, task, heuristic, bandit });
  }

  /**
   * Finalize the pending decision for an agent type + task with the real
   * outcome. Called by AutoModelRouter.recordOutcome() (i.e. by the
   * orchestrator after each auto-routed task). Best-effort append to the
   * trajectory file.
   */
  recordOutcome(
    agentType: string,
    task: string,
    outcome: BanditOutcome,
    outcomeData?: { latencyMs?: number; costUsd?: number; qualityScore?: number },
  ): void {
    const key = pendingKey(agentType, task);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    // Only decisions where the bandit diverged carry promotion signal; but we
    // keep ALL in the trajectory so decisionCount is truthful.
    const decision: PromotionDecision = {
      ...pending,
      outcome,
      latencyMs: outcomeData?.latencyMs,
      costUsd: outcomeData?.costUsd,
      qualityScore: outcomeData?.qualityScore,
      timestamp: new Date().toISOString(),
    };
    this.append(decision);
  }

  /** All finalized decisions from the trajectory file (best-effort). */
  getDecisions(): PromotionDecision[] {
    try {
      if (!existsSync(trajectoryPath())) return [];
      const raw = readFileSync(trajectoryPath(), 'utf-8');
      const decisions: PromotionDecision[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          decisions.push(JSON.parse(trimmed) as PromotionDecision);
        } catch {
          // Skip malformed lines — the trajectory must never break evaluation.
        }
      }
      return decisions;
    } catch {
      return [];
    }
  }

  /**
   * Evaluate the promotion gate over the accumulated trajectory.
   *
   * @param minDecisions Minimum diverged decisions required for the gate to be
   *                     meaningful (ruflo's promotion gate needs a sample).
   */
  evaluate(minDecisions: number = DEFAULT_MIN_PROMOTION_DECISIONS): PromotionStatus {
    const decisions = this.getDecisions();
    const diverged = decisions.filter(
      (d) =>
        d.bandit.provider !== d.heuristic.provider ||
        d.bandit.model !== d.heuristic.model,
    );
    const sufficient = diverged.length >= minDecisions;

    if (diverged.length === 0) {
      return {
        decisionCount: decisions.length,
        divergedCount: 0,
        minDecisions,
        qualityDelta: 0,
        costDelta: 0,
        latencyDelta: 0,
        latencyMeasured: false,
        criteria: { quality: false, cost: true, latency: true },
        sufficient,
        promoted: false,
      };
    }

    // ── (a) Quality: actual outcomes of the bandit pick vs the heuristic's
    //     predicted quality for the same tasks.
    const qualityB = mean(diverged.map(actualQuality));
    const qualityH = mean(diverged.map((d) => d.heuristic.predictedQuality));
    const qualityDelta = qualityH > 0 ? (qualityB - qualityH) / qualityH : 0;

    // ── (b) Cost: actual (or predicted) bandit cost vs heuristic predicted cost.
    const costB = mean(diverged.map((d) => d.costUsd ?? d.bandit.predictedCostUsd));
    const costH = mean(diverged.map((d) => d.heuristic.predictedCostUsd));
    const costDelta = costH > 0 ? (costB - costH) / costH : 0;

    // ── (c) Latency: p95 actual bandit latency vs p95 heuristic estimated latency.
    const withLatency = diverged.filter((d) => d.latencyMs !== undefined);
    const latencyB = p95(withLatency.map((d) => d.latencyMs!));
    const latencyH = p95(diverged.map((d) => d.heuristic.estimatedLatencyMs));
    // No latency measurements → report 0 (neutral), never a misleading −100%.
    const latencyDelta = withLatency.length === 0 ? 0 : latencyH > 0 ? (latencyB - latencyH) / latencyH : 0;

    const criteria = {
      quality: qualityDelta > QUALITY_THRESHOLD,
      cost: costDelta < COST_THRESHOLD,
      // No latency measurements yet → treat as neutral (don't block promotion
      // on absent telemetry, but don't claim a win either).
      latency: withLatency.length === 0 ? true : latencyDelta < LATENCY_THRESHOLD,
    };

    return {
      decisionCount: decisions.length,
      divergedCount: diverged.length,
      minDecisions,
      qualityDelta,
      costDelta,
      latencyDelta,
      latencyMeasured: withLatency.length > 0,
      criteria,
      sufficient,
      promoted: sufficient && criteria.quality && criteria.cost && criteria.latency,
    };
  }

  /** Clear the trajectory (used by `buff model bandit reset`). */
  reset(): void {
    this.pending.clear();
    try {
      if (existsSync(trajectoryPath())) writeFileSync(trajectoryPath(), '', 'utf-8');
    } catch {
      // Best-effort.
    }
  }

  private append(decision: PromotionDecision): void {
    try {
      const dir = dirname(trajectoryPath());
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(trajectoryPath(), `${JSON.stringify(decision)}\n`, { flag: 'a' });
    } catch {
      // Best-effort — never break outcome recording on a failed write.
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let promotionInstance: RouterPromotion | null = null;

/** Get or create the RouterPromotion singleton. */
export function getRouterPromotion(): RouterPromotion {
  if (!promotionInstance) promotionInstance = new RouterPromotion();
  return promotionInstance;
}

/** Reset the singleton (useful for testing). */
export function resetRouterPromotion(): void {
  promotionInstance = null;
}
