/**
 * G7 — deliverable classification.
 *
 * Pins the fix for the category error that killed the WhatsApp story task:
 * "write a 100-page story" was planned as a Python program that would write
 * the story, because the decision layer had no vocabulary for authored work.
 *
 * The classifier is deterministic on purpose — it is the safety net the LLM's
 * own decision is checked against — so these tests cover BOTH directions:
 * authored asks must be caught, and engineering asks must stay on the code path
 * (a false positive here would be a regression in how all software is planned).
 */

import { describe, it, expect } from 'vitest';
import {
  AUTHORED_CONFIDENCE_FLOOR,
  authoredDeliverableGuidance,
  classifyDeliverable,
  deliverableClassLabel,
  describeSubstrates,
  isAuthoredGoal,
  isCompositeGoal,
} from '../../src/learning/deliverable-class.js';

/** The verbatim goal from the failing orchestrator traces. */
const REAL_STORY_GOAL =
  'Continue , take multiple iterations if required- draft a plan and  create story by getting detailed plan executed,  I will appreciate if a pdf is created with 100 page story leveling to details like Harry Potter styles on  magic and suspense.';

/** The writer step description the planner produced for it. */
const REAL_WRITER_STEP =
  'Create a Python script to append the story continuation and the \'ruprekha\' (outline) to /Users/dheeraj/Documents/story/Mahagatha.md, ensuring narrative consistency with chapter_1.md.';

describe('classifyDeliverable — the real failing goal', () => {
  it('classifies the story request as authored creative work', () => {
    const v = classifyDeliverable(REAL_STORY_GOAL);
    expect(v.class).toBe('creative');
    expect(v.authored).toBe(true);
    expect(v.confidence).toBeGreaterThanOrEqual(AUTHORED_CONFIDENCE_FLOOR);
    expect(v.signals.join(' ')).toMatch(/story/i);
  });

  it('reads the mis-planned step as a CODE request — which is why the goal, not the step, drives the mode', () => {
    // The planner's step literally asks for a Python script, so a classifier
    // looking only at step text would agree with the mistake. This documents
    // WHY the authored decision is taken from the GOAL and enforced upstream
    // (reasoner + orchestrator), and why the step shape is then replaced.
    expect(classifyDeliverable(REAL_WRITER_STEP).class).toBe('code');
  });

  it('catches a Hindi/Hinglish story request (the session was in Hindi)', () => {
    expect(classifyDeliverable('दो भाइयों की कहानी लिखो और अगले अध्याय continue करो').authored).toBe(true);
    expect(classifyDeliverable('एक उपन्यास लिखिए').authored).toBe(true);
  });
});

describe('classifyDeliverable — authored asks', () => {
  it('catches books, poems, chapters and screenplays', () => {
    for (const goal of [
      'create a book for a class 4 student teaching division',
      'write a poem about the monsoon',
      'draft 3 more chapters',
      'write a screenplay about a heist',
      'continue the story where you left off',
    ]) {
      expect(classifyDeliverable(goal).authored, goal).toBe(true);
    }
  });

  it('catches non-fiction documents', () => {
    for (const goal of [
      'write a report on our Q3 sales',
      'draft an essay on climate policy',
      'write a blog post about the new API',
      'prepare a cover letter for this job',
    ]) {
      expect(classifyDeliverable(goal).authored, goal).toBe(true);
    }
  });
});

describe('classifyDeliverable — engineering asks MUST stay code', () => {
  it('keeps ordinary software requests on the code path', () => {
    for (const goal of [
      'build a react dashboard for sales data',
      'fix the failing auth middleware test',
      'add a REST endpoint for user profile',
      'refactor the payment module into two files',
      'create a python program which says "Hello Dheeraj"',
      'set up postgres with a migrations pipeline',
      'enhance my calculator app',
    ]) {
      const v = classifyDeliverable(goal);
      expect(v.class, goal).toBe('code');
      expect(v.authored, goal).toBe(false);
    }
  });

  it('does NOT read a program that manipulates an artifact as authored', () => {
    // The override table exists for exactly this: "create a PDF generator" is
    // software, not authorship.
    for (const goal of [
      'create a script that writes the story to a markdown file',
      'build a tool to convert pdf to text',
      'write a parser for the docx format',
      'a CLI that exports reports to csv',
    ]) {
      expect(classifyDeliverable(goal).authored, goal).toBe(false);
    }
  });

  it('prefers the dominant signal when a goal mixes both', () => {
    const v = classifyDeliverable('build a web app that stores books and lets users write reviews');
    expect(v.class).toBe('code');
  });
});

