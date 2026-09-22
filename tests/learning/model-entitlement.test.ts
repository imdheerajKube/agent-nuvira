/**
 * Cost/entitlement labels must be honest, and must never hide a model.
 *
 * The Models-page audit removed one lie ("509 available" was a listing count).
 * The mirror-image lie is filtering the page to free models only: a user who
 * just bought credits would see nothing appear and conclude the purchase failed.
 *
 * The load-bearing case in this file is NEGATIVE: the catalog carries `0/0`
 * pricing for Gemini, and the codebase's own auto-router notes that *"Gemini
 * paid models 403 without billing"* — so a zero price must NOT be labelled free.
 * Treating it as free would recreate the over-claim in a new place.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyModelEntitlement,
  ENTITLEMENT_CHIP,
} from '../../src/inference/model-entitlement.js';

describe('classifyModelEntitlement — what a call would cost', () => {
  it('trusts a provider-declared free id above everything else', () => {
    const e = classifyModelEntitlement('openrouter', 'meta-llama/llama-3.3-70b-instruct:free');
    expect(e.tier).toBe('free');
    expect(e.basis).toMatch(/declares this id free/i);
  });

  it('treats a local runtime as free — inference happens on this machine', () => {
    for (const provider of ['local', 'lmstudio', 'vllm']) {
      const e = classifyModelEntitlement(provider, 'llama3');
      expect(e.tier).toBe('free');
      expect(e.basis).toMatch(/runs on this machine/i);
    }
  });

  it('does NOT call the nuvira gateway free — it forwards to providers that bill', () => {
    const e = classifyModelEntitlement('nuvira', 'default');
    expect(e.tier).not.toBe('free');
  });

  it('labels a non-zero list price as metered, and names the rate', () => {
    const e = classifyModelEntitlement('groq', 'llama-3.3-70b-versatile');
    expect(e.tier).toBe('metered');
    expect(e.basis).toMatch(/per 1K in\/out/i);
    // The label must not claim the KEY cannot use it — that is the registry's job.
    expect(e.basis).toMatch(/your key/i);
  });

  it('does NOT read a zero catalog price as free (the Gemini case)', () => {
    // Catalog price is 0/0 for gemini, yet paid models 403 without billing.
    const e = classifyModelEntitlement('gemini', 'gemini-2.0-flash');
    expect(e.tier).toBe('unknown');
    expect(e.basis).toMatch(/no per-token price|cost/i);
  });

  it('says "unknown" for a provider the catalog does not describe', () => {
    const e = classifyModelEntitlement('some-new-runtime', 'whatever');
    expect(e.tier).toBe('unknown');
    expect(e.basis).toMatch(/not described by the catalog/i);
  });

  it('always answers — an unlabelled cell is what made the old page ambiguous', () => {
    const cases: Array<[string, string | undefined]> = [
      ['local', undefined],
      ['local', ''],
      ['openrouter', 'x:free'],
      ['openai', 'gpt-4o-mini'],
      ['nonsense', undefined],
    ];
    for (const [provider, model] of cases) {
      const e = classifyModelEntitlement(provider, model);
      expect(['free', 'metered', 'unknown']).toContain(e.tier);
      expect(e.basis.length).toBeGreaterThan(0);
    }
  });

  it('has a chip for every tier — the UI must not have to invent one', () => {
    expect(Object.keys(ENTITLEMENT_CHIP).sort()).toEqual(['free', 'metered', 'unknown']);
  });
});
