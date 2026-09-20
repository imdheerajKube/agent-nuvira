/**
 * Recall policy (Q2) — the agent must know what THIS PROJECT already did.
 *
 * chat always recalled prior project work; edit/execute/plan/pipeline-tool gated
 * it behind a continue/resume signal, so the same request phrased as ordinary
 * work ("fix the slugify parser bug") started with no knowledge of what the
 * project — or the agent — had already done. The gate bought nothing: recall is
 * local JSON reads and `maybeAutoRecall` returns null for a project with no
 * history.
 *
 * The tests pin the two halves that must not be confused: WHETHER to recall
 * (always) versus whether to print a visible card (only when the user asked to
 * continue).
 */

import { describe, it, expect } from 'vitest';

import { recallPolicy } from '../../src/context/session-recall.js';

describe('recallPolicy', () => {
  it('recalls for ordinary work requests — not only continuations', () => {
    for (const intent of ['fix', 'implement', 'create', 'explain', 'refactor', undefined]) {
      expect(recallPolicy({ intent }).recall).toBe(true);
    }
  });

  it('recalls for every dispatch mode', () => {
    for (const mode of ['code', 'plan', 'recall', undefined]) {
      expect(recallPolicy({ mode }).recall).toBe(true);
    }
  });

  it('announces the card ONLY when the user explicitly continued or resumed', () => {
    expect(recallPolicy({ intent: 'continue' }).announce).toBe(true);
    expect(recallPolicy({ intent: 'resume' }).announce).toBe(true);
    expect(recallPolicy({ mode: 'recall' }).announce).toBe(true);
  });

  it('stays quiet for background recall — an unrequested card on every command is noise', () => {
    expect(recallPolicy({ intent: 'fix' }).announce).toBe(false);
    expect(recallPolicy({ intent: 'implement' }).announce).toBe(false);
    expect(recallPolicy({ mode: 'plan' }).announce).toBe(false);
    expect(recallPolicy().announce).toBe(false);
  });

  it('is callable with no argument (every call site has one, but never crash)', () => {
    expect(recallPolicy()).toEqual({ recall: true, announce: false });
  });
});
