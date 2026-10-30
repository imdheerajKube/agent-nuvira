/**
 * Cache-read tokens reach the cost ledger.
 *
 * Cline reports "58.5M in (99.3% cache read)" for the same audit this agent ran
 * with no cache figure at all: the provider caches identical prompt prefixes
 * automatically, but this codebase stored only `prompt_tokens`, so a mostly
 * cached session read as fresh compute. These tests pin the three things that
 * make the number reportable: it is recorded on the row, it is summarised with a
 * hit rate, and it is printed next to the token count it qualifies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CostTracker, recordCallWithUsage } from '../../src/learning/cost-tracker.js';
import { cachedPromptTokensOf } from '../../src/inference/sse.js';

const PREV = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  process.env.NUVIRA_MEMORY_DIR = mkdtempSync(join(tmpdir(), 'cache-ledger-'));
});

afterEach(() => {
  if (PREV === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = PREV;
});

describe('cachedPromptTokensOf', () => {
  it('reads DeepSeek’s prompt_cache_hit_tokens', () => {
    expect(cachedPromptTokensOf({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 960 })).toBe(960);
  });

  it('reads OpenAI’s nested prompt_tokens_details.cached_tokens', () => {
    expect(
      cachedPromptTokensOf({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 640 } }),
    ).toBe(640);
  });

  it('is undefined when the endpoint reports nothing — not 0', () => {
    expect(cachedPromptTokensOf({ prompt_tokens: 1000, completion_tokens: 5 })).toBeUndefined();
    expect(cachedPromptTokensOf(undefined)).toBeUndefined();
  });
});

describe('cost ledger cache accounting', () => {
  it('records the cache figure on the row and never more than the input', () => {
    const tracker = new CostTracker();
    const entry = tracker.recordCallMeasured('deepseek', 'deepseek-v4', 1000, 50, undefined, undefined, 960);
    expect(entry.inputTokens).toBe(1000);
    expect(entry.cachedInputTokens).toBe(960);

    // A provider reporting more cached tokens than it sent must not make the
    // ledger claim more than the request contained.
    const clamped = tracker.recordCallMeasured('deepseek', 'deepseek-v4', 100, 5, undefined, undefined, 900);
    expect(clamped.cachedInputTokens).toBe(100);
  });

  it('leaves the field absent when no cache figure was reported', () => {
    const tracker = new CostTracker();
    const entry = tracker.recordCallMeasured('openai', 'gpt-x', 500, 20);
    expect(entry.cachedInputTokens).toBeUndefined();
  });

  it('summarises the cache read and its hit rate, and prints them', () => {
    const tracker = new CostTracker();
    tracker.recordCallMeasured('deepseek', 'deepseek-v4', 1000, 50, undefined, undefined, 960);
    tracker.recordCallMeasured('deepseek', 'deepseek-v4', 1000, 50, undefined, undefined, 900);

    const summary = tracker.getSummary();
    expect(summary.cachedInputTokens).toBe(1860);
    expect(summary.inputTokens).toBe(2000);
    expect(summary.cacheHitRate).toBeCloseTo(0.93, 5);
    expect(tracker.formatSummary()).toContain('Cache read: 1,860 of 2,000 input tokens (93.0%)');
  });

  it('is carried through the shared usage recorder (the adapters’ path)', () => {
    const tracker = new CostTracker();
    recordCallWithUsage(tracker, 'deepseek', 'deepseek-v4', 'prompt', 'answer', {
      promptTokens: 1000,
      completionTokens: 10,
      cachedPromptTokens: 900,
    });
    expect(tracker.getSummary().cachedInputTokens).toBe(900);
  });

  it('omits the cache line entirely when nothing was reported', () => {
    const tracker = new CostTracker();
    tracker.recordCallMeasured('openai', 'gpt-x', 500, 20);
    const summary = tracker.getSummary();
    expect(summary.cachedInputTokens).toBe(0);
    expect(summary.cacheHitRate).toBe(0);
    expect(tracker.formatSummary()).not.toContain('Cache read');
  });
});
