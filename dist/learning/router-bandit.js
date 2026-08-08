/**
 * RouterBandit — bucketed Thompson-sampling bandit for Auto model routing.
 *
 * Inspired by ruflo's `model-router.ts` (Beta-Bernoulli Thompson sampling)
 * and generalized beyond 3 Claude tiers to agent-nuvira's full provider set.
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
 * Persisted to ~/.buff/memory/router-bandit.json (respects BUFF_MEMORY_DIR).
 * All writes are best-effort — a failed write must never break routing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { analyzeComplexity } from './hybrid-router.js';
/**
 * Minimum accumulated samples (α+β) before a prior is considered "learned".
 * Priors below this have essentially no data — bandit routing treats them as
 * unlearned and (when enabled) escalates to a provider/model that has data.
 */
export const DEFAULT_MIN_SAMPLES = 8;
/** The complexity buckets the bandit learns per provider. */
export const COMPLEXITY_BUCKETS = [
    'trivial',
    'simple',
    'moderate',
    'complex',
    'critical',
];
// ─── Storage ────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 2; // v2 = adds per-modelId modelPriors (ADR-149 mirror)
const MAX_HISTORY = 200;
function memoryDir() {
    return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}
function statePath() {
    return join(memoryDir(), 'router-bandit.json');
}
function emptyState() {
    return { version: CURRENT_VERSION, priors: {}, modelPriors: {}, learningHistory: [] };
}
// ─── Sampling (Marsaglia–Tsang gamma + Beta via gamma ratio) ────────────────
/** Standard normal via Box–Muller. */
export function standardNormal() {
    let u = 0;
    let v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/**
 * Sample from Gamma(shape, scale=1) using the Marsaglia–Tsang method.
 * Handles shape < 1 with the GS transform (Gamma(shape+1) · U^(1/shape)).
 */
export function sampleGamma(shape) {
    if (shape <= 0)
        return 0;
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
        if (u < 1 - 0.0331 * x * x * x * x)
            return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v)))
            return d * v;
    }
}
/**
 * Sample from Beta(α, β) using the gamma-ratio identity X/(X+Y).
 * Degenerate priors (α ≤ 0 or β ≤ 0) return the neutral midpoint 0.5.
 */
