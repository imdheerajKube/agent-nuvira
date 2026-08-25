/**
 * Tests for the ML task-similarity router (ruflo neural-router analog).
 *
 * Covers the two pieces that must be provably correct:
 * 1. Feature extraction + similarity — the hashing is deterministic, similar
 *    tasks land closer than unrelated ones, and the intent/complexity tail
 *    carries the same bucketing the bandit learns by.
 * 2. learnedScores() — cold start is neutral, min-samples guards trust, and
 *    the factor is strength-clamped so a raw win rate can never overturn a
 *    large deterministic edge on its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MLRouter,
  extractFeatures,
  cosineSimilarity,
  DEFAULT_ML_MIN_SAMPLES,
  DEFAULT_ML_STRENGTH,
} from '../../src/learning/ml-router.js';

// Isolate persistence: route the memory dir to a temp path per test.
const TEST_MEMORY_DIR = '/tmp/ml-router-test-' + Date.now();

describe('ml-router — feature extraction & similarity', () => {
  it('is deterministic across calls (same task → same vector)', () => {
    const a = extractFeatures('implement JWT authentication with refresh tokens');
    const b = extractFeatures('implement JWT authentication with refresh tokens');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('similar tasks land closer than unrelated ones', () => {
    const login = extractFeatures('implement JWT authentication with refresh tokens');
    const login2 = extractFeatures('implement JWT auth and refresh token rotation');
    const unrelated = extractFeatures('deploy a kubernetes cluster to production');
    expect(cosineSimilarity(login, login2)).toBeGreaterThan(cosineSimilarity(login, unrelated));
  });

  it('carries complexity + intent into the feature tail (bandit-consistent bucketing)', () => {
    const a = extractFeatures('write an essay', 'moderate', 'creative');
    const b = extractFeatures('write an essay', 'moderate', 'creative');
    const c = extractFeatures('write an essay', 'moderate', 'coding');
    expect(a).toEqual(b);
    // Different intent → different tail bucket → different vector.
    expect(new Set(a).size === new Set(c).size ? !a.every((v, i) => v === c[i]) : true).toBe(true);
    expect(cosineSimilarity(a, c)).toBeLessThan(1);
  });
});

describe('ml-router — learnedScores', () => {
  let ml: MLRouter;

  beforeEach(() => {
    vi.stubEnv('NUVIRA_MEMORY_DIR', TEST_MEMORY_DIR);
    ml = new MLRouter();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      const { rmSync } = require('node:fs');
      rmSync(TEST_MEMORY_DIR, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it('cold start is NEUTRAL — all factors 1.0, none trusted', () => {
    const scores = ml.learnedScores('implement a login form', ['groq', 'gemini']);
    for (const p of ['groq', 'gemini']) {
      const s = scores.get(p)!;
      expect(s.factor).toBe(1);
      expect(s.trusted).toBe(false);
    }
  });

  it('a provider that succeeded on similar tasks gets a boost (trusted after min samples)', () => {
    // Seed 5 successes for groq on very similar tasks (>= DEFAULT_ML_MIN_SAMPLES).
    for (let i = 0; i < DEFAULT_ML_MIN_SAMPLES; i++) {
      ml.record('implement JWT authentication with refresh tokens', 'groq', 'llama-3.3-70b', 'success', 0.85, 'writer', 'moderate', 'coding');
    }
    // A couple of failures for gemini on the same family.
    for (let i = 0; i < 3; i++) {
      ml.record('implement JWT authentication with refresh tokens', 'gemini', 'gemini-2.0-flash', 'failure', 0.4, 'writer', 'moderate', 'coding');
    }

    const scores = ml.learnedScores('implement JWT auth with refresh tokens', ['groq', 'gemini']);
    const groq = scores.get('groq')!;
    const gemini = scores.get('gemini')!;
    expect(groq.trusted).toBe(true);
    expect(groq.winRate).toBeGreaterThan(0.5);
    expect(groq.factor).toBeGreaterThan(1);
    // Gemini has only 3 samples < minSamples(5) → not trusted, neutral.
    expect(gemini.trusted).toBe(false);
    expect(gemini.factor).toBe(1);
  });

  it('factor is strength-clamped — a 100% win rate cannot exceed 1 + strength/2', () => {
    for (let i = 0; i < 10; i++) {
      ml.record('implement JWT authentication', 'groq', 'm', 'success', 0.9, 'writer', 'moderate', 'coding');
    }
    const scores = ml.learnedScores('implement JWT authentication', ['groq']);
    const s = scores.get('groq')!;
    expect(s.winRate).toBe(1);
    expect(s.factor).toBeCloseTo(1 + DEFAULT_ML_STRENGTH * 0.5, 5);
  });

  it('persists records and reloads them (state survives a restart)', () => {
    ml.record('implement a login form', 'groq', 'llama-3.3-70b', 'success', 0.9, 'writer', 'simple', 'coding');
    ml.record('implement a login form', 'groq', 'llama-3.3-70b', 'success', 0.9, 'writer', 'simple', 'coding');
    expect(ml.size()).toBe(2);

    const reloaded = new MLRouter();
    expect(reloaded.size()).toBe(2);
    const scores = reloaded.learnedScores('implement a login form', ['groq']);
    expect(scores.get('groq')!.samples).toBeGreaterThanOrEqual(2);
  });

  it('reset() wipes learned state', () => {
    ml.record('x', 'groq', 'm', 'success', 0.9, 'writer', 'simple', 'coding');
    ml.reset();
    expect(ml.size()).toBe(0);
    const scores = ml.learnedScores('x', ['groq']);
    expect(scores.get('groq')!.trusted).toBe(false);
  });
});
