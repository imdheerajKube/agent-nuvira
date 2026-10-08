/**
 * RouterBandit — bucketed Thompson-sampling bandit for Auto model routing.
 *
 * Inspired by ruflo's `model-router.ts` (Beta-Bernoulli Thompson sampling)
 * and generalized beyond the original 3-tier setup to agent-nuvira's full provider set.
 *
 * Mechanism:
 * - Each provider keeps a Beta(α, β) prior PER complexity bucket
 *   (trivial/simple/moderate/complex/critical) so learning is task-type-local.
 * - During routing, the deterministic score is multiplied by a Thompson draw
 *   θ ~ Beta(α, β). Cold-start Beta(1,1) is uniform, so behavior matches the
 *   deterministic router until outcomes accumulate.
 * - `recordOutcome()` applies a COST-ADJUSTED Bernoulli reward: cheap
 *   providers get the highest α bump on success (a cheap successful call is
 *   the most cost-efficient outcome), failures always β++.
 *
 * Persisted to ~/.nuvira/memory/router-bandit.json (respects NUVIRA_MEMORY_DIR).
 * All writes are best-effort — a failed write must never break routing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {envBuff, resolveNuviraHome} from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Routing outcome used to update bandit priors. */
export type BanditOutcome = 'success' | 'failure' | 'escalated';

/** Richer feedback data that can improve the bandit reward signal. */
export interface BanditOutcomeData {
  outcome: BanditOutcome;
  latencyMs?: number;
  tokensUsed?: number;
  costUsd?: number;
  testPassed?: boolean;
  qualityScore?: number;
  userAccepted?: boolean;
  verificationPassed?: boolean;
  metadata?: Record<string, unknown>;
}

/** A single Beta prior pair. */
export interface BetaPrior {
  alpha: number;
  beta: number;
}

/**
 * Minimum accumulated samples (α+β) before a prior is considered "learned".
 * Priors below this have essentially no data — bandit routing treats them as
 * unlearned and (when enabled) escalates to a provider/model that has data.
 */
export const DEFAULT_MIN_SAMPLES = 8;

/**
 * How much one deferred `userAccepted: false` moves an arm.
 *
 * NOT a new reward rule: the success branch of {@link RouterBandit.applyReward}
 * already treats `userAccepted: false` as `reward -= 0.1`, and `reward` moves α by
 * exactly that amount (β by `1 - reward`). Applying the verdict a turn late is
 * therefore `α -= 0.1, β += 0.1` — byte-for-byte the same arm the run would have
 * had if the verdict had been known at record time. Stated as a constant so the
 * two halves cannot drift apart.
 */
export const USER_REJECTION_DELTA = 0.1;
/**
 * How old the newest recorded outcome may be before the bandit's data stops
 * being described as "learned" for a decision made today. See `isStale`.
 */
export const BANDIT_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

/** The complexity buckets the bandit learns per provider. */
export const COMPLEXITY_BUCKETS: ComplexityLevel[] = [
  'trivial',
  'simple',
  'moderate',
  'complex',
  'critical',
];

