/**
 * Provider revival — the shared "one more round of check" sweep.
 *
 * Before this existed, `chat.ts` was the ONLY path that read the transient
 * failure marker. The orchestrator, resilient-call, edit, execute and plan all
 * allocated it and never acted on it, so in those paths a provider that
 * recovered from a transient failure stayed excluded for the rest of the run —
 * which is how a single 503 degraded a whole pipeline.
 *
 * These tests pin the contract that makes the sweep safe to call on every
 * routing path: it must re-admit what recovered, keep out what did not, and
 * never cost a network call it does not need.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Registry mock: the sweep only probes providers the registry still blocks ─

const blocked = vi.hoisted(() => new Set<string>());
vi.mock('../../src/learning/model-registry.js', () => ({
  getModelRegistry: () => ({ getBlockedProviders: () => [...blocked] }),
}));

import {
  sweepTransientFailures,
  sessionRevivalStore,
  collectionRevivalStore,
  type RevivalStore,
} from '../../src/learning/provider-revival.js';
import { TRANSIENT_FAILURE_EXCLUSION_MS, type FailureSessionState } from '../../src/learning/failure-bookkeeping.js';
import type { ConfigManager } from '../../src/config/manager.js';

const config = {} as ConfigManager;

function makeSession(overrides?: Partial<FailureSessionState>): FailureSessionState {
  return {
    sessionFailedProviders: new Map(),
    sessionTransientFailedProviders: new Set(),
    ...overrides,
  };
}

/** A store with no probe model, so `resolveProbeModel` never hits the router. */
function storeFor(session: FailureSessionState): RevivalStore {
  return { ...sessionRevivalStore(session), resolveProbeModel: () => 'probe-model' };
}

beforeEach(() => {
  blocked.clear();
});

describe('sweepTransientFailures', () => {
  it('re-admits a provider whose spot-check proves it is back', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['gemini', Date.now() - 1]]),
      sessionTransientFailedProviders: new Set(['gemini']),
    });
    blocked.add('gemini');

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: async () => 'verified' as never,
    });

    expect(result.probed).toEqual(['gemini']);
    expect(result.revived).toEqual(['gemini']);
    expect(session.sessionTransientFailedProviders.has('gemini')).toBe(false);
    expect(session.sessionFailedProviders.has('gemini')).toBe(false);
  });

  it('keeps a still-down provider excluded and re-arms the window', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['groq', Date.now() - 1]]),
      sessionTransientFailedProviders: new Set(['groq']),
    });
    blocked.add('groq');
    const before = Date.now();

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: async () => 'unavailable' as never,
    });

    expect(result.stillDown).toEqual(['groq']);
    expect(result.revived).toEqual([]);
    // Still marked, and the exclusion moved forward by a full transient window.
    expect(session.sessionTransientFailedProviders.has('groq')).toBe(true);
    const expiry = session.sessionFailedProviders.get('groq')!;
    expect(expiry).toBeGreaterThanOrEqual(before + TRANSIENT_FAILURE_EXCLUSION_MS);
  });

  it("treats a throttled 'skipped' probe as healthy (already verified recently)", async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['nim', Date.now() - 1]]),
      sessionTransientFailedProviders: new Set(['nim']),
    });
    blocked.add('nim');

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: async () => 'skipped' as never,
    });

    expect(result.revived).toEqual(['nim']);
  });

  it('makes NO probe while the exclusion is still active', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['openrouter', Date.now() + 60_000]]),
      sessionTransientFailedProviders: new Set(['openrouter']),
    });
    blocked.add('openrouter');
    const probe = vi.fn(async () => 'verified');

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: probe as never,
    });

    // The exclusion has not lapsed, so there is nothing to re-verify yet — this
    // is what keeps a per-batch sweep cheap.
    expect(probe).not.toHaveBeenCalled();
    expect(result.probed).toEqual([]);
    expect(session.sessionTransientFailedProviders.has('openrouter')).toBe(true);
  });

  it('makes NO probe when the registry no longer blocks the provider', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['local', Date.now() - 1]]),
      sessionTransientFailedProviders: new Set(['local']),
    });
    // NOT added to `blocked` — a lapsed time-based park means nothing to prove.
    const probe = vi.fn(async () => 'verified');

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: probe as never,
    });

    expect(probe).not.toHaveBeenCalled();
    expect(result.revived).toEqual(['local']);
  });

  it('bounds the probes per sweep so a foreground turn is never held hostage', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map(),
      sessionTransientFailedProviders: new Set(['a', 'b', 'c', 'd', 'e']),
    });
    for (const p of ['a', 'b', 'c', 'd', 'e']) blocked.add(p);
    const probe = vi.fn(async () => 'verified');

    const result = await sweepTransientFailures(storeFor(session), config, {
      probe: probe as never,
      maxProbes: 2,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.probed).toHaveLength(2);
    // The untouched providers keep their markers for a later sweep — a bounded
    // sweep defers, it does not silently drop them.
    expect(session.sessionTransientFailedProviders.size).toBe(3);
  });

  it('is a no-op when nothing is pending', async () => {
    const probe = vi.fn(async () => 'verified');
    const result = await sweepTransientFailures(storeFor(makeSession()), config, {
      probe: probe as never,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(result).toEqual({ probed: [], revived: [], stillDown: [] });
  });

  it('never throws — a failing probe or store must not break the caller', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map([['boom', Date.now() - 1]]),
      sessionTransientFailedProviders: new Set(['boom']),
    });
    blocked.add('boom');

    await expect(
      sweepTransientFailures(storeFor(session), config, {
        probe: async () => {
          throw new Error('probe exploded');
        },
      }),
    ).resolves.toBeDefined();

    await expect(
      sweepTransientFailures(
        {
          transientProviders: () => {
            throw new Error('store exploded');
          },
          isExclusionActive: () => false,
          clearProvider: () => {},
          reArmProvider: () => {},
        },
        config,
      ),
    ).resolves.toEqual({ probed: [], revived: [], stillDown: [] });
  });

  it('iterates a SNAPSHOT so a re-armed provider is not probed twice in one sweep', async () => {
    const session = makeSession({
      sessionFailedProviders: new Map(),
      sessionTransientFailedProviders: new Set(['twice']),
    });
    blocked.add('twice');
    // reArmProvider re-adds the key while iterating; a non-snapshot loop would
    // revisit it and double-probe.
    const probe = vi.fn(async () => 'unavailable');

    await sweepTransientFailures(storeFor(session), config, { probe: probe as never });

    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('collectionRevivalStore', () => {
  it('adapts the raw (exclusions, markers) pair every CLI path holds', async () => {
    const sessionFailed = new Map<string, number>([['x', Date.now() - 1]]);
    const transient = new Set<string>(['x']);
    blocked.add('x');

    const result = await sweepTransientFailures(
      { ...collectionRevivalStore(sessionFailed, transient), resolveProbeModel: () => 'm' },
      config,
      { probe: async () => 'verified' as never },
    );

    expect(result.revived).toEqual(['x']);
    expect(transient.size).toBe(0);
    expect(sessionFailed.size).toBe(0);
  });
});
