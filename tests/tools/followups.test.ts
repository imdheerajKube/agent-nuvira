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
import { followupsFromAnswerList } from '../../src/tools/followup-utils.js';

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

/**
 * The LIVE case (2026-10-14): `nuvira execute "hi"` on `local/deepseek-coder`
 * reported 0 tool calls, wrote its three options as PROSE, and the user had
 * nothing to click — the model's suggestions were unreachable, which is the one
 * job a followup has.
 */
describe('followupsFromAnswerList — a model that wrote its options instead of calling the tool', () => {
  it('recovers the real measured answer (numbered options under a lead-in)', () => {
    const answer = [
      "It seems like you've shared a lot of information here, but it's not clear what you're asking.",
      '',
      'Would you like me to:',
      '  1. Fix the factorial performance issue by adding a limit or an iterative check?',
      '  2. Replace the new Function evaluation with a safer alternative?',
      '  3. Run the existing test suite to see if these bugs are currently triggering any test failures?',
    ].join('\n');

    expect(followupsFromAnswerList(answer)).toEqual([
      { prompt: 'Fix the factorial performance issue by adding a limit or an iterative check?' },
      { prompt: 'Replace the new Function evaluation with a safer alternative?' },
      { prompt: 'Run the existing test suite to see if these bugs are currently triggering any test failures?' },
    ]);
  });

  it('recovers a bulleted list behind a question lead-in', () => {
    const answer = [
      'The refactor is done.',
      '',
      'Which of these should I start with?',
      '- Add tests for the new parser',
      '- Update the README examples',
    ].join('\n');
    const out = followupsFromAnswerList(answer);
    expect(out.map((f) => f.prompt)).toEqual([
      'Add tests for the new parser',
      'Update the README examples',
    ]);
  });

  it('ignores a numbered list with NO lead-in (a procedure is the answer, not a menu)', () => {
    const answer = [
      'Here is how the retry works.',
      '1. The request fails.',
      '2. The router records the failure.',
      '3. The next candidate is tried.',
    ].join('\n');
    expect(followupsFromAnswerList(answer)).toEqual([]);
  });

  it('ignores a list that is not the END of the answer', () => {
    const answer = [
      'Next steps:',
      '1. Add tests',
      '2. Update docs',
      '',
      'Both are optional for now, and nothing here is on fire.',
    ].join('\n');
    expect(followupsFromAnswerList(answer)).toEqual([]);
  });

  it('needs at least two items — one numbered line is not a menu', () => {
    expect(followupsFromAnswerList('Shall I:\n1. Ship it?')).toEqual([]);
  });

  it('caps the recovered list at the contract maximum', () => {
    const answer = [
      'Options:',
      '1. One',
      '2. Two',
      '3. Three',
      '4. Four',
      '5. Five',
    ].join('\n');
    const out = followupsFromAnswerList(answer);
    expect(out).toHaveLength(MAX_FOLLOWUPS);
    expect(out.map((f) => f.prompt)).toEqual(['One', 'Two', 'Three']);
  });

  it('strips the list markers so the prompt is the request, not "2. …"', () => {
    const out = followupsFromAnswerList('Want me to:\n1) Run the suite\n2) Fix the flake');
    expect(out.map((f) => f.prompt)).toEqual(['Run the suite', 'Fix the flake']);
  });

  it('drops leaked tool scaffolding instead of offering raw JSON', () => {
    const answer = [
      'Done.',
      'Next steps:',
      '- {"tool":"suggest_followups","arguments":{}}',
      '- Review the diff',
    ].join('\n');
    const out = followupsFromAnswerList(answer);
    expect(out.map((f) => f.prompt)).toEqual(['Review the diff']);
    expect(JSON.stringify(out)).not.toContain('"tool"');
  });

  it('returns [] for empty/absent input', () => {
    expect(followupsFromAnswerList('')).toEqual([]);
    expect(followupsFromAnswerList('   \n  ')).toEqual([]);
    expect(followupsFromAnswerList(undefined)).toEqual([]);
    expect(followupsFromAnswerList(null)).toEqual([]);
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
