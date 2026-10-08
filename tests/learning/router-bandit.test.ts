/**
 * Tests for RouterBandit — bucketed Thompson-sampling bandit for Auto routing.
 *
 * Coverage:
 * - Gamma/Beta sampling (degenerate prior → neutral 0.5, valid range)
 * - Cost-adjusted success rewards (cheap provider success = highest α bump)
 * - recordOutcome prior updates (success / failure / escalated)
 * - Complexity-bucket isolation (learning is task-type-local)
 * - Persistence to BUFF_MEMORY_DIR (load/save round-trip, reset)
 * - noteDecision / getLastProvider for outcome wiring
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RouterBandit,
  resetRouterBandit,
  getRouterBandit,
  sampleBeta,
  sampleGamma,
  costAdjustedSuccessReward,
  USER_REJECTION_DELTA,
  COMPLEXITY_BUCKETS,
  type RouterBanditState,
} from '../../src/learning/router-bandit.js';

// ─── Sample isolation: point BUFF_MEMORY_DIR at a fresh temp dir ───────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-bandit-test-'));
  process.env.NUVIRA_MEMORY_DIR = tempDir;
  resetRouterBandit();
});

afterEach(() => {
  delete process.env.NUVIRA_MEMORY_DIR;
  resetRouterBandit();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Sampling primitives ───────────────────────────────────────────────────

describe('sampling primitives', () => {
  it('sampleGamma returns positive values for valid shapes', () => {
    for (let i = 0; i < 50; i++) {
      const g = sampleGamma(2);
      expect(g).toBeGreaterThan(0);
    }
  });

  it('sampleGamma handles degenerate shapes', () => {
    expect(sampleGamma(0)).toBe(0);
    expect(sampleGamma(-1)).toBe(0);
    expect(sampleGamma(0.5)).toBeGreaterThan(0);
  });

  it('sampleBeta returns 0.5 for degenerate priors', () => {
    expect(sampleBeta(0, 1)).toBe(0.5);
    expect(sampleBeta(1, 0)).toBe(0.5);
    expect(sampleBeta(0, 0)).toBe(0.5);
  });

  it('sampleBeta stays in (0,1) for valid priors', () => {
    for (let i = 0; i < 100; i++) {
      const t = sampleBeta(1, 1);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('sampleBeta(1,1) is unbiased around 0.5 on average', () => {
    let sum = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) sum += sampleBeta(1, 1);
    expect(sum / n).toBeGreaterThan(0.45);
    expect(sum / n).toBeLessThan(0.55);
  });
});

// ─── Cost-adjusted rewards ─────────────────────────────────────────────────

describe('costAdjustedSuccessReward', () => {
  it('rewards cheap providers most', () => {
    expect(costAdjustedSuccessReward(1.0)).toBeGreaterThan(costAdjustedSuccessReward(0.5));
    expect(costAdjustedSuccessReward(0.5)).toBeGreaterThan(costAdjustedSuccessReward(0.0));
  });

  it('stays within [0.1, 0.9]', () => {
    for (const c of [0, 0.2, 0.5, 0.8, 1]) {
      const r = costAdjustedSuccessReward(c);
      expect(r).toBeGreaterThanOrEqual(0.1);
      expect(r).toBeLessThanOrEqual(0.9);
    }
  });

  it('clamps out-of-range cost scores', () => {
    expect(costAdjustedSuccessReward(5)).toBe(0.9);
    expect(costAdjustedSuccessReward(-2)).toBe(0.1);
  });
});

// ─── recordOutcome prior updates ───────────────────────────────────────────

describe('recordOutcome', () => {
  it('success bumps alpha and beta together (total mass conserved)', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 0.85);
    const prior = bandit.getPrior('groq', 'moderate');
    // Beta(1,1) → reward r: α = 1 + r, β = 1 + (1 - r), so α + β = 3
    expect(prior.alpha).toBeGreaterThan(1);
    expect(prior.beta).toBeGreaterThan(1);
    expect(prior.alpha + prior.beta).toBeCloseTo(3, 5);
  });

  it('failure bumps only beta', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('gemini', 'implement a login form', 'failure');
    const prior = bandit.getPrior('gemini', 'moderate');
    expect(prior.beta).toBe(2);
    expect(prior.alpha).toBe(1);
  });

  it('escalation gives a small alpha bump', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('openrouter', 'implement a login form', 'escalated');
    const prior = bandit.getPrior('openrouter', 'moderate');
    expect(prior.alpha).toBeGreaterThan(1);
    expect(prior.alpha).toBeLessThan(1.5);
  });

  it('keeps learning local to the complexity bucket', () => {
    const bandit = new RouterBandit();
    // Success on a 'trivial' task should NOT change the 'critical' prior
    bandit.recordOutcome('groq', 'format this code', 'success', 1.0);
    const trivial = bandit.getPrior('groq', 'trivial');
    const critical = bandit.getPrior('groq', 'critical');
    expect(trivial.alpha).toBeGreaterThan(1);
    expect(critical).toEqual({ alpha: 1, beta: 1 });
  });

  it('cheap success bumps alpha more than expensive success', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    bandit.recordOutcome('openrouter', 'implement a login form', 'success', 0.1);
    const groq = bandit.getPrior('groq', 'moderate');
    const or = bandit.getPrior('openrouter', 'moderate');
    expect(groq.alpha).toBeGreaterThan(or.alpha);
  });

  it('bounded learning history', () => {
    const bandit = new RouterBandit();
    for (let i = 0; i < 250; i++) {
      bandit.recordOutcome('groq', `task number ${i}`, i % 2 === 0 ? 'success' : 'failure');
    }
    const state = bandit.getState();
    expect(state.learningHistory.length).toBeLessThanOrEqual(200);
  });

  it('uses richer outcome telemetry to adjust the reward signal', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 0.85, {
      qualityScore: 0.9,
      testPassed: true,
      userAccepted: true,
      verificationPassed: true,
    });
    const prior = bandit.getPrior('groq', 'moderate');
    expect(prior.alpha).toBeGreaterThan(1.8);
    expect(prior.beta).toBeLessThan(2.2);
    expect(bandit.getState().learningHistory[0].qualityScore).toBe(0.9);
  });

  it('penalizes negative verification outcomes in the reward model', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('openrouter', 'deploy to production', 'failure', 0.2, {
      qualityScore: 0.2,
      verificationPassed: false,
    });
    const prior = bandit.getPrior('openrouter', 'critical');
    expect(prior.beta).toBeGreaterThan(2);
  });
});

// ─── recordUserRejection (deferred userAccepted: false) ─────────────────────

describe('recordUserRejection', () => {
  it('applies the EXACT delta the success branch would have applied had it known', () => {
    const bandit = new RouterBandit();
    // Record a success WITHOUT the user verdict (how the real turn ends).
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    // Snapshot — `getPrior` returns the LIVE prior object, which the rejection mutates.
    const before = { ...bandit.getPrior('groq', 'moderate') };
    // The user's next message reports the turn still fails.
    const moved = bandit.recordUserRejection('groq', 'moderate', 'success');
    const after = bandit.getPrior('groq', 'moderate');
    expect(moved).toBe(true);
    expect(after.alpha).toBeCloseTo(before.alpha - USER_REJECTION_DELTA, 10);
    expect(after.beta).toBeCloseTo(before.beta + USER_REJECTION_DELTA, 10);
  });

  it('moves the per-model arm too when one served the turn', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 1.0);
    const before = { ...bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate') };
    bandit.recordUserRejection('groq', 'moderate', 'success', undefined, 'llama-3.3-70b-versatile');
    const after = bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate');
    expect(after.alpha).toBeCloseTo(before.alpha - USER_REJECTION_DELTA, 10);
    expect(after.beta).toBeCloseTo(before.beta + USER_REJECTION_DELTA, 10);
  });

  it('does NOTHING for a non-success outcome — those branches never read userAccepted', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('gemini', 'implement a login form', 'failure', 0.5);
    const before = { ...bandit.getPrior('gemini', 'moderate') };
    const moved = bandit.recordUserRejection('gemini', 'moderate', 'failure');
    const after = bandit.getPrior('gemini', 'moderate');
    expect(moved).toBe(false);
    expect(after.alpha).toBe(before.alpha);
    expect(after.beta).toBe(before.beta);
  });

  it('corrects an arm but never CREATES one', () => {
    const bandit = new RouterBandit();
    const moved = bandit.recordUserRejection('groq', 'moderate', 'success');
    expect(moved).toBe(false);
    // Nothing recorded → the prior must still be the untouched cold start.
    expect(bandit.getPrior('groq', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });

  it('clamps alpha above zero so a run of rejections cannot invalidate the Beta arm', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    for (let i = 0; i < 50; i++) bandit.recordUserRejection('groq', 'moderate', 'success');
    const prior = bandit.getPrior('groq', 'moderate');
    expect(prior.alpha).toBeGreaterThan(0);
    expect(prior.beta).toBeGreaterThan(1);
  });
});

// ─── sampleScore ───────────────────────────────────────────────────────────

describe('sampleScore', () => {
  it('cold start is DETERMINISTIC — untouched Beta(1,1) priors sample the mean (ISSUE-002)', () => {
    // The bandit is on by default now, so a cold start MUST NOT randomize the
    // heuristic ranking (a uniform draw would let a 0.5 provider beat a 0.9
    // one by chance). Untouched priors sample the mean (0.5), which scales
    // every provider identically → the deterministic ordering is preserved.
    const bandit = new RouterBandit();
    for (let i = 0; i < 20; i++) {
      const s = bandit.sampleScore('groq', 'moderate', 0.8);
      expect(s).toBe(0.4);
    }
  });

  it('a single recorded outcome breaks cold-start determinism (sampling resumes)', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    const values = new Set<number>();
    for (let i = 0; i < 20; i++) {
      values.add(bandit.sampleScore('groq', 'moderate', 0.8));
    }
    // With real data the draws vary (Thompson sampling) — not a constant mean.
    expect(values.size).toBeGreaterThan(1);
  });

  it('positive history skews the sample upward vs a fresh prior', () => {
    // IMPORTANT: instantiate `fresh` BEFORE training so it holds Beta(1,1)
    // in memory — RouterBandit loads persisted state at construction, and
    // recordOutcome() saves to the same BUFF_MEMORY_DIR file.
    const fresh = new RouterBandit();
    const trained = new RouterBandit();
    for (let i = 0; i < 100; i++) {
      trained.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    }
    let trainedSum = 0;
    let freshSum = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      trainedSum += trained.sampleScore('groq', 'moderate', 1);
      freshSum += fresh.sampleScore('groq', 'moderate', 1);
    }
    expect(trainedSum / n).toBeGreaterThan(freshSum / n);
  });
});

// ─── noteDecision / getLastProvider ────────────────────────────────────────

describe('noteDecision / getLastProvider', () => {
  it('tracks the last provider per agent type', () => {
    const bandit = new RouterBandit();
    bandit.noteDecision('planner', 'groq');
    bandit.noteDecision('writer', 'gemini');
    expect(bandit.getLastProvider('planner')).toBe('groq');
    expect(bandit.getLastProvider('writer')).toBe('gemini');
    expect(bandit.getLastProvider('chat')).toBeUndefined();
  });
});

// ─── Per-modelId learning (ruflo ADR-149 mirror) ───────────────────────────

describe('per-model learning (modelPriors)', () => {
  it('getModelPrior returns Beta(1,1) before any outcomes', () => {
    const bandit = new RouterBandit();
    expect(bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });

  it('noteModelDecision / getLastModel tracks the concrete model per agent type', () => {
    const bandit = new RouterBandit();
    bandit.noteModelDecision('writer', 'llama-3.3-70b-versatile');
    bandit.noteModelDecision('planner', 'gemini-2.5-flash');
    expect(bandit.getLastModel('writer')).toBe('llama-3.3-70b-versatile');
    expect(bandit.getLastModel('planner')).toBe('gemini-2.5-flash');
    expect(bandit.getLastModel('chat')).toBeUndefined();
  });

  it('recordModelOutcome updates the per-model prior in the right complexity bucket', () => {
    const bandit = new RouterBandit();
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 0.85);
    const prior = bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate');
    expect(prior.alpha).toBeGreaterThan(1);
    expect(prior.alpha + prior.beta).toBeCloseTo(3, 5);
    // Bucket isolation: other complexity buckets untouched
    expect(bandit.getModelPrior('llama-3.3-70b-versatile', 'trivial')).toEqual({ alpha: 1, beta: 1 });
  });

  it('recordModelOutcome failure bumps beta only', () => {
    const bandit = new RouterBandit();
    bandit.recordModelOutcome('gemini-2.5-flash', 'implement a login form', 'failure');
    const prior = bandit.getModelPrior('gemini-2.5-flash', 'moderate');
    expect(prior.beta).toBe(2);
    expect(prior.alpha).toBe(1);
  });

  it('model priors are independent of provider priors', () => {
    const bandit = new RouterBandit();
    // Same task, provider-level success for groq and model-level failure for a groq model
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);
    bandit.recordModelOutcome('openai/gpt-oss-20b', 'implement a login form', 'failure');
    expect(bandit.getPrior('groq', 'moderate').alpha).toBeGreaterThan(1);
    expect(bandit.getModelPrior('openai/gpt-oss-20b', 'moderate').beta).toBe(2);
    // The provider prior and the model prior are different surfaces
    expect(bandit.getModelPrior('groq', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });

  it('sampleModelScore cold start scales the deterministic score by a uniform draw', () => {
    const bandit = new RouterBandit();
    for (let i = 0; i < 20; i++) {
      const s = bandit.sampleModelScore('llama-3.3-70b-versatile', 'moderate', 0.8);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(0.8);
    }
  });

  it('accumulated model successes skew the per-model sample upward', () => {
    const fresh = new RouterBandit();
    const trained = new RouterBandit();
    for (let i = 0; i < 100; i++) {
      trained.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 1.0);
    }
    let trainedSum = 0;
    let freshSum = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      trainedSum += trained.sampleModelScore('llama-3.3-70b-versatile', 'moderate', 1);
      freshSum += fresh.sampleModelScore('llama-3.3-70b-versatile', 'moderate', 1);
    }
    expect(trainedSum / n).toBeGreaterThan(freshSum / n);
  });

  it('persists modelPriors to disk and reloads them', () => {
    const bandit = new RouterBandit();
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 0.85);
    resetRouterBandit();
    const reloaded = getRouterBandit();
    expect(reloaded.getModelPrior('llama-3.3-70b-versatile', 'moderate').alpha).toBeGreaterThan(1);
  });

  it('reset() clears model priors and last-model wiring', () => {
    const bandit = new RouterBandit();
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success');
    bandit.noteModelDecision('writer', 'llama-3.3-70b-versatile');
    bandit.reset();
    expect(bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate')).toEqual({ alpha: 1, beta: 1 });
    expect(bandit.getLastModel('writer')).toBeUndefined();
  });
});

// ─── Persistence ───────────────────────────────────────────────────────────

describe('persistence', () => {
  it('persists priors to BUFF_MEMORY_DIR and reloads them', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0);

    const statePath = join(tempDir, 'router-bandit.json');
    expect(existsSync(statePath)).toBe(true);
    const raw = readFileSync(statePath, 'utf-8');
    const saved = JSON.parse(raw) as RouterBanditState;
    expect(saved.priors['moderate']?.['groq']?.alpha).toBeGreaterThan(1);

    // New instance (fresh singleton path) should load the saved state
    resetRouterBandit();
    const reloaded = getRouterBandit();
    expect(reloaded.getPrior('groq', 'moderate').alpha).toBeGreaterThan(1);
  });

  it('reset() clears priors and history', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success');
    bandit.reset();
    expect(bandit.getPrior('groq', 'moderate')).toEqual({ alpha: 1, beta: 1 });
    expect(bandit.getState().learningHistory.length).toBe(0);
    expect(bandit.getLastProvider('planner')).toBeUndefined();
  });

  it('tolerates a corrupt state file', () => {
    writeFileSync(join(tempDir, 'router-bandit.json'), '{{{not json', 'utf-8');
    const bandit = new RouterBandit();
    expect(bandit.getPrior('groq', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });
});

// ─── Bucket coverage ───────────────────────────────────────────────────────

describe('COMPLEXITY_BUCKETS', () => {
  it('covers all router complexity levels', () => {
    expect(COMPLEXITY_BUCKETS).toContain('trivial');
    expect(COMPLEXITY_BUCKETS).toContain('simple');
    expect(COMPLEXITY_BUCKETS).toContain('moderate');
    expect(COMPLEXITY_BUCKETS).toContain('complex');
    expect(COMPLEXITY_BUCKETS).toContain('critical');
  });
});

// ─── Intent-aware bucketing (v3) ───────────────────────────────────────────
// Learning is bucketed by task INTENT *and* complexity so a provider's
// coding-session wins can never boost it for creative writing (the mis-routing
// that sent an essay to a 4-bit local model). Legacy callers WITHOUT an intent
// keep the plain complexity key — fully backward compatible.

describe('intent-aware bucketing (v3)', () => {
  it('records and reads priors under the intent-scoped bucket key', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    // Intent-scoped read finds the learned prior
    expect(bandit.getPrior('groq', 'moderate', 'coding').alpha).toBeGreaterThan(1);
    // The legacy (no-intent) bucket stays untouched — coding wins must never
    // leak into the generic prior surface.
    expect(bandit.getPrior('groq', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });

  it('isolates learning across task intents', () => {
    const bandit = new RouterBandit();
    // Successes on coding tasks for groq, failures on creative tasks for groq
    for (let i = 0; i < 20; i++) {
      bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    }
    bandit.recordOutcome('groq', 'write an essay about elephants', 'failure', 1.0, undefined, 'creative');

    const coding = bandit.getPrior('groq', 'moderate', 'coding');
    const creative = bandit.getPrior('groq', 'moderate', 'creative');
    // Coding wins made groq look great for coding (20 successes @ cost 1.0 →
    // α = 1 + 20·0.9 = 19, β = 1 + 20·0.1 = 3 → win rate ≈ 0.86)…
    expect(coding.alpha / (coding.alpha + coding.beta)).toBeGreaterThan(0.85);
    // …but the creative bucket records ONLY the creative failure
    expect(creative.beta).toBe(2);
    expect(creative.alpha).toBe(1);
  });

  it('legacy no-intent callers still use the plain complexity key', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('gemini', 'implement a login form', 'success', 1.0);
    // No intent passed → plain key (backward compatible with v2 data/tests)
    expect(bandit.getPrior('gemini', 'moderate').alpha).toBeGreaterThan(1);
    expect(bandit.getPrior('gemini', 'moderate', 'coding')).toEqual({ alpha: 1, beta: 1 });
  });

  it('stamps taskIntent on learning history entries', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'write an essay', 'failure', 1.0, undefined, 'creative');
    const entry = bandit.getState().learningHistory[0];
    expect(entry.taskIntent).toBe('creative');
    expect(entry.complexity).toBe('moderate'); // analyzeComplexity('write an essay')
  });

  it('per-model priors are intent-bucketed too', () => {
    const bandit = new RouterBandit();
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 0.85, undefined, 'coding');
    expect(bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate', 'coding').alpha).toBeGreaterThan(1);
    expect(bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate')).toEqual({ alpha: 1, beta: 1 });
  });

  it('sampleScore uses the intent-scoped prior when provided', () => {
    const bandit = new RouterBandit();
    // Seed MANY failures (not one): a single Thompson draw from Beta(1,~2)
    // exceeds 0.5 ~25% of the time — genuinely flaky. With 30 failures the
    // prior is Beta(1, 31): P(draw > 0.5) = 0.5^31 ≈ 5e-10, effectively
    // deterministic while still exercising the sampled path.
    for (let i = 0; i < 30; i++) {
      bandit.recordOutcome('groq', 'implement a login form', 'failure', 1.0, undefined, 'coding');
    }
    // Failures bumped β in the INTENT bucket → mean far below 0.5 → the
    // intent-scoped sample must land below the neutral 0.5.
    const prior = bandit.getPrior('groq', 'moderate', 'coding');
    expect(prior.beta).toBeGreaterThan(1);
    const sampled = bandit.sampleScore('groq', 'moderate', 1, 'coding');
    expect(sampled).toBeLessThan(0.5);
  });
});

/**
 * fix_model_routing P6 — NEGATIVE REWARD for a step-level failure.
 *
 * The ungrounded "bandit-learned" score had a second half: the bandit only ever
 * heard about whole-TASK outcomes, so the failure that actually killed runs — a
 * model resolving a step with nothing usable — taught it nothing. Its prior kept
 * sampling the same dead arm back to the top, which is precisely how a model that
 * returned five empty responses in a row outranked one that had just worked.
 */
