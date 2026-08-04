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
import { resetModelRegistry } from '../../src/learning/model-registry.js';

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
});
