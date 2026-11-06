import { describe, expect, it } from 'vitest';

import {
  diagnoseEmptyCompletion,
  escalatedOutputBudget,
  MAX_ESCALATED_OUTPUT_TOKENS,
  MIN_ESCALATED_OUTPUT_TOKENS,
} from '../../src/learning/empty-completion.js';

describe('diagnoseEmptyCompletion', () => {
  it('names a reasoning model cut at its cap as a spent budget, not an outage', () => {
    const verdict = diagnoseEmptyCompletion({
      finishReason: 'length',
      reasoningChars: 48_000,
      contentChars: 0,
      completionTokens: 4096,
      maxTokens: 4096,
    });
    expect(verdict.cause).toBe('reasoning-budget');
    expect(verdict.budgetExhausted).toBe(true);
    expect(verdict.recommendation).toBe('retry-same-pair-larger-budget');
    expect(verdict.evidence).toContain('4096/4096');
  });

  it('names a cap-truncated answer with no captured reasoning as an output budget', () => {
    const verdict = diagnoseEmptyCompletion({ finishReason: 'length', completionTokens: 2048, maxTokens: 2048 });
    expect(verdict.cause).toBe('output-budget');
    expect(verdict.recommendation).toBe('retry-same-pair-larger-budget');
  });

  it('treats a completion at the cap as exhaustion even without finish_reason', () => {
    const verdict = diagnoseEmptyCompletion({ completionTokens: 8192, maxTokens: 8192, reasoningChars: 10 });
    expect(verdict.budgetExhausted).toBe(true);
    expect(verdict.recommendation).toBe('retry-same-pair-larger-budget');
  });

  it('probes reasoning with no answer when the cap is unreported — a shape is not a proof', () => {
    const verdict = diagnoseEmptyCompletion({ reasoningChars: 12_000, contentChars: 0 });
    expect(verdict.cause).toBe('no-answer');
    expect(verdict.budgetExhausted).toBe(false);
    expect(verdict.recommendation).toBe('probe-then-retry');
  });

  it('probes a clean stop that carried nothing instead of rotating on a guess', () => {
    const verdict = diagnoseEmptyCompletion({ finishReason: 'stop', completionTokens: 12, maxTokens: 4096 });
    expect(verdict.cause).toBe('no-answer');
    expect(verdict.recommendation).toBe('probe-then-retry');
  });

  it('probes a response with no diagnostics at all', () => {
    const verdict = diagnoseEmptyCompletion({});
    expect(verdict.cause).toBe('no-evidence');
    expect(verdict.recommendation).toBe('probe-then-retry');
    expect(verdict.budgetExhausted).toBe(false);
  });

  it('never claims exhaustion from a low completion count below the cap', () => {
    const verdict = diagnoseEmptyCompletion({ completionTokens: 100, maxTokens: 4096 });
    expect(verdict.budgetExhausted).toBe(false);
    expect(verdict.recommendation).toBe('probe-then-retry');
  });
});

describe('escalatedOutputBudget', () => {
  it('doubles what the pair actually consumed', () => {
    expect(escalatedOutputBudget(4096)).toBe(8192);
    expect(escalatedOutputBudget(9000, 4096)).toBe(18_000);
  });

  it('floors a tiny or unknown budget at the minimum', () => {
    expect(escalatedOutputBudget(undefined, 512)).toBe(MIN_ESCALATED_OUTPUT_TOKENS);
    expect(escalatedOutputBudget(200)).toBe(MIN_ESCALATED_OUTPUT_TOKENS);
  });

  it('never exceeds the ceiling', () => {
    expect(escalatedOutputBudget(64_000)).toBe(MAX_ESCALATED_OUTPUT_TOKENS);
  });
});