describe('classifyDeliverable — edge cases', () => {
  it('returns an unauthored code default for an empty goal', () => {
    const v = classifyDeliverable('');
    expect(v.class).toBe('code');
    expect(v.confidence).toBe(0);
    expect(v.signals).toEqual([]);
  });

  it('reports zero confidence when nothing matches', () => {
    const v = classifyDeliverable('do the thing');
    expect(v.class).toBe('code');
    expect(v.confidence).toBe(0);
    expect(v.authored).toBe(false);
  });

  it('separates data and research asks', () => {
    expect(classifyDeliverable('analyze this csv dataset and chart the trend').class).toBe('data');
    expect(classifyDeliverable('compare the trade-offs of postgres vs mysql options').class).toBe('research');
  });
});

describe('isAuthoredGoal', () => {
  it('is the single predicate callers use to switch planning modes', () => {
    expect(isAuthoredGoal(REAL_STORY_GOAL)).toBe(true);
    expect(isAuthoredGoal('implement jwt auth')).toBe(false);
  });
});

describe('authoredDeliverableGuidance', () => {
  it('forbids planning a generator for authored work', () => {
    const g = authoredDeliverableGuidance('creative');
    expect(g).toMatch(/DELIVERABLE CLASS/);
    expect(g).toMatch(/MUST NOT plan a script, tool, or generator/);
    expect(g).toMatch(/`language`: "none"/);
    expect(g).toMatch(/`platform`: "document"/);
  });

  it('returns empty for software goals so no prompt weight is added', () => {
    expect(authoredDeliverableGuidance('code')).toBe('');
    expect(authoredDeliverableGuidance('data')).toBe('');
  });
});

/**
 * G12 — hybrid asks. A single class cannot express "a web book with narration",
 * and forcing one answer is exactly how the original audit produced a Python
 * script instead of a story.
 */
describe('substrates — what the deliverable is made of', () => {
  it('keeps a plain story as prose only', () => {
    const v = classifyDeliverable(REAL_STORY_GOAL);
    expect(v.substrates).toEqual(['prose']);
    expect(v.composite).toBe(false);
    expect(v.interactive).toBe(false);
  });

  it('reads a web-based interactive book as prose + web', () => {
    // The ask the user actually described: a book, presented as a website,
    // with voice. "page" alone must NOT make it a website — this does.
    const v = classifyDeliverable(
      'develop a web-based interactive book with voice narration for each chapter',
    );
    expect(v.substrates).toContain('prose');
    expect(v.substrates).toContain('web');
    expect(v.composite).toBe(true);
    expect(v.interactive).toBe(true);
  });

  it('adds the python substrate when a service was named, without dropping prose', () => {
    const v = classifyDeliverable(
      'create a 50 page story as an interactive website and add a python script for text-to-speech narration',
    );
    expect(v.substrates).toEqual(expect.arrayContaining(['prose', 'web', 'python']));
    expect(v.composite).toBe(true);
  });

  it('does NOT call a plain software build composite just because it has two runtimes', () => {
    const v = classifyDeliverable('build a react dashboard with a python fastapi backend and postgres');
    expect(v.authored).toBe(false);
    expect(v.composite).toBe(false);
    expect(isCompositeGoal('build a react dashboard with a python fastapi backend')).toBe(false);
  });

  it('is not fooled by a code-intent phrase about the same nouns', () => {
    // "a script that writes the story" is software, and the artifact it touches
    // is an INPUT, not a substrate.
    const v = classifyDeliverable('write a python script that exports the story to pdf');
    expect(v.authored).toBe(false);
    expect(v.composite).toBe(false);
  });

  it('reports the substrates for logs', () => {
    const v = classifyDeliverable('write a story as a website with narration audio');
    expect(describeSubstrates(v)).toMatch(/prose/);
    expect(describeSubstrates(v)).toMatch(/web/);
  });

  it('gives the reasoner hybrid guidance, not just authored guidance', () => {
    const g = authoredDeliverableGuidance('creative', ['prose', 'web', 'python']);
    expect(g).toMatch(/HYBRID DELIVERABLE/);
    expect(g).toMatch(/NON-DELIVERY/);
    // The optional-service rule: the deliverable must work without Python.
    expect(g).toMatch(/OPTIONAL ENHANCEMENT/);
    // …and the site must work by opening a file.
    expect(g).toMatch(/no install, no build/);
  });
});

describe('deliverableClassLabel', () => {
  it('names every class', () => {
    expect(deliverableClassLabel('creative')).toMatch(/creative writing/);
    expect(deliverableClassLabel('document')).toMatch(/authored document/);
    expect(deliverableClassLabel('data')).toMatch(/data analysis/);
    expect(deliverableClassLabel('research')).toMatch(/research/);
    expect(deliverableClassLabel('code')).toBe('software');
  });
});
