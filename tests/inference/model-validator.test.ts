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
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
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

  it('never returns the literal "default" sentinel — falls back to the catalog model when the list is unavailable', async () => {
    // OBSERVED LIVE (WhatsApp trace-1788970301803-8302u5): listModels failed
    // mid-pipeline → step 4 returned 'default' → Groq 404'd on
    // `The model \`default\` does not exist` and a song request died. The
    // sentinel must never reach a provider API — the catalog's curated real
    // model is the floor (gemini → gemini-2.0-flash).
    const provider = makeProvider([], { listThrows: true });
    const result = await resolveWorkingModel(provider, 'gemini');
    expect(result).toBe('gemini-2.0-flash');
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

  it('announces a repair only when ASKED to — the announcement belongs to resolveRoute', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // Registry is fresh (no verified models), so the live-list repair runs and
      // the pin is not marked dead — the path where a repair is worth reporting.
      const provider = makeProvider([model('gemini-2.5-flash', ['chat'])]);

      // DEFAULT: silent. Every caller now resolves through `resolveRoute()`, which
      // owns the reporting (line + routing history + run trace). Announcing here
      // too printed TWO lines for one substitution, and in strict mode it
      // announced a swap that then threw instead of happening.
      const repaired = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp');
      expect(repaired).toBe('gemini-2.5-flash');
      expect(warnSpy).not.toHaveBeenCalled();

      // Opt-in: the same repair, announced — so the contract is "quiet by
      // default", not "the warning is gone".
      const announced = await resolveWorkingModel(provider, 'gemini', 'gemini-2.0-flash-exp', true);
      expect(announced).toBe('gemini-2.5-flash');
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

  // ─── Capability-aware repair (the observed "strong pin → 7B toy" bug) ───────
  // Found live: a quota-parked `openai/gpt-oss-120b` was silently repaired to
  // the ONLY verified model that never rate-limited — `allam-2-7b`, the weakest
  // the provider serves — while a 27B and a 120B were both verified-usable.
  // The repair ranking (error rate, then latency) is a HEALTH ranking, so the
  // small fast model always wins it. When the dead pin was STRONG, repair must
  // not drop a capability band if a comparable sibling exists.
  it('repairs a dead STRONG pin to a comparable model, not the health-first 7B toy', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const registry = getModelRegistry();
      // The requested strong model is dead (quota-parked / rate-limited).
      registry.markUnavailable('groq', 'qwen/qwen3.8-27b', 'rate-limit', 'telemetry');
      // The weak model is FASTEST → it wins the health ranking.
      registry.markVerified('groq', 'allam-2-7b', 'telemetry', 100);
      // A comparable-capability sibling is verified but SLOWER → health-second.
      registry.markVerified('groq', 'openai/gpt-oss-120b', 'telemetry', 800);

      const provider = makeProvider([]);
      const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b');
      expect(result).toBe('openai/gpt-oss-120b');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still repairs to the health-first model when the dead pin was WEAK', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const registry = getModelRegistry();
      registry.markUnavailable('groq', 'allam-2-7b', 'rate-limit', 'telemetry');
      registry.markVerified('groq', 'openai/gpt-oss-120b', 'telemetry', 100);
      registry.markVerified('groq', 'qwen/qwen3.8-27b', 'telemetry', 200);

      const provider = makeProvider([]);
      // A weak request is not narrowed — the health-first pick is kept.
      const result = await resolveWorkingModel(provider, 'groq', 'allam-2-7b');
      expect(result).toBe('openai/gpt-oss-120b');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never dead-ends: repairs to an available (weaker) model when nothing comparable exists', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const registry = getModelRegistry();
      registry.markUnavailable('groq', 'qwen/qwen3.8-27b', 'rate-limit', 'telemetry');
      registry.markVerified('groq', 'allam-2-7b', 'telemetry', 100);

      const provider = makeProvider([]);
      const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b');
      // Nothing is comparable, so the health-first model is still used — a weak
      // candidate beats no candidate.
      expect(result).toBe('allam-2-7b');
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ─── The repair FLOOR (measured, trace-1791547245754-dmqwmu) ──────────────
  // Live: a parked `local/gpt-oss:120b-cloud` was repaired to
  // `local/qwen2.5:0.5b` — a ≤4B toy. The toy answered with confident nonsense
  // (a "plan" describing `generate_song` / `send_kashvi_song.py` for a RAG-app
  // goal), but it ANSWERED: the call succeeded, the failover walk never left the
  // provider, and the trace blamed the 120B model that was asked for. A repair
  // may not drop a model that NAMES a large size down to one that cannot hold
  // the task when the provider has nothing capable; the provider's own error is
  // the honest outcome, and the walk then reaches a provider that can serve it.
  it('refuses to hand a named-large pin to a ≤4B toy when the provider has nothing capable', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const registry = getModelRegistry();
      registry.markUnavailable('local', 'gpt-oss:120b-cloud', 'credit-exhausted', 'telemetry');
      // Health-first AND a toy: a 50ms 0%-error model always wins that ranking.
      registry.markVerified('local', 'qwen2.5:0.5b', 'telemetry', 50);

      const provider = makeProvider([]);
      const result = await resolveWorkingModel(provider, 'local', 'gpt-oss:120b-cloud');

      // The pin is handed back instead of the toy: the caller's walk advances
      // (and the pair is registry-blocked, so no doomed call is even made).
      expect(result).toBe('gpt-oss:120b-cloud');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still uses an agentic-capable sibling when the provider has one', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const registry = getModelRegistry();
      registry.markUnavailable('local', 'gpt-oss:120b-cloud', 'credit-exhausted', 'telemetry');
      registry.markVerified('local', 'qwen2.5:0.5b', 'telemetry', 50); // fastest → health-first
      registry.markVerified('local', 'deepseek-coder:latest', 'telemetry', 300);

      const provider = makeProvider([]);
      const result = await resolveWorkingModel(provider, 'local', 'gpt-oss:120b-cloud');

      // The floor NARROWS the downgrade, it never blocks a repair.
      expect(result).toBe('deepseek-coder:latest');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refuses the toy on the LIVE-LIST repair path too (the measured path)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // The local live list does not enumerate a cloud model id, which is what
      // made repair fall back to the installed models on that machine.
      getModelRegistry().markUnavailable('local', 'gpt-oss:120b-cloud', 'not in live model list', 'probe');
      const provider = makeProvider([model('qwen2.5:0.5b', ['chat'])]);

      const result = await resolveWorkingModel(provider, 'local', 'gpt-oss:120b-cloud');

      expect(result).toBe('gpt-oss:120b-cloud');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the provider\u2019s own repair for a pin that names NO size (the floor needs evidence)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      getModelRegistry().markUnavailable('local', 'some-gone-model', 'not in live model list', 'probe');
      const provider = makeProvider([model('qwen2.5:0.5b', ['chat'])]);

      const result = await resolveWorkingModel(provider, 'local', 'some-gone-model');

      // No size in the id → no positive evidence to protect, so an unrecognised
      // name still gets the provider's best attempt.
      expect(result).toBe('qwen2.5:0.5b');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('verify-on-demand (max mode)', () => {
  let registryTempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    clearModelListCache();
    registryTempDir = mkdtempSync(join(tmpdir(), 'buff-val-vod-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = registryTempDir;
    resetModelRegistry();
  });

  afterEach(() => {
    resetModelRegistry();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(registryTempDir, { recursive: true, force: true });
  });

  it('proves an unverified strong model instead of downgrading to a weak verified one', async () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'allam-2-7b', 'telemetry', 100); // only a weak model verified
    const provider = makeProvider([]);

    const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b', false, true);

    expect(result).toBe('qwen/qwen3.8-27b');
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(registry.getEntry('groq', 'qwen/qwen3.8-27b')?.status).toBe('verified');
  });

  it('does NOT probe when a comparable verified model already exists (no downgrade to avoid)', async () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'qwen/qwen3.8-27b', 'telemetry', 100);
    const provider = makeProvider([]);
    // Requested model is verified-usable → fast path, no probe.
    const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b', false, true);
    expect(result).toBe('qwen/qwen3.8-27b');
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('a rejected probe marks the model unavailable and repairs to a verified sibling', async () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'allam-2-7b', 'telemetry', 100);
    const provider = makeProvider([]);
    (provider.generate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Groq API error (404): model not found'),
    );

    const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b', false, true);

    expect(result).toBe('allam-2-7b');
    expect(registry.getEntry('groq', 'qwen/qwen3.8-27b')?.status).toBe('unavailable');
  });

  it('verifyOnDemand off (default) never probes — balanced stays byte-identical', async () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'allam-2-7b', 'telemetry', 100);
    const provider = makeProvider([]);

    const result = await resolveWorkingModel(provider, 'groq', 'qwen/qwen3.8-27b');

    // No probe with verifyOnDemand off: the empty live list means the desired
    // model is kept (existing step-4 behavior), and generate is never called.
    expect(result).toBe('qwen/qwen3.8-27b');
    expect(provider.generate).not.toHaveBeenCalled();
  });
});
