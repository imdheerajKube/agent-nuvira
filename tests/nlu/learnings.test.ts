/**
 * NLU learnings — the memory half of self-correction.
 *
 * A confirmed misreading must change how the SAME ask routes from then on, and
 * must NOT leak onto a different ask. Both halves are load-bearing: without the
 * first the agent never improves, and without the second it degrades — the
 * observed object-blindness ("create a *project plan* to develop X" vs "create a
 * *plan* for my kid") is exactly the distinction a fuzzy matcher would erase.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyLearning,
  clearLearnings,
  listLearnings,
  matchLearning,
  recordLearning,
  removeLearning,
  signatureOf,
} from '../../src/nlu/learnings.js';
import { explainAskKind, resolveAskKind } from '../../src/nlu/conversation-gate.js';

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-nlu-learnings-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  clearLearnings();
});

afterEach(() => {
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('signatureOf', () => {
  it('ignores word order, repetition, punctuation and politeness', () => {
    const a = signatureOf('Create a plan for my kid, please!');
    expect(a).toBe(signatureOf('please create a plan for my kid'));
    expect(a).toBe(signatureOf('Create a plan for my kid, please!'));
  });

  it('keeps every word that carries meaning', () => {
    expect(signatureOf('create a project plan to develop a calculator')).not.toBe(
      signatureOf('create a plan for my kid'),
    );
  });

  it('is empty for text with no signal at all', () => {
    expect(signatureOf('   ')).toBe('');
    expect(signatureOf('the a of')).toBe('');
  });
});

describe('recording and matching', () => {
  const PLAN_ASK = 'explain how the data pipeline works';

  it('stores a readable example alongside the signature', () => {
    const learning = recordLearning({ text: PLAN_ASK, from: 'chat', to: 'pipeline', reason: 'it wants code' })!;
    expect(learning.example).toBe(PLAN_ASK);
    expect(learning.hits).toBe(0);
    const stored = listLearnings();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.signature).toBe(signatureOf(PLAN_ASK));
  });

  it('refreshes one entry per (ask, target) instead of accumulating duplicates', () => {
    recordLearning({ text: PLAN_ASK, from: 'chat', to: 'pipeline' });
    recordLearning({ text: 'explain how the data pipeline works', from: 'chat', to: 'pipeline' });
    expect(listLearnings()).toHaveLength(1);
  });

  it('a contradicting correction SUPERSEDES the earlier one', () => {
    recordLearning({ text: PLAN_ASK, from: 'chat', to: 'pipeline' });
    recordLearning({ text: PLAN_ASK, from: 'pipeline', to: 'chat' });
    const stored = listLearnings();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.to).toBe('chat');
  });

  it('refuses a no-op correction', () => {
    expect(recordLearning({ text: PLAN_ASK, from: 'chat', to: 'chat' })).toBeUndefined();
    expect(listLearnings()).toHaveLength(0);
  });

  it('matches the same ask, reordered — and nothing looser', () => {
    recordLearning({ text: 'create a plan for my kid to speak english', from: 'chat', to: 'pipeline' });
    expect(matchLearning('create a plan for my kid to speak english')).toBeDefined();
    // ADDING a word keeps the same object, so it still matches…
    expect(matchLearning('create a plan for my kid to speak english fluently')).toBeDefined();
    // …but SUBSTITUTING one does not: the object may have changed.
    expect(matchLearning('create a plan for my colleague to speak english')).toBeUndefined();
    // The live object-blindness pair: same words at the edges, different object.
    expect(matchLearning('create a project plan to develop a calculator and unit converter')).toBeUndefined();
    expect(matchLearning('explain how the router picks a model')).toBeUndefined();
  });

  it('can be forgotten', () => {
    const learning = recordLearning({ text: PLAN_ASK, from: 'chat', to: 'pipeline' })!;
    expect(removeLearning(learning.id)).toBe(true);
    expect(removeLearning(learning.id)).toBe(false);
    expect(listLearnings()).toHaveLength(0);
  });
});

describe('applyLearning', () => {
  it('changes the route only when it disagrees with the verdict', () => {
    const learning = recordLearning({ text: 'explain how the data pipeline works', from: 'chat', to: 'pipeline' })!;
    expect(applyLearning('explain how the data pipeline works', 'chat')?.kind).toBe('pipeline');
    expect(applyLearning('explain how the data pipeline works', 'pipeline')).toBeUndefined();
    expect(applyLearning('something entirely different', 'chat')).toBeUndefined();
    expect(learning.to).toBe('pipeline');
  });
});

describe('the routing gate honours a learning', () => {
  const ASK = 'explain how the data pipeline works';

  it('routes by the rules when nothing has been learned', () => {
    expect(resolveAskKind(ASK)).toBe('chat');
  });

  it('routes by the LEARNING once a correction is recorded', () => {
    recordLearning({ text: ASK, from: 'chat', to: 'pipeline', reason: 'the user wants it built' });
    expect(resolveAskKind(ASK)).toBe('pipeline');
  });

  it('counts the hits of an applied learning', () => {
    const learning = recordLearning({ text: ASK, from: 'chat', to: 'pipeline' })!;
    resolveAskKind(ASK);
    expect(listLearnings()[0]!.hits).toBe(1);
    expect(listLearnings()[0]!.lastAppliedAt).toBeGreaterThan(0);
    expect(learning.id).toBe(listLearnings()[0]!.id);
  });

  it('leaves every OTHER ask to the rules — including a lookalike', () => {
    recordLearning({ text: ASK, from: 'chat', to: 'pipeline' });
    expect(resolveAskKind('explain how the build pipeline works')).toBe('chat');
    expect(resolveAskKind('create a plan for enabling my kid to be fluent in english')).toBe('chat');
  });

  it('EXPLAINS an override, so `nuvira nlu debug` can show why the route differs', () => {
    recordLearning({ text: ASK, from: 'chat', to: 'pipeline', reason: 'wants it built' });

    const overridden = explainAskKind(ASK);
    expect(overridden.kind).toBe('pipeline');
    expect(overridden.base).toBe('chat');
    expect(overridden.learning).toMatchObject({ from: 'chat', to: 'pipeline', reason: 'wants it built' });

    const plain = explainAskKind('explain how the build pipeline works');
    expect(plain.kind).toBe('chat');
    expect(plain.learning).toBeUndefined();
  });
});
