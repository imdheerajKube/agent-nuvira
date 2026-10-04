/**
 * Reasoning-effort — the safety contract.
 *
 * The knob's whole justification is that it can NEVER break a model that does
 * not support it. These tests pin the three rules that make that true:
 *   1. default-deny      — nothing is sent without positive registry evidence,
 *   2. shaping           — intent is translated per provider family,
 *   3. closed-loop       — a rejection is learned and the call retried without.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ReasoningCapability } from '../../src/config/types.js';
import {
  reasoningRequestBody,
  resolveReasoningRequest,
  isReasoningParamRejection,
  withReasoningFallback,
  reasoningCapabilityFromAdvertised,
  reasoningShapeForProvider,
  SHAPE_DEFAULT_PARAM,
  type ReasoningRegistryLike,
} from '../../src/inference/reasoning-effort.js';

function stubRegistry(cap: ReasoningCapability | undefined): ReasoningRegistryLike & { marked: string[] } {
  const marked: string[] = [];
  return {
    marked,
    getReasoningCapability: () => cap,
    markReasoningUnsupported: (_p, _m, param) => {
      marked.push(param);
    },
  };
}

const supported: ReasoningCapability = {
  supported: true,
  param: 'reasoning_effort',
  shape: 'openai-reasoning-effort',
  verifiedAt: 1,
  source: 'advertised',
};

describe('reasoningRequestBody', () => {
  it('emits a plain effort string for the OpenAI family', () => {
    expect(reasoningRequestBody({ param: 'reasoning_effort', shape: 'openai-reasoning-effort' }, 'high')).toEqual({
      reasoning_effort: 'high',
    });
  });

  it('emits an extended-thinking budget for Anthropic', () => {
    const body = reasoningRequestBody({ param: 'thinking', shape: 'anthropic-thinking' }, 'high');
    expect(body.thinking).toMatchObject({ type: 'enabled' });
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0);
  });

  it('scales the budget with effort (Gemini shape)', () => {
    const low = reasoningRequestBody({ param: 'thinkingConfig', shape: 'gemini-thinking' }, 'low');
    const high = reasoningRequestBody({ param: 'thinkingConfig', shape: 'gemini-thinking' }, 'high');
    const budget = (b: Record<string, unknown>) => (b.thinkingConfig as { thinkingBudget: number }).thinkingBudget;
    expect(budget(high)).toBeGreaterThan(budget(low));
  });
});

describe('resolveReasoningRequest — DEFAULT-DENY', () => {
  it('returns undefined when no effort is requested (balanced)', () => {
    expect(resolveReasoningRequest('groq', 'openai/gpt-oss-120b', undefined, stubRegistry(supported))).toBeUndefined();
  });

  it('returns undefined when the registry has no capability (unknown model)', () => {
    expect(resolveReasoningRequest('groq', 'openai/gpt-oss-120b', 'high', stubRegistry(undefined))).toBeUndefined();
  });

  it('returns undefined when the capability is explicitly unsupported', () => {
    const unsupported: ReasoningCapability = { ...supported, supported: false, source: 'learned-unsupported' };
    expect(resolveReasoningRequest('groq', 'openai/gpt-oss-120b', 'high', stubRegistry(unsupported))).toBeUndefined();
  });

  it('returns undefined when there is no registry at all', () => {
    expect(resolveReasoningRequest('groq', 'openai/gpt-oss-120b', 'high', undefined)).toBeUndefined();
  });

  it('emits the request when the pair is verified', () => {
    const req = resolveReasoningRequest('groq', 'openai/gpt-oss-120b', 'high', stubRegistry(supported));
    expect(req).toEqual({ body: { reasoning_effort: 'high' }, param: 'reasoning_effort', shape: 'openai-reasoning-effort' });
  });
});

describe('isReasoningParamRejection', () => {
  it('matches a 400 that names the parameter', () => {
    expect(isReasoningParamRejection(new Error('Groq API error (400): unknown parameter reasoning_effort'), 'reasoning_effort')).toBe(true);
  });

  it('matches a 422 unsupported-field phrasing', () => {
    expect(isReasoningParamRejection(new Error('422: unsupported field'), 'reasoning_effort')).toBe(true);
  });

  it('does NOT match a non-client error', () => {
    expect(isReasoningParamRejection(new Error('Groq API error (429): rate limit'), 'reasoning_effort')).toBe(false);
  });

  it('does NOT match a 400 that is unrelated to the parameter', () => {
    expect(isReasoningParamRejection(new Error('400: model not found'), 'reasoning_effort')).toBe(false);
  });
});

describe('withReasoningFallback — closed loop', () => {
  it('runs with no fragment when there is no request (byte-identical path)', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const out = await withReasoningFallback({ provider: 'groq', model: 'm', request: undefined, registry: stubRegistry(supported), run });
    expect(out).toBe('ok');
    expect(run).toHaveBeenCalledWith({});
  });

  it('runs with the fragment on success and does not retry', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const reg = stubRegistry(supported);
    await withReasoningFallback({ provider: 'groq', model: 'm', request: resolveReasoningRequest('groq', 'm', 'high', reg), registry: reg, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ reasoning_effort: 'high' });
    expect(reg.marked).toEqual([]);
  });

  it('learns unsupported and retries once without the parameter', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('Groq API error (400): unknown parameter reasoning_effort'))
      .mockResolvedValueOnce('ok');
    const reg = stubRegistry(supported);
    const out = await withReasoningFallback({ provider: 'groq', model: 'm', request: resolveReasoningRequest('groq', 'm', 'high', reg), registry: reg, run });
    expect(out).toBe('ok');
    expect(run).toHaveBeenNthCalledWith(2, {});
    expect(reg.marked).toEqual(['reasoning_effort']);
  });

  it('rethrows an unrelated error without retrying or learning', async () => {
    const run = vi.fn().mockRejectedValue(new Error('Groq API error (429): rate limit'));
    const reg = stubRegistry(supported);
    await expect(
      withReasoningFallback({ provider: 'groq', model: 'm', request: resolveReasoningRequest('groq', 'm', 'high', reg), registry: reg, run }),
    ).rejects.toThrow(/429/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(reg.marked).toEqual([]);
  });
});

describe('reasoningCapabilityFromAdvertised', () => {
  it('recognises reasoning in a provider-advertised parameter list', () => {
    const cap = reasoningCapabilityFromAdvertised(['temperature', 'reasoning', 'tools'], 42);
    expect(cap).toMatchObject({ supported: true, source: 'advertised', verifiedAt: 42 });
  });

  it('returns undefined when reasoning is not advertised', () => {
    expect(reasoningCapabilityFromAdvertised(['temperature', 'tools'])).toBeUndefined();
    expect(reasoningCapabilityFromAdvertised(undefined)).toBeUndefined();
  });
});

describe('reasoningShapeForProvider', () => {
  it('maps the OpenAI-compatible family to the reasoning_effort shape', () => {
    for (const p of ['groq', 'deepseek', 'openrouter', 'openai', 'xai']) {
      expect(reasoningShapeForProvider(p)).toBe('openai-reasoning-effort');
    }
  });

  it('returns undefined for providers with no wired shape', () => {
    expect(reasoningShapeForProvider('local')).toBeUndefined();
    expect(reasoningShapeForProvider('unknown-provider')).toBeUndefined();
  });

  it('exposes the default param name per shape', () => {
    expect(SHAPE_DEFAULT_PARAM['openai-reasoning-effort']).toBe('reasoning_effort');
  });
});
