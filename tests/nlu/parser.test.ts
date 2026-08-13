import { describe, it, expect } from 'vitest';
import { parseRequestSync, parseRequest } from '../../src/nlu/parser.js';
import { RULE_TRUST_THRESHOLD } from '../../src/nlu/intent.js';
import type { LLMCallFn } from '../../src/agents/agent.js';

/** An LLM that always throws — proves the rule path never needs a model. */
const throwingLLM: LLMCallFn = async () => {
  throw new Error('LLM unavailable');
};

/** An LLM that returns a schema-valid verify response. */
const answeringLLM: LLMCallFn = async (prompt) =>
  JSON.stringify({
    intent: 'create',
    confidence: 0.9,
    entities: { files: [], frameworks: ['react'], keywords: ['auth'] },
    memoryHint: 'no prior context',
  });

describe('parseRequestSync — deterministic fast path', () => {
  it('classifies + resolves the action without any LLM call', () => {
    const parsed = parseRequestSync('create a cli tool');
    expect(parsed.intent).toBe('create');
    expect(parsed.confidence).toBeGreaterThanOrEqual(RULE_TRUST_THRESHOLD);
    expect(parsed.action.name).toBe('build');
    expect(parsed.mode).toBe('dev');
    expect(parsed.source).toBe('rule');
  });

  it('extracts entities deterministically (files + temporal)', () => {
    const parsed = parseRequestSync('fix the bug in src/login.ts');
    expect(parsed.entities.files).toContain('src/login.ts');
    expect(parsed.intent).toBe('fix');
    const cont = parseRequestSync("continue last week's plan");
    expect(cont.entities.timeRange?.text).toContain('last week');
    expect(cont.intent).toBe('continue');
  });

  it('mode is never null — the ask action fills unknown intents', () => {
    const parsed = parseRequestSync('kaleidoscope');
    expect(parsed.intent).toBe('unknown');
    expect(parsed.confidence).toBe(0);
    expect(parsed.mode).toBe('chat');
    expect(parsed.action.name).toBe('ask');
    expect(parsed.action.run).toBe('chat');
  });

  // Wall-clock regression guard for the deterministic fast path. The budget
  // is deliberately CI-safe (a shared Windows runner measured 5.9ms/parse on
  // one run) — the point is catching pathological regressions (LLM fallthrough,
  // O(n²) matching), not benchmarking hardware.
  it('stays fast on the headline recall case (CI-safe latency budget)', () => {
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) parseRequestSync("continue last week's ecommerce plan");
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(50);
  });
});

describe('parseRequest — LLM verify path (C2)', () => {
  it('fast path: a confident rule result never calls the LLM', async () => {
    const parsed = await parseRequest('create an nvda addon', throwingLLM);
    expect(parsed.intent).toBe('create');
    expect(parsed.source).toBe('rule');
    expect(parsed.action.name).toBe('build');
  });

  it('below-threshold: the LLM verify upgrades intent, action and mode together', async () => {
    const parsed = await parseRequest('sort out my auth stuff', answeringLLM);
    expect(parsed.intent).toBe('create');
    expect(parsed.source).toBe('llm');
    expect(parsed.action.name).toBe('build');
    expect(parsed.mode).toBe('dev');
    expect(parsed.entities.frameworks).toContain('react');
  });

  it('below-threshold + LLM failure → rule fallback, never a crash, never a guess', async () => {
    const parsed = await parseRequest('do the thing', throwingLLM);
    expect(parsed.source).toBe('rule-fallback');
    expect(parsed.intent).toBe('unknown');
    expect(parsed.mode).toBe('chat'); // ask action fills the gap
    expect(parsed.action.name).toBe('ask');
  });

  it('below-threshold + unparseable LLM JSON → rule fallback', async () => {
    const garbageLLM: LLMCallFn = async () => 'sure, I can help with that!';
    const parsed = await parseRequest('do the thing', garbageLLM);
    expect(parsed.source).toBe('rule-fallback');
    expect(parsed.action.name).toBe('ask');
  });
});
