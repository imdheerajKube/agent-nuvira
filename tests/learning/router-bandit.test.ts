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
  COMPLEXITY_BUCKETS,
  type RouterBanditState,
} from '../../src/learning/router-bandit.js';

// ─── Sample isolation: point BUFF_MEMORY_DIR at a fresh temp dir ───────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-bandit-test-'));
  process.env.BUFF_MEMORY_DIR = tempDir;
  resetRouterBandit();
});

afterEach(() => {
  delete process.env.BUFF_MEMORY_DIR;
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
