/**
 * Provider Catalog (Issue 001) — the single source of truth for every
 * provider Agent-Nuvira knows how to reach. The catalog is ADAPTER METADATA,
 * never a selection: routing/probing only consider catalog providers the user
 * has credentials for (or keyless ones). These tests pin the catalog's shape.
 */

import { describe, it, expect } from 'vitest';
import {
  PROVIDER_CATALOG,
  CATALOG_PROVIDER_IDS,
  CATALOG_KEYLESS_IDS,
  CATALOG_OPENAI_COMPAT_IDS,
  CATALOG_NATIVE_IDS,
  CATALOG_ENV_VARS,
  getCatalogProvider,
  catalogEnvVar,
  isCatalogKeyless,
  catalogCapabilities,
  catalogPricing,
  catalogContextWindow,
} from '../../src/inference/provider-catalog.js';

describe('provider catalog (Issue 001 — all 17+ providers)', () => {
  it('contains the full extended set — well beyond the old 6 built-ins', () => {
    expect(CATALOG_PROVIDER_IDS.length).toBeGreaterThanOrEqual(20);
    // The original built-ins are still present…
    for (const id of ['local', 'groq', 'gemini', 'nim', 'openrouter', 'nuvira']) {
      expect(CATALOG_PROVIDER_IDS).toContain(id);
    }
    // …and the extended providers that users onboard via env vars are too.
    for (const id of [
      'openai', 'anthropic', 'mistral', 'cohere', 'together', 'deepinfra',
      'fireworks', 'perplexity', 'azure', 'lmstudio', 'anyscale', 'vllm',
      'deepseek', 'xai', 'replicate',
    ]) {
      expect(CATALOG_PROVIDER_IDS).toContain(id);
    }
  });

  it('maps every keyed provider to its REAL env var (not just *_API_KEY)', () => {
    expect(catalogEnvVar('openai')).toBe('OPENAI_API_KEY');
    expect(catalogEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(catalogEnvVar('deepinfra')).toBe('DEEPINFRA_TOKEN');
    expect(catalogEnvVar('replicate')).toBe('REPLICATE_API_TOKEN');
    expect(CATALOG_ENV_VARS['mistral']).toBe('MISTRAL_API_KEY');
    // Keyless providers have no env var.
    expect(catalogEnvVar('lmstudio')).toBeUndefined();
    expect(catalogEnvVar('vllm')).toBeUndefined();
  });

  it('marks the zero-config keyless providers', () => {
    for (const id of ['local', 'nuvira', 'lmstudio', 'vllm']) {
      expect(isCatalogKeyless(id)).toBe(true);
      expect(CATALOG_KEYLESS_IDS).toContain(id);
    }
    expect(isCatalogKeyless('groq')).toBe(false);
    expect(isCatalogKeyless('openai')).toBe(false);
  });

  it('flags OpenAI-compatible providers for the generic adapter', () => {
    for (const id of ['openai', 'mistral', 'cohere', 'together', 'deepinfra', 'fireworks', 'perplexity', 'azure', 'lmstudio', 'anyscale', 'vllm', 'deepseek', 'xai', 'replicate']) {
      expect(getCatalogProvider(id)?.openAICompat).toBe(true);
      expect(CATALOG_OPENAI_COMPAT_IDS).toContain(id);
    }
  });

  it('flags anthropic as the native (non-OpenAI-compatible) adapter', () => {
    expect(getCatalogProvider('anthropic')?.nativeAdapter).toBe('anthropic');
    expect(CATALOG_NATIVE_IDS).toEqual(['anthropic']);
  });

  it('carries capability metadata (0–1 per dimension) for every provider', () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      const caps = catalogCapabilities(id);
      expect(caps).toBeDefined();
      for (const dim of ['reasoning', 'speed', 'cost', 'privacy', 'reliability']) {
        expect(caps![dim as keyof typeof caps]).toBeGreaterThanOrEqual(0);
        expect(caps![dim as keyof typeof caps]).toBeLessThanOrEqual(1);
      }
    }
    // Local is the most private; openai is a strong cloud reasoning provider.
    expect(catalogCapabilities('local')!.privacy).toBe(1);
    expect(catalogCapabilities('openai')!.reasoning).toBeGreaterThanOrEqual(0.9);
  });

  it('carries list pricing + a nominal context window for every provider', () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      const pricing = catalogPricing(id);
      expect(pricing).toBeDefined();
      expect(pricing!.inputPer1K).toBeGreaterThanOrEqual(0);
      expect(catalogContextWindow(id)).toBeGreaterThan(0);
    }
    // Free providers price at $0; paid providers price above zero.
    expect(catalogPricing('local')!.inputPer1K).toBe(0);
    expect(catalogPricing('openai')!.inputPer1K).toBeGreaterThan(0);
  });

  it('azure carries its api-key header + required api-version query', () => {
    const azure = getCatalogProvider('azure');
    expect(azure?.apiKeyHeader).toBe('api-key');
    expect(azure?.apiVersionQuery).toContain('api-version=');
  });
});
