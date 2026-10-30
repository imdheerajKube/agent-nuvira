/**
 * Prompt-cache capability — the condition W1 was missing.
 *
 * A frozen prompt prefix is only a discount where the provider caches identical
 * prefixes. DeepSeek bills a cache read at $0.003/M against $0.15/M fresh (50×);
 * a local runner or an unknown gateway bills every call at full rate and never
 * lets the prefix shrink. Choosing the wrong strategy here does not produce a
 * wrong answer — it produces a 50× bill, so the default for anything unknown
 * must be "do not assume a cache".
 */

import { describe, it, expect } from 'vitest';
import {
  cacheStablePrefixPaysOff,
  promptCacheExplanation,
  promptCacheSupport,
} from '../../src/learning/prompt-cache.js';

describe('promptCacheSupport', () => {
  it('knows the providers whose prefix cache needs no request-side opt-in', () => {
    expect(promptCacheSupport('deepseek', 'deepseek-flash')).toBe('supported');
    expect(promptCacheSupport('openai', 'gpt-5')).toBe('supported');
    expect(promptCacheSupport('azure', 'gpt-4o')).toBe('supported');
    // The audit's own pair — the one whose 65 % cache share W1 exists to raise.
    expect(cacheStablePrefixPaysOff('deepseek', 'deepseek-flash')).toBe(true);
  });

  it('does not assume a cache behind a gateway or on an unknown id', () => {
    expect(promptCacheSupport('openrouter', 'anthropic/claude-x')).toBe('unknown');
    expect(promptCacheSupport('omniroute', 'deepseek-flash')).toBe('unknown');
    expect(promptCacheSupport('some-plugin', 'their-model')).toBe('unknown');
    expect(promptCacheSupport('', 'x')).toBe('unknown');
  });

  it('marks a local runner as having no cache at all', () => {
    expect(promptCacheSupport('local', 'qwen2.5:0.5b')).toBe('unsupported');
    expect(promptCacheSupport('lmstudio')).toBe('unsupported');
    expect(cacheStablePrefixPaysOff('local', 'llama3')).toBe(false);
  });

  it('does not count Anthropic, whose caching is opt-in and never requested here', () => {
    // There is no `cache_control` anywhere in src/inference, so Anthropic's cache
    // is never written: freezing the prefix there buys nothing.
    expect(promptCacheSupport('anthropic', 'claude-x')).toBe('unsupported');
  });

  it('is case/whitespace tolerant (provider ids arrive from config and flags)', () => {
    expect(promptCacheSupport('  DeepSeek ', 'x')).toBe('supported');
  });
});

describe('cacheStablePrefixPaysOff', () => {
  it('is true ONLY for a known cache — every other answer falls back to trimming', () => {
    expect(cacheStablePrefixPaysOff('deepseek', 'deepseek-flash')).toBe(true);
    expect(cacheStablePrefixPaysOff('openai', 'gpt-5')).toBe(true);
    for (const p of ['local', 'groq', 'gemini', 'nim', 'openrouter', 'anthropic', 'plugin-x']) {
      expect(cacheStablePrefixPaysOff(p, 'm')).toBe(false);
    }
  });
});

describe('promptCacheExplanation', () => {
  it('states the decision AND the reason, per case', () => {
    expect(promptCacheExplanation('deepseek', 'deepseek-flash')).toContain('caches identical prompt prefixes');
    expect(promptCacheExplanation('local', 'llama3')).toContain('trims old messages per call');
    expect(promptCacheExplanation('openrouter', 'x')).toContain('no known prefix cache');
    // The model is named, so a turn report says which route it applied to.
    expect(promptCacheExplanation('deepseek', 'deepseek-flash')).toContain('deepseek/deepseek-flash');
  });
});
