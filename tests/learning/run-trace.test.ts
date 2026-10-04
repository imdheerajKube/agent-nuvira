/**
 * The Run Trace — the loop's representation of its own behaviour.
 *
 * The live failure this pins: a turn asked FOUR variants of "may I run `node -c
 * script.js`?" and nothing in the system held the fact that it had asked before.
 * So it could not notice the loop, could not stop it, and could not answer the
 * user who asked why it kept asking. A representation of the run is what makes
 * all three possible; these tests are about the representation being good enough
 * to recognise a REAL repeat without flagging genuinely different questions.
 */

import { describe, it, expect } from 'vitest';

import {
  RunTrace,
  detectProcessComplaint,
  isSameQuestion,
  isTraceKey,
  questionShape,
  repeatNudge,
  repeatedFailureNudge,
  noProgressNudge,
  runTraceFor,
  peekRunTrace,
  clearRunTrace,
  MAX_TRACE_ENTRIES,
} from '../../src/learning/run-trace.js';

/** The four questions a live turn actually asked (verbatim shapes). */
const LIVE_ASKS = [
  'Run a JavaScript syntax check (`node -c script.js`) to make sure the edits parse?',
  'May I run `node -c script.js` to perform a syntax check?',
  'May I run `node -c script.js` to verify the changes are valid?',
  'Run a JavaScript syntax check (node -c script.js)?',
];

describe('questionShape + isSameQuestion — recognising a REAL repeat', () => {
  it('collapses the four variants a live turn asked to one question', () => {
    const first = questionShape(LIVE_ASKS[0]);
    for (const variant of LIVE_ASKS.slice(1)) {
      expect(isSameQuestion(first, questionShape(variant)), variant).toBe(true);
    }
  });

  it('does NOT collapse genuinely different questions', () => {
    const a = questionShape('Which runtime should I use?');
    const b = questionShape('Which database should I use?');
    expect(isSameQuestion(a, b)).toBe(false);
  });

  it('joins on a shared TARGET even when the wording is nothing alike', () => {
    // No shared tokens at all — the target is the whole reason these are the
    // same ask, and the reason targets are checked before tokens.
    const a = questionShape('Apply the patch to `src/a.ts`?');
    const b = questionShape('Shall I write the changes into src/a.ts?');
    expect(isSameQuestion(a, b)).toBe(true);
  });

  it('uses token overlap only when neither question names a target', () => {
    const a = questionShape('Should I prefer the streaming approach for large files?');
    const b = questionShape('Should I prefer the streaming approach for big files?');
    expect(isSameQuestion(a, b)).toBe(true);
  });

  it('treats an empty shape as matching nothing', () => {
    expect(isSameQuestion(questionShape(''), questionShape(''))).toBe(false);
  });
});

