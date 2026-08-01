/**
 * Model Health Validator — resolveWorkingModel tests.
 *
 * Auto routing must only use models that actually exist on the provider.
 * A provider's pinned config.model can be deprecated (gemini-2.0-flash-exp →
 * 404) or a placeholder (nim 'new-nim-model'). resolveWorkingModel() validates
 * the resolved model against the provider's LIVE listModels() and repairs it
 * to a verified-working model.
 */

import { describe, it, expect, vi } from 'vitest';

import { resolveWorkingModel } from '../../src/inference/model-validator.js';
import type { InferenceProvider, ModelDescriptor } from '../../src/inference/interface.js';

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
