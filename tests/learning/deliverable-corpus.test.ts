/**
 * Tests for the deliverable corpus (item 13's collection path).
 *
 * The corpus is deliberately INERT — nothing reads it and no score is derived
 * from it — so these tests pin the three properties that make it worth keeping:
 * a delivery is recorded as FACTS with a null label, a user verdict labels it
 * (by TRACE when known, newest-first otherwise), and silence is never recorded
 * as acceptance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordDeliverableCandidate,
  markLastDeliverableRejected,
  labelDeliverableByTrace,
  readDeliverableCandidates,
  clearDeliverableCandidates,
  deliverableCorpusPath,
  MAX_DELIVERABLE_CANDIDATES,
  DELIVERABLE_EXCERPT_MAX,
} from '../../src/learning/deliverable-corpus.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nuvira-corpus-test-'));
  process.env.NUVIRA_MEMORY_DIR = tempDir;
});

afterEach(() => {
  delete process.env.NUVIRA_MEMORY_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

const delivery = (over: Partial<Parameters<typeof recordDeliverableCandidate>[0]> = {}) => ({
  ask: 'write a ~5000 word guide about queues',
  path: 'GUIDE.md',
  deliveredWords: 5100,
  targetWords: 5000,
  verification: 'delivered-and-read-back',
  excerpt: '# Queues\n\nA queue is a buffer...',
  traceId: 'trace-1',
  ...over,
});

describe('deliverable-corpus', () => {
  it('reads empty when nothing was ever collected', () => {
    expect(readDeliverableCandidates()).toEqual([]);
  });

  it('records a delivery as FACTS with a null label — never a verdict', () => {
    const row = recordDeliverableCandidate(delivery(), 1000);
    expect(row).not.toBeNull();
    expect(row!.verdict).toBeNull();
    expect(row!.verdictAt).toBeUndefined();
    const rows = readDeliverableCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: 1000,
      path: 'GUIDE.md',
      deliveredWords: 5100,
      targetWords: 5000,
      verification: 'delivered-and-read-back',
      traceId: 'trace-1',
      verdict: null,
    });
  });

  it('omits targetWords when the ask stated no magnitude', () => {
    const row = recordDeliverableCandidate(delivery({ targetWords: undefined }), 1);
    expect(row && 'targetWords' in row).toBe(false);
  });

  it('labels the NEWEST-UNLABELLED row on a derived correction, once', () => {
    recordDeliverableCandidate(delivery({ path: 'a.md', traceId: 'ta' }), 1);
    recordDeliverableCandidate(delivery({ path: 'b.md', traceId: 'tb' }), 2);
    expect(markLastDeliverableRejected(50)).toBe(true);
    const rows = readDeliverableCandidates();
    // b is the most recent delivery, so a correction speaks about IT.
    expect(rows[0].verdict).toBeNull();
    expect(rows[1]).toMatchObject({ path: 'b.md', verdict: 'rejected', verdictAt: 50 });
    // The SAME correction is not applied twice.
    expect(markLastDeliverableRejected(60)).toBe(true);
    const after = readDeliverableCandidates();
    expect(after[1].verdictAt).toBe(50);
    expect(after[0]).toMatchObject({ path: 'a.md', verdict: 'rejected', verdictAt: 60 });
  });

  it('labels the row for the EXACT trace, not merely the newest', () => {
    recordDeliverableCandidate(delivery({ path: 'a.md', traceId: 'ta' }), 1);
    recordDeliverableCandidate(delivery({ path: 'b.md', traceId: 'tb' }), 2);
    // An EXPLICIT verdict about the OLDER turn must land on the older delivery.
    expect(labelDeliverableByTrace('ta', 'accepted', 70)).toBe(true);
    const rows = readDeliverableCandidates();
    expect(rows[0]).toMatchObject({ path: 'a.md', verdict: 'accepted', verdictAt: 70 });
    expect(rows[1].verdict).toBeNull();
  });

  it('falls back to the newest unlabelled row for a REJECTION with no matching trace', () => {
    recordDeliverableCandidate(delivery({ path: 'a.md', traceId: undefined }), 1);
    // The delivery predates the trace link — a rejection still lands on it.
    expect(labelDeliverableByTrace('trace-unknown', 'rejected', 80)).toBe(true);
    expect(readDeliverableCandidates()[0].verdict).toBe('rejected');
  });

  it('refuses to INVENT an acceptance for a delivery it cannot identify', () => {
    recordDeliverableCandidate(delivery({ path: 'a.md', traceId: 'ta' }), 1);
    // An acceptance about a trace we have no delivery for must not label someone else's row.
    expect(labelDeliverableByTrace('trace-unknown', 'accepted', 90)).toBe(false);
    expect(readDeliverableCandidates()[0].verdict).toBeNull();
  });

  it('replaces a verdict when a turn is re-rated', () => {
    recordDeliverableCandidate(delivery(), 1);
    labelDeliverableByTrace('trace-1', 'rejected', 10);
    labelDeliverableByTrace('trace-1', 'accepted', 11);
    expect(readDeliverableCandidates()[0]).toMatchObject({ verdict: 'accepted', verdictAt: 11 });
  });

  it('walks newest-first across successive derived corrections', () => {
    recordDeliverableCandidate(delivery({ path: 'a.md' }), 1);
    recordDeliverableCandidate(delivery({ path: 'b.md' }), 2);
    markLastDeliverableRejected(50);
    markLastDeliverableRejected(51);
    // Every row now carries a verdict — nothing left to label.
    expect(markLastDeliverableRejected(52)).toBe(false);
    expect(readDeliverableCandidates().every((r) => r.verdict === 'rejected')).toBe(true);
  });

  it('returns false when there is nothing to label', () => {
    expect(markLastDeliverableRejected()).toBe(false);
    recordDeliverableCandidate(delivery(), 1);
    markLastDeliverableRejected(2);
    expect(markLastDeliverableRejected(3)).toBe(false);
  });

  it('bounds the excerpt and the ask it keeps', () => {
    const row = recordDeliverableCandidate(
      delivery({ excerpt: 'x'.repeat(DELIVERABLE_EXCERPT_MAX + 500), ask: 'y'.repeat(900) }),
      1,
    );
    expect(row!.excerpt).toHaveLength(DELIVERABLE_EXCERPT_MAX);
    expect(row!.ask.length).toBeLessThanOrEqual(500);
  });

  it('refuses a row with no path or no excerpt', () => {
    expect(recordDeliverableCandidate(delivery({ path: '' }), 1)).toBeNull();
    expect(recordDeliverableCandidate(delivery({ excerpt: '' }), 1)).toBeNull();
    expect(readDeliverableCandidates()).toEqual([]);
  });

  it('caps the store, dropping the OLDEST rows', () => {
    for (let i = 0; i < MAX_DELIVERABLE_CANDIDATES + 5; i++) {
      recordDeliverableCandidate(delivery({ path: `f${i}.md` }), i + 1);
    }
    const rows = readDeliverableCandidates();
    expect(rows).toHaveLength(MAX_DELIVERABLE_CANDIDATES);
    expect(rows[0].path).toBe('f5.md');
    expect(rows[rows.length - 1].path).toBe(`f${MAX_DELIVERABLE_CANDIDATES + 4}.md`);
  });

  it('skips a corrupt line instead of failing the whole store', () => {
    recordDeliverableCandidate(delivery({ path: 'ok.md' }), 1);
    const raw = readFileSync(deliverableCorpusPath(), 'utf-8');
    writeFileSync(deliverableCorpusPath(), `${raw}not json\n`, 'utf-8');
    const rows = readDeliverableCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('ok.md');
  });

  it('MIGRATES the legacy `rejected` boolean on read, so one shape is reasoned about', () => {
    writeFileSync(
      deliverableCorpusPath(),
      JSON.stringify({ ts: 1, ask: 'a', path: 'a.md', deliveredWords: 1, excerpt: 'x', rejected: true }) + '\n',
      'utf-8',
    );
    expect(readDeliverableCandidates()[0].verdict).toBe('rejected');
  });

  it('clears the store', () => {
    recordDeliverableCandidate(delivery(), 1);
    clearDeliverableCandidates();
    expect(readDeliverableCandidates()).toEqual([]);
  });
});
