/**
 * Continuation core tests (Nuvira-Router P4 M4.1 + M4.3).
 *
 * Covers: partial-failure classification (definitive vs mid-stream), the
 * bounded continuation note (context-relay: prompt + partial output, budget
 * capped, head+tail preserved), and the per-task continuation budget.
 */

import { describe, it, expect } from 'vitest';
import {
  isPartialFailure,
  buildContinuationNote,
  trimPartialOutput,
  estimateNoteTokens,
  ContinuationBudget,
  DEFAULT_CONTINUATION_MAX_TOKENS,
} from '../../src/learning/continuation.js';

describe('isPartialFailure (M4.1 classification)', () => {
  it('rate-limit and auth errors are DEFINITIVE — never continue', () => {
    expect(isPartialFailure(new Error('429 rate limit exceeded'))).toBe(false);
    expect(isPartialFailure(new Error('quota exhausted — 429'))).toBe(false);
    expect(isPartialFailure(new Error('401 unauthorized — api key invalid'))).toBe(false);
    expect(isPartialFailure(new Error('403 forbidden'))).toBe(false);
    expect(isPartialFailure(new Error('404 model not found'))).toBe(false);
    expect(isPartialFailure(new Error('model not found: deprecated-model'))).toBe(false);
  });

  it('network / server / timeout errors after a stream started ARE partial candidates', () => {
    expect(isPartialFailure(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isPartialFailure(new Error('502 bad gateway'))).toBe(true);
    expect(isPartialFailure(new Error('socket hang up'))).toBe(true);
    expect(isPartialFailure(new Error('The operation was aborted'))).toBe(true);
  });
});

describe('buildContinuationNote (M4.1 core + M4.3 context relay)', () => {
  it('includes the prompt and the partial output, instructing the model to continue', () => {
    const note = buildContinuationNote('implement jwt auth', 'We need to add a verify function');
    expect(note).toContain('implement jwt auth');
    expect(note).toContain('We need to add a verify function');
    expect(note).toContain('Continue from here');
    expect(note).toContain('Do NOT restart from scratch');
  });

  it('handles an empty partial output gracefully (failure before any tokens)', () => {
    const note = buildContinuationNote('write a poem', '');
    expect(note).toContain('(none — the failure happened before any output)');
  });

  it('bounds a huge partial output to the token budget, keeping head + long tail', () => {
    const bigPartial = 'a'.repeat(50_000);
    const note = buildContinuationNote('task', bigPartial, { maxTokens: 256 });
    // 256 tokens × 4.5 chars = 1152 chars budget; the note must be bounded.
    expect(note.length).toBeLessThan(3000);
    expect(note).toContain('chars truncated');
    // Tail preserved (most recent tokens matter most for continuation).
    const tail = note.slice(-30);
    expect(tail).toContain('aaaa');
  });

  it('a pathological prompt is trimmed too, never dominating the budget', () => {
    const note = buildContinuationNote('x'.repeat(100_000), 'partial', { maxTokens: 128 });
    expect(note.length).toBeLessThan(2000);
    expect(note).toContain('prompt truncated');
  });

  it('default budget is bounded (DEFAULT_CONTINUATION_MAX_TOKENS)', () => {
    const note = buildContinuationNote('task', 'y'.repeat(50_000));
    expect(estimateNoteTokens(note)).toBeLessThanOrEqual(DEFAULT_CONTINUATION_MAX_TOKENS * 1.5);
  });
});

describe('trimPartialOutput', () => {
  it('passes through small outputs untouched', () => {
    expect(trimPartialOutput('short', 100)).toBe('short');
  });

  it('trims oversized outputs with head, marker, and long tail', () => {
    const out = trimPartialOutput('abc'.repeat(100), 200);
    expect(out).toContain('chars truncated');
    expect(out).toContain('abcabc'); // tail
    expect(out.length).toBeLessThan(400);
  });
});

describe('ContinuationBudget (M4.1 budget cap)', () => {
  it('allows exactly ONE continuation per task by default', () => {
    const budget = new ContinuationBudget();
    expect(budget.tryUse('task-1')).toBe(true);
    expect(budget.tryUse('task-1')).toBe(false); // capped for THIS task
    // A DIFFERENT task has its own budget (the cap is per task).
    expect(budget.tryUse('task-2')).toBe(true);
  });

  it('a larger per-task cap is honored', () => {
    const budget = new ContinuationBudget(2);
    expect(budget.tryUse('task-1')).toBe(true);
    expect(budget.tryUse('task-1')).toBe(true);
    expect(budget.tryUse('task-1')).toBe(false);
  });

  it('reset clears the used set', () => {
    const budget = new ContinuationBudget();
    budget.tryUse('task-1');
    expect(budget.hasBudget('task-1')).toBe(false);
    budget.reset();
    expect(budget.hasBudget('task-1')).toBe(true);
  });
});
