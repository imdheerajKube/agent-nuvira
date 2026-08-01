/**
 * Router — resolveProvider auto-fallback tests.
 *
 * Regression: when the provider value is 'auto' (e.g. stale active-model
 * state reaching resolveProvider), the old code fell back to the DEFAULT
 * provider — which could be unconfigured (e.g. OpenRouter with no API key),
 * producing a confusing 401 on first use. Now 'auto' falls back to the first
 * provider that HAS credentials, so Auto never silently lands on a provider
 * that will fail.
 */

import { describe, it, expect, vi } from 'vitest';

import { resolveProvider } from '../../src/cli/router.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** A minimal ConfigManager-shaped object for resolveProvider tests. */
function makeConfigManager(overrides: {
  defaultProvider?: string;
  providers?: Record<string, { model?: string }>;
  creds?: string[];
} = {}) {
  const creds = new Set(overrides.creds || []);
  return {
    getAll: vi.fn(() => ({
      defaultProvider: overrides.defaultProvider || 'openrouter',
      providers: overrides.providers || {},
    })),
    getProviderConfig: vi.fn((provider: string) => ({
      type: provider,
      config: overrides.providers?.[provider] || { model: 'default' },
    })),
    hasRequiredCredentials: vi.fn((provider: string) => creds.has(provider)),
  } as any;
}

// ─── resolveProvider('auto') ────────────────────────────────────────────────

describe('resolveProvider with provider "auto"', () => {
  it('falls back to the first provider with credentials instead of an unconfigured default', () => {
    const cm = makeConfigManager({
      defaultProvider: 'openrouter', // unconfigured default — the old bug
      creds: ['groq', 'local'],
    });

    const { type } = resolveProvider(cm, 'auto');

    // Must NOT resolve to the unconfigured openrouter default
    expect(type).not.toBe('openrouter');
    // Prefers a configured provider (groq checked before local)
    expect(type).toBe('groq');
  });

  it('falls back to the configured default when NO provider has credentials', () => {
    const cm = makeConfigManager({ defaultProvider: 'local' });

    const { type } = resolveProvider(cm, 'auto');

    expect(type).toBe('local');
  });

  it('returns a working provider instance (never a literal "auto")', () => {
    const cm = makeConfigManager({ creds: ['gemini'] });

    const { type, provider } = resolveProvider(cm, 'auto');

    expect(type).toBe('gemini');
    expect(provider.name).toBeTruthy();
  });

  it('does not affect concrete provider resolution', () => {
    const cm = makeConfigManager({});

    const { type } = resolveProvider(cm, 'groq');

    expect(type).toBe('groq');
  });
});