describe('RunTrace — what the run knows about itself', () => {
  it('counts a repeat and keeps the answer the user gave', () => {
    const t = new RunTrace();
    t.recordAsk(LIVE_ASKS[0], true, 'Yes, run it');
    t.recordAsk(LIVE_ASKS[1], true, 'Yes');
    t.recordAsk(LIVE_ASKS[2], true, 'Yes');

    expect(t.priorAskMatches(LIVE_ASKS[3])).toHaveLength(3);
    // The most recent SHOWN answer is the one handed back.
    expect(t.priorAnswer(LIVE_ASKS[3])).toBe('Yes');
    expect(t.repeatedAskCount()).toBe(2);
    expect(t.countAsks()).toBe(3);
  });

  it('groups the asks so a self-report can say "asked 4×"', () => {
    const t = new RunTrace();
    for (const q of LIVE_ASKS) t.recordAsk(q, true, 'Yes');
    const summary = t.askSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].times).toBe(4);
    expect(summary[0].answer).toBe('Yes');
  });

  it('separates SHOWN asks from suppressed ones', () => {
    const t = new RunTrace();
    t.recordAsk('Do you want me to proceed?', false);
    t.recordAsk('Which runtime?', true, 'Node');
    expect(t.countAsks()).toBe(2);
    expect(t.countShownAsks()).toBe(1);
  });

  it('has no prior answer when the earlier ask was never shown', () => {
    const t = new RunTrace();
    t.recordAsk('May I run `node -c script.js`?', false);
    expect(t.priorAskMatches(LIVE_ASKS[0])).toHaveLength(1);
    expect(t.priorAnswer(LIVE_ASKS[0])).toBeUndefined();
  });

  it('stays bounded — a long conversation cannot grow it without limit', () => {
    const t = new RunTrace();
    for (let i = 0; i < MAX_TRACE_ENTRIES + 25; i += 1) {
      t.recordAsk(`Unique question number ${i} about feature ${i}?`, true, 'ok');
    }
    expect(t.countAsks()).toBe(MAX_TRACE_ENTRIES);
  });

  it('tracks refusals and the files actually changed', () => {
    const t = new RunTrace();
    t.recordRefusal('run_terminal', 'changes state and needs explicit confirmation', 'running "npm publish"');
    t.recordMutation('edit_file', 'script.js');
    t.recordMutation('edit_file', 'script.js');
    t.recordMutation('write_file', 'style.css');
    expect(t.distinctMutationPaths()).toEqual(['script.js', 'style.css']);
    expect(t.priorRefusalMatches('run_terminal', 'running "npm publish"')).toBe(1);
  });

  /**
   * The self-diagnosis signal: an action that RAN and FAILED, more than once.
   *
   * The live macOS-build turn re-issued `npx tauri build` ~10 times against the
   * same missing Rust/Cargo and never once stopped to ask WHY — the run had no
   * record of its own repeated failure. This is that record.
   */
  it('recognizes the SAME failing action run more than once', () => {
    const t = new RunTrace();
    t.recordFailure('run_terminal', 'npx tauri build', 'command not found: cargo');
    t.recordFailure('run_terminal', 'npx tauri build', 'command not found: cargo');
    const repeated = t.repeatedFailure();
    expect(repeated).not.toBeNull();
    expect(repeated!.times).toBe(2);
    expect(repeated!.action).toBe('npx tauri build');
    expect(repeated!.detail).toContain('cargo');
  });

  it('does NOT flag ordinary iteration — distinct failures are not a loop', () => {
    const t = new RunTrace();
    t.recordFailure('run_terminal', 'npm test', 'exit 1');
    t.recordFailure('run_terminal', 'npm run build', 'exit 2');
    // Different actions, one failure each → no repeated action → no diagnosis.
    expect(t.repeatedFailure()).toBeNull();
    // A single failure is likewise not a loop.
    const single = new RunTrace();
    single.recordFailure('run_terminal', 'npx tauri build', 'exit 1');
    expect(single.repeatedFailure()).toBeNull();
  });
});

describe('selfReport — the material for answering "why are you asking again?"', () => {
  it('leads with the repetition and states the answer', () => {
    const t = new RunTrace();
    for (const q of LIVE_ASKS) t.recordAsk(q, true, 'Yes, go ahead');
    t.recordMutation('edit_file', 'script.js');

    const report = t.selfReport();
    expect(report).toContain('You asked 4 question(s)');
    expect(report).toContain('3 of them repeated');
    expect(report).toContain('the user answered: "Yes, go ahead"');
    expect(report).toContain('script.js');
    // The instruction that stops the loop rather than merely describing it.
    expect(report).toMatch(/Do not ask it again/);
  });

  it('says plainly when there was no repetition', () => {
    const t = new RunTrace();
    t.recordAsk('Which runtime should I use?', true, 'Node');
    const report = t.selfReport();
    expect(report).toContain('0 of them repeated');
    expect(report).not.toMatch(/You REPEATED/);
  });

  it('reports an untouched workspace honestly', () => {
    const t = new RunTrace();
    expect(t.selfReport()).toContain('You have not changed any files');
    expect(t.selfReport()).toContain('have not asked the user any questions');
  });
});

describe('detectProcessComplaint — the user asking about the RUN', () => {
  const complaints = [
    'why are you asking me this again and again ?',
    'why are you asking me this again and again ? 🤔 Apply a safe expression parser by updating script.js',
    'stop asking me every second',
    'you keep asking permission for everything',
    'why do you ask the same question?',
    'enough with the prompts',
  ];
  for (const text of complaints) {
    it(`detects: ${text.slice(0, 48)}`, () => {
      expect(detectProcessComplaint(text)).toBe(true);
    });
  }

  const notComplaints = [
    '',
    'fix the calculator parser',
    'why is the converter blank?',
    'add keyboard support',
    'explain how the router works',
  ];
  for (const text of notComplaints) {
    it(`does not detect: ${text.slice(0, 48) || '(empty)'}`, () => {
      expect(detectProcessComplaint(text)).toBe(false);
    });
  }
});

