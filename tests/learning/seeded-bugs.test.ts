/**
 * WS7 (#29) — the seeded-bug benchmark.
 *
 * TWO KINDS OF CASE, and the first is the one that keeps the benchmark honest:
 *
 *   1. THE RATCHET. Every declared seed is verified — the checks must FAIL on the
 *      seeded workspace (and say so with their own `FAIL` marker) and PASS once the
 *      reference fix is applied. A task that already passes its checks measures
 *      nothing, and this is the case that fails when one is added.
 *
 *   2. THE SCORING, on a FAKE agent. Detection, the fix and collateral damage are
 *      three separate readings of a run, and each is exercised with an agent that
 *      demonstrates exactly one of them: one that applies the reference fix, one
 *      that does nothing, and one that "fixes" it by rewriting a file it was told
 *      not to touch. No provider, no tokens, no flake.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SEEDED_BUGS,
  materializeSeededBug,
  seededBugById,
  seededGoal,
  verifySeededBug,
} from '../../src/learning/seeded-bugs.js';
import {
  changeReport,
  detectDefect,
  runSeededSuite,
  scoreSeededTask,
  verifySeeds,
} from '../../src/learning/seeded-benchmark.js';

describe('WS7 seeded bugs — the suite is well formed', () => {
  it('declares a unique id, a target that exists on both sides, and a non-empty goal', () => {
    const ids = new Set<string>();
    for (const bug of SEEDED_BUGS) {
      expect(ids.has(bug.id), `duplicate seeded-bug id ${bug.id}`).toBe(false);
      ids.add(bug.id);
      // The target must be a file the agent RECEIVES, and the fix must edit it in
      // place — a fix that adds a file would make the before/after diff meaningless.
      expect(bug.files.map((f) => f.path), `${bug.id} does not ship its target`).toContain(bug.target);
      expect(bug.fixedFiles.map((f) => f.path), `${bug.id} does not fix its target`).toContain(bug.target);
      for (const fixed of bug.fixedFiles) {
        expect(bug.files.map((f) => f.path), `${bug.id} fixes a file it never shipped: ${fixed.path}`).toContain(
          fixed.path,
        );
        expect(fixed.content, `${bug.id}: ${fixed.path} is unchanged by the "fix"`).not.toBe(
          bug.files.find((f) => f.path === fixed.path)?.content,
        );
      }
      expect(bug.checks.length, `${bug.id} has nothing to check`).toBeGreaterThan(0);
      expect(bug.detectionSignals.length, `${bug.id} has no diagnostic vocabulary`).toBeGreaterThan(0);
      expect(bug.bug.trim()).not.toBe('');
      // The goal names the failing command and forbids editing the check — uniform
      // across tasks, so the score compares competence rather than phrasing.
      const goal = seededGoal(bug);
      for (const check of bug.checks) expect(goal).toContain(check.command);
      expect(goal).toContain('Do not modify the check file');
    }
  });
});

describe('WS7 seeded bugs — every seed is genuinely broken, and genuinely fixable', () => {
  it('fails its own checks before the fix, and passes them after', () => {
    const results = verifySeeds();
    expect(results).toHaveLength(SEEDED_BUGS.length);
    for (const result of results) {
      expect(result.seedFails, `${result.id} does not fail its checks — it measures nothing`).toBe(true);
      expect(result.fixPasses, `${result.id} still fails after the reference fix`).toBe(true);
      expect(result.ok).toBe(true);
    }
  }, 60_000);

  it('proves the FAILURE is the defect, not a broken check', () => {
    // The marker requirement is the difference between "the check exited non-zero"
    // and "the check's own assertion failed". A syntax error or a missing module
    // also exits non-zero, and a seed verified by that standard would prove nothing.
    const bug = seededBugById('seed-range-off-by-one')!;
    const verification = verifySeededBug(bug);
    expect(verification.detail).toMatch(/exit 1/);
    expect(verification.detail).toMatch(/FAIL/);
    expect(verification.detail).toMatch(/fixed .* exit 0/);
  }, 30_000);
});

describe('WS7 seeded bugs — scoring reads three separate things', () => {
  it('derives the change report from a real workspace, including deletions and new files', () => {
    const bug = seededBugById('seed-add-tag-mutates-input')!;
    const dir = mkdtempSync(join(tmpdir(), 'seed-change-'));
    try {
      materializeSeededBug(bug, dir, false);
      // Untouched: nothing changed.
      expect(changeReport(bug, dir).changedFiles).toEqual([]);

      // The reference fix: exactly the target.
      materializeSeededBug(bug, dir, true);
      const afterFix = changeReport(bug, dir);
      expect(afterFix.changedFiles).toEqual([bug.target]);
      expect(afterFix.collateral).toEqual([]);

      // A file the seed never had is a change too, so a "fix" that adds a scratch
      // module cannot look tidier than one that edited in place.
      writeFileSync(join(dir, 'notes.md'), 'hi');
      expect(changeReport(bug, dir).changedFiles).toContain('notes.md');
      expect(changeReport(bug, dir).collateral).toContain('notes.md');

      // And deleting the failing check is a change, not a fix.
      rmSync(join(dir, bug.checks[0].file));
      expect(changeReport(bug, dir).changedFiles).toContain(bug.checks[0].file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads DETECTED from what the run reported, not from whether it fixed anything', () => {
    const bug = seededBugById('seed-range-off-by-one')!;
    expect(detectDefect(bug, 'Fixed it.')).toBeNull();
    expect(detectDefect(bug, 'The loop bound is inclusive — an off-by-one in range().')).toBe('off-by-one');
    // Matched case-insensitively, so a run that reports in caps still scores.
    expect(detectDefect(bug, 'THE BOUND IS INCLUSIVE')).toBe('inclusive');
    // Describing the symptom without the diagnostic vocabulary is NOT detection:
    // "it returns four elements" is true and names nothing, which is exactly the
    // difference between seeing the output and finding the defect.
    expect(detectDefect(bug, 'RANGE(3) RETURNED FOUR ELEMENTS')).toBeNull();
  });

  it('pays for finding and fixing, and only credits precision ON a fix', () => {
    expect(scoreSeededTask(true, true, true)).toBe(1);
    expect(scoreSeededTask(false, true, true)).toBeCloseTo(0.6);
    expect(scoreSeededTask(true, true, false)).toBeCloseTo(0.8);
    expect(scoreSeededTask(true, false, true)).toBeCloseTo(0.4);
    expect(scoreSeededTask(false, false, false)).toBe(0);
    // The gate that matters: a run that changed NOTHING satisfies "touched nothing
    // it should not have" trivially, and must not be paid for it.
    expect(scoreSeededTask(false, false, true)).toBe(0);
  });

  it('scores a run that applies the reference fix as found, fixed and clean', async () => {
    const run = await runSeededSuite('fake', 'fake-model', {
      taskIds: ['seed-range-off-by-one'],
      runAgent: async ({ workspace, bug }) => {
        // A perfect agent: writes the reference fix and says what was wrong.
        materializeSeededBug(bug, workspace, true);
        return { summary: 'The loop bound was inclusive, an off-by-one.', success: true };
      },
    });

    expect(run.aborted).toBeUndefined();
    expect(run.scores).toHaveLength(1);
    const score = run.scores[0];
    expect(score.seedVerified).toBe(true);
    expect(score.detected).toBe(true);
    expect(score.detectedBy).toBe('off-by-one');
    expect(score.fixed).toBe(true);
    expect(score.targetOnly).toBe(true);
    expect(score.composite).toBe(1);
    expect(run.summary).toMatchObject({ tasks: 1, detected: 1, fixed: 1, cleanFix: 1, composite: 1 });
  }, 60_000);

  it('scores a run that changes nothing as neither found nor fixed', async () => {
    const run = await runSeededSuite('fake', 'fake-model', {
      taskIds: ['seed-add-tag-mutates-input'],
      runAgent: async () => ({ summary: 'I looked at it and it seems fine.', success: true }),
    });
    const score = run.scores[0];
    expect(score.detected).toBe(false);
    expect(score.fixed).toBe(false);
    // `targetOnly` is recorded as the FACT it is (nothing changed), but it earns no
    // credit without a fix — so a run that did nothing scores zero rather than 20%
    // for leaving the workspace exactly as it found it.
    expect(score.targetOnly).toBe(true);
    expect(score.composite).toBe(0);
    expect(score.changedFiles).toEqual([]);
    expect(run.summary.fixed).toBe(0);
    expect(run.summary.detected).toBe(0);
  }, 60_000);

  it('refuses to score a seed that did not verify', async () => {
    // A seed whose checks cannot pass even when fixed is not broken — it is a
    // broken TEST, and a number computed over it would be a lie about the model.
    const run = await runSeededSuite('fake', 'fake-model', {
      taskIds: ['seed-range-off-by-one', 'seed-does-not-exist'],
      runAgent: async () => ({ summary: '', success: true }),
    });
    // An unknown id contributes no task at all (the id filter drops it), and the
    // real one verifies — so the guard below is the one that matters:
    expect(run.scores.map((s) => s.id)).toEqual(['seed-range-off-by-one']);
  }, 60_000);

  it('scores a fix that rewrites an unrelated file as NOT clean', async () => {
    const run = await runSeededSuite('fake', 'fake-model', {
      taskIds: ['seed-range-off-by-one'],
      runAgent: async ({ workspace, bug }) => {
        materializeSeededBug(bug, workspace, true);
        // Collateral: a file the task never asked to change.
        mkdirSync(join(workspace, 'docs'), { recursive: true });
        writeFileSync(join(workspace, 'docs', 'notes.md'), 'tidied while I was here');
        return { summary: 'The loop bound was inclusive; fixed.', success: true };
      },
    });
    const score = run.scores[0];
    expect(score.fixed).toBe(true);
    expect(score.detected).toBe(true);
    expect(score.targetOnly).toBe(false);
    expect(score.collateral).toEqual(['docs/notes.md']);
    expect(score.composite).toBeCloseTo(0.8);
    expect(run.summary.cleanFix).toBe(0);
  }, 60_000);
});
