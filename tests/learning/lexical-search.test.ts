/**
 * Lexical retrieval (`src/learning/lexical-search.ts`).
 *
 * These pin the two properties fusion depends on: a query is ranked by the terms
 * it actually contains (so a shared word is real evidence rather than a
 * coincidence of scale), and a query sharing NO vocabulary returns NOTHING — the
 * property that keeps an unrelated question out even though fusion now admits
 * lexical hits past the cosine floor.
 */

import { describe, it, expect } from 'vitest';

import { bm25Search, contentTokens, fnv1a, type LexicalDocument } from '../../src/learning/lexical-search.js';

const doc = (id: string, text: string): LexicalDocument => ({ id, text });

describe('contentTokens', () => {
  it('lowercases, splits on punctuation and numbers, and drops stopwords and short tokens', () => {
    // 'when' and 'are' are stopwords; '30' is too short and 'of' is a stopword.
    expect(contentTokens('When are INVOICES payable? Within 30 days of receipt!')).toEqual([
      'invoices',
      'payable',
      'within',
      'days',
      'receipt',
    ]);
    expect(contentTokens('a an the it')).toEqual([]);
    expect(contentTokens('')).toEqual([]);
  });
});

describe('fnv1a', () => {
  it('is deterministic and distinguishes inputs', () => {
    expect(fnv1a('invoices')).toBe(fnv1a('invoices'));
    expect(fnv1a('invoices')).not.toBe(fnv1a('invoice'));
  });
});

describe('bm25Search', () => {
  const documents = [
    doc('a', 'invoices are payable within thirty days of receipt'),
    doc('b', 'worker nodes and an ingress controller route traffic'),
    doc('c', 'late payments accrue interest calculated from the due date'),
  ];

  it('ranks the document that shares the most query terms first', () => {
    const hits = bm25Search(documents, 'when are invoices payable', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('a');
  });

  it('returns NOTHING when the query shares no content term with any document', () => {
    // The leak-proof half: unknown vocabulary is not evidence, so an unrelated
    // question cannot be handed a passage.
    expect(bm25Search(documents, 'what is the capital of France', 3)).toEqual([]);
    expect(bm25Search(documents, 'a an the of', 3)).toEqual([]);
    expect(bm25Search(documents, '', 3)).toEqual([]);
  });

  it('is limited by k and ordered deterministically on ties', () => {
    // Two documents that score identically: the tiebreak is the id, not insertion
    // order, so the fusion it feeds is reproducible run to run.
    const tied = [doc('z', 'alpha marker'), doc('a', 'alpha marker')];
    const hits = bm25Search(tied, 'alpha', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('a');
  });

  it('handles an empty corpus and a non-positive k without throwing', () => {
    expect(bm25Search([], 'alpha', 5)).toEqual([]);
    expect(bm25Search(documents, 'invoices', 0)).toEqual([]);
  });

  it('weights a rare term above one every document carries', () => {
    // 'alpha' appears everywhere and says nothing (idf ≈ 0); 'unique' appears once
    // and is worth a lot — which is what stops a common word from dominating.
    const common = [doc('a', 'alpha alpha alpha'), doc('b', 'alpha beta'), doc('c', 'alpha gamma')];
    const withRare = [...common, doc('d', 'uniqueterm alpha')];
    const ranked = bm25Search(withRare, 'alpha uniqueterm', 4);
    expect(ranked[0].id).toBe('d');
  });
});
