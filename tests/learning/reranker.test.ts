import { afterEach, describe, expect, it } from 'vitest';

import {
  attachmentRerankEnabled,
  orderByScores,
  passesRerankThreshold,
  resetRerankerCache,
  rerankPassages,
} from '../../src/learning/reranker.js';

afterEach(() => {
  delete process.env.NUVIRA_ATTACHMENT_RERANK;
  resetRerankerCache();
});

describe('local reranker', () => {
  it('orders by score descending and breaks ties by original index', () => {
    expect(orderByScores([-2, 6, 1, 6])).toEqual([
      { index: 1, score: 6 },
      { index: 3, score: 6 },
      { index: 2, score: 1 },
      { index: 0, score: -2 },
    ]);
  });

  it('is on by default and can be explicitly disabled', () => {
    expect(attachmentRerankEnabled()).toBe(true);
    process.env.NUVIRA_ATTACHMENT_RERANK = '0';
    expect(attachmentRerankEnabled()).toBe(false);
  });

  it('returns null when disabled so callers keep lexical order', async () => {
    process.env.NUVIRA_ATTACHMENT_RERANK = 'off';
    await expect(rerankPassages('question', ['passage'])).resolves.toBeNull();
  });

  it('applies an optional score floor without abstaining when reranking is unavailable', () => {
    const ranked = orderByScores([6, -11]);
    expect(passesRerankThreshold(ranked, undefined)).toBe(true);
    expect(passesRerankThreshold(ranked, 0)).toBe(true);
    expect(passesRerankThreshold(ranked, 7)).toBe(false);
    expect(passesRerankThreshold(null, 7)).toBe(true);
  });
});
