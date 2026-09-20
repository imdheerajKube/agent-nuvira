/**
 * R1 — the harness must be fitted to the MODEL.
 *
 * Before this, `getLoopExposureMode(configManager)` returned the same value for
 * every model, and the CLI learned that a model cannot take native tools by
 * burning a 400 on it (per turn). These tests pin the model-aware rules that
 * replace that.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveModelHarnessProfile,
  shouldSkipNativeTools,
} from '../../src/learning/model-harness.js';

describe('resolveModelHarnessProfile — tiny models get the tight harness', () => {
  const tiny = ['qwen2.5:0.5b', 'llama3.2:1b', 'gemma4:e4b', 'qwen2.5:3b', 'phi3'];

  for (const model of tiny) {
    it(`${model}: JSON transport, tiered exposure, serial reads`, () => {
      const p = resolveModelHarnessProfile({ model });
      expect(p.transport).toBe('json');
      expect(p.exposure).toBe('tiered');
      expect(p.maxParallelReads).toBe(1);
      expect(p.reason).toContain('tiny model');
    });
  }

  it('a tiny model never receives full exposure, even when config asks for it', () => {
    const p = resolveModelHarnessProfile({
      model: 'qwen2.5:0.5b',
      configExposure: 'all',
      contextLength: 128_000,
    });
    expect(p.exposure).toBe('tiered');
  });
});

describe('resolveModelHarnessProfile — capable models keep native tools', () => {
  it('gpt-oss:120b is native, not tiny, and reads in parallel', () => {
    const p = resolveModelHarnessProfile({ model: 'gpt-oss:120b' });
    expect(p.transport).toBe('native');
    expect(p.exposure).toBe('tiered');
    expect(p.maxParallelReads).toBe(4);
  });

  it('gpt-oss:20b is strong enough for native tools (size is not in the tiny set)', () => {
    expect(resolveModelHarnessProfile({ model: 'gpt-oss:20b' }).transport).toBe('native');
  });

  it('exposes the full schema set only when config opted in', () => {
    const off = resolveModelHarnessProfile({ model: 'gpt-oss:120b' });
    expect(off.exposure).toBe('tiered');
    const on = resolveModelHarnessProfile({ model: 'gpt-oss:120b', configExposure: 'all' });
    expect(on.exposure).toBe('all');
  });
});

describe('resolveModelHarnessProfile — the context gate on full exposure', () => {
  it('refuses `all` when the window cannot pay for ~17K tokens of schemas', () => {
    const p = resolveModelHarnessProfile({
      model: 'some-local-llama3.1',
      configExposure: 'all',
      contextLength: 8_192,
    });
    expect(p.exposure).toBe('tiered');
    expect(p.reason).toContain('8192');
  });

  it('allows `all` on a large window', () => {
    const p = resolveModelHarnessProfile({
      model: 'some-local-llama3.1',
      configExposure: 'all',
      contextLength: 128_000,
    });
    expect(p.exposure).toBe('all');
  });

  it('treats an unknown window as permissive (config already opted in)', () => {
    const p = resolveModelHarnessProfile({ model: 'claude-sonnet-4', configExposure: 'all' });
    expect(p.exposure).toBe('all');
    expect(p.reason).toContain('unknown');
  });
});

describe('resolveModelHarnessProfile — unknown models fail safe', () => {
  it('an unrecognised family starts on the JSON contract, not a doomed native call', () => {
    const p = resolveModelHarnessProfile({ model: 'mystery-model-v1' });
    expect(p.transport).toBe('json');
    expect(p.exposure).toBe('tiered');
  });

  it('no model at all is still a valid profile', () => {
    const p = resolveModelHarnessProfile({});
    expect(p.exposure).toBe('tiered');
    expect(p.transport).toBe('json');
    expect(p.maxParallelReads).toBe(4);
  });
});

describe('shouldSkipNativeTools', () => {
  it('skips the native attempt for a tiny model', () => {
    expect(shouldSkipNativeTools({ model: 'qwen2.5:0.5b' })).toBe(true);
  });

  it('keeps native tools for gpt-oss:120b', () => {
    expect(shouldSkipNativeTools({ model: 'gpt-oss:120b' })).toBe(false);
  });
});
