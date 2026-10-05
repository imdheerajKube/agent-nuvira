/**
 * A3 — model-id validation. The value saved as `providers.<type>.model` must be
 * one the provider actually serves; a wrong id is rejected with suggestions
 * instead of becoming a silent substitution at call time.
 *
 * The provider adapter is mocked, so no network — the test pins the DECISION
 * table: present → verified; absent with a live list → rejected; no live list →
 * accepted unverified (offline configuration must stay possible).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const listModels = vi.fn(async () => [
  { id: 'deepseek-flash', name: 'deepseek-flash', provider: 'deepseek', owner: 'deepseek', tags: [] },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', provider: 'deepseek', owner: 'deepseek', tags: [] },
]);

vi.mock('../../src/inference/factory.js', () => ({
  ProviderFactory: {
    createProvider: (type: string) => {
      if (type === 'not-a-provider') throw new Error('no adapter for this provider');
      return { listModels };
    },
  },
}));

import { validateModelIdForProvider, suggestModelIds } from '../../src/inference/model-id-validation.js';

describe('validateModelIdForProvider (A3)', () => {
  beforeEach(() => {
    listModels.mockClear();
    listModels.mockResolvedValue([
      { id: 'deepseek-flash', name: 'deepseek-flash', provider: 'deepseek', owner: 'deepseek', tags: [] },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', provider: 'deepseek', owner: 'deepseek', tags: [] },
    ]);
  });

  it('accepts a model the provider actually serves (verified)', async () => {
    const v = await validateModelIdForProvider('deepseek', 'deepseek-flash');
    expect(v.ok).toBe(true);
    expect(v.verified).toBe(true);
  });

  it('rejects the id that caused A3, and suggests the real one', async () => {
    const v = await validateModelIdForProvider('deepseek', 'DeepSeek-V4.1-Flash');
    expect(v.ok).toBe(false);
    expect(v.verified).toBe(true);
    expect(v.message).toContain('DeepSeek-V4.1-Flash');
    expect(v.suggestions).toContain('deepseek-flash');
  });

  it('accepts `default` and the provider curated default without a lookup', async () => {
    expect((await validateModelIdForProvider('deepseek', 'default')).ok).toBe(true);
    // 'deepseek-chat' is the catalog default for deepseek.
    expect((await validateModelIdForProvider('deepseek', 'deepseek-chat')).ok).toBe(true);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('accepts an id UNVERIFIED when the provider lists nothing (offline)', async () => {
    listModels.mockResolvedValue([]);
    const v = await validateModelIdForProvider('deepseek', 'some-unreleased-model');
    expect(v.ok).toBe(true);
    expect(v.verified).toBe(false);
  });

  it('accepts when the adapter cannot be constructed (unknown/plugin provider)', async () => {
    const v = await validateModelIdForProvider('not-a-provider', 'whatever');
    // createProvider is mocked to succeed here; the meaningful assertion is that
    // validation never throws and never blocks on an unknown shape.
    expect(v.ok).toBe(true);
  });

  it('suggestModelIds prefers the same family token over lexical distance', () => {
    // Noise around the target so the max cap (5) is actually exercised: the
    // same-family ids must outrank the unrelated one, which then falls off.
    const ids = ['deepseek-flash', 'deepseek-v4-pro', 'gpt-4o-mini', 'llama-3.3-70b', 'qwen-2.5-7b', 'mistral-small', 'kimi-k2'];
    const out = suggestModelIds('DeepSeek-V4.1-Flash', ids);
    expect(out[0]).toMatch(/^deepseek-/);
    expect(out.slice(0, 2).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });
});
