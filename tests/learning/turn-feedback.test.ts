/**
 * Tests for turn feedback (`nuvira rate`) — the one label the harness cannot
 * derive.
 *
 * These pin the properties that make the label trustworthy: it lands on the turn
 * it is about, it carries its source, and it never manufactures a label out of
 * nothing (a missing trace is a refusal, not a silent success).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beginTrace, endTrace, getTrace, recordTurnReport } from '../../src/learning/reasoning-trace.js';
import {
  parseVerdict,
  rateTurn,
  listTurnVerdicts,
  latestRateableTraceId,
} from '../../src/learning/turn-feedback.js';
import { readDeliverableCandidates, recordDeliverableCandidate } from '../../src/learning/deliverable-corpus.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nuvira-feedback-test-'));
  process.env.NUVIRA_MEMORY_DIR = tempDir;
});

afterEach(() => {
  delete process.env.NUVIRA_MEMORY_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const openTurn = (goal = 'write a guide to queues'): string => {
  const id = beginTrace({ goal, source: 'chat' });
  endTrace(id, true);
  return id;
};

describe('parseVerdict', () => {
  it('maps the friendly and the precise words, and nothing else', () => {
    expect(parseVerdict('good')).toBe('accepted');
    expect(parseVerdict('accepted')).toBe('accepted');
    expect(parseVerdict('BAD')).toBe('rejected');
    expect(parseVerdict('rejected')).toBe('rejected');
    // A parser that accepts eight spellings is one nobody can predict.
    expect(parseVerdict('maybe')).toBeNull();
    expect(parseVerdict('')).toBeNull();
  });
});

describe('rateTurn', () => {
  it('records the verdict on the turn it is about, with its source', () => {
    const id = openTurn();
    const result = rateTurn({ verdict: 'accepted', traceId: id, source: 'cli', now: 500 });
    expect(result.ok).toBe(true);
    const trace = getTrace(id);
    expect(trace?.userVerdict).toEqual({ verdict: 'accepted', at: 500, source: 'cli' });
    // …and it lands on the reviewable timeline, in order.
    expect(trace?.events?.some((e) => e.summary.includes('user verdict — accepted'))).toBe(true);
  });

  it('rates the MOST RECENT turn when no trace id is given', () => {
    openTurn('first');
    const newest = openTurn('second');
    const result = rateTurn({ verdict: 'rejected', source: 'cli', now: 1 });
    expect(result.ok && result.rated.traceId).toBe(newest);
    expect(getTrace(newest)?.userVerdict?.verdict).toBe('rejected');
  });

  it('labels the matching corpus row for the rated turn', () => {
    const id = openTurn();
    recordDeliverableCandidate(
      { ask: 'write a guide', path: 'GUIDE.md', deliveredWords: 5100, excerpt: 'x', traceId: id },
      1,
    );
    const result = rateTurn({ verdict: 'accepted', traceId: id, source: 'dashboard', now: 2 });
    expect(result.ok && result.rated.corpusLabeled).toBe(true);
    expect(readDeliverableCandidates()[0].verdict).toBe('accepted');
  });

  it('reports corpusLabeled false when the turn delivered no artifact', () => {
    const id = openTurn();
    const result = rateTurn({ verdict: 'accepted', traceId: id, source: 'cli', now: 3 });
    expect(result.ok && result.rated.corpusLabeled).toBe(false);
    expect(readDeliverableCandidates()).toEqual([]);
  });

  it('REFUSES rather than inventing a verdict when there is no turn', () => {
    expect(latestRateableTraceId()).toBeNull();
    const result = rateTurn({ verdict: 'accepted', source: 'cli' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no trace/i);
  });

  it('refuses an unknown trace', () => {
    openTurn();
    const result = rateTurn({ verdict: 'accepted', traceId: 'trace-does-not-exist', source: 'cli' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not found/i);
  });

  it('lets a turn be re-rated — the newer judgement wins', () => {
    const id = openTurn();
    rateTurn({ verdict: 'accepted', traceId: id, source: 'cli', now: 1 });
    rateTurn({ verdict: 'rejected', traceId: id, source: 'cli', now: 2 });
    expect(getTrace(id)?.userVerdict).toMatchObject({ verdict: 'rejected', at: 2 });
  });
});

describe('listTurnVerdicts', () => {
  it('lists only rated turns, most recent first', () => {
    const a = openTurn('a');
    const b = openTurn('b');
    rateTurn({ verdict: 'accepted', traceId: a, source: 'cli', now: 10 });
    rateTurn({ verdict: 'rejected', traceId: b, source: 'dashboard', now: 20 });
    const rows = listTurnVerdicts(10);
    expect(rows.map((r) => r.verdict)).toEqual(['rejected', 'accepted']);
    expect(rows[0]).toMatchObject({ traceId: b, source: 'dashboard' });
  });

  it('returns nothing when no turn was rated', () => {
    openTurn();
    expect(listTurnVerdicts()).toEqual([]);
  });
});

describe('recordTurnReport is untouched by the verdict', () => {
  it('keeps the derived report separate from the user label', () => {
    const id = openTurn();
    recordTurnReport(id, { verification: 'verified', summary: 'did the work' } as never);
    rateTurn({ verdict: 'rejected', traceId: id, source: 'cli', now: 5 });
    const trace = getTrace(id);
    // The DERIVED report says the work verified; the USER says it missed. Both are
    // kept, because a quality signal needs to know they disagreed.
    expect(trace?.turnReport?.verification).toBe('verified');
    expect(trace?.userVerdict?.verdict).toBe('rejected');
  });
});
