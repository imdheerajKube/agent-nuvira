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

import {
  bm25Search,
  contentTokens,
  fnv1a,
  fuzzySimilarity,
  identifierTokens,
  termVariants,
  trigramSimilarity,
  type LexicalDocument,
} from '../../src/learning/lexical-search.js';

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

describe('termVariants', () => {
  it('expands applied/apply forms but leaves identifiers and stopwords alone', () => {
    expect(termVariants('applied')).toEqual(expect.arrayContaining(['applied', 'apply', 'applies', 'applying']));
    expect(termVariants('changes')).toEqual(expect.arrayContaining(['changes', 'change']));
    expect(termVariants('WH-8821')).toEqual(['wh-8821']);
    expect(termVariants('current')).toEqual(['current']);
    expect(termVariants('class')).toEqual(['class']);
    expect(termVariants('world')).toEqual(['world']);
    expect(termVariants('capital')).toEqual(['capital']);
  });
});

describe('identifierTokens', () => {
  it('keeps compound identifiers whole and also emits their parts', () => {
    expect(identifierTokens('ERR_DB_POOL_EXHAUSTED v3.5.15 WH-8821 X-Request-ID')).toEqual([
      'err_db_pool_exhausted',
      'err',
      'pool',
      'exhausted',
      'v3.5.15',
      'v3',
      'wh-8821',
      '8821',
      'x-request-id',
      'request',
    ]);
  });

  it('does not turn ordinary two-digit prose into a search term', () => {
    expect(identifierTokens('within 30 days')).toEqual(['within', 'days']);
  });
});

describe('trigramSimilarity', () => {
  it('is high for a typo and low for unrelated words', () => {
    expect(trigramSimilarity('idempotancy', 'idempotency')).toBeGreaterThan(0.6);
    expect(trigramSimilarity('france', 'finance')).toBeLessThan(0.6);
    expect(trigramSimilarity('cup', 'capital')).toBe(0);
  });
});

describe('fuzzySimilarity', () => {
  it('handles both a substitution and an insertion typo without matching an unrelated word', () => {
    expect(fuzzySimilarity('latancy', 'latency')).toBeGreaterThan(0.75);
    expect(fuzzySimilarity('runbok', 'runbook')).toBeGreaterThan(0.75);
    expect(fuzzySimilarity('terminaton', 'termination')).toBeGreaterThan(0.75);
    expect(fuzzySimilarity('france', 'finance')).toBeLessThan(0.75);
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

  it('finds a dotted version only when identifier-aware tokenization is enabled', () => {
    const docs = [doc('a', 'Released in v3.5.15 with a retry fix'), doc('b', 'Retry policy notes')];
    expect(bm25Search(docs, 'What changed in v3.5.15?', 3)).toEqual([]);
    expect(bm25Search(docs, 'What changed in v3.5.15?', 3, { identifierAware: true })[0].id).toBe('a');
  });

  it('recovers applied/apply with morphology expansion', () => {
    const docs = [doc('a', 'Applies accepted changes only at safe points. Never apply during a tool call.')];
    expect(bm25Search(docs, 'When may a change be applied?', 3, {
      identifierAware: true,
    })).toEqual([]);
    expect(bm25Search(docs, 'When may a change be applied?', 3, {
      identifierAware: true,
      expandMorphology: true,
    })[0]?.id).toBe('a');
  });

  it('recovers a typo only when the fuzzy fallback is enabled', () => {
    const docs = [doc('a', 'An idempotency key prevents duplicate charges'), doc('b', 'chargeback policy')];
    expect(bm25Search(docs, 'idempotancy', 3, { identifierAware: true })).toEqual([]);
    expect(bm25Search(docs, 'idempotancy', 3, { identifierAware: true, fuzzy: true })[0].id).toBe('a');
  });

  it('still returns nothing for unrelated vocabulary with fuzzy matching enabled', () => {
    expect(bm25Search(documents, 'capital of France', 3, { identifierAware: true, fuzzy: true })).toEqual([]);
    expect(bm25Search(documents, 'sourdough bread', 3, { identifierAware: true, fuzzy: true })).toEqual([]);
  });

  it('does not fuzzy-match a World Cup question to a sentence containing "would"', () => {
    // Real-prose regression: `world` and `would` score 0.800, so an unguarded
    // fallback retrieved the passage below. A function word is not evidence.
    const prose = [doc('a', 'The team would have shipped sooner, but the review would not close.')];
    expect(bm25Search(prose, 'Who won the 2022 World Cup?', 3, { identifierAware: true, fuzzy: true })).toEqual([]);
  });

  it('does not count a generic content word as evidence by itself', () => {
    // Real-document regression: the steering text says `current` many times but
    // never says Bitcoin or price. `current` alone must not retrieve a passage.
    const prose = [doc('a', 'The current plan version is 7. The current owner is the platform team.')];
    expect(bm25Search(prose, 'What is the current price of Bitcoin?', 3, {
      identifierAware: true,
      fuzzy: true,
    })).toEqual([]);

    // A specific term alongside the generic one is still allowed to rank.
    expect(bm25Search(prose, 'What is the current version?', 3, {
      identifierAware: true,
      fuzzy: true,
    })[0]?.id).toBe('a');
  });
});
