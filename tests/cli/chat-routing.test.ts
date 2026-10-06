/**
 * ChatCommand — unified routing behaviors tests.
 *
 * Covers the two enterprise routing enhancements:
 * 1. COLD-START PROBE: when the Model Availability Registry has zero usable
 *    providers, routeMessageAuto fires ONE background refreshModelRegistry so
 *    the first auto pick learns from real probe data instead of failing into
 *    dead ends. Fires exactly once per chat session.
 * 2. RE-VERIFY BEFORE RE-ADMIT: a provider whose TRANSIENT failure exclusion
 *    just expired is only re-admitted after a quick on-demand spot-check
 *    confirms it's actually back. Still-down → re-excluded for another window;
 *    verified/skipped (recently verified) → re-admitted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';
import { resetQuotaLedger } from '../../src/learning/quota-ledger.js';
import { setVectorBackendOverride, resetVectorBackendSelection } from '../../src/memory/vector-store.js';

// ─── Module-level mocks ─────────────────────────────────────────────────────

const mockSpotCheck = vi.hoisted(() => vi.fn().mockResolvedValue('verified'));
const mockRefreshRegistry = vi.hoisted(() => vi.fn().mockResolvedValue({ providersProbed: [], modelsListed: 0, verified: 0, unavailable: 0, skipped: 0, errors: 0 }));
const mockResolveProvider = vi.hoisted(() => vi.fn());
const mockRouterResolve = vi.hoisted(() => vi.fn());

// The fake provider returned by resolveProvider — always available.
const fakeProvider = {
  name: 'Fake Provider',
  isAvailable: async () => true,
  listModels: async () => [{ id: 'm1' }],
  generate: async () => 'ok',
  getInfo: () => 'fake',
};

vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: (...args: unknown[]) => mockResolveProvider(...args),
}));

vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    isAutoModel: actual.isAutoModel,
    isAutoProvider: actual.isAutoProvider,
    getAutoRouter: () => ({
      resolve: (...args: unknown[]) => mockRouterResolve(...args),
      resolveModel: (provider: string) => provider === 'gemini' ? 'gemini-2.5-flash' : 'default',
    }),
  };
});

vi.mock('../../src/inference/model-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inference/model-probe.js')>();
  return {
    ...actual,
    refreshModelRegistry: (...args: unknown[]) => mockRefreshRegistry(...args),
    spotCheckModel: (...args: unknown[]) => mockSpotCheck(...args),
  };
});

vi.mock('../../src/learning/provider-fallback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/provider-fallback.js')>();
  return {
    ...actual,
    getProviderFallback: () => ({
      getCircuitBreakerStatus: () => [],
      recordFailure: () => {},
    }),
  };
});

vi.mock('../../src/learning/quota-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/quota-ledger.js')>();
  return {
    ...actual,
    getQuotaLedger: () => ({
      getRouterQuotaStatus: () => [],
      parkProvider: () => {},
      recordEvent: () => {},
    }),
  };
});

vi.mock('../../src/learning/routing-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/routing-history.js')>();
  return {
    ...actual,
    recordRoutingDecision: () => {},
  };
});

vi.mock('../../src/inference/model-validator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inference/model-validator.js')>();
  return {
    ...actual,
    resolveWorkingModel: async (_p: unknown, _t: string, model: string) => model,
  };
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ChatCommand — cold-start probe (unified registry learning)', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-route-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
    mockSpotCheck.mockReset();
    mockRefreshRegistry.mockClear();
    mockRefreshRegistry.mockResolvedValue({ providersProbed: ['gemini'], modelsListed: 1, verified: 1, unavailable: 0, skipped: 0, errors: 0 });
    // Router always returns the available fake provider.
    mockResolveProvider.mockReturnValue({ type: 'gemini', provider: fakeProvider });
    mockRouterResolve.mockReturnValue({
      agentType: 'chat', provider: 'gemini', model: 'gemini-2.5-flash',
      complexity: 'simple', taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
      escalationApplied: false, taskType: 'chat', score: 0.8,
      weights: {}, ranked: [{ provider: 'gemini', score: 0.8, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' }],
      fallbackChain: [], explanation: 'test', routedBy: 'heuristic',
    });
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('fires ONE background registry refresh when no usable providers exist (cold start)', async () => {
    const cmd = new ChatCommand() as any;
    // Fresh registry — no verified models → cold-start probe fires.
    expect(getModelRegistry().getUsableProviders()).toEqual([]);

    const routed = await cmd.routeMessageAuto('hello');
    expect(routed.type).toBe('gemini');
    expect(mockRefreshRegistry).toHaveBeenCalledTimes(1);

    // Second message: the session latch prevents a second probe.
    await cmd.routeMessageAuto('again');
    expect(mockRefreshRegistry).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the cold-start probe when the registry already has usable providers', async () => {
    getModelRegistry().markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    const cmd = new ChatCommand() as any;

    await cmd.routeMessageAuto('hello');
    expect(mockRefreshRegistry).not.toHaveBeenCalled();
  });
});

describe('ChatCommand — re-verify before re-admit (expired transient exclusions)', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-route-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
    mockSpotCheck.mockReset();
    mockSpotCheck.mockResolvedValue('verified');
    mockRefreshRegistry.mockClear();
    mockResolveProvider.mockReturnValue({ type: 'gemini', provider: fakeProvider });
    mockRouterResolve.mockReturnValue({
      agentType: 'chat', provider: 'gemini', model: 'gemini-2.5-flash',
      complexity: 'simple', taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
      escalationApplied: false, taskType: 'chat', score: 0.8,
      weights: {}, ranked: [{ provider: 'gemini', score: 0.8, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' }],
      fallbackChain: [], explanation: 'test', routedBy: 'heuristic',
    });
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) {
      delete process.env.NUVIRA_MEMORY_DIR;
    } else {
      process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('re-verifies an expired transient provider via spot-check and re-admits on success', async () => {
    const registry = getModelRegistry();
    // Registry learned gemini is dead (telemetry) — it IS blocked.
    registry.markUnavailable('gemini', 'gemini-2.5-flash', '403 permission denied', 'telemetry');
    expect(registry.getBlockedProviders()).toContain('gemini');

    const cmd = new ChatCommand() as any;
    // Simulate: gemini failed transiently 2 minutes ago (exclusion EXPIRED).
    cmd.sessionTransientFailedProviders.add('gemini');
    cmd.sessionFailedProviders.set('gemini', Date.now() - 120_000);

    // The spot-check says it's back → gemini is re-admitted and routed.
    mockSpotCheck.mockResolvedValue('verified');
    const routed = await cmd.routeMessageAuto('hello');
    expect(mockSpotCheck).toHaveBeenCalledWith('gemini', 'gemini-2.5-flash', expect.anything());
    expect(routed.type).toBe('gemini');
    // Exclusion cleared — no longer transient-failed.
    expect(cmd.sessionTransientFailedProviders.has('gemini')).toBe(false);
  });

  it('keeps a still-down provider excluded for another transient window', async () => {
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', 'auth', 'telemetry');
    expect(registry.getBlockedProviders()).toContain('gemini');

    const cmd = new ChatCommand() as any;
    cmd.sessionTransientFailedProviders.add('gemini');
    cmd.sessionFailedProviders.set('gemini', Date.now() - 120_000);

    // Spot-check still fails → gemini must NOT be routed this message.
    mockSpotCheck.mockResolvedValue('unavailable');
    await cmd.routeMessageAuto('hello');

    // Re-excluded for a fresh transient window.
    expect(cmd.sessionTransientFailedProviders.has('gemini')).toBe(true);
    const expiresAt = cmd.sessionFailedProviders.get('gemini');
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('does not spot-check a provider the registry still considers healthy', async () => {
    const registry = getModelRegistry();
    // gemini is verified (healthy) — a transient failure did NOT flip it.
    registry.markVerified('gemini', 'gemini-2.5-flash', 'spot-check');

    const cmd = new ChatCommand() as any;
    cmd.sessionTransientFailedProviders.add('gemini');
    cmd.sessionFailedProviders.set('gemini', Date.now() - 120_000);

    await cmd.routeMessageAuto('hello');
    // Healthy provider → no spot-check needed, re-admitted directly.
    expect(mockSpotCheck).not.toHaveBeenCalled();
    expect(cmd.sessionTransientFailedProviders.has('gemini')).toBe(false);
  });

  it('treats a recently-verified (skipped) spot-check as a pass', async () => {
    const registry = getModelRegistry();
    registry.markUnavailable('gemini', 'gemini-2.5-flash', '403 permission denied', 'telemetry');

    const cmd = new ChatCommand() as any;
    cmd.sessionTransientFailedProviders.add('gemini');
    cmd.sessionFailedProviders.set('gemini', Date.now() - 120_000);

    // spotCheckModel returns 'skipped' (model verified within the 10-min
    // throttle) — that means healthy, so gemini is re-admitted.
    mockSpotCheck.mockResolvedValue('skipped');
    const routed = await cmd.routeMessageAuto('hello');
    expect(routed.type).toBe('gemini');
    expect(cmd.sessionTransientFailedProviders.has('gemini')).toBe(false);
  });
});

/**
 * fix_model_routing P2/P3 — the HANDOFF plumbing, on the surface that failed.
 *
 * The reported run died because a model that returned nothing usable kept being
 * re-asked. The loop now hands off (P2) — and these tests pin the three caller-side
 * pieces that handoff depends on, each of which is invisible until it is wrong:
 *
 *   1. A MODEL-scoped exclusion must actually advance the deep pool to the next
 *      candidate (not silently return the same pair, which would make every
 *      handoff a no-op).
 *   2. A handoff must NOT be served from the 30-second routing cache: its key
 *      cannot see the pair we just excluded, so a cached decision can hand back
 *      the very model we are trying to escape.
 *   3. A continuation prefers the model that already delivered this task (RC7).
 */
