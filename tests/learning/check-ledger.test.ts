/**
 * A red check must be ANSWERED, not outlived, and a completion claim must match the
 * turn's evidence. Both are pure decisions over a recorded turn, which is why they
 * can be pinned without a model.
 */

import { describe, it, expect } from 'vitest';

import { parseFailingCount, redCheckNudge, unansweredRedChecks, type CheckRun } from '../../src/learning/check-ledger.js';
import {
  FINISH_ACCEPTED_MARKER,
  FINISH_REFUSED_MARKER,
  completionNudge,
  judgeCompletion,
} from '../../src/learning/completion-contract.js';

const CLEAN = {
  unmet: [] as string[],
  redChecks: [] as { command: string; stale?: boolean }[],
  unboundModules: [] as string[],
  wroteFiles: true,
  checksRan: 2,
};

describe('unansweredRedChecks', () => {
  it('drops a check that was re-run green (last run wins)', () => {
    const runs: CheckRun[] = [
      { command: 'npm test', tool: 'run_terminal', ok: false, afterWrites: 1 },
      { command: 'npm test', tool: 'run_terminal', ok: true, afterWrites: 2 },
    ];
    expect(unansweredRedChecks(runs, 2)).toEqual([]);
  });

  it('marks a failure that the code changed after as STALE — re-run is the answer', () => {
    const runs: CheckRun[] = [{ command: 'npx tsc --noEmit', tool: 'run_terminal', ok: false, afterWrites: 1 }];
    const [red] = unansweredRedChecks(runs, 4);
    expect(red.command).toBe('npx tsc --noEmit');
    expect(red.stale).toBe(true);
    expect(red.writesSince).toBe(3);
  });

  it('keeps a failure that still stands as red, not stale', () => {
    const runs: CheckRun[] = [{ command: 'npm test', tool: 'run_terminal', ok: false, afterWrites: 3 }];
    const [red] = unansweredRedChecks(runs, 3);
    expect(red.stale).toBe(false);
    expect(redCheckNudge([red])).toContain('has not passed since');
  });

  // ── the repo was already red when the turn arrived ───────────────────────
  // Measured 2026-10-29 (BUG-SEEDED): the seeded project ships 113 failing tests.
  // The arm ran the suite, fixed the four defects it was asked about, re-ran the
  // suite — still 113 failures it did not cause — and `finish` refused because the
  // command was "red". It then spent steps re-running a suite that could not go
  // green, and nearly ended without the report it was actually asked for. A failure
  // that pre-dates the turn and did not get worse is the repository's condition.
  it('treats a failure that was ALREADY red, and no worse, as pre-existing', () => {
    const runs: CheckRun[] = [
      { command: 'python3 -m pytest tests/ -q', tool: 'run_terminal', ok: false, afterWrites: 0, failing: 113 },
      { command: 'python3 -m pytest tests/ -q', tool: 'run_terminal', ok: false, afterWrites: 2, failing: 113 },
    ];
    const [red] = unansweredRedChecks(runs, 2);
    expect(red.preExisting).toBe(true);
    expect(red.baseline).toBe(113);
    // Not "stale": there is nothing to re-run toward — the tree is exactly as red.
    expect(red.stale).toBe(false);
    expect(redCheckNudge([red])).toContain('ALREADY red before you changed anything');
  });

  it('does NOT excuse a failure that got WORSE than the baseline', () => {
    const runs: CheckRun[] = [
      { command: 'python3 -m pytest tests/ -q', tool: 'run_terminal', ok: false, afterWrites: 0, failing: 113 },
      { command: 'python3 -m pytest tests/ -q', tool: 'run_terminal', ok: false, afterWrites: 2, failing: 118 },
    ];
    const [red] = unansweredRedChecks(runs, 2);
    // Still red THIS TURN made worse: no excuse, and the claim stays refused.
    expect(red.preExisting).toBeUndefined();
    expect(red.stale).toBe(false);
    const verdict = judgeCompletion(
      { summary: 'Fixed four defects', verified: true },
      { ...CLEAN, redChecks: [{ command: 'python3 -m pytest tests/ -q', stale: false }] },
    );
    expect(verdict.accepted).toBe(false);
  });

  it('keeps the strict reading when the output named no failure count', () => {
    const runs: CheckRun[] = [
      { command: 'make test', tool: 'run_terminal', ok: false, afterWrites: 0 },
      { command: 'make test', tool: 'run_terminal', ok: false, afterWrites: 1 },
    ];
    const [red] = unansweredRedChecks(runs, 1);
    expect(red.preExisting).toBeUndefined();
  });

  it('says which command failed and refuses a "verified" ending', () => {
    const text = redCheckNudge([{ command: 'npm test', tool: 'run_terminal', stale: true, writesSince: 2 }]);
    expect(text).toContain('`npm test` FAILED');
    expect(text).toContain('changed 2 time(s)');
    expect(text).toContain('Do not describe the work as verified');
  });
});

