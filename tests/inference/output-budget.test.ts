import { afterEach, describe, expect, it } from 'vitest';

import {
  clearOutputBudgetMemory,
  noteOutputBudgetExhausted,
  OUTPUT_BUDGET_TTL_MS,
  rememberedOutputBudget,
} from '../../src/inference/output-budget.js';

afterEach(() => {
  clearOutputBudgetMemory();
});

describe('learned output budget', () => {
  it('remembers nothing for an unseen pair', () => {
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-pro')).toBeUndefined();
  });

  it('raises the floor after a cap-truncated step, per pair only', () => {
    expect(noteOutputBudgetExhausted('deepseek', 'deepseek-v4-pro', 4096)).toBe(8192);
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-pro')).toBe(8192);
    // A sibling model learns nothing from another pair's truncation.
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-flash')).toBeUndefined();
    // Another provider serving the same id is a different account/pair.
    expect(rememberedOutputBudget('openrouter', 'deepseek-v4-pro')).toBeUndefined();
  });

  it('only ever escalates, never shrinks a learned floor', () => {
    noteOutputBudgetExhausted('deepseek', 'deepseek-v4-pro', 8192);
    expect(noteOutputBudgetExhausted('deepseek', 'deepseek-v4-pro', 1000)).toBe(16_384);
  });

  it('caps the learned floor', () => {
    expect(noteOutputBudgetExhausted('deepseek', 'deepseek-v4-pro', 40_000)).toBe(32_768);
  });

  it('expires so one long step cannot permanently inflate a cheap model', () => {
    noteOutputBudgetExhausted('deepseek', 'deepseek-v4-flash', 4096);
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-flash')).toBe(8192);
    // Read through the same TTL the implementation applies.
    const before = Date.now();
    expect(OUTPUT_BUDGET_TTL_MS).toBeGreaterThan(0);
    expect(rememberedOutputBudget('deepseek', 'deepseek-v4-flash')).toBe(8192);
    expect(Date.now() - before).toBeLessThan(OUTPUT_BUDGET_TTL_MS);
  });
});
