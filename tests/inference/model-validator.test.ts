/**
 * Model Health Validator — resolveWorkingModel tests.
 *
 * Auto routing must only use models that actually exist on the provider.
 * A provider's pinned config.model can be deprecated (gemini-2.0-flash-exp →
 * 404) or a placeholder (nim 'new-nim-model'). resolveWorkingModel() validates
 * the resolved model against the provider's LIVE listModels() and repairs it
 * to a verified-working model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkingModel, clearModelListCache } from '../../src/inference/model-validator.js';
import type { InferenceProvider, ModelDescriptor } from '../../src/inference/interface.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { logger } from '../../src/utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProvider(models: ModelDescriptor[], opts?: { listThrows?: boolean }): InferenceProvider {
  return {
    name: 'FakeProvider',
    listModels: vi.fn().mockImplementation(async () => {
      if (opts?.listThrows) throw new Error('listModels failed');
      return models;
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('ok'),
    getInfo: () => 'FakeProvider',
  } as unknown as InferenceProvider;
}

function model(id: string, tags?: string[]): ModelDescriptor {
  return { id, name: id, provider: 'test', tags };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveWorkingModel', () => {
  // The live model list is cached per provider type (TTL) to avoid a
  // listModels() GET on every auto-routed message. Tests must clear the cache
  // so each test sees the provider's OWN mock list, not a prior test's.
  // The ModelRegistry fast-path must ALSO be isolated: it reads a persisted
  // JSON mirror from BUFF_MEMORY_DIR, and a real registry would short-circuit
  // the mocked listModels (verified entries bypass the live fetch).
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    clearModelListCache();
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-val-registry-'));
    originalMemoryDir = process.env.BUFF_MEMORY_DIR;
    process.env.BUFF_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.BUFF_MEMORY_DIR;
    } else {
      process.env.BUFF_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

  it('caches the live model list per provider type within the TTL window', async () => {
    const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
    // First call hits listModels() and populates the cache
    const first = await resolveWorkingModel(provider, 'gemini', 'gemini-2.5-flash');
    expect(first).toBe('gemini-2.5-flash');

    // Second call for the same provider type must be served from the cache —
    // listModels() is NOT called again (this is the per-message latency win).
    const second = await resolveWorkingModel(provider, 'gemini', 'gemini-2.5-flash');
    expect(second).toBe('gemini-2.5-flash');
    expect(provider.listModels).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed listModels() fetch (transient errors stay transparent)', async () => {
    const failing = makeProvider([], { listThrows: true });
    await resolveWorkingModel(failing, 'groq', 'llama-3.3-70b-versatile');
    // Failed fetch → nothing cached → a later healthy provider for the same
    // type must still hit its own listModels().
    const healthy = makeProvider([model('llama-3.3-70b-versatile', ['chat'])]);
    const result = await resolveWorkingModel(healthy, 'groq', 'llama-3.3-70b-versatile');
    expect(result).toBe('llama-3.3-70b-versatile');
    expect(healthy.listModels).toHaveBeenCalledTimes(1);
  });

  it('keeps the desired model when it is present in the live list', async () => {
    const provider = makeProvider([
      model('gemini-2.5-flash', ['chat']),
      model('gemini-2.0-flash', ['chat']),
    ]);
    const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.5-flash');
    expect(result).toBe('gemini-2.5-flash');
  });

  it('repairs a deprecated pinned model to a curated known-good default', async () => {
    // gemini-2.0-flash-exp was retired by Google — 404s. The curated default
    // gemini-2.5-flash is in the live list → it must be chosen.
    const provider = makeProvider([
      model('gemini-2.5-flash', ['chat']),
      model('gemini-2.0-flash', ['chat']),
    ]);
    const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
    expect(result).toBe('gemini-2.5-flash');
  });

  it('repairs a placeholder NIM model to a curated working model', async () => {
    const provider = makeProvider([
      model('meta/llama-3.3-70b-instruct', ['chat']),
    ]);
    const result = await resolveWorkingModel(provider, 'nim', 'new-nim-model');
    expect(result).toBe('meta/llama-3.3-70b-instruct');
  });

  it('falls back to the first usable model when no curated default matches', async () => {
    const provider = makeProvider([
      model('whisper-large-v3', ['speech']), // speech — never chat-compatible
      model('custom-chat-model-1', ['chat']),
    ]);
    const result = await resolveWorkingModel(provider, 'local', 'some-gone-model');
    expect(result).toBe('custom-chat-model-1');
  });

  it('skips speech models during generic fallback', async () => {
    const provider = makeProvider([
      model('whisper-large-v3', ['speech']),
      model('distil-whisper-large-v3-en', ['speech']),
    ]);
    // Only speech models exist — nothing chat-usable, so keep the desired model
    const result = await resolveWorkingModel(provider, 'local', 'desired-model');
    expect(result).toBe('desired-model');
  });

  it('keeps the desired model when the live list cannot be fetched', async () => {
    const provider = makeProvider([], { listThrows: true });
    const result = await resolveWorkingModel(provider, 'groq', 'llama-3.3-70b-versatile');
    expect(result).toBe('llama-3.3-70b-versatile');
  });

  it('keeps the desired model when the live list is empty', async () => {
    const provider = makeProvider([]);
    const result = await resolveWorkingModel(provider, 'groq', 'llama-3.3-70b-versatile');
    expect(result).toBe('llama-3.3-70b-versatile');
  });

  it('resolves a working model when no desired model is provided (adapter default may be deprecated)', async () => {
    // 'default' means "no pinned model" — the adapter's hardcoded default can
    // be deprecated (gemini-2.0-flash-exp), so resolve a verified live one.
    const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
    const result = await resolveWorkingModel(provider, 'gemini');
    expect(result).toBe('gemini-2.5-flash');
  });

  it('falls back to "default" when no desired model is given and the list is unavailable', async () => {
    const provider = makeProvider([], { listThrows: true });
    const result = await resolveWorkingModel(provider, 'gemini');
    expect(result).toBe('default');
  });

  it('resolves a working model when the desired model is literally "default"', async () => {
    const provider = makeProvider([model('gemini-2.0-flash', ['chat'])]);
    const result = await resolveWorkingModel(provider, 'gemini', 'default');
    expect(result).toBe('gemini-2.0-flash');
  });

  it('repairs a stale OpenRouter model id to a curated working model', async () => {
    const provider = makeProvider([
      model('openai/gpt-4o-mini', ['chat']),
      model('meta-llama/llama-3.3-70b-instruct', ['chat']),
    ]);
    const result = await resolveWorkingModel(provider, 'openrouter', 'gpt-4-gone');
    expect(result).toBe('openai/gpt-4o-mini');
  });

  it('is tolerant of models without tags', async () => {
    const provider = makeProvider([model('some-model-no-tags')]);
    const result = await resolveWorkingModel(provider, 'groq', 'gone-model');
    expect(result).toBe('some-model-no-tags');
  });

  // ─── No-recursion guarantee (the "select a model, then it's not available"
  // ─── complaint) ────────────────────────────────────────────────────────────
  // Once the Model Availability Registry has VERIFIED a working model for a
  // provider (from a prior real call or spot-check) AND learned the stale pin
  // is dead, a stale pinned model must be repaired SILENTLY — no repeated
  // "model X is not available" warning on every message. The first repair
  // (registry has no verified replacement yet) may warn, but once learned the
  // warning must not recur.
  it('repairs silently from a registry-verified model — no warning on repeat routes', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // The exact state after one learned repair: the pin is marked dead and
      // the replacement was VERIFIED by a prior real call (next session).
      const registry = getModelRegistry();
      registry.markUnavailable('gemini', 'gemini-2.0-flash-exp', 'not in live model list', 'probe');
      registry.markVerified('gemini', 'gemini-2.5-flash', 'telemetry');
      const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);

      const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      expect(result).toBe('gemini-2.5-flash');
      // Silent: the registry already knows the replacement works — re-warning
      // on every message is the recursive UX the user complained about.
      expect(warnSpy).not.toHaveBeenCalled();
      // Fast path: the verified registry entry must short-circuit listModels().
      expect(provider.listModels).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns ONCE when no verified replacement exists yet (cold registry)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // Registry is fresh (no verified models) → the live-list repair must
      // warn once so the user learns their pin is dead and what replaced it.
      const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
      const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      expect(result).toBe('gemini-2.5-flash');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("model 'gemini-2.0-flash-exp' is not available");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('teaches the registry that a repaired-away pin is dead — only when a verified alternative exists', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // A verified replacement already exists (prior real call) → teaching the
      // pin dead is SAFE: the provider keeps a usable entry, so
      // getBlockedProviders() can never flip it to blocked.
      getModelRegistry().markVerified('gemini', 'gemini-2.5-flash', 'telemetry');
      const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
      const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      expect(result).toBe('gemini-2.5-flash');
      // The repair persists: the dead pin is now unavailable in the registry,
      // so the NEXT route (and the router's resolveModel) skips it.
      const entry = getModelRegistry().getEntry('gemini', 'gemini-2.0-flash-exp');
      expect(entry?.status).toBe('unavailable');
      // And crucially the provider is NOT blocked (it retains the verified
      // alternative) — no "ends at local" regression for a healthy provider.
      expect(getModelRegistry().getBlockedProviders()).not.toContain('gemini');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT teach on a cold registry (never flips a healthy provider into getBlockedProviders)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // Cold registry: no verified models yet. The pin is repaired (with a
      // warning — the user learns their pin is dead), but the pin must NOT be
      // marked unavailable, because that would make getBlockedProviders()
      // block the WHOLE provider (all tracked models unavailable, no verified
      // alternative) → routeMessageAuto would skip it and jump to local on the
      // very next message, never trying the working replacement.
      const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
      const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      expect(result).toBe('gemini-2.5-flash');
      expect(getModelRegistry().getEntry('gemini', 'gemini-2.0-flash-exp')).toBeUndefined();
      expect(getModelRegistry().getBlockedProviders()).not.toContain('gemini');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never resurrects a model the registry marked unavailable', async () => {
    // Registry says gemini-2.5-flash is definitively dead (telemetry) — repair
    // must route AROUND it, not back into it, even if it appears in the live
    // list (listModels can list models the key can't actually use).
    getModelRegistry().markUnavailable('gemini', 'gemini-2.5-flash', '404 model not found', 'telemetry');
    const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);
    const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
    // No verified replacement and the only live model is registry-blocked →
    // keep the desired model so the real error surfaces.
    expect(result).toBe('gemini-2.0-flash-exp');
  });

  it('does NOT silently replace a merely-unverified pin (user pin wins until proven dead)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // gemini-2.5-flash is verified, but the pin has NO registry entry (never
      // learned dead) — a user's fresh working pin must not be overridden.
      getModelRegistry().markVerified('gemini', 'gemini-2.5-flash', 'telemetry');
      const provider = makeProvider([model('gemini-2.0-flash-exp', ['chat'])]);
      const result = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      // The pin IS in the live list → kept, verified-replacement ignored.
      expect(result).toBe('gemini-2.0-flash-exp');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
