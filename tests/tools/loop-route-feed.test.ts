/**
 * The route feed — what the model is told about the model serving it.
 *
 * The defect this closes is a fabricated answer: the loop's prompt says nothing
 * about the route, so "which model are you?" could only be answered from the
 * user's config (what the ROUTER reads, not what answered), from memory, or from
 * an earlier step — all of which are confidently wrong after a substitution or a
 * failover. These tests pin the feed's honesty rules and its freshness.
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_ROUTE_HISTORY,
  ROUTE_FEED_MARKER,
  isUnresolvedModel,
  noteServedRoute,
  routeFeedFingerprint,
  routeFeedText,
} from '../../src/tools/loop-route-feed.js';

describe('routeFeedText — states only what was measured', () => {
  it('names the provider and the model that is serving the call', () => {
    const text = routeFeedText({ providerType: 'groq', providerName: 'Groq', model: 'openai/gpt-oss-120b' });
    expect(text.startsWith(ROUTE_FEED_MARKER)).toBe(true);
    expect(text).toContain('groq');
    expect(text).toContain('openai/gpt-oss-120b');
    // The instruction is part of the contract: a fact with no instruction gets
    // paraphrased into something else.
    expect(text).toContain('answer from THIS line');
  });

  it('names a substitution in both directions', () => {
    const text = routeFeedText({
      providerType: 'groq',
      model: 'openai/gpt-oss-120b',
      requested: 'gemini-3.1-flash-lite',
      substituted: true,
    });
    expect(text).toContain('gemini-3.1-flash-lite');
    expect(text).toContain('openai/gpt-oss-120b');
    expect(text).toContain('NOT available');
  });

  it('says "served as asked" when nothing was substituted', () => {
    const text = routeFeedText({
      providerType: 'groq',
      model: 'openai/gpt-oss-120b',
      requested: 'openai/gpt-oss-120b',
      substituted: false,
    });
    expect(text).toContain('served as asked');
    expect(text).not.toContain('NOT available');
  });

  it('refuses to invent a route when the model is unresolved', () => {
    for (const model of ['', 'default', 'auto', 'unknown']) {
      expect(isUnresolvedModel(model)).toBe(true);
      const text = routeFeedText({ providerType: 'auto', model });
      expect(text).toContain('UNRESOLVED');
      // The explicit prohibition is the point: "unresolved" must not become a
      // licence to guess, and the model is told exactly what not to do.
      expect(text).toContain('do not name a model from memory');
    }
    expect(isUnresolvedModel('openai/gpt-oss-120b')).toBe(false);
  });

  it('reports a failover history so one model cannot claim the whole turn', () => {
    const text = routeFeedText({
      providerType: 'local',
      model: 'gemma4:e4b',
      previous: ['groq/openai/gpt-oss-120b'],
    });
    expect(text).toContain('earlier in this turn');
    expect(text).toContain('groq/openai/gpt-oss-120b');
    expect(text).toContain('local');
  });
});

describe('noteServedRoute — failover history', () => {
  it('remembers the pair that was replaced', () => {
    const first = noteServedRoute(null, { providerType: 'groq', model: 'openai/gpt-oss-120b' });
    expect(first.previous).toBeUndefined();

    const second = noteServedRoute(first, { providerType: 'local', model: 'gemma4:e4b' });
    expect(second.previous).toEqual(['groq/openai/gpt-oss-120b']);
  });

  it('does not duplicate or record placeholder pairs', () => {
    const route = noteServedRoute(null, { providerType: 'auto', model: 'default' });
    expect(route.previous).toBeUndefined();
    // Re-noting the SAME pair adds nothing.
    const same = noteServedRoute(
      { providerType: 'groq', model: 'a' },
      { providerType: 'groq', model: 'a' },
    );
    expect(same.previous).toBeUndefined();
  });

  it('stays bounded', () => {
    let route = noteServedRoute(null, { providerType: 'p0', model: 'm0' });
    for (let i = 1; i <= 10; i++) {
      route = noteServedRoute(route, { providerType: `p${i}`, model: `m${i}` });
    }
    expect(route.previous!.length).toBe(MAX_ROUTE_HISTORY);
  });
});

describe('routeFeedFingerprint — change detection', () => {
  it('is equal for equal facts and different for different ones', () => {
    const a = { providerType: 'groq', model: 'm1' };
    expect(routeFeedFingerprint(a)).toBe(routeFeedFingerprint({ ...a }));
    expect(routeFeedFingerprint(a)).not.toBe(routeFeedFingerprint({ providerType: 'groq', model: 'm2' }));
    // A failover history change is a change: the model must be told.
    expect(routeFeedFingerprint({ ...a, previous: ['x/y'] })).not.toBe(routeFeedFingerprint(a));
    expect(routeFeedFingerprint(null)).toBe('');
  });
});