describe('ChatCommand — mid-turn handoff plumbing (fix_model_routing)', () => {
  let tempDir: string;
  let originalMemoryDir: string | undefined;

  const decision = (over: Partial<Record<string, unknown>> = {}) => ({
    agentType: 'chat',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    complexity: 'simple',
    taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
    escalationApplied: false,
    taskType: 'chat',
    score: 0.8,
    weights: {},
    ranked: [
      { provider: 'gemini', score: 0.8, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' },
      { provider: 'groq', score: 0.7, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' },
    ],
    fallbackChain: [],
    explanation: 'test',
    routedBy: 'heuristic',
    ...over,
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'buff-chat-handoff-'));
    originalMemoryDir = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    setVectorBackendOverride('json');
    resetModelRegistry();
    resetQuotaLedger();
    mockSpotCheck.mockReset();
    mockSpotCheck.mockResolvedValue('verified');
    mockRefreshRegistry.mockClear();
    mockRouterResolve.mockReset();
    mockRouterResolve.mockReturnValue(decision());
    // Per-provider adapters, so a handoff to another provider is OBSERVABLE.
    mockResolveProvider.mockReset();
    mockResolveProvider.mockImplementation((_cm: unknown, provider: string) => ({
      type: provider,
      provider: { ...fakeProvider, name: `Fake ${provider}` },
    }));
    getModelRegistry().markVerified('gemini', 'gemini-2.5-flash', 'spot-check');
    getModelRegistry().markVerified('groq', 'openai/gpt-oss-120b', 'spot-check');
  });

  afterEach(() => {
    resetModelRegistry();
    resetQuotaLedger();
    resetVectorBackendSelection();
    if (originalMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = originalMemoryDir;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a MODEL-scoped exclusion advances the pool to a different candidate', async () => {
    const cmd = new ChatCommand() as any;
    const first = await cmd.routeMessageAuto('build the app');
    expect(first.type).toBe('gemini');

    // Exactly what `requestModelSwitch` writes for the pair that returned
    // nothing usable: model-scoped, so the SAME provider's siblings stay
    // routable, and the walk must move on.
    cmd.sessionFailedModels.set('gemini|gemini-2.5-flash', Date.now() + 120_000);

    const second = await cmd.routeMessageAuto('build the app', []);
    expect(`${second.type}|${second.model}`).not.toBe('gemini|gemini-2.5-flash');
    expect(second.type).toBe('groq');
  });

  it('noCache forces a FRESH decision, so a handoff cannot reuse the one it is escaping', async () => {
    const cmd = new ChatCommand() as any;
    const msg = 'wire up the routing handoff';
    await cmd.routeMessageAuto(msg);
    const afterFirst = mockRouterResolve.mock.calls.length;

    // Within the 30s TTL, an identical routing signature reuses the cached
    // decision: no second resolve.
    await cmd.routeMessageAuto(msg);
    expect(mockRouterResolve.mock.calls.length).toBe(afterFirst);

    // …and a HANDOFF must not reuse it: the pair it just excluded is not part of
    // the cache signature, so a cached answer could be the same broken model.
    await cmd.routeMessageAuto(msg, [], { noCache: true, fallbackFrom: 'gemini' });
    expect(mockRouterResolve.mock.calls.length).toBe(afterFirst + 1);
  });

  it('prefers the model that already delivered this task when re-routing a continuation', async () => {
    const cmd = new ChatCommand() as any;
    const sig = 'coding|simple';
    cmd.lastTaskSignature = sig;
    // What a DELIVERED turn of this task would have recorded.
    cmd.taskContinuity.remember(sig, 'groq', 'openai/gpt-oss-120b');

    // A continuation carries no task signal of its own, so the router would
    // re-decide — here it would pick gemini again, which is how the live
    // `resume` degraded onto a model that had never served the task.
    const routed = await cmd.routeMessageAuto('resume', [], { routingText: 'build the app' });
    expect(routed.type).toBe('groq');
    expect(routed.model).toBe('openai/gpt-oss-120b');
  });

  it('does NOT override a plain new ask with a remembered model', async () => {
    const cmd = new ChatCommand() as any;
    cmd.lastTaskSignature = 'coding|simple';
    cmd.taskContinuity.remember('coding|simple', 'groq', 'openai/gpt-oss-120b');

    // No routingText → not a continuation → the router's own pick stands.
    const routed = await cmd.routeMessageAuto('build the app');
    expect(routed.type).toBe('gemini');
  });
});