describe('RouterBandit.penalizeModel — empties are evidence, not silence', () => {
  it('punishes the model in the arm the ROUTER samples (intent-aware bucket)', () => {
    const bandit = getRouterBandit();
    bandit.reset();
    const before = bandit.getModelPrior('gemma-4-26b-a4b-it', 'moderate' as never, 'coding');

    bandit.penalizeModel('gemma-4-26b-a4b-it', 'moderate' as never, 'coding');

    const after = bandit.getModelPrior('gemma-4-26b-a4b-it', 'moderate' as never, 'coding');
    expect(after.beta).toBe(before.beta + 1);
    expect(after.alpha).toBe(before.alpha);
    // …and the router can now SEE that it has data (no longer a cold-start arm).
    expect(
      bandit.hasLearnedData('gemini', 'moderate' as never, 'coding', 'gemma-4-26b-a4b-it'),
    ).toBe(true);
  });

  it('repeated empties drive the sampled expectation DOWN', () => {
    const bandit = getRouterBandit();
    bandit.reset();
    const mean = () => {
      const p = bandit.getModelPrior('broken', 'moderate' as never);
      return p.alpha / (p.alpha + p.beta);
    };
    bandit.penalizeModel('broken', 'moderate' as never);
    const once = mean();
    for (let i = 0; i < 5; i++) bandit.penalizeModel('broken', 'moderate' as never);
    expect(mean()).toBeLessThan(once);
    expect(mean()).toBeLessThan(0.5);
  });

  it('with no bucket supplied, penalizes every arm that knows the model (never invents arms)', () => {
    const bandit = getRouterBandit();
    bandit.reset();
    bandit.recordModelOutcomeWithComplexity('broken', 'moderate' as never, 'success', 0.5, undefined, 'coding');
    bandit.penalizeModel('broken');
    const coding = bandit.getModelPrior('broken', 'moderate' as never, 'coding');
    expect(coding.beta).toBeGreaterThan(1);
    // A bucket with no entry for the model is left alone — and no new one appears
    // for an unrelated intent.
    expect(bandit.getModelPrior('broken', 'simple' as never, 'research')).toEqual({ alpha: 1, beta: 1 });
  });

  it('records the failure in history, so the store reflects that learning happened', () => {
    const bandit = getRouterBandit();
    bandit.reset();
    bandit.penalizeModel('broken', 'moderate' as never);
    const history = bandit.getState().learningHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ model: 'broken', outcome: 'failure', reward: 0 });
    // A fresh write means the staleness guard is not fooled into thinking the
    // store is old.
    expect(bandit.isStale()).toBe(false);
  });

  it('never records anything for a placeholder id', () => {
    const bandit = getRouterBandit();
    bandit.reset();
    bandit.penalizeModel('default');
    bandit.penalizeModel('');
    expect(bandit.getState().learningHistory).toHaveLength(0);
    expect(bandit.getModelPrior('default', 'moderate' as never)).toEqual({ alpha: 1, beta: 1 });
  });
});