describe('per-conversation storage', () => {
  it('gives one trace per conversation, so a loop ACROSS turns is visible', () => {
    const a = { id: 'session-a' };
    const b = { id: 'session-b' };
    runTraceFor(a).recordAsk('May I run `node -c script.js`?', true, 'Yes');

    expect(peekRunTrace(a)?.countAsks()).toBe(1);
    expect(peekRunTrace(b)).toBeUndefined();
    // A second turn on the same conversation sees the first turn's asks.
    expect(runTraceFor(a).priorAskMatches('Run `node -c script.js`?')).toHaveLength(1);
  });

  it('is dropped with the conversation', () => {
    const key = { id: 'gone' };
    runTraceFor(key).recordAsk('x?', true);
    clearRunTrace(key);
    expect(peekRunTrace(key)).toBeUndefined();
  });

  it('rejects non-object keys', () => {
    expect(isTraceKey('a-string')).toBe(false);
    expect(peekRunTrace(undefined)).toBeUndefined();
    expect(peekRunTrace('nope' as unknown as object)).toBeUndefined();
  });
});

describe('repeatNudge — stop the loop without bulldozing the decision', () => {
  it('hands back the answer and forbids the repeat', () => {
    const text = repeatNudge('May I run `node -c script.js`?', 'Yes');
    expect(text).toContain('ALREADY answered');
    expect(text).toContain('Their answer was: "Yes"');
    expect(text).toContain('Do NOT ask it again');
  });

  it('never orders the model to proceed (unsafe when the answer was "no")', () => {
    const text = repeatNudge('Do you want me to overwrite index.html?', 'No');
    expect(text).not.toMatch(/\bproceed\b/i);
    expect(text).toMatch(/what blocks you/);
  });
});

describe('repeatedFailureNudge — the self-diagnosis correction', () => {
  const failure = {
    tool: 'run_terminal',
    action: 'npx tauri build',
    times: 3,
    detail: 'command not found: cargo',
  };

  it('names the repeated action, its count, and the failure', () => {
    const text = repeatedFailureNudge(failure);
    expect(text).toContain('npx tauri build');
    expect(text).toContain('3 times');
    expect(text).toContain('command not found: cargo');
  });

  it('demands a diagnosis and a changed approach, not another retry', () => {
    const text = repeatedFailureNudge(failure);
    expect(text).toMatch(/ROOT CAUSE/);
    expect(text).toMatch(/DIFFERENT action/);
    expect(text).toMatch(/STOP retrying/);
    // The one move that produced the loop must be forbidden explicitly.
    expect(text).toMatch(/Do NOT ask the user for permission to run the same failing command/);
  });
});

describe('recentFailures + noProgressNudge — the GENERALIZED stall', () => {
  it('hands back the most recent failures, newest last and bounded', () => {
    const t = new RunTrace();
    t.recordFailure('run_terminal', 'npm test', 'exit 1');
    t.recordFailure('run_terminal', 'npm run build', 'exit 2');
    t.recordFailure('run_terminal', 'npm run lint', 'exit 3');
    const recent = t.recentFailures(2);
    expect(recent.map((f) => f.action)).toEqual(['npm run build', 'npm run lint']);
  });

  it('names every attempt and demands a shared-cause diagnosis', () => {
    const failures = [
      { tool: 'run_terminal', action: 'npx tauri build', detail: 'command not found: cargo' },
      { tool: 'run_terminal', action: 'cargo build', detail: 'command not found: cargo' },
      { tool: 'run_terminal', action: 'rustc src/main.rs', detail: 'command not found: cargo' },
      { tool: 'run_terminal', action: 'cargo install tauri-cli', detail: 'command not found: cargo' },
    ];
    const text = noProgressNudge(failures, 4);
    expect(text).toContain('4 attempts');
    expect(text).toContain('npx tauri build');
    expect(text).toContain('cargo install tauri-cli');
    expect(text).toMatch(/STALL/);
    expect(text).toMatch(/shared cause/);
    expect(text).toMatch(/DIFFERENT action/);
  });

  it('still gives usable guidance when no single action repeated', () => {
    const text = noProgressNudge([], 5);
    expect(text).toContain('5 attempts');
    expect(text).toContain('no single action repeated');
    expect(text).toMatch(/DIAGNOSE/);
  });
});