/** Persisted bandit state. */
export interface RouterBanditState {
  version: number;
  /** priors[complexityBucket][provider] = Beta(α, β) */
  priors: Record<string, Record<string, BetaPrior>>;
  /**
   * Per-modelId Beta priors — modelPriors[complexityBucket][modelId] = Beta(α, β).
   * Mirrors ruflo's ADR-149 `priorsById` shadow state: the bandit learns that
   * e.g. `llama-3.3-70b-versatile` ≠ `openai/gpt-oss-20b` within the SAME
   * provider, so the concrete model choice can learn from real outcomes.
   */
  modelPriors: Record<string, Record<string, BetaPrior>>;
  /** Recent learning history (bounded, for observability). */
  learningHistory: Array<{
    provider: string;
    /** Concrete model id this outcome was attributed to (per-model learning). */
    model?: string;
    complexity: string;
    /** v3 — task intent the outcome was bucketed under ('coding', 'creative', …). */
    taskIntent?: string;
    outcome: string;
    reward: number;
    latencyMs?: number;
    tokensUsed?: number;
    costUsd?: number;
    testPassed?: boolean;
    qualityScore?: number;
    userAccepted?: boolean;
    verificationPassed?: boolean;
    timestamp: string;
  }>;
  /**
   * Bundle 36 — trace ids whose EXPLICIT user verdict has already been applied to
   * the arms that served them. An explicit `nuvira rate bad` arrives in its OWN
   * process, so it cannot rely on `pendingOutcome`; keying the correction on the
   * trace is what lets a re-run (or a verdict that follows a DERIVED rejection of
   * the same turn) move an arm exactly once. Bounded like the history.
   */
  correctedVerdicts?: string[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const CURRENT_VERSION = 3; // v2 = per-modelId modelPriors; v3 = task-INTENT-aware buckets
const MAX_HISTORY = 200;
/** Cap the applied-verdict dedupe set (oldest drop first — a trace, once old, is never re-rated). */
const MAX_CORRECTED_VERDICTS = 2000;

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
}

function statePath(): string {
  return join(memoryDir(), 'router-bandit.json');
}

function emptyState(): RouterBanditState {
  return { version: CURRENT_VERSION, priors: {}, modelPriors: {}, learningHistory: [] };
}

// ─── Sampling (Marsaglia–Tsang gamma + Beta via gamma ratio) ────────────────

/** Standard normal via Box–Muller. */
export function standardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sample from Gamma(shape, scale=1) using the Marsaglia–Tsang method.
 * Handles shape < 1 with the GS transform (Gamma(shape+1) · U^(1/shape)).
 */
export function sampleGamma(shape: number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    const u = Math.random();
    // Avoid log(0) on the rare u === 0
    const uu = Math.max(u, Number.EPSILON);
    return sampleGamma(shape + 1) * Math.pow(uu, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = standardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Sample from Beta(α, β) using the gamma-ratio identity X/(X+Y).
 * Degenerate priors (α ≤ 0 or β ≤ 0) return the neutral midpoint 0.5.
 */
export function sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  if (x + y === 0) return 0.5;
  return x / (x + y);
}

// ─── Cost-adjusted rewards ──────────────────────────────────────────────────

/**
 * Compute the α-bump for a successful routing outcome.
 * Cheap providers (costScore near 1) get the highest reward because their
 * success is the most cost-efficient — mirrors ruflo's "Haiku-success >
 * Sonnet-success > Opus-success" table, generalized to any provider.
 * Returns a value in [0.1, 0.9] (expensive = 0.1, neutral = 0.5, free = 0.9);
 * β gets `1 - reward` on success.
 */
export function costAdjustedSuccessReward(costScore: number): number {
  const c = Math.max(0, Math.min(1, costScore));
  return 0.1 + 0.8 * c;
}

// ─── RouterBandit ───────────────────────────────────────────────────────────

export class RouterBandit {
  private state: RouterBanditState;
  /** Provider chosen by the last resolve() per agent type (for outcome wiring). */
  private lastProviderByAgent: Record<string, string> = {};
  /** Concrete model chosen by the last resolve() per agent type (for per-model learning). */
  private lastModelByAgent: Record<string, string> = {};

  constructor() {
    this.state = this.load();
  }

  /** Load persisted state (best-effort). */
  private load(): RouterBanditState {
    try {
      if (!existsSync(statePath())) return emptyState();
      const raw = readFileSync(statePath(), 'utf-8');
      const data = JSON.parse(raw) as RouterBanditState;
      if (!data || typeof data !== 'object' || !data.priors) return emptyState();
      // Version comes from the file when present; emptyState() supplies defaults
      return { ...emptyState(), ...data };
    } catch {
      return emptyState();
    }
  }

  private save(): void {
    try {
      if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
      writeFileSync(statePath(), JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // Best-effort — never break routing on a failed write.
    }
  }

  /**
   * v3 — the learning bucket key. Learning is bucketed by task INTENT *and*
   * complexity, so a provider's win-rate on coding sessions can never boost it
   * for creative writing (the mis-routing that sent an essay to a 4-bit local
   * model). Callers WITHOUT an intent (tests, legacy paths, persisted v2 data)
   * keep the plain complexity key — fully backward compatible.
   */
  private bucketKey(complexity: ComplexityLevel, taskIntent?: string): string {
    return taskIntent ? `${taskIntent}:${complexity}` : complexity;
  }

  /** Get the Beta prior for a model in a complexity bucket (per-model learning). */
  getModelPrior(model: string, complexity: ComplexityLevel, taskIntent?: string): BetaPrior {
    return this.state.modelPriors[this.bucketKey(complexity, taskIntent)]?.[model] ?? { alpha: 1, beta: 1 };
  }

  /** Note the concrete model picked for an agent type (per-model outcome wiring). */
  noteModelDecision(agentType: string, model: string): void {
    this.lastModelByAgent[agentType] = model;
  }

  /** Concrete model picked last for an agent type, if any. */
  getLastModel(agentType: string): string | undefined {
    return this.lastModelByAgent[agentType];
  }

  /**
   * Thompson-sample a model's score for a complexity bucket using its
   * per-model prior. Cold-start Beta(1,1) → uniform draw, so the model choice
   * behaves deterministically until per-model outcomes accumulate.
   */
  sampleModelScore(model: string, complexity: ComplexityLevel, score: number, taskIntent?: string): number {
    const prior = this.getModelPrior(model, complexity, taskIntent);
    const theta = sampleBeta(prior.alpha, prior.beta);
    return score * theta;
  }

  /** Get the Beta prior for a provider in a complexity bucket (intent-aware). */
  getPrior(provider: string, complexity: ComplexityLevel, taskIntent?: string): BetaPrior {
    return this.state.priors[this.bucketKey(complexity, taskIntent)]?.[provider] ?? { alpha: 1, beta: 1 };
  }

  /**
   * P6 (fix_model_routing) — IS THERE ACTUALLY LEARNED DATA for this arm?
   *
   * `Beta(1,1)` is the UNTOUCHED prior: no outcome has ever been recorded for
   * this provider in this bucket. The router used to call any `useBandit`
   * decision `bandit-learned`, so a decision made from a cold-start prior — a
   * score multiplied by a constant 0.5 that cannot reorder anything — was
   * presented to the user as learned. Live: the store had no entry for ANY of
   * the models in play, and the trace still read `bandit-learned`.
   */
  hasLearnedData(
    provider: string,
    complexity: ComplexityLevel,
    taskIntent?: string,
    /** The concrete model, when known — its own arm is evidence too. */
    model?: string,
  ): boolean {
    const prior = this.getPrior(provider, complexity, taskIntent);
    if (prior.alpha + prior.beta > 2) return true;
    if (model) {
      const modelPrior = this.getModelPrior(model, complexity, taskIntent);
      if (modelPrior.alpha + modelPrior.beta > 2) return true;
    }
    return false;
  }

  /** Milliseconds since the newest recorded outcome (`Infinity` when none). */
  ageMs(now: number = Date.now()): number {
    const newest = this.state.learningHistory.reduce<number>((acc, h) => {
      const t = Date.parse(h.timestamp ?? '');
      return Number.isFinite(t) && t > acc ? t : acc;
    }, 0);
    return newest === 0 ? Number.POSITIVE_INFINITY : Math.max(0, now - newest);
  }

  /**
   * P6 (fix_model_routing) — NEGATIVE REWARD for a step-level failure.
   *
   * `recordOutcome` rewards a model only when a whole TASK succeeds or fails,
   * which never happens for the failure that actually killed runs: a model that
   * resolves a step with NOTHING usable. That model was retried, the turn ended
   * `bounded`, and the bandit learned nothing — so its prior kept sampling the
   * same broken arm back up. This is where an ungrounded "learned" score comes
   * from, and where it is now corrected.
   *
   * The signal is a property of the MODEL rather than of the task (a model that
   * returns nothing fails every kind of ask), so when no bucket is supplied the
   * penalty lands on every arm that already holds an entry for this model — the
   * only arms that could otherwise keep sampling it up — and a brand-new model
   * with no arms at all gets the general bucket rather than inventing
   * task-specific ones.
   */
  penalizeModel(model: string, complexity?: ComplexityLevel, taskIntent?: string): void {
    if (!model || model === 'default') return;
    const keys: string[] = [];
    if (complexity) {
      keys.push(this.bucketKey(complexity, taskIntent));
    } else {
      for (const key of Object.keys(this.state.modelPriors)) {
        if (this.state.modelPriors[key]?.[model]) keys.push(key);
      }
      if (keys.length === 0) keys.push(this.bucketKey('moderate' as ComplexityLevel, taskIntent));
    }
    const nowIso = new Date().toISOString();
    for (const key of keys) {
      const bucket = this.state.modelPriors[key] ?? (this.state.modelPriors[key] = {});
      const prior = bucket[model] ?? (bucket[model] = { alpha: 1, beta: 1 });
      prior.beta += 1;
      this.state.learningHistory.push({
        provider: model, // model-id surface; `provider` keeps CLI history rendering
        model,
        complexity: (complexity ?? ('moderate' as ComplexityLevel)),
        ...(taskIntent ? { taskIntent } : {}),
        outcome: 'failure',
        reward: 0,
        timestamp: nowIso,
      });
    }
    if (this.state.learningHistory.length > MAX_HISTORY) {
      this.state.learningHistory = this.state.learningHistory.slice(-MAX_HISTORY);
    }
    this.save();
  }

  /**
   * P6 — staleness guard. A store whose newest sample is older than
   * {@link BANDIT_STALENESS_MS} describes a different machine, different keys
   * and a different model roster; calling its output "learned" for today's task
   * is a claim nobody checked. Observed on disk: the store was last written 11
   * days before the decision it supposedly informed.
   */
  isStale(now: number = Date.now()): boolean {
    return this.ageMs(now) > BANDIT_STALENESS_MS;
  }

  /** Note the provider picked for an agent type (for recordOutcome wiring). */
  noteDecision(agentType: string, provider: string): void {
    this.lastProviderByAgent[agentType] = provider;
  }

  /** Provider picked last for an agent type, if any. */
  getLastProvider(agentType: string): string | undefined {
    return this.lastProviderByAgent[agentType];
  }

  /**
   * Apply a reward to a Beta prior for the given outcome.
   * Shared by provider-level and per-modelId learning so both surfaces use
   * exactly the same reward math (cost-adjusted success, partial credit for
   * escalation, penalties for failures). Returns the reward applied.
   */
  private applyReward(
    prior: BetaPrior,
    outcome: BanditOutcome,
    costScore: number,
    outcomeData?: Partial<BanditOutcomeData>,
  ): number {
    if (outcome === 'success') {
      let reward = costAdjustedSuccessReward(costScore);
      if (outcomeData?.qualityScore !== undefined) {
        reward += Math.max(-0.15, Math.min(0.2, (outcomeData.qualityScore - 0.5) * 0.2));
      }
      if (outcomeData?.testPassed === false) reward -= 0.1;
      if (outcomeData?.userAccepted === false) reward -= 0.1;
      if (outcomeData?.verificationPassed === false) reward -= 0.08;
      reward = Math.max(0.1, Math.min(0.9, reward));
      prior.alpha += reward;
      prior.beta += 1 - reward;
      return reward;
    }
    if (outcome === 'escalated') {
      let reward = 0.2;
      if (outcomeData?.verificationPassed === true) reward += 0.1;
      if (outcomeData?.qualityScore !== undefined) {
        reward += Math.max(-0.05, Math.min(0.05, (outcomeData.qualityScore - 0.5) * 0.05));
      }
      reward = Math.max(0.1, Math.min(0.9, reward));
      prior.alpha += reward;
      prior.beta += 1 - reward;
      return reward;
    }
    // failure — β++ (the model underperformed for this task type)
    let penalty = 0;
    if (outcomeData?.qualityScore !== undefined) {
      penalty += Math.max(0.05, Math.min(0.2, (0.5 - outcomeData.qualityScore) * 0.2));
    }
    if (outcomeData?.verificationPassed === false) penalty += 0.08;
    prior.beta += 1 + penalty;
    return 0;
  }

  /**
   * Update the bandit prior for a provider in the task's complexity bucket.
   * @param taskDescription Task text — complexity is re-derived with the SAME
   *                        analyzeComplexity path route() uses, so record-time
   *                        and select-time buckets always match.
   * @param outcome        success | failure | escalated
   * @param costScore      0–1 cost score of the provider (1 = cheapest). Drives
   *                       the cost-adjusted success reward. Default 0.5.
   * @param outcomeData    Optional richer outcome telemetry for the reward model.
   */
  recordOutcome(
    provider: string,
    taskDescription: string,
    outcome: BanditOutcome,
    costScore = 0.5,
    outcomeData?: Partial<BanditOutcomeData>,
    taskIntent?: string,
  ): void {
    const complexity = analyzeComplexity(taskDescription);
    this.recordOutcomeWithComplexity(provider, complexity, outcome, costScore, outcomeData, taskIntent);
  }

  /**
   * Update the bandit prior for a provider in an EXPLICIT complexity bucket.
   * Used when the plan's TaskStep.complexity (a subtask label) differs from
   * what re-analyzing the description would return — keeps select-time and
   * record-time buckets identical for subtask-local routing.
   */
  recordOutcomeWithComplexity(
    provider: string,
    complexity: ComplexityLevel,
    outcome: BanditOutcome,
    costScore = 0.5,
    outcomeData?: Partial<BanditOutcomeData>,
    taskIntent?: string,
  ): void {
    const key = this.bucketKey(complexity, taskIntent);
    const bucket = this.state.priors[key] ?? (this.state.priors[key] = {});
    const prior = bucket[provider] ?? (bucket[provider] = { alpha: 1, beta: 1 });
    const reward = this.applyReward(prior, outcome, costScore, outcomeData);

    this.state.learningHistory.push({
      provider,
      complexity,
      taskIntent,
      outcome,
      reward,
      latencyMs: outcomeData?.latencyMs,
      tokensUsed: outcomeData?.tokensUsed,
      costUsd: outcomeData?.costUsd,
      testPassed: outcomeData?.testPassed,
      qualityScore: outcomeData?.qualityScore,
      userAccepted: outcomeData?.userAccepted,
      verificationPassed: outcomeData?.verificationPassed,
      timestamp: new Date().toISOString(),
    });
    if (this.state.learningHistory.length > MAX_HISTORY) {
      this.state.learningHistory = this.state.learningHistory.slice(-MAX_HISTORY);
    }
    this.save();
  }

  /**
   * Update the bandit prior for a provider in the task's complexity bucket.

  /**
   * Update the PER-MODEL prior for a concrete model id in the task's complexity
   * bucket (mirror of ruflo's ADR-149 `priorsById` shadow state). Called by the
   * router alongside the provider-level recordOutcome so the model choice learns
   * which concrete model within a provider performs best.
   *
   * @param model          The concrete model id (e.g. 'llama-3.3-70b-versatile').
   * @param taskDescription Task text — complexity bucket re-derived identically.
   * @param outcome        success | failure | escalated
   * @param costScore      0–1 cost score of the model's provider (1 = cheapest).
   * @param outcomeData    Optional richer outcome telemetry for the reward model.
   */
  recordModelOutcome(
    model: string,
    taskDescription: string,
    outcome: BanditOutcome,
    costScore = 0.5,
    outcomeData?: Partial<BanditOutcomeData>,
    taskIntent?: string,
  ): void {
    const complexity = analyzeComplexity(taskDescription);
    this.recordModelOutcomeWithComplexity(model, complexity, outcome, costScore, outcomeData, taskIntent);
  }

  /**
   * Update the PER-MODEL prior for a concrete model id in an EXPLICIT
   * complexity bucket. Mirrors recordOutcomeWithComplexity for per-model
   * learning (ADR-149) so subtask labels stay consistent.
   */
  recordModelOutcomeWithComplexity(
    model: string,
    complexity: ComplexityLevel,
    outcome: BanditOutcome,
    costScore = 0.5,
    outcomeData?: Partial<BanditOutcomeData>,
    taskIntent?: string,
  ): void {
    const key = this.bucketKey(complexity, taskIntent);
    const bucket = this.state.modelPriors[key] ?? (this.state.modelPriors[key] = {});
    const prior = bucket[model] ?? (bucket[model] = { alpha: 1, beta: 1 });
    const reward = this.applyReward(prior, outcome, costScore, outcomeData);

    this.state.learningHistory.push({
      provider: model, // model-id surface; provider field keeps CLI history rendering
      model,
      complexity,
      taskIntent,
      outcome,
      reward,
      latencyMs: outcomeData?.latencyMs,
      tokensUsed: outcomeData?.tokensUsed,
      costUsd: outcomeData?.costUsd,
      testPassed: outcomeData?.testPassed,
      qualityScore: outcomeData?.qualityScore,
      userAccepted: outcomeData?.userAccepted,
      verificationPassed: outcomeData?.verificationPassed,
      timestamp: new Date().toISOString(),
    });
    if (this.state.learningHistory.length > MAX_HISTORY) {
      this.state.learningHistory = this.state.learningHistory.slice(-MAX_HISTORY);
    }
    this.save();
  }

  /**
   * Apply the DEFERRED half of `userAccepted: false` to the arms that served the
   * turn the user has just corrected.
   *
   * WHY DEFERRED. The user's verdict on a turn arrives with their NEXT message
   * ("still broken", "no change"), but bandit learning happens at the END of the
   * turn it describes — so the signal can never be part of that turn's own
   * observation. Reading the user's SILENCE as acceptance would be a fabricated
   * sample (exactly what this reward model refuses to do), so the turn is recorded
   * as it was and the rejection is applied when it actually arrives.
   *
   * Only a SUCCESS carries an un-applied penalty: the escalated and failure
   * branches of `applyReward` never read `userAccepted`, so a rejection of one of
   * those is already fully reflected and adds nothing.
   *
   * A rejection CORRECTS an existing arm and never creates one — a turn we never
   * recorded has nothing to correct.
   *
   * @returns True when a prior was actually moved.
   */
  recordUserRejection(
    provider: string,
    complexity: ComplexityLevel,
    outcome: BanditOutcome,
    taskIntent?: string,
    model?: string,
  ): boolean {
    if (outcome !== 'success') return false;
    const key = this.bucketKey(complexity, taskIntent);
    // Clamp α above zero: a Beta prior needs positive shape parameters, so a run of
    // rejections must never make an arm numerically invalid.
    const applyDelta = (prior: BetaPrior): void => {
      prior.alpha = Math.max(0.1, prior.alpha - USER_REJECTION_DELTA);
      prior.beta += USER_REJECTION_DELTA;
    };
    let moved = false;
    const providerPrior = this.state.priors[key]?.[provider];
    if (providerPrior) {
      applyDelta(providerPrior);
      moved = true;
    }
    if (model) {
      const modelPrior = this.state.modelPriors[key]?.[model];
      if (modelPrior) {
        applyDelta(modelPrior);
        moved = true;
      }
    }
    if (moved) this.save();
    return moved;
  }

  /**
   * Apply an EXPLICIT user verdict (`nuvira rate bad`, or the dashboard's 👎) to the
   * arms that served the trace it is about.
   *
   * WHY A SEPARATE ENTRY POINT. `recordUserRejection` applies the same deferred
   * delta for the DERIVED signal, but its attribution lives in the in-process
   * `pendingOutcome` slot: it is gone by the time the user rates a turn from the
   * CLI (or from the dashboard after the process ended). An explicit verdict names
   * a TRACE, so this reads the pair and complexity the trace recorded and corrects
   * the arm there — the same `α−δ / β+δ` a known verdict would have applied at
   * record time.
   *
   * COUNTED ONCE, EVER. The trace id is remembered, so a re-run — or a verdict
   * that follows a DERIVED rejection of the same turn — cannot move the arm twice.
   * The marker is written even when no arm existed, because a rejection CORRECTS an
   * existing arm and never creates one, and a second attempt must not suddenly
   * apply a delta the first deliberately did not.
   *
   * Only a SUCCESS carries an un-applied penalty: the escalated and failure
   * branches of `applyReward` never read `userAccepted`, so a rejection of one of
   * those is already fully reflected.
   */
  recordExplicitVerdict(input: {
    traceId: string;
    provider: string;
    complexity: ComplexityLevel;
    taskIntent?: string;
    model?: string;
    /** The outcome the turn's own evidence was recorded under (see `turnOutcomeObservation`). */
    outcome: BanditOutcome;
  }): { applied: boolean; alreadyApplied: boolean; moved: number; reason: string } {
    const noop = (reason: string, alreadyApplied = false) => ({
      applied: false,
      alreadyApplied,
      moved: 0,
      reason,
    });
    if (!input.traceId) return noop('no trace id to key the correction on');
    const done = this.state.correctedVerdicts ?? [];
    if (done.includes(input.traceId)) return noop('this verdict was already applied', true);
    if (input.outcome !== 'success') {
      return noop('the turn was not recorded as a success — its arm never read the verdict');
    }

    const keys = this.correctionKeys(input.provider, input.complexity, input.taskIntent);
    const applyDelta = (prior: BetaPrior): void => {
      // Clamp α above zero: a Beta prior needs positive shape parameters.
      prior.alpha = Math.max(0.1, prior.alpha - USER_REJECTION_DELTA);
      prior.beta += USER_REJECTION_DELTA;
    };
    let moved = 0;
    for (const key of keys) {
      const providerPrior = this.state.priors[key]?.[input.provider];
      if (providerPrior) {
        applyDelta(providerPrior);
        moved++;
      }
      if (input.model) {
        const modelPrior = this.state.modelPriors[key]?.[input.model];
        if (modelPrior) {
          applyDelta(modelPrior);
          moved++;
        }
      }
    }

    this.state.correctedVerdicts = [...done, input.traceId].slice(-MAX_CORRECTED_VERDICTS);
    this.save();
    return {
      applied: true,
      alreadyApplied: false,
      moved,
      reason: moved > 0 ? `moved ${moved} prior(s)` : 'no recorded arm for this pair yet',
    };
  }

  /**
   * The bucket keys whose arms could have served this turn, most precise first.
   *
   * The exact `intent:complexity` bucket is used when the trace carried the intent
   * (new traces do; see `TraceRoutingSnapshot.taskIntent`). When it did not — an
   * older trace — every bucket at the SAME complexity that already holds an entry
   * for the provider is corrected instead, because a correction that silently
   * no-ops is worse than one that lands on the buckets this pair could have served.
   */
  private correctionKeys(provider: string, complexity: ComplexityLevel, taskIntent?: string): string[] {
    const keys: string[] = [];
    if (taskIntent) {
      const exact = this.bucketKey(complexity, taskIntent);
      if (this.state.priors[exact]?.[provider]) keys.push(exact);
    } else if (this.state.priors[complexity]?.[provider]) {
      keys.push(complexity);
    }
    if (keys.length === 0) {
      for (const key of Object.keys(this.state.priors)) {
        if ((key === complexity || key.endsWith(`:${complexity}`)) && this.state.priors[key]?.[provider]) {
          keys.push(key);
        }
      }
    }
    return keys;
  }

  /**
   * Update the PER-MODEL prior for a concrete model id in the task's complexity

  /**
   * Thompson-sample a provider's deterministic score for a complexity bucket.
   * Cold-start Beta(1,1) → uniform draws, so expected behavior matches the
   * deterministic router; accumulated outcomes skew the sample up/down.
   */
  sampleScore(provider: string, complexity: ComplexityLevel, score: number, taskIntent?: string): number {
    const prior = this.getPrior(provider, complexity, taskIntent);
    // ISSUE-002: an untouched Beta(1,1) prior (no outcomes accumulated) means
    // there is NO learned data — a random uniform draw would randomize the
    // ranking on a cold start (a 0.9 provider could lose to a 0.5 one purely
    // by chance). Returning the prior MEAN (0.5) is deterministic AND scales
    // every provider identically, so a cold-start bandit preserves the
    // heuristic ordering exactly until real outcomes accumulate. The bandit
    // is now enabled by default, so this determinism is load-bearing.
    if (prior.alpha === 1 && prior.beta === 1) {
      return score * 0.5;
    }
    const theta = sampleBeta(prior.alpha, prior.beta);
    return score * theta;
  }

  /** Full state snapshot (for CLI display / tests). */
  getState(): RouterBanditState {
    return {
      version: this.state.version,
      priors: this.state.priors,
      modelPriors: this.state.modelPriors,
      learningHistory: [...this.state.learningHistory],
    };
  }

  /** Reset all state (used by tests and `nuvira model bandit reset`). */
  reset(): void {
    this.state = emptyState();
    this.lastProviderByAgent = {};
    this.lastModelByAgent = {};
    this.save();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let banditInstance: RouterBandit | null = null;

/** Get or create the RouterBandit singleton. */
export function getRouterBandit(): RouterBandit {
  if (!banditInstance) {
    banditInstance = new RouterBandit();
  }
  return banditInstance;
}

/** Reset the singleton (useful for testing). */
export function resetRouterBandit(): void {
  banditInstance = null;
}