export function sampleBeta(alpha, beta) {
    if (alpha <= 0 || beta <= 0)
        return 0.5;
    const x = sampleGamma(alpha);
    const y = sampleGamma(beta);
    if (x + y === 0)
        return 0.5;
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
export function costAdjustedSuccessReward(costScore) {
    const c = Math.max(0, Math.min(1, costScore));
    return 0.1 + 0.8 * c;
}
// ─── RouterBandit ───────────────────────────────────────────────────────────
export class RouterBandit {
    state;
    /** Provider chosen by the last resolve() per agent type (for outcome wiring). */
    lastProviderByAgent = {};
    /** Concrete model chosen by the last resolve() per agent type (for per-model learning). */
    lastModelByAgent = {};
    constructor() {
        this.state = this.load();
    }
    /** Load persisted state (best-effort). */
    load() {
        try {
            if (!existsSync(statePath()))
                return emptyState();
            const raw = readFileSync(statePath(), 'utf-8');
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object' || !data.priors)
                return emptyState();
            // Version comes from the file when present; emptyState() supplies defaults
            return { ...emptyState(), ...data };
        }
        catch {
            return emptyState();
        }
    }
    save() {
        try {
            if (!existsSync(memoryDir()))
                mkdirSync(memoryDir(), { recursive: true });
            writeFileSync(statePath(), JSON.stringify(this.state, null, 2), 'utf-8');
        }
        catch {
            // Best-effort — never break routing on a failed write.
        }
    }
    /** Get the Beta prior for a model in a complexity bucket (per-model learning). */
    getModelPrior(model, complexity) {
        return this.state.modelPriors[complexity]?.[model] ?? { alpha: 1, beta: 1 };
    }
    /** Note the concrete model picked for an agent type (per-model outcome wiring). */
    noteModelDecision(agentType, model) {
        this.lastModelByAgent[agentType] = model;
    }
    /** Concrete model picked last for an agent type, if any. */
    getLastModel(agentType) {
        return this.lastModelByAgent[agentType];
    }
    /**
     * Thompson-sample a model's score for a complexity bucket using its
     * per-model prior. Cold-start Beta(1,1) → uniform draw, so the model choice
     * behaves deterministically until per-model outcomes accumulate.
     */
    sampleModelScore(model, complexity, score) {
        const prior = this.getModelPrior(model, complexity);
        const theta = sampleBeta(prior.alpha, prior.beta);
        return score * theta;
    }
    /** Get the Beta prior for a provider in a complexity bucket. */
    getPrior(provider, complexity) {
        return this.state.priors[complexity]?.[provider] ?? { alpha: 1, beta: 1 };
    }
    /** Note the provider picked for an agent type (for recordOutcome wiring). */
    noteDecision(agentType, provider) {
        this.lastProviderByAgent[agentType] = provider;
    }
    /** Provider picked last for an agent type, if any. */
    getLastProvider(agentType) {
        return this.lastProviderByAgent[agentType];
    }
    /**
     * Apply a reward to a Beta prior for the given outcome.
     * Shared by provider-level and per-modelId learning so both surfaces use
     * exactly the same reward math (cost-adjusted success, partial credit for
     * escalation, penalties for failures). Returns the reward applied.
     */
    applyReward(prior, outcome, costScore, outcomeData) {
        if (outcome === 'success') {
            let reward = costAdjustedSuccessReward(costScore);
            if (outcomeData?.qualityScore !== undefined) {
                reward += Math.max(-0.15, Math.min(0.2, (outcomeData.qualityScore - 0.5) * 0.2));
            }
            if (outcomeData?.testPassed === false)
                reward -= 0.1;
            if (outcomeData?.userAccepted === false)
                reward -= 0.1;
            if (outcomeData?.verificationPassed === false)
                reward -= 0.08;
            reward = Math.max(0.1, Math.min(0.9, reward));
            prior.alpha += reward;
            prior.beta += 1 - reward;
            return reward;
        }
        if (outcome === 'escalated') {
            let reward = 0.2;
            if (outcomeData?.verificationPassed === true)
                reward += 0.1;
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
        if (outcomeData?.verificationPassed === false)
            penalty += 0.08;
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
    recordOutcome(provider, taskDescription, outcome, costScore = 0.5, outcomeData) {
        const complexity = analyzeComplexity(taskDescription);
        this.recordOutcomeWithComplexity(provider, complexity, outcome, costScore, outcomeData);
    }
    /**
     * Update the bandit prior for a provider in an EXPLICIT complexity bucket.
     * Used when the plan's TaskStep.complexity (a subtask label) differs from
     * what re-analyzing the description would return — keeps select-time and
     * record-time buckets identical for subtask-local routing.
     */
    recordOutcomeWithComplexity(provider, complexity, outcome, costScore = 0.5, outcomeData) {
        const bucket = this.state.priors[complexity] ?? (this.state.priors[complexity] = {});
        const prior = bucket[provider] ?? (bucket[provider] = { alpha: 1, beta: 1 });
        const reward = this.applyReward(prior, outcome, costScore, outcomeData);
        this.state.learningHistory.push({
            provider,
            complexity,
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
    recordModelOutcome(model, taskDescription, outcome, costScore = 0.5, outcomeData) {
        const complexity = analyzeComplexity(taskDescription);
        this.recordModelOutcomeWithComplexity(model, complexity, outcome, costScore, outcomeData);
    }
    /**
     * Update the PER-MODEL prior for a concrete model id in an EXPLICIT
     * complexity bucket. Mirrors recordOutcomeWithComplexity for per-model
     * learning (ADR-149) so subtask labels stay consistent.
     */
    recordModelOutcomeWithComplexity(model, complexity, outcome, costScore = 0.5, outcomeData) {
        const bucket = this.state.modelPriors[complexity] ?? (this.state.modelPriors[complexity] = {});
        const prior = bucket[model] ?? (bucket[model] = { alpha: 1, beta: 1 });
        const reward = this.applyReward(prior, outcome, costScore, outcomeData);
        this.state.learningHistory.push({
            provider: model, // model-id surface; provider field keeps CLI history rendering
            model,
            complexity,
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
     * Update the PER-MODEL prior for a concrete model id in the task's complexity
  
    /**
     * Thompson-sample a provider's deterministic score for a complexity bucket.
     * Cold-start Beta(1,1) → uniform draws, so expected behavior matches the
     * deterministic router; accumulated outcomes skew the sample up/down.
     */
    sampleScore(provider, complexity, score) {
        const prior = this.getPrior(provider, complexity);
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
    getState() {
        return {
            version: this.state.version,
            priors: this.state.priors,
            modelPriors: this.state.modelPriors,
            learningHistory: [...this.state.learningHistory],
        };
    }
    /** Reset all state (used by tests and `buff model bandit reset`). */
    reset() {
        this.state = emptyState();
        this.lastProviderByAgent = {};
        this.lastModelByAgent = {};
        this.save();
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let banditInstance = null;
/** Get or create the RouterBandit singleton. */
export function getRouterBandit() {
    if (!banditInstance) {
        banditInstance = new RouterBandit();
    }
    return banditInstance;
}
/** Reset the singleton (useful for testing). */
export function resetRouterBandit() {
    banditInstance = null;
}
//# sourceMappingURL=router-bandit.js.map