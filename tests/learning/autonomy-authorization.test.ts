import { describe, it, expect } from 'vitest';

import {
  requestAuthorizesWrites,
  detectPermissionSeeking,
  decideWriteConfirmation,
  isTaskRefinement,
  IRREVERSIBLE_ACTION_RE,
} from '../../src/learning/autonomy-policy.js';

/**
 * G13 — "stop asking permission for work the request already authorized".
 *
 * Every string in `authorized` below is a REAL ask from a live run (the
 * story/book sessions, the composite web-book ask, the WhatsApp task). Every
 * string in `notAuthorized` is a case where the gate must stay exactly as
 * strict as it was.
 */
describe('requestAuthorizesWrites', () => {
  const authorized: Array<[string, string]> = [
    [
      'write a 12 page story called Kharig Nights about a village boy who finds a lamp in a banyan root, with suspense and wonder',
      'the exact goal of the live run that stopped to ask permission',
    ],
    [
      'develop a web-based interactive book: a 20 page story called Mahagatha with voice narration for every chapter, presented as a website',
      'the hybrid ask (prose + site)',
    ],
    ["build the app from this plan — it's a phased build, take the time you need", 'plan-driven build'],
    ['continue', 'a continuation authorizes the work it continues'],
    ['go ahead', 'short affirmative'],
    ['yes', 'short affirmative'],
    ['keep going and finish the remaining chapters', 'continuation phrasing inside a sentence'],
    ['create the project structure and write the chapters to /Users/dheeraj/Documents/story/', 'named destination path'],
    ['Can you create the interactive book site?', 'polite request form — not analysis'],
    ['add a README and a test suite', 'edit verbs count'],
    [
      'fix the calculator so that division by zero returns 0 instead of NaN',
      'a directive verb on existing work names no artifact at all — the noun list must not be the only way in',
    ],
    ['update the parser to handle unicode paths', 'directive verb, no artifact noun'],
    // ── The live regression: a question AND a directive in one message ────────
    // Verbatim from session f624a182, turn 38. The message OPENS with an
    // analysis word ("why"), which used to veto the whole turn — switching off
    // the autonomy gates and producing four permission prompts for a syntax
    // check. A complaint about repeated questions therefore caused them. The
    // directive clause is the authorization; the question is commentary.
    [
      'why are you asking me this again and again ? 🤔 Apply a safe expression parser ' +
        '(supporting parentheses, advanced functions, and a degree/radian toggle) by ' +
        'updating script.js — replace calculate & scientific functions',
      'a leading question must not de-authorize the directive that follows it',
    ],
    ['why is the converter broken? fix it and add a regression test', 'question clause + directive clause'],
    ['Remove the old parser. How is the build configured?', 'directive clause first, question after'],
    // Verb INFLECTIONS are the same evidence as the base form — "updating" and
    // "created" are how people actually write, and `\bupdate\b` missed them.
    ['updating the converter styles', 'inflected directive verb'],
    ['fixing the divide-by-zero path', 'inflected maintenance verb'],
    // A clarification of the active task opens with `when`, but it is not a
    // question: "when I said add images…" carries a create verb and a website.
    // Treating the subordinate `when` as an analysis opener revoked the whole
    // turn's write authorization and blocked the edits the plan already named.
    [
      'when i said add images to website i meand to say as background',
      'a clarification beginning with when is not a question',
    ],
  ];

  for (const [request, why] of authorized) {
    it(`authorizes: ${why}`, () => {
      expect(requestAuthorizesWrites(request).authorized).toBe(true);
    });
  }

  const notAuthorized: Array<[string, string]> = [
    ['', 'empty'],
    ['what does the writer agent do?', 'a question about the system'],
    ['explain how to create a file in node', 'analysis opener + create verb must NOT authorize'],
    ['how do I write a story to a file?', 'analysis opener'],
    ['compare vite and webpack', 'analysis opener'],
    ['why is the build failing?', 'a question with no directive clause stays a question'],
    ['how do I update the parser?', 'analysis opener + directive verb is still a question'],
    ['when should I create the file?', 'when + auxiliary is still a question'],
    ['read the story and tell me what you think', 'no creation verb'],
    ['thanks, that looks great', 'no request at all'],
  ];

  for (const [request, why] of notAuthorized) {
    it(`does NOT authorize: ${why}`, () => {
      expect(requestAuthorizesWrites(request).authorized).toBe(false);
    });
  }

  it('explains itself, so the judgment is auditable', () => {
    expect(requestAuthorizesWrites('write a 12 page story').reason).toMatch(/deliverable/);
    expect(requestAuthorizesWrites('what does X do?').reason).toMatch(/about the work/i);
    expect(requestAuthorizesWrites('').reason).toMatch(/no request text/);
  });
});

describe('isTaskRefinement', () => {
  it('recognises a correction/refinement of the active task', () => {
    for (const text of [
      'when i said add images to website i meand to say as background',
      'i meant as background',
      'to clarify, use the photo behind the cards',
      'make it the backdrop instead',
    ]) {
      expect(isTaskRefinement(text)).toBe(true);
    }
  });

  it('does not treat an unrelated question or a write veto as a refinement', () => {
    expect(isTaskRefinement('why is the build failing?')).toBe(false);
    expect(isTaskRefinement('what does the writer agent do?')).toBe(false);
    expect(isTaskRefinement('why did you use it?')).toBe(false);
    expect(isTaskRefinement('i meant as background — do not write any files')).toBe(false);
  });
});

