/**
 * P2 — the skill index.
 *
 * The measured problem: a description is written for a marketplace card, and
 * every bounded surface truncated the part that says WHEN to use the skill.
 * `design-system` is the canonical case — its description opens with what it
 * builds, and the "Use when…" clause sat past every cap, so the best match for
 * "help me build a design system" arrived without the words "design system".
 */

import { describe, expect, it } from 'vitest';

import {
  buildSkillIndex,
  capWords,
  lintSkillDescription,
  triggerLine,
} from '../../src/learning/skill-index.js';

/** The real description from the bundled catalog (the regression fixture). */
const DESIGN_SYSTEM =
  'Build a component library / design system: tokens, base components, composition ' +
  'patterns, documentation, and testing. Use when the goal asks to create a design ' +
  'system, component library, or shared UI kit.';

describe('triggerLine — the routing clause, not the summary', () => {
  it('prefers the "Use when…" clause over the opening sentence', () => {
    const line = triggerLine(DESIGN_SYSTEM, 120);
    expect(line).toContain('Use when');
    expect(line).toContain('design system');
  });

  it('does not need the trigger to be the SECOND sentence', () => {
    const line = triggerLine('Deploy a static site. Use when the user wants to publish a website.', 120);
    expect(line).toContain('publish a website');
  });

  it('falls back to the first clause when the author wrote no trigger', () => {
    expect(triggerLine('Zorbafies the widget frobnicator.', 120)).toBe('Zorbafies the widget frobnicator.');
  });

  it('caps on a word boundary with an ellipsis (never mid-word)', () => {
    const clause =
      'Use when the goal asks to create a design system, component library, or shared UI kit.';
    const line = triggerLine(clause, 40);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
    // What precedes the ellipsis is an exact prefix of the clause, and the cut
    // landed where the clause has a separator — i.e. not inside a word.
    const body = line.slice(0, -1);
    expect(clause.startsWith(body)).toBe(true);
    expect([' ', ',', ';', '.']).toContain(clause[body.length]);
  });

  it('collapses whitespace and strips a leading list marker', () => {
    expect(triggerLine('-   Use   when\nthe task is a   refactor.', 120)).toBe('Use when the task is a refactor.');
  });

  it('returns an empty string for an empty description', () => {
    expect(triggerLine('', 90)).toBe('');
  });
});

describe('lintSkillDescription — the description IS the index', () => {
  it('accepts a description that states when to use it', () => {
    const lint = lintSkillDescription(
      'Use when the goal asks to review a pull request for correctness, security, and test coverage.',
    );
    expect(lint.issues).toEqual([]);
    expect(lint.ok).toBe(true);
    expect(lint.trigger).toContain('Use when');
  });

  it('flags a missing description', () => {
    const lint = lintSkillDescription('');
    expect(lint.issues).toContain('missing');
    expect(lint.ok).toBe(false);
  });

  it('flags a too-short description', () => {
    expect(lintSkillDescription('Use when testing.').issues).toContain('too-short');
  });

  it('flags a too-long description (truncated in every bounded surface)', () => {
    const long = `Use when ${'very '.repeat(60)}long.`;
    expect(lintSkillDescription(long).issues).toContain('too-long');
  });

  it('flags a description that never says WHEN', () => {
    const lint = lintSkillDescription('A component library with tokens, base components and documentation.');
    expect(lint.issues).toContain('no-trigger');
    expect(lint.issues).toContain('generic-open');
  });

  it('reports the real design-system description without hiding the trigger', () => {
    const lint = lintSkillDescription(DESIGN_SYSTEM);
    // It is too long for a marketplace cap — but its trigger is recoverable.
    expect(lint.issues).toContain('too-long');
    expect(lint.trigger).toContain('design system');
  });
});

describe('buildSkillIndex — bounded, but nothing is ever dropped', () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, '0')}`,
    description: 'Use when the task needs this specific capability to be exercised end to end.',
  }));

  it('lists EVERY skill, by name, with a trigger line when the budget allows', () => {
    const idx = buildSkillIndex(entries);
    for (const e of entries) expect(idx.text).toContain(e.name);
    expect(idx.withTrigger).toBe(entries.length);
    expect(idx.nameOnly).toBe(0);
    expect(idx.chars).toBeLessThan(12_000);
  });

  it('shrinks every line evenly rather than starving the tail of the catalog', () => {
    const tight = buildSkillIndex(entries, { budgetChars: 2_400 });
    // All present…
    for (const e of entries) expect(tight.text).toContain(e.name);
    // …and either every line has a trigger, or none does — never "the first 20 got one".
    expect(tight.withTrigger === 0 || tight.nameOnly === 0).toBe(true);
    if (tight.withTrigger > 0) {
      // Widths are uniform: the longest trigger line cannot dwarf the shortest.
      const widths = tight.text
        .split('\n')
        .filter((l) => l.includes(': '))
        .map((l) => l.length);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(40);
    }
  });

  it('falls back to name-only lines for an enormous catalog (visible beats detailed)', () => {
    const huge = Array.from({ length: 900 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'Use when the task needs this capability.',
    }));
    const idx = buildSkillIndex(huge);
    expect(idx.nameOnly).toBe(900);
    expect(idx.withTrigger).toBe(0);
    expect(idx.text).toContain('skill-899');
  });

  it('returns an empty block for no skills (never a stray heading)', () => {
    expect(buildSkillIndex([]).text).toBe('');
  });

  it('renders a custom heading and omits a skill with no description from the trigger count', () => {
    const idx = buildSkillIndex(
      [
        { name: 'with-trigger', description: 'Use when the task is a code review.' },
        { name: 'no-description', description: '' },
      ],
      { heading: '## Available' },
    );
    expect(idx.text.startsWith('## Available')).toBe(true);
    expect(idx.withTrigger).toBe(1);
    expect(idx.nameOnly).toBe(1);
  });
});

describe('capWords', () => {
  it('leaves short text alone and trims trailing punctuation when cutting', () => {
    expect(capWords('short line', 40)).toBe('short line');
    expect(capWords('Use when the task is a code review, exactly.', 20)).toBe('Use when the task…');
  });
});
