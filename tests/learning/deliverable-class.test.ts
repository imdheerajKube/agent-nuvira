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
  asksForAuthoredFile,
  authoredDeliverableGuidance,
  classifyDeliverable,
  deliverableClassLabel,
  describeSubstrates,
  isAuthoredGoal,
  isCompositeGoal,
  isLongFormAuthoredGoal,
  wantsAuthoredArtifact,
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

/**
 * G13b — `wantsAuthoredArtifact`: an authored deliverable the user asked to be
 * PRODUCED, as opposed to authored content they asked to be TOLD.
 *
 * The conjunction is the whole design. `isAuthoredGoal` alone cannot tell "write
 * a 12 page story to /path/Mahagatha.md" from "tell me a story", and treating
 * them alike is what let the first one be answered with prose and no file. The
 * authorization half supplies the missing evidence (a creation verb on a
 * file-shaped deliverable, or a named destination), so the chat ask keeps its
 * chat answer.
 */
describe('wantsAuthoredArtifact — produced vs told (G13b)', () => {
  it('is true for an authored ask that names its destination', () => {
    expect(wantsAuthoredArtifact('write a 12 page story to /Users/d/story/Mahagatha.md')).toBe(true);
  });

  it('is true for an authored ask with a creation verb and no path', () => {
    expect(wantsAuthoredArtifact('write a 5 page story called Kharig Nights')).toBe(true);
    expect(wantsAuthoredArtifact('create a 20 chapter book about a village boy')).toBe(true);
  });

  it('is true for a HYBRID web book', () => {
    expect(
      wantsAuthoredArtifact('develop an interactive web-based book with voice narration'),
    ).toBe(true);
  });

  it('is FALSE for the same content asked as chat', () => {
    expect(wantsAuthoredArtifact('tell me a story about a village boy')).toBe(false);
    expect(wantsAuthoredArtifact('read me a poem about the monsoon')).toBe(false);
  });

  it('is FALSE for a question ABOUT producing the artifact', () => {
    expect(wantsAuthoredArtifact('how do I write a story to a file?')).toBe(false);
    expect(wantsAuthoredArtifact('explain how to write a story to a file')).toBe(false);
  });

  it('is FALSE for engineering asks — this must never capture code work', () => {
    expect(wantsAuthoredArtifact('fix the calculator so division by zero returns 0')).toBe(false);
    expect(wantsAuthoredArtifact('build an api for booking')).toBe(false);
    expect(wantsAuthoredArtifact('refactor the router')).toBe(false);
  });

  it('is FALSE for an empty goal', () => {
    expect(wantsAuthoredArtifact('')).toBe(false);
  });
});

/**
 * `asksForAuthoredFile` — the NARROW half, for the chat-vs-task gate.
 *
 * The split exists because the two callers have different context. The engine
 * router and the loop's deliverable gate only run once the ask is already a
 * TASK, so "a creation verb on an authored noun" is enough evidence there. The
 * conversation gate decides chat-vs-task, and must be narrower: "write a poem
 * about rain" is pinned as a CHAT answer (the text IS the deliverable), and
 * re-routing it to the pipeline is the original category error in reverse.
 *
 * So the narrow rule needs the artifact to be SIZE-ARGUING (more than one unit)
 * or PLACED (a named destination) — exactly the two cases the pipeline exists to
 * serve.
 */
describe('asksForAuthoredFile — the narrow chat-vs-task rule (G13b)', () => {
  it('is true when a magnitude needs more than one unit', () => {
    expect(asksForAuthoredFile('write a 200 page book about the sea')).toBe(true);
    expect(asksForAuthoredFile('write a 12 page story called Kharig Nights')).toBe(true);
  });

  it('is true when the request NAMES a destination — the live failure', () => {
    // "2 pages" resolves to ONE unit, so magnitude alone misses it; the named
    // path is what the user actually asked for.
    expect(asksForAuthoredFile('write a 2 page story to /tmp/kharig-nights.md about a village boy')).toBe(true);
  });

  it('is FALSE for the short authored asks that ARE the chat answer', () => {
    expect(asksForAuthoredFile('write a poem about rain')).toBe(false);
    expect(asksForAuthoredFile('Write a song in Hindi for my daughter')).toBe(false);
    expect(asksForAuthoredFile('write a poem and send it to Alex')).toBe(false);
    expect(asksForAuthoredFile('write an essay about my village')).toBe(false);
    expect(asksForAuthoredFile('write a 1 page summary of the meeting')).toBe(false);
  });

  it('is FALSE for a bare "book" — a DEFAULT magnitude is not a request', () => {
    expect(asksForAuthoredFile('write a book about the sea')).toBe(false);
    expect(isLongFormAuthoredGoal('write a book about the sea')).toBe(false);
  });

  it('is narrower than wantsAuthoredArtifact — and both are true for a file ask', () => {
    const goal = 'write a 12 page story to /Users/d/story/Mahagatha.md';
    expect(asksForAuthoredFile(goal)).toBe(true);
    expect(wantsAuthoredArtifact(goal)).toBe(true);
    // …and the poem separates them, which is the whole reason for the split.
    expect(wantsAuthoredArtifact('write a poem about rain')).toBe(true);
    expect(asksForAuthoredFile('write a poem about rain')).toBe(false);
  });
});