describe('parseFailingCount', () => {
  it('reads the counts the benchmark projects actually print', () => {
    expect(parseFailingCount('125 failed, 487 passed, 3 skipped in 11.05s')).toBe(125);
    expect(parseFailingCount('Ran 450 tests in 9.06s\n\nFAILED (failures=3, errors=17, skipped=1)')).toBe(20);
    expect(parseFailingCount('3 tests failed')).toBe(3);
    expect(parseFailingCount('all good')).toBeUndefined();
  });
});

describe('judgeCompletion', () => {
  it('does not refuse a verified claim for a pre-existing red check, but says it is red', () => {
    const verdict = judgeCompletion(
      { summary: 'Fixed four defects and wrote the report', verified: true },
      { ...CLEAN, redChecks: [{ command: 'pytest', stale: false, preExisting: true }] },
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.warnings.some((w) => w.includes('already failing before this turn'))).toBe(true);
  });

  it('still refuses a check this turn made worse', () => {
    const verdict = judgeCompletion(
      { summary: 'Done', verified: true },
      { ...CLEAN, redChecks: [{ command: 'pytest', stale: true }] },
    );
    expect(verdict.accepted).toBe(false);
  });
  it('accepts a verified claim the evidence backs', () => {
    const verdict = judgeCompletion({ summary: 'Shipped the checkout route and its tests', verified: true }, CLEAN);
    expect(verdict.accepted).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('SHOWS an unmet requirement row as an observation, and does not refuse the claim', () => {
    // A row is the request read back as prose. It may be the wrong reading of the ask,
    // or satisfied in a way no static reader can see, so it is an observation the model
    // can answer — not a verdict over the work.
    const verdict = judgeCompletion(
      { summary: 'Done', verified: true },
      { ...CLEAN, unmet: ['README.md — what this is and how to run it'] },
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.warnings.join(' ')).toContain('README.md');
  });

  it('refuses "verified" while a check is red — an executed failure is evidence, not a prediction', () => {
    const red = judgeCompletion({ summary: 'Done', verified: true }, {
      ...CLEAN,
      redChecks: [{ command: 'npm test', stale: true }],
    });
    expect(red.accepted).toBe(false);
    expect(red.problems.join(' ')).toContain('not been re-run');
  });

  it('SHOWS a new module with no static test import, because a test may reach it another way', () => {
    const unbound = judgeCompletion({ summary: 'Done', verified: true }, {
      ...CLEAN,
      unboundModules: ['src/modules/reports/service.ts'],
    });
    expect(unbound.accepted).toBe(true);
    expect(unbound.problems).toEqual([]);
    expect(unbound.warnings.join(' ')).toContain('no test file was found importing it');
  });

  it('SHOWS a runnable entry point with no README, and lets the model decide', () => {
    const verdict = judgeCompletion(
      { summary: 'Shipped the app', verified: true },
      { ...CLEAN, quickstart: { entry: 'package.json' } },
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.warnings.join(' ')).toContain('no README a fresh clone could follow');
  });

  it('refuses "verified" when files changed and no check ever ran', () => {
    const verdict = judgeCompletion({ summary: 'Done', verified: true }, { ...CLEAN, checksRan: 0 });
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.join(' ')).toContain('no check ever ran');
  });

  it('refuses a claim with no summary, because it states nothing', () => {
    const verdict = judgeCompletion({ verified: true }, CLEAN);
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems[0]).toContain('one line');
  });

  it('accepts verified:false ONLY when it says what is missing', () => {
    const silent = judgeCompletion({ summary: 'Mostly done', verified: false }, CLEAN);
    expect(silent.accepted).toBe(false);
    expect(silent.problems[0]).toContain('verified:false must list');

    const honest = judgeCompletion(
      { summary: 'Mostly done', verified: false, unmet: ['e2e run needs a browser install'] },
      CLEAN,
    );
    expect(honest.accepted).toBe(true);
    expect(honest.summary).toContain('1 stated gap');
  });

  it('markers are what the loop reads — never prose', () => {
    expect(FINISH_ACCEPTED_MARKER).toBe('Completion accepted');
    expect(FINISH_REFUSED_MARKER).toBe('Completion NOT accepted');
    expect(FINISH_REFUSED_MARKER.startsWith(FINISH_ACCEPTED_MARKER)).toBe(false);
  });
});

describe('completionNudge', () => {
  it('lists what is outstanding and offers both exits', () => {
    const text = completionNudge({
      unmet: ['README.md — what this is and how to run it', 'the test suite must actually RUN and pass'],
      unboundModules: ['src/modules/reports/service.ts'],
      redChecks: ['npm test (not re-run since the code changed)'],
    });
    expect(text).toContain('not done: README.md');
    expect(text).toContain('no test imports it');
    expect(text).toContain('npm test');
    expect(text).toContain('verified:false');
  });

  it('is bounded — never a wall of text', () => {
    const text = completionNudge({
      unmet: Array.from({ length: 12 }, (_, i) => `row ${i}`),
    });
    expect(text).toContain('row 5');
    expect(text).not.toContain('row 6');
    expect(text).toContain('…and 6 more');
  });
});
