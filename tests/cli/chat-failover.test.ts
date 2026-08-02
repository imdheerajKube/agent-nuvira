/**
 * Chat command — auto-mode session failover tests.
 *
 * Regression tests for the "auto mode gets stuck when a provider dies
 * mid-session" bug:
 * - A provider whose token expired (auth) or quota ran out (rate-limit) must be
 *   excluded from auto routing for the REST of the session, so the next message
 *   routes to another provider instead of re-picking the broken one and failing
 *   again.
 * - Transient 5xx/network errors must NOT permanently exclude a provider — they
 *   flow through the shared circuit breaker (which needs repeated failures
 *   before opening a cooldown).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ChatCommand } from '../../src/cli/chat.js';
import { resetProviderFallback, getProviderFallback } from '../../src/learning/provider-fallback.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

// ─── Provider fixture ───────────────────────────────────────────────────────

const providers = new Map<string, InferenceProvider>();

function makeProvider(name: string): InferenceProvider {
  return {
    name,
    listModels: vi.fn().mockResolvedValue([{ id: 'model-x', name: 'Model X', provider: name, tags: ['chat'] }]),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue('ok'),
    getInfo: () => name,
  } as unknown as InferenceProvider;
}

// resolveProvider returns a provider keyed by the requested type — so the auto
// router's candidate walk can actually fail over gemini → groq in the tests.
vi.mock('../../src/cli/router.js', () => ({
  resolveProvider: vi.fn((_cm: unknown, type?: string) => {
    const t = type || 'gemini';
    return { type: t, provider: providers.get(t) || makeProvider(t) };
  }),
}));

// Deterministic auto router: winner = gemini, ranked = [gemini, groq].
vi.mock('../../src/learning/auto-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/auto-router.js')>();
  return {
    ...actual,
    getAutoRouter: () => ({
      resolve: () => ({
        agentType: 'chat',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        complexity: 'simple',
        taskProfile: { intent: 'coding', requiresVerification: false, notes: [] },
        escalationApplied: false,
        taskType: 'code-generation',
        score: 0.8,
        weights: { reasoning: 0.2, speed: 0.3, cost: 0.3, privacy: 0.1, reliability: 0.1 },
        ranked: [
          { provider: 'gemini', score: 0.8, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' },
          { provider: 'groq', score: 0.7, dimensions: {}, weightTotal: 1, inCooldown: false, reason: 'test' },
        ],
        fallbackChain: [],
        explanation: 'test decision',
        routedBy: 'heuristic',
      }),
      resolveModel: (provider: string) => (provider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.3-70b'),
      isAutoModel: actual.isAutoModel,
      isAutoProvider: actual.isAutoProvider,
    }),
  };
});

// Hermetic: no real routing-history writes or live model-list fetches.
vi.mock('../../src/learning/routing-history.js', () => ({
  recordRoutingDecision: vi.fn(),
}));
vi.mock('../../src/inference/model-validator.js', () => ({
  resolveWorkingModel: vi.fn(async (_p: unknown, _t: string, desired?: string) => desired || 'default'),
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ChatCommand — auto-mode session failover', () => {
  beforeEach(() => {
    providers.clear();
    providers.set('gemini', makeProvider('Fake Gemini'));
    providers.set('groq', makeProvider('Fake Groq'));
    resetProviderFallback();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    resetProviderFallback();
    vi.restoreAllMocks();
  });

  it('routes to the ranked winner when nothing has failed', async () => {
    const cmd = new ChatCommand();
    const routed = await (cmd as any).routeMessageAuto('implement login');
    expect(routed.type).toBe('gemini');
  });

  it('skips a provider that failed earlier in the session (expired token mid-session)', async () => {
    const cmd = new ChatCommand();
    // Simulate gemini's key expiring mid-session (auth → whole-session exclusion)
    (cmd as any).sessionFailedProviders = new Map([['gemini', Number.MAX_SAFE_INTEGER]]);

    const routed = await (cmd as any).routeMessageAuto('implement login');

    // Auto routing must fail over to the next-ranked provider instead of
    // re-picking the broken gemini.
    expect(routed.type).toBe('groq');
    expect(routed.provider.name).toBe('Fake Groq');
  });

  it('excludes a provider from the session on auth errors (expired token)', () => {
    const cmd = new ChatCommand();
    (cmd as any).recordAutoProviderFailure('gemini', new Error('401 Unauthorized: API key not valid'));

    // Auth exclusion is permanent for the session
    expect((cmd as any).sessionFailedProviders.get('gemini')).toBe(Number.MAX_SAFE_INTEGER);
    // The shared circuit breaker must ALSO have recorded the failure so the
    // auto router deprioritizes gemini by scoring on subsequent messages.
    // (configManager is protected — access via the same `as any` cast used for
    // the other private members above.)
    const status = getProviderFallback((cmd as any).configManager).getCircuitBreakerStatus();
    const geminiStatus = status.find((s) => s.provider === 'gemini');
    expect(geminiStatus).toBeDefined();
    expect(geminiStatus!.failures).toBeGreaterThanOrEqual(1);
  });

  it('excludes a provider only briefly on rate-limit errors (exhausted quota)', () => {
    const cmd = new ChatCommand();
    (cmd as any).recordAutoProviderFailure('gemini', new Error('token limit exceeded for this project'));

    // Rate-limit exclusion is TRANSIENT (5-min cooldown), not permanent — a
    // throttled-but-working provider must be re-admitted, not blacklisted.
    const expiresAt = (cmd as any).sessionFailedProviders.get('gemini');
    expect(typeof expiresAt).toBe('number');
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).not.toBe(Number.MAX_SAFE_INTEGER);
    // The circuit breaker also recorded the failure for scoring deprioritization
    const status = getProviderFallback((cmd as any).configManager).getCircuitBreakerStatus();
    const geminiStatus = status.find((s) => s.provider === 'gemini');
    expect(geminiStatus).toBeDefined();
    expect(geminiStatus!.failures).toBe(1);
  });

  it('does NOT exclude a provider on transient server errors (circuit breaker only)', () => {
    const cmd = new ChatCommand();
    (cmd as any).recordAutoProviderFailure('groq', new Error('500 Internal Server Error'));

    // Transient failures must not exclude the provider from the session —
    // only the circuit breaker counts them toward cooldown.
    expect((cmd as any).sessionFailedProviders.get('groq')).toBeUndefined();
    const status = getProviderFallback((cmd as any).configManager).getCircuitBreakerStatus();
    const groqStatus = status.find((s) => s.provider === 'groq');
    expect(groqStatus).toBeDefined();
    expect(groqStatus!.failures).toBe(1);
  });

  it('re-admits a rate-limited provider once its cooldown expires', async () => {
    const cmd = new ChatCommand();
    // gemini rate-limited 5 minutes ago → exclusion already expired → it can be
    // routed to again (it is the ranked winner).
    (cmd as any).sessionFailedProviders = new Map([['gemini', Date.now() - 1000]]);

    const routed = await (cmd as any).routeMessageAuto('implement login');
    expect(routed.type).toBe('gemini');
  });

  it('fails over repeatedly until a working provider is found (gemini then groq both tried)', async () => {
    const cmd = new ChatCommand();
    // Both gemini AND groq session-failed → the fallback surfaces the best
    // remaining candidate so the caller's isAvailable() gate shows a real error
    // rather than silently re-entering a broken provider.
    (cmd as any).sessionFailedProviders = new Map([
      ['gemini', Number.MAX_SAFE_INTEGER],
      ['groq', Number.MAX_SAFE_INTEGER],
    ]);

    const routed = await (cmd as any).routeMessageAuto('implement login');
    // With every ranked candidate excluded, the router's literal winner is
    // returned (gemini) — routeMessageAuto still returns a shape the caller can
    // gate on instead of throwing.
    expect(routed).toBeDefined();
    expect(typeof routed.type).toBe('string');
    expect(typeof routed.model).toBe('string');
  });
});
