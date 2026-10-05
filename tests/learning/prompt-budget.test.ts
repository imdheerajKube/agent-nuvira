/**
 * Workstream D1 — outbound prompt budget.
 *
 * Measurement is bounded and deterministic: the total/system size picks a band,
 * and past the hard ceiling the LOWEST-value optional contributor is dropped
 * first. The identity/tool contract (no dropPriority) is never trimmed.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PROMPT_BUDGET,
  formatPromptBudgetBreakdown,
  measurePromptBudget,
  resolvePromptBudget,
} from '../../src/learning/prompt-budget.js';

describe('resolvePromptBudget', () => {
  it('returns the defaults with no config', () => {
    expect(resolvePromptBudget()).toEqual(DEFAULT_PROMPT_BUDGET);
  });

  it('overrides per key and ignores invalid values', () => {
    const cm = {
      getAll: () => ({ routing: { promptBudget: { maxTotal: 1000, noteTotal: -5 } } }),
    };
    const b = resolvePromptBudget(cm as any);
    expect(b.maxTotal).toBe(1000);
    expect(b.noteTotal).toBe(DEFAULT_PROMPT_BUDGET.noteTotal);
  });
});

describe('measurePromptBudget', () => {
  it('is ok when small and names the biggest contributor', () => {
    const r = measurePromptBudget([
      { name: 'system:identity+tool-contract', chars: 5_000 },
      { name: 'history+ask', chars: 1_000 },
    ]);
    expect(r.level).toBe('ok');
    expect(r.totalChars).toBe(6_000);
    expect(r.biggest?.name).toBe('system:identity+tool-contract');
    expect(r.trims).toEqual([]);
  });

  it('notes then warns as the total grows', () => {
    const note = measurePromptBudget([{ name: 'history+ask', chars: 25_000 }]);
    expect(note.level).toBe('note');
    const warn = measurePromptBudget([{ name: 'history+ask', chars: 41_000 }]);
    expect(warn.level).toBe('warn');
  });

  it('notes when only the SYSTEM layer is over its own budget', () => {
    const r = measurePromptBudget([
      { name: 'system:identity+tool-contract', chars: 9_000 },
      { name: 'history+ask', chars: 1_000 },
    ]);
    expect(r.systemChars).toBe(9_000);
    expect(r.level).toBe('note');
  });

  it('plans trims lowest-value-first past the ceiling, never the contract', () => {
    const r = measurePromptBudget([
      { name: 'system:identity+tool-contract', chars: 9_000 },
      { name: 'skill-hint', chars: 24_000, dropPriority: 10 },
      { name: 'recall', chars: 20_000, dropPriority: 30 },
    ]);
    expect(r.level).toBe('over');
    // Lowest dropPriority drops first, and the no-priority contract is never
    // listed; once the total is under the ceiling the ladder STOPS.
    expect(r.trims).toEqual(['skill-hint']);
    expect(r.trims).not.toContain('recall');
    expect(r.trims).not.toContain('system:identity+tool-contract');
  });

  it('drops multiple contributors when one trim is not enough', () => {
    const r = measurePromptBudget([
      { name: 'skill-hint', chars: 5_000, dropPriority: 10 },
      { name: 'recall', chars: 30_000, dropPriority: 30 },
      { name: 'project-context', chars: 30_000, dropPriority: 40 },
    ]);
    expect(r.level).toBe('over');
    expect(r.trims).toEqual(['skill-hint', 'recall']);
  });

  it('stops trimming once under the ceiling', () => {
    const r = measurePromptBudget(
      [
        { name: 'system:identity+tool-contract', chars: 1_000 },
        { name: 'skill-hint', chars: 30_000, dropPriority: 10 },
        { name: 'recall', chars: 30_000, dropPriority: 30 },
      ],
      { budget: { ...DEFAULT_PROMPT_BUDGET, maxTotal: 40_000 } },
    );
    expect(r.trims).toEqual(['skill-hint']);
  });
});

describe('formatPromptBudgetBreakdown', () => {
  it('names the total, band and top contributors', () => {
    const r = measurePromptBudget([
      { name: 'skill-hint', chars: 24_000 },
      { name: 'history+ask', chars: 1_000 },
    ]);
    const line = formatPromptBudgetBreakdown(r);
    expect(line).toContain('skill-hint');
    expect(line).toContain('25000');
  });
});