// ─── recordExplicitVerdict (Bundle 36 — an EXPLICIT rate reaches the router) ──

/**
 * The derived rejection already reached the bandit through `pendingOutcome`; an
 * explicit `nuvira rate bad` runs in its OWN process, so it corrects the arm from
 * the trace instead — once per trace, whatever the outcome branch allows.
 */
describe('recordExplicitVerdict', () => {
  it('moves the provider arm by the same delta the derived path would', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...bandit.getPrior('groq', 'moderate' as never, 'coding') };
    const res = bandit.recordExplicitVerdict({
      traceId: 'trace-1',
      provider: 'groq',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      outcome: 'success',
    });
    expect(res.applied).toBe(true);
    expect(res.moved).toBe(1);
    const after = bandit.getPrior('groq', 'moderate' as never, 'coding');
    expect(after.alpha).toBeCloseTo(before.alpha - USER_REJECTION_DELTA, 10);
    expect(after.beta).toBeCloseTo(before.beta + USER_REJECTION_DELTA, 10);
  });

  it('is applied ONCE per trace — re-rating cannot move the arm twice', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const input = {
      traceId: 'trace-once',
      provider: 'groq',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      outcome: 'success' as const,
    };
    bandit.recordExplicitVerdict(input);
    const afterFirst = { ...bandit.getPrior('groq', 'moderate' as never, 'coding') };
    const second = bandit.recordExplicitVerdict(input);
    expect(second.applied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(bandit.getPrior('groq', 'moderate' as never, 'coding')).toEqual(afterFirst);
  });

  it('corrects an arm but never CREATES one, and remembers so it is not retried', () => {
    const bandit = new RouterBandit();
    const res = bandit.recordExplicitVerdict({
      traceId: 'trace-no-arm',
      provider: 'groq',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      outcome: 'success',
    });
    expect(res.applied).toBe(true);
    expect(res.moved).toBe(0);
    expect(bandit.getPrior('groq', 'moderate' as never, 'coding')).toEqual({ alpha: 1, beta: 1 });
    // Even after an arm later appears, this verdict must not be applied on a re-rate.
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...bandit.getPrior('groq', 'moderate' as never, 'coding') };
    const second = bandit.recordExplicitVerdict({
      traceId: 'trace-no-arm',
      provider: 'groq',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      outcome: 'success',
    });
    expect(second.alreadyApplied).toBe(true);
    expect(bandit.getPrior('groq', 'moderate' as never, 'coding')).toEqual(before);
  });

  it('does NOTHING for a non-success outcome (those branches never read the verdict)', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('gemini', 'implement a login form', 'failure', 0.5, undefined, 'coding');
    const before = { ...bandit.getPrior('gemini', 'moderate' as never, 'coding') };
    const res = bandit.recordExplicitVerdict({
      traceId: 'trace-fail',
      provider: 'gemini',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      outcome: 'failure',
    });
    expect(res.applied).toBe(false);
    expect(bandit.getPrior('gemini', 'moderate' as never, 'coding')).toEqual(before);
    expect(bandit.getState().correctedVerdicts ?? []).not.toContain('trace-fail');
  });

  it('without the intent, corrects every bucket at that complexity that knows the provider', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    bandit.recordOutcome('groq', 'write an essay', 'success', 1.0, undefined, 'creative');
    const codingBefore = { ...bandit.getPrior('groq', 'moderate' as never, 'coding') };
    const creativeBefore = { ...bandit.getPrior('groq', 'moderate' as never, 'creative') };
    const res = bandit.recordExplicitVerdict({
      traceId: 'trace-no-intent',
      provider: 'groq',
      complexity: 'moderate' as never,
      outcome: 'success',
    });
    expect(res.moved).toBe(2);
    expect(bandit.getPrior('groq', 'moderate' as never, 'coding').alpha).toBeCloseTo(
      codingBefore.alpha - USER_REJECTION_DELTA,
      10,
    );
    expect(bandit.getPrior('groq', 'moderate' as never, 'creative').alpha).toBeCloseTo(
      creativeBefore.alpha - USER_REJECTION_DELTA,
      10,
    );
    // A DIFFERENT complexity is untouched.
    expect(bandit.getPrior('groq', 'simple' as never, 'coding')).toEqual({ alpha: 1, beta: 1 });
  });

  it('moves the per-model arm too when the trace named the model', () => {
    const bandit = new RouterBandit();
    bandit.recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    bandit.recordModelOutcome('llama-3.3-70b-versatile', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate' as never, 'coding') };
    const res = bandit.recordExplicitVerdict({
      traceId: 'trace-model',
      provider: 'groq',
      complexity: 'moderate' as never,
      taskIntent: 'coding',
      model: 'llama-3.3-70b-versatile',
      outcome: 'success',
    });
    expect(res.moved).toBe(2);
    const after = bandit.getModelPrior('llama-3.3-70b-versatile', 'moderate' as never, 'coding');
    expect(after.alpha).toBeCloseTo(before.alpha - USER_REJECTION_DELTA, 10);
    expect(after.beta).toBeCloseTo(before.beta + USER_REJECTION_DELTA, 10);
  });
});
