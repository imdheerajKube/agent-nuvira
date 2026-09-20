/**
 * Followup hygiene + continuation (P5).
 *
 * The followups a turn emits decide what the user clicks next, so they must be
 * CLEAN (no leaked tool JSON, no empty/duplicate entries, bounded length) and a
 * clicked followup must be a CONTINUATION of the previous execution rather than
 * a brand-new independent request.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeFollowups,
  buildFollowupContinuationPrompt,
  isFollowupContinuation,
  isSuggestedFollowup,
  FOLLOWUP_CONTINUATION_MARKER,
  MAX_FOLLOWUPS,
  type FollowupSuggestion,
} from '../../src/tools/registry.js';

describe('normalizeFollowups — clean + structured output', () => {
  it('caps the list at the contract maximum', () => {
    const raw: FollowupSuggestion[] = Array.from({ length: 7 }, (_, i) => ({ prompt: `Option ${i + 1}` }));
    const out = normalizeFollowups(raw);
    expect(out).toHaveLength(MAX_FOLLOWUPS);
    expect(out.map((f) => f.prompt)).toEqual(['Option 1', 'Option 2', 'Option 3']);
  });

  it('drops empty, whitespace-only, and non-string prompts', () => {
    const out = normalizeFollowups([
      { prompt: '' },
      { prompt: '   ' },
      { prompt: 'Real one' },
      // @ts-expect-error — deliberately malformed model output
      { prompt: 42 },
      // @ts-expect-error — deliberately malformed model output
      null,
    ]);
    expect(out).toEqual([{ prompt: 'Real one' }]);
  });

  it('drops leaked tool-call scaffolding instead of rendering raw JSON', () => {
    const out = normalizeFollowups([
      { prompt: '{"tool":"suggest_followups","arguments":{"followups":[]}}' },
      { prompt: '<function=suggest_followups>{"x":1}</function>' },
      { prompt: 'Explain the trade-offs' },
    ]);
    expect(out.map((f) => f.prompt)).toEqual(['Explain the trade-offs']);
    expect(JSON.stringify(out)).not.toContain('"tool"');
  });

  it('strips bullets/quotes/backticks and collapses newlines', () => {
    const out = normalizeFollowups([
      { prompt: '- Add error handling\n  to the routes' },
      { prompt: '`Draft the README`' },
      { prompt: '\u2022 1. Review the diff' },
    ]);
    expect(out.map((f) => f.prompt)).toEqual([
      'Add error handling to the routes',
      'Draft the README',
      '1. Review the diff',
    ]);
  });

  it('dedupes case-insensitively and excludes the question the user just asked', () => {
    const out = normalizeFollowups(
      [
        { prompt: 'Plan a 7 day trip' },
        { prompt: 'plan a 7 DAY trip' },
        { prompt: 'Add Vietnam visa details' },
      ],
      { question: 'Plan a 7 day trip' },
    );
    expect(out.map((f) => f.prompt)).toEqual(['Add Vietnam visa details']);
  });

  it('caps prompt length at a word boundary and keeps a distinct short label', () => {
    const long = `Investigate ${'the '.repeat(120)}end`;
    const out = normalizeFollowups([{ prompt: long, label: 'Investigate' }]);
    expect(out[0].label).toBe('Investigate');
    expect(out[0].prompt.length).toBeLessThanOrEqual(301);
    expect(out[0].prompt.endsWith('\u2026')).toBe(true);
    // Never cuts mid-word.
    expect(out[0].prompt).not.toMatch(/th\u2026$/);
  });

  it('omits a label that merely repeats the prompt (shape stays as callers expect)', () => {
    const out = normalizeFollowups([{ prompt: 'Review the plan', label: 'Review the plan' }]);
    expect(out).toEqual([{ prompt: 'Review the plan' }]);
  });

  it('returns [] for empty/absent input so callers can fall back', () => {
    expect(normalizeFollowups([])).toEqual([]);
    expect(normalizeFollowups(undefined)).toEqual([]);
    expect(normalizeFollowups(null)).toEqual([]);
  });
});

describe('followup continuation — a clicked followup is not a fresh request', () => {
  it('prepends the continuation marker', () => {
    const marked = buildFollowupContinuationPrompt('Add a day in Hanoi');
    expect(marked).toContain(FOLLOWUP_CONTINUATION_MARKER);
    expect(marked.endsWith('Add a day in Hanoi')).toBe(true);
    expect(isFollowupContinuation(marked)).toBe(true);
  });

  it('is idempotent — re-marking never stacks markers', () => {
    const once = buildFollowupContinuationPrompt('Extend the itinerary');
    const twice = buildFollowupContinuationPrompt(once);
    expect(twice).toBe(once);
    expect(twice.split(FOLLOWUP_CONTINUATION_MARKER)).toHaveLength(2);
  });

  it('leaves an empty prompt untouched', () => {
    expect(buildFollowupContinuationPrompt('')).toBe('');
  });

  it('recognises a message that matches a previously suggested followup', () => {
    const suggestions: FollowupSuggestion[] = [
      { prompt: 'Draft a 7-day Vietnam itinerary with costs' },
      { prompt: 'Compare Philippines vs Vietnam in December' },
    ];
    expect(isSuggestedFollowup('Draft a 7-day Vietnam itinerary with costs', suggestions)).toBe(true);
    // Trailing punctuation / case differences still match.
    expect(isSuggestedFollowup('draft a 7-day vietnam itinerary with costs.', suggestions)).toBe(true);
    // A genuinely new request does not.
    expect(isSuggestedFollowup('Book the flights for me', suggestions)).toBe(false);
    expect(isSuggestedFollowup('anything', undefined)).toBe(false);
    expect(isSuggestedFollowup('anything', [])).toBe(false);
  });

  it('does not re-flag an already-marked continuation', () => {
    const suggestions: FollowupSuggestion[] = [{ prompt: 'Add a day in Hanoi' }];
    const marked = buildFollowupContinuationPrompt('Add a day in Hanoi');
    expect(isSuggestedFollowup(marked, suggestions)).toBe(false);
  });
});
