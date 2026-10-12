/**
 * Model capability — the deterministic name-based estimator behind
 * capability-aware model REPAIR.
 *
 * The heuristic exists for one job: a dead pin must not be silently repaired to
 * a model in a lower capability band when a comparable sibling is available.
 * These tests pin the ordering that job depends on (a 7B toy must not outrank a
 * 27B/120B) and the neutral default that keeps an unrecognised id from being
 * treated as weak.
 */

import { describe, it, expect } from 'vitest';

import {
  estimateModelCapability,
  capabilityBand,
  nonDowngradeCandidates,
  sameClassFallback,
  strongestFirst,
  capabilityClassOf,
  bandRank,
  isHighCapabilityModel,
  NEUTRAL_CAPABILITY,
  CAPABILITY_HIGH_MIN,
  CAPABILITY_MEDIUM_MIN,
} from '../../src/learning/model-capability.js';

describe('estimateModelCapability', () => {
  it('ranks a small toy below a mid-size model below a large one', () => {
    const toy = estimateModelCapability('allam-2-7b');
    const mid = estimateModelCapability('qwen/qwen3.8-27b');
    const large = estimateModelCapability('openai/gpt-oss-120b');
    expect(toy).toBeLessThan(mid);
    expect(mid).toBeLessThan(large);
  });

  it('reads the parameter count from the LAST size token (mixture ids)', () => {
    // `mixtral-8x7b` is a 7B-per-expert model, not an 8B one — the last `<n>b`
    // is the size, and reading the first would inflate it.
    expect(estimateModelCapability('mixtral-8x7b')).toBe(estimateModelCapability('some-7b-model'));
  });

  it('does not mistake a version number for a parameter count', () => {
    // `qwen3.8-flash` carries no size — it must read as flash-tier, not as 3.8B.
    expect(estimateModelCapability('qwen3.8-flash')).toBeGreaterThan(estimateModelCapability('qwen3.8-2b'));
  });

  it('recognizes small/fast qualifiers as LOWER than a neutral unknown', () => {
    expect(estimateModelCapability('foo-flash-lite')).toBeLessThan(NEUTRAL_CAPABILITY);
    expect(estimateModelCapability('foo-mini')).toBeLessThan(NEUTRAL_CAPABILITY);
  });

  it('recognizes strong family qualifiers', () => {
    expect(isHighCapabilityModel('gemini-3.1-pro-preview')).toBe(true);
    expect(isHighCapabilityModel('anthropic/claude-opus-4')).toBe(true);
  });

  it('treats an unrecognised id as NEUTRAL (an unknown is not a failure)', () => {
    expect(estimateModelCapability('wire-stub-model')).toBe(NEUTRAL_CAPABILITY);
    expect(estimateModelCapability('')).toBe(NEUTRAL_CAPABILITY);
    expect(estimateModelCapability(undefined)).toBe(NEUTRAL_CAPABILITY);
    expect(estimateModelCapability('default')).toBe(NEUTRAL_CAPABILITY);
  });

  it('bands align with the router reasoning floor', () => {
    expect(capabilityBand(CAPABILITY_HIGH_MIN)).toBe('high');
    expect(capabilityBand(CAPABILITY_MEDIUM_MIN)).toBe('medium');
    expect(capabilityBand(CAPABILITY_MEDIUM_MIN - 0.01)).toBe('low');
  });
});

describe('nonDowngradeCandidates', () => {
  it('drops a weaker candidate while keeping a comparable one, preserving order', () => {
    const candidates = ['allam-2-7b', 'qwen/qwen3.8-27b'];
    const out = nonDowngradeCandidates('openai/gpt-oss-120b', candidates);
    expect(out).not.toContain('allam-2-7b');
    expect(out).toEqual(['qwen/qwen3.8-27b']);
  });

  it('keeps the full (health-ordered) list when nothing is comparable — never dead-ends', () => {
    const candidates = ['allam-2-7b'];
    expect(nonDowngradeCandidates('qwen/qwen3.8-27b', candidates)).toEqual(['allam-2-7b']);
  });

  it('does not narrow a weak request (the health-first pick is kept)', () => {
    const candidates = ['allam-2-7b', 'qwen/qwen3.8-27b'];
    expect(nonDowngradeCandidates('allam-2-7b', candidates)).toEqual(candidates);
  });

  it('is a pure filter — an empty input stays empty', () => {
    expect(nonDowngradeCandidates('openai/gpt-oss-120b', [])).toEqual([]);
  });
});

// ─── Same-class fallback (the pinned + auto-fallback rule) ──────────────────
// A user who pins a model and leaves auto-fallback on has chosen a QUALITY BAR,
// not merely a first attempt. These pin the rule that keeps a handoff inside it:
// the pin's own class wins, a HIGHER class is not a compromise, and a step DOWN
// is only ever taken when nothing else exists — and is reported, so the caller
// can say so instead of the user discovering it.
describe('sameClassFallback', () => {
  it('keeps a strong pin in its own class — a tiny sibling never outranks a same-class model', () => {
    const pick = sameClassFallback('openai/gpt-oss-120b', [
      'local/qwen2.5:0.5b',
      'qwen/qwen3.8-27b',
      'llama3:70b',
    ]);
    expect(pick?.crossClass).toBe(false);
    expect(pick?.model).not.toBe('local/qwen2.5:0.5b');
    expect(['qwen/qwen3.8-27b', 'llama3:70b']).toContain(pick?.model);
  });

  it('takes a HIGHER class without calling it a step down', () => {
    expect(sameClassFallback('qwen2.5:0.5b', ['openai/gpt-oss-120b'])).toEqual({
      model: 'openai/gpt-oss-120b',
      crossClass: false,
    });
  });

  it('steps down ONLY when the class has nothing, and says so', () => {
    expect(sameClassFallback('openai/gpt-oss-120b', ['local/qwen2.5:0.5b', 'allam-2-7b'])).toEqual({
      model: 'allam-2-7b',
      crossClass: true,
    });
  });

  it('never invents a model for an empty list', () => {
    expect(sameClassFallback('openai/gpt-oss-120b', [])).toBeUndefined();
    expect(sameClassFallback(undefined, ['', '   '])).toBeUndefined();
  });

  it('reads the class of a model id, and ranks the bands', () => {
    expect(capabilityClassOf('openai/gpt-oss-120b')).toBe('high');
    expect(capabilityClassOf('qwen2.5:0.5b')).toBe('low');
    expect(bandRank('high')).toBeGreaterThan(bandRank('medium'));
    expect(bandRank('medium')).toBeGreaterThan(bandRank('low'));
  });

  it('orders candidates strongest-first, stably within a band', () => {
    expect(strongestFirst(['qwen2.5:0.5b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'])).toEqual([
      'openai/gpt-oss-120b',
      'qwen/qwen3.8-27b',
      'qwen2.5:0.5b',
    ]);
    // Equal scores keep their incoming order (a curated order still decides).
    const a = 'model-one-pro';
    const b = 'model-two-pro';
    expect(strongestFirst([a, b])).toEqual([a, b]);
  });
});
