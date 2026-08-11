import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  matchExplainRule,
  matchContinueRule,
  matchFixRule,
  matchConfigureRule,
  matchCreateRule,
  extractTimeRange,
  RULE_TRUST_THRESHOLD,
  type IntentResult,
} from '../../src/nlu/intent.js';

/** Deterministic "today" so temporal tests never depend on wall-clock time. */
const REF = new Date('2026-08-09T12:00:00Z');

// ─── Rule matrix ────────────────────────────────────────────────────────────

const RULE_MATRIX: Array<[string, IntentResult]> = [
  // create → dev
  ['create a new CLI tool', { intent: 'create', confidence: 0.9, modeHint: 'dev' }],
  ['please implement JWT auth', { intent: 'create', confidence: 0.9, modeHint: 'dev' }],
  ['build an api', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['write a test', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['I want to create a new module', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  // continue → recall
  ["continue last week's ecommerce plan", { intent: 'continue', confidence: 0.95, modeHint: 'recall' }],
  ['resume the migration', { intent: 'continue', confidence: 0.9, modeHint: 'recall' }],
  ['pick up where I left off', { intent: 'continue', confidence: 0.9, modeHint: 'recall' }],
  // fix → execute
  ['fix the login bug', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  ['debug the failing test', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  ['resolve the merge conflict', { intent: 'fix', confidence: 0.85, modeHint: 'execute' }],
  // explain → chat
  ['explain how caching works', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['assess the current state of the project', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['evaluate whether the migration is safe', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['analyze the performance of the query', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['compare the two approaches', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['how do I add JWT auth to Express?', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  ['what is the difference between arrays and lists', { intent: 'explain', confidence: 0.8, modeHint: 'chat' }],
  // "add" — the most common developer phrasing (article or project-object only,
  // never bare verb-initial, so "add 2 + 2" stays out of dev mode)
  ['add a route to the express app', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  ['add error handling to the api', { intent: 'create', confidence: 0.85, modeHint: 'dev' }],
  // configure → config
  ['configure the gemini api key', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
  ['switch provider to groq', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
  ['change model for this project', { intent: 'configure', confidence: 0.85, modeHint: 'config' }],
];

describe('classifyIntent — rule matrix', () => {
  it.each(RULE_MATRIX)('classifies %j', (text, expected) => {
    const result = classifyIntent(text, REF);
    expect(result.intent).toBe(expected.intent);
    expect(result.modeHint).toBe(expected.modeHint);
    expect(result.confidence).toBe(expected.confidence);
  });

  it('prioritizes explain over create for "how to build" questions', () => {
    const result = classifyIntent('how do I build a website?', REF);
    expect(result.intent).toBe('explain');
    expect(result.modeHint).toBe('chat');
  });

  it('prioritizes continue over create for "continue building"', () => {
    const result = classifyIntent('continue building the app', REF);
    expect(result.intent).toBe('continue');
    expect(result.modeHint).toBe('recall');
  });

  it('never false-positives "the build failed" into create', () => {
    const result = classifyIntent('the build failed with a syntax error', REF);
    expect(result.intent).not.toBe('create');
  });

  it('never false-positives "make sure tests pass" into create', () => {
    const result = classifyIntent('make sure the tests pass before merging', REF);
    expect(result.intent).not.toBe('create');
  });

  it('never false-positives arithmetic "add" into create', () => {
    const result = classifyIntent('please add 2 + 2 and explain', REF);
    expect(result.intent).toBe('explain');
  });

  it('classifies "create a config file" as create, not configure', () => {
    const result = classifyIntent('create a config file', REF);
    expect(result.intent).toBe('create');
    expect(result.modeHint).toBe('dev');
  });

  it('still classifies "configure the gemini api key" as configure', () => {
    const result = classifyIntent('configure the gemini api key', REF);
    expect(result.intent).toBe('configure');
    expect(result.modeHint).toBe('config');
  });

  it('treats the empty string as unknown', () => {
    const result = classifyIntent('   ', REF);
    expect(result).toEqual({ intent: 'unknown', confidence: 0, modeHint: null });
  });
});

// ─── Unknown → confidence 0 (never a guess) ─────────────────────────────────

describe('classifyIntent — unknown contract', () => {
  it.each(['hello there', 'thanks!', 'random gibberish 42'])(
    'returns confidence 0 for %j',
    (text) => {
      const result = classifyIntent(text, REF);
      expect(result.intent).toBe('unknown');
      expect(result.confidence).toBe(0);
      expect(result.modeHint).toBeNull();
      expect(result.timeRange).toBeUndefined();
    },
  );
});

// ─── Temporal extraction ────────────────────────────────────────────────────

describe('extractTimeRange', () => {
  it("extracts a date range for 'last week'", () => {
    const range = extractTimeRange("continue last week's ecommerce plan", REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('last week');
    expect(range!.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range!.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(range!.timex).toMatch(/^\d{4}-W\d{2}$/); // ISO week notation
  });

  it("extracts a point date for 'yesterday'", () => {
    const range = extractTimeRange('continue yesterday work', REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('yesterday');
    expect(range!.start).toBe('2026-08-08');
  });

  it("extracts a point date for '2 days ago'", () => {
    const range = extractTimeRange('resume the plan from 2 days ago', REF);
    expect(range).toBeDefined();
    expect(range!.text).toBe('2 days ago');
    expect(range!.start).toBe('2026-08-07');
  });

  it('returns undefined for text without temporal references', () => {
    expect(extractTimeRange('resume the migration', REF)).toBeUndefined();
    expect(extractTimeRange('fix the login bug', REF)).toBeUndefined();
  });

  it('attaches timeRange only on the continue intent', () => {
    const result = classifyIntent("continue last week's ecommerce plan", REF);
    expect(result.timeRange).toBeDefined();
    expect(result.confidence).toBe(0.95);

    const noTemporal = classifyIntent('resume the migration', REF);
    expect(noTemporal.timeRange).toBeUndefined();
    expect(noTemporal.confidence).toBe(0.9);
  });
});

// ─── Pure rule functions ────────────────────────────────────────────────────

describe('rule functions are pure', () => {
  it('matchExplainRule', () => {
    expect(matchExplainRule('explain how caching works')?.intent).toBe('explain');
    expect(matchExplainRule('create a cli tool')).toBeNull();
  });

  it('matchContinueRule', () => {
    expect(matchContinueRule('resume the plan', REF)?.intent).toBe('continue');
    expect(matchContinueRule('fix the bug', REF)).toBeNull();
  });

  it('matchFixRule', () => {
    expect(matchFixRule('fix the login bug')?.intent).toBe('fix');
    expect(matchFixRule('explain how caching works')).toBeNull();
  });

  it('matchConfigureRule', () => {
    expect(matchConfigureRule('configure the gemini api key')?.intent).toBe('configure');
    expect(matchConfigureRule('create a cli tool')).toBeNull();
  });

  it('matchCreateRule', () => {
    expect(matchCreateRule('create a new CLI tool')?.intent).toBe('create');
    expect(matchCreateRule('the build failed')?.intent).toBeUndefined();
  });

  it('exports a trust threshold above every rule confidence', () => {
    for (const [text] of RULE_MATRIX) {
      const result = classifyIntent(text, REF);
      expect(result.confidence).toBeGreaterThanOrEqual(RULE_TRUST_THRESHOLD);
    }
  });
});

// ─── Performance budget ─────────────────────────────────────────────────────

describe('performance budget', () => {
  it('classifies the full matrix in <5ms average (zero network, pure rules)', () => {
    const texts = RULE_MATRIX.map(([t]) => t);
    // Warm-up (module init + recognizer lazy state).
    for (let i = 0; i < 50; i++) classifyIntent(texts[i % texts.length], REF);
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      classifyIntent(texts[i % texts.length], REF);
    }
    const avgMs = (performance.now() - start) / iterations;
    expect(avgMs).toBeLessThan(5);
  });
});
