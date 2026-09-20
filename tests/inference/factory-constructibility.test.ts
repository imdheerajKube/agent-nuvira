/**
 * `ProviderFactory.isConstructible` — the predicate routing uses to keep
 * unusable providers out of candidate pools.
 *
 * Context: `resolveProvider` used to answer ANY id it did not recognise with
 * the DEFAULT provider's adapter. Because a caller pairs that adapter with the
 * id it ASKED for, a credential check passing on an id with no working path
 * produced mislabeled models (`… 'bedrock' — using 'qwen2.5:0.5b'`, a local
 * Ollama model). The predicate lets routing drop such ids before they are ever
 * proposed.
 *
 * Note: `bedrock` IS constructible here — it is catalog metadata with
 * `openAICompat`, so the generic adapter serves it correctly once
 * `resolveProvider` resolves it under its own identity (see
 * tests/cli/router.test.ts). The predicate exists for ids that are neither
 * built-in, catalog-compatible, nor an installed plugin.
 */

import { describe, it, expect } from 'vitest';

import { ProviderFactory } from '../../src/inference/factory.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider } from '../../src/inference/provider-catalog.js';

describe('ProviderFactory.isConstructible', () => {
  it('accepts every provider with a dedicated adapter', () => {
    for (const type of ['nim', 'gemini', 'openrouter', 'groq', 'local', 'nuvira', 'anthropic']) {
      expect(ProviderFactory.isConstructible(type), type).toBe(true);
    }
  });

  it('accepts every catalog provider served by the generic OpenAI-compatible adapter', () => {
    const compat = CATALOG_PROVIDER_IDS.filter((id) => getCatalogProvider(id)?.openAICompat);
    expect(compat.length).toBeGreaterThan(0);
    for (const id of compat) {
      expect(ProviderFactory.isConstructible(id), id).toBe(true);
    }
  });

  it('agrees with createProvider — a constructible id never throws, others always do', () => {
    for (const type of ['groq', 'local', 'gemini']) {
      expect(ProviderFactory.isConstructible(type)).toBe(true);
      expect(() => ProviderFactory.createProvider(type, { apiKey: 'x' } as never)).not.toThrow();
    }
    expect(ProviderFactory.isConstructible('definitely-not-a-provider')).toBe(false);
    expect(() => ProviderFactory.createProvider('definitely-not-a-provider', {} as never)).toThrow(
      /Unknown provider type/,
    );
  });

  it('rejects nonsense ids and never throws itself', () => {
    expect(ProviderFactory.isConstructible('')).toBe(false);
    expect(ProviderFactory.isConstructible('----')).toBe(false);
  });

  it('keeps zero-config users a provider (local stays constructible)', () => {
    expect(ProviderFactory.isConstructible('local')).toBe(true);
  });
});