describe('detectPermissionSeeking', () => {
  const seeking = [
    'Do you want me to create the full project structure with all the chapter pages?',
    'Shall I proceed with building the site now?',
    'Should I go ahead and write the remaining chapters?',
    'Would you like me to scaffold the project first?',
    'I can set this up for you. Awaiting your confirmation to proceed.',
    // The other live shape: a bare proposal question naming the create work.
    'Create the Mahagatha interactive-book project with 20 chapter pages and voice narration?',
    "Ready to proceed — let me know if you'd like me to start.",
  ];

  for (const text of seeking) {
    it(`detects: ${text.slice(0, 52)}…`, () => {
      expect(detectPermissionSeeking(text)).toBe(true);
    });
  }

  const notSeeking = [
    '',
    'Chapter 1\n\nArin hurried along the dusty lane, his bare feet leaving faint footprints.',
    'Done — I created chapters/01-chapter-1.md and stated the title in the document.',
    'The story uses a banyan tree as its central image, and the lamp is a test of character.',
    // A genuine content question is NOT permission-seeking.
    'Which of these two titles do you prefer?',
  ];

  for (const text of notSeeking) {
    it(`does not detect: ${text.slice(0, 52) || '(empty)'}`, () => {
      expect(detectPermissionSeeking(text)).toBe(false);
    });
  }

  it('only judges the CLOSING sentences — a question mid-answer is narration', () => {
    const text =
      'Should I use chapters or one long file? I checked the workspace and settled it: chapters.\n\n' +
      'Chapter 1 is written and saved to chapters/01-chapter-1.md.';
    expect(detectPermissionSeeking(text)).toBe(false);
  });
});

describe('decideWriteConfirmation', () => {
  it('proceeds on creating a file the request asked for', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'chapters/01-chapter-1.md',
      exists: false,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/destroys nothing/);
  });

  it('still asks when the target already exists (overwrite stays the user’s call)', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'kharig-nights.md',
      exists: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/already exists/);
  });

  it('still asks when the request never authorized file creation', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'chapter.md',
      exists: false,
      authorizedByRequest: false,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/did not ask for files/);
  });

  /**
   * THE RUN'S OWN OUTPUT — the measured defect (trace-1793853385112-sf2exl): an
   * assessment turn created its report, then could not add §2, because the path
   * existed. The report on disk stopped at one section. Existing content that the
   * RUN wrote, and nothing has touched since, is recoverable by definition.
   */
  it('proceeds on replacing a file this run wrote and nothing has changed', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'AUDIT_CROSSCHECK.md',
      exists: true,
      ownUnchanged: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/this run wrote/);
  });

  it('still asks when the file changed since this run wrote it', () => {
    // ownUnchanged is false: someone edited it, so the two cases diverged and
    // the original gate applies again.
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'AUDIT_CROSSCHECK.md',
      exists: true,
      ownUnchanged: false,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
  });

  it('never lets ownUnchanged bypass the request authorization', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'AUDIT_CROSSCHECK.md',
      exists: true,
      ownUnchanged: true,
      authorizedByRequest: false,
    });
    expect(verdict.action).toBe('ask');
  });
});

describe('decideWriteConfirmation — append is additive', () => {
  it('proceeds on the first section of a new file', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'report.md',
      exists: false,
      append: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
  });

  it('proceeds on appending another section to a file this run wrote', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'report.md',
      exists: true,
      append: true,
      ownUnchanged: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
  });

  it('proceeds on appending to an existing file the REQUEST names', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'CHANGELOG.md',
      exists: true,
      append: true,
      namedByRequest: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('proceed');
    expect(verdict.reason).toMatch(/names/);
  });

  it('asks before appending to a file nobody mentioned', () => {
    const verdict = decideWriteConfirmation({
      tool: 'write_file',
      path: 'README.md',
      exists: true,
      append: true,
      authorizedByRequest: true,
    });
    expect(verdict.action).toBe('ask');
    expect(verdict.reason).toMatch(/never mentioned/);
  });
});

describe('IRREVERSIBLE_ACTION_RE — the escalation escape', () => {
  it('matches the actions a question must never be auto-answered for', () => {
    for (const text of [
      'Do you want me to overwrite the existing kharig-nights.md?',
      'Should I delete the old chapters first?',
      'Shall I publish the release now?',
      'Do you want me to deploy this to production?',
      'Should I send the draft to Alex on WhatsApp?',
    ]) {
      expect(IRREVERSIBLE_ACTION_RE.test(text)).toBe(true);
    }
  });

  it('does not match ordinary creation questions', () => {
    for (const text of [
      'Do you want me to create the full project structure?',
      'Shall I write the remaining chapters?',
      'Should I add a README?',
    ]) {
      expect(IRREVERSIBLE_ACTION_RE.test(text)).toBe(false);
    }
  });
});
