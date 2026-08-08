/**
 * Model selection — dynamic provider/model resolution with NO hardcoded
 * defaults. Every decision is derived at runtime from the user's keys
 * (ConfigManager.hasRequiredCredentials) + the Model Availability Registry
 * (verified models, learned health, predictive blocks).
 *
 * Covers:
 *   - rankAvailableProviders: zero-config → local only; verified providers
 *     first (health-ranked); registry-blocked providers excluded.
 *   - resolveDefaultProvider: always the best available right now.
 *   - preferredModelsFor: verified models ranked by learned health.
 *   - bestAvailable: capability-profile picks + registry-only (no config).
 *   - requireAdapterModel: pinned config wins; verified fallback; clear
 *     onboarding error when nothing is known.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import {
  rankAvailableProviders,
  resolveDefaultProvider,
  preferredModelsFor,
  bestAvailable,
  requireAdapterModel,
  BUILTIN_PROVIDERS,
} from '../../src/learning/model-selection.js';
import { ConfigManager } from '../../src/config/manager.js';

/** Minimal ConfigManager-shaped object with a controllable credential set. */
function makeConfig(creds: string[]): any {
  return {
    hasRequiredCredentials: vi.fn((p: string) => creds.includes(p)),
  };
}

describe('model selection — dynamic defaults (nothing hardcoded)', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-model-selection-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = tempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('rankAvailableProviders', () => {
    it('never assumes a cloud provider — a user with NO keys gets local (the universal zero-config fallback) only', () => {
      // Issue 001: no cloud provider is ever assumed. `local` is the universal
      // zero-config fallback; the OTHER keyless runners (nuvira, lmstudio,
      // vllm) only join once the registry VERIFIES them or the user configures
      // them explicitly — a not-running localhost endpoint must never
      // out-rank running local on a cold start.
      const ranked = rankAvailableProviders(makeConfig([]));
      expect(ranked).toHaveLength(1);
      expect(ranked[0].provider).toBe('local');
      expect(ranked[0].verifiedModels).toEqual([]);
      // Once verified, the other keyless runners join the pool.
      const registry = getModelRegistry();
      registry.markVerified('lmstudio', 'local-model', 'telemetry');
      const afterVerify = rankAvailableProviders(makeConfig([])).map((r) => r.provider);
      expect(afterVerify).toContain('lmstudio');
      expect(afterVerify).toContain('local');
    });

    it('puts providers with VERIFIED models first, in learned-health order', () => {
      const registry = getModelRegistry();
      // gemini's verified model has higher latency than groq's → groq ranks first
      registry.markVerified('gemini', 'g-big', 'telemetry', 900);
      registry.markVerified('groq', 'g-fast', 'telemetry', 120);

      const ranked = rankAvailableProviders(makeConfig(['gemini', 'groq', 'nim']));
      expect(ranked[0].provider).toBe('groq'); // lowest latency
      expect(ranked[0].verifiedModels).toEqual(['g-fast']);
      expect(ranked[1].provider).toBe('gemini');
      // unverified-but-configured providers come after verified ones
      expect(ranked.map((r) => r.provider)).toContain('nim');
      expect(ranked[2].provider).toBe('nim');
    });

    it('includes extended catalog providers the user has keys for (Issue 001)', () => {
      // A user who sets OPENAI_API_KEY / ANTHROPIC_API_KEY gets those
      // providers ranked — the candidate pool is the full catalog, not the
      // old 6 built-ins.
      const ranked = rankAvailableProviders(makeConfig(['groq', 'openai', 'anthropic', 'deepseek']));
      const providers = ranked.map((r) => r.provider);
      expect(providers).toContain('openai');
      expect(providers).toContain('anthropic');
      expect(providers).toContain('deepseek');
      // Without keys they stay out.
      const noKey = rankAvailableProviders(makeConfig(['groq'])).map((r) => r.provider);
      expect(noKey).not.toContain('openai');
      expect(noKey).not.toContain('anthropic');
    });

    it('excludes providers the registry has definitively blocked', () => {
      const registry = getModelRegistry();
      registry.markUnavailable('gemini', 'g-big', 'model not found', 'telemetry');
      registry.markUnavailable('gemini', 'g-other', 'auth', 'telemetry');
      expect(registry.getBlockedProviders()).toContain('gemini');

      const ranked = rankAvailableProviders(makeConfig(['gemini', 'groq']));
      expect(ranked.map((r) => r.provider)).not.toContain('gemini');
      expect(ranked.map((r) => r.provider)).toContain('groq');
    });
  });

  describe('resolveDefaultProvider', () => {
    it('resolves to a VERIFIED provider when one exists', () => {
      getModelRegistry().markVerified('groq', 'g-fast', 'telemetry');
      expect(resolveDefaultProvider(makeConfig(['gemini', 'groq']))).toBe('groq');
    });

    it('resolves to a CONFIGURED provider when nothing is verified yet (catalog order, no preference)', () => {
      expect(resolveDefaultProvider(makeConfig(['gemini', 'groq']))).toBe('groq');
    });

    it('falls back to zero-config local when the user has no keys at all', () => {
      expect(resolveDefaultProvider(makeConfig([]))).toBe('local');
    });
  });

  describe('preferredModelsFor', () => {
    it('ranks verified models by learned health (error rate, then latency)', () => {
      const registry = getModelRegistry();
      registry.markVerified('groq', 'slow-ok', 'telemetry', 800);
      registry.markVerified('groq', 'fast-better', 'telemetry', 100);
      registry.markVerified('groq', 'flaky', 'telemetry', 50);
      // mark flaky with an error rate via a failed call record
      registry.recordCall('groq', 'flaky', false, 'timeout');

      expect(preferredModelsFor('groq')[0]).toBe('fast-better');
      expect(preferredModelsFor('groq')).not.toContain('unknown-model');
    });
  });

  describe('bestAvailable', () => {
    it('picks a verified model for a capability profile', () => {
      getModelRegistry().markVerified('local', 'local-model', 'telemetry');
      getModelRegistry().markVerified('groq', 'g-fast', 'telemetry');

      const pick = bestAvailable({ speed: 'high' }, makeConfig(['groq', 'local']));
      expect(pick?.provider).toBe('groq');
      expect(pick?.model).toBe('g-fast');
    });

    it('prefers a large-context provider when the profile asks for one', () => {
      getModelRegistry().markVerified('local', 'local-model', 'telemetry', 10);
      getModelRegistry().markVerified('gemini', 'g-big', 'telemetry', 100);

      const pick = bestAvailable({ context: 'large' }, makeConfig(['gemini', 'local']));
      expect(pick?.provider).toBe('gemini');
    });

    it('returns undefined when the user has nothing usable (callers show guidance)', () => {
      expect(bestAvailable({}, makeConfig([]))).toBeUndefined();
    });

    it('works registry-only when no ConfigManager is available (learning layer)', () => {
      getModelRegistry().markVerified('local', 'local-model', 'telemetry');
      const pick = bestAvailable({});
      expect(pick?.provider).toBe('local');
      expect(pick?.model).toBe('local-model');
    });
  });

  describe('requireAdapterModel (adapter last-resort)', () => {
    it('honors an explicit configured pin', () => {
      expect(requireAdapterModel('gemini', 'my-pinned-model')).toBe('my-pinned-model');
    });

    it('uses the best registry-verified model when the pin is the default sentinel', () => {
      getModelRegistry().markVerified('gemini', 'g-verified', 'telemetry');
      expect(requireAdapterModel('gemini', 'default')).toBe('g-verified');
    });

    it('refuses to invent a model name — clear onboarding error when nothing is known', () => {
      expect(() => requireAdapterModel('gemini', undefined)).toThrow(/No model resolved/);
      expect(() => requireAdapterModel('gemini', 'default')).toThrow(/buff models refresh/);
    });
  });

  it('exposes only the built-in adapter CATALOG — no preference order semantics', () => {
    expect(BUILTIN_PROVIDERS).toEqual(['local', 'groq', 'gemini', 'nim', 'openrouter', 'nuvira']);
  });

  it('ConfigManager resolves the auto default provider to a concrete built-in', () => {
    // The config default is the dynamic 'auto' directive; getProviderConfig
    // resolves it to a REAL adapter type (env keys / registry may influence
    // which, but never a literal 'auto' reaching the factory).
    const cm = new ConfigManager(join(tempDir, 'cfg'));
    expect(cm.getAll().defaultProvider).toBe('auto');
    const resolved = cm.getProviderConfig();
    expect(BUILTIN_PROVIDERS).toContain(resolved.type);
    expect(resolved.type).not.toBe('auto');
  });
});
