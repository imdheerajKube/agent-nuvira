/**
 * ProviderFallback — Unit tests for the automatic provider failover engine.
 *
 * Covers:
 * 1. classifyFallbackError — all 6 error types
 * 2. isRetryableError — auth vs non-auth
 * 3. getFallbackChain — ordering, dedup, cooldown, plugins
 * 4. callWithFallback — success, fallback, all fail, disabled, auth error
 * 5. Circuit breaker — threshold, cooldown, reset
 * 6. updateConfig / getConfig
 * 7. Singleton pattern
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  classifyFallbackError,
  isRetryableError,
  ProviderFallback,
  getProviderFallback,
  resetProviderFallback,
  type ProviderFallbackConfig,
  type FallbackResult,
} from '../../src/learning/provider-fallback.js';
import type { InferenceProvider } from '../../src/inference/interface.js';
import type { ConfigManager } from '../../src/config/manager.js';
import type { ProviderType } from '../../src/config/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockConfigManager = vi.hoisted(() => ({
  getProviderConfig: vi.fn().mockReturnValue({ type: 'groq', config: { model: 'test-model' } }),
  hasRequiredCredentials: vi.fn().mockReturnValue(true),
  getAll: vi.fn().mockReturnValue({
    defaultProvider: 'groq',
    providers: {
      groq: { model: 'llama-3.3-70b-versatile' },
      nim: { model: 'meta/llama-3.1-8b-instruct' },
      gemini: { model: 'gemini-2.0-flash-exp' },
      openrouter: { model: 'mistralai/mistral-7b-instruct' },
      local: { model: 'llama2' },
    },
    fallback: { enabled: true, providers: ['groq', 'nim', 'gemini', 'openrouter', 'local'], maxAttempts: 3, retryDelayMs: 1 },
  }),
}));

vi.mock('../../src/inference/factory.js', () => ({
  ProviderFactory: {
    createProvider: vi.fn((type: string) => ({
      name: type.charAt(0).toUpperCase() + type.slice(1),
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn().mockResolvedValue(`response from ${type}`),
      generateStream: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      getInfo: vi.fn().mockReturnValue('Mock info'),
    })),
  },
}));

vi.mock('../../src/plugins/registry.js', () => ({
  getPluginRegistry: vi.fn(() => ({
    getAllPlugins: vi.fn().mockReturnValue([
      { metadata: { name: 'Custom AI', version: '1.0.0', description: '' }, getProviderType: () => 'custom-ai', createProvider: vi.fn() },
    ]),
    hasPlugin: vi.fn().mockReturnValue(false),
    getPlugin: vi.fn().mockReturnValue(undefined),
    register: vi.fn(),
    unregister: vi.fn(),
    createProviderFromPlugin: vi.fn(),
    listPlugins: vi.fn().mockReturnValue([]),
  })),
}));

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Create a controlled mock InferenceProvider */
function createMockProvider(name: string, overrides: Partial<InferenceProvider> = {}): InferenceProvider {
  return {
    name: overrides.name || name,
    isAvailable: overrides.isAvailable || vi.fn().mockResolvedValue(true),
    generate: overrides.generate || vi.fn().mockResolvedValue(`response from ${name}`),
    generateStream: overrides.generateStream as any || vi.fn(),
    listModels: overrides.listModels || vi.fn().mockResolvedValue([]),
    getInfo: overrides.getInfo || vi.fn().mockReturnValue('Mock info'),
  } as InferenceProvider;
}

// ─── classifyFallbackError ──────────────────────────────────────────────────

describe('classifyFallbackError', () => {
  it.each([
    [new Error('401 Unauthorized'), 'auth'],
    [new Error('403 Forbidden'), 'auth'],
    ['unauthorized access', 'auth'],
    ['forbidden: access denied', 'auth'],
    ['invalid API key provided', 'auth'],
    ['authentication failed', 'auth'],
  ])('detects auth error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it.each([
    [new Error('429 Too Many Requests'), 'rate-limit'],
    [new Error('rate limit exceeded'), 'rate-limit'],
    ['too many requests, try again later', 'rate-limit'],
    ['quota exceeded for API calls', 'rate-limit'],
    ['rate_limit hit on endpoint', 'rate-limit'],
  ])('detects rate-limit error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it.each([
    [new Error('500 Internal Server Error'), 'server'],
    [new Error('502 Bad Gateway'), 'server'],
    ['503 Service Unavailable', 'server'],
    ['server error occurred', 'server'],
    ['internal server error', 'server'],
  ])('detects server error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it.each([
    [new Error('fetch failed'), 'network'],
    [new Error('econnrefused'), 'network'],
    ['enotfound: DNS resolution failed', 'network'],
    ['econnreset by peer', 'network'],
    ['network error occurred', 'network'],
    ['eai_again: temporary name resolution failure', 'network'],
  ])('detects network error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it.each([
    [new Error('timeout exceeded'), 'timeout'],
    ['request timed out after 30s', 'timeout'],
    ['timed out waiting for response', 'timeout'],
  ])('detects timeout error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it.each([
    [new Error('Something unexpected happened'), 'unknown'],
    [new Error(''), 'unknown'],
    ['random string without keywords', 'unknown'],
  ])('detects unknown error from: "%s"', (err, expected) => {
    expect(classifyFallbackError(err)).toBe(expected);
  });

  it('handles non-Error objects', () => {
    expect(classifyFallbackError('string error')).toBe('unknown');
    expect(classifyFallbackError(null)).toBe('unknown');
    expect(classifyFallbackError(undefined)).toBe('unknown');
    expect(classifyFallbackError(42)).toBe('unknown');
    expect(classifyFallbackError({ custom: 'error' })).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyFallbackError('RATE LIMIT EXCEEDED')).toBe('rate-limit');
    expect(classifyFallbackError('API KEY INVALID')).toBe('auth');
    expect(classifyFallbackError('SERVER ERROR')).toBe('server');
    expect(classifyFallbackError('FETCH FAILED')).toBe('network');
    expect(classifyFallbackError('TIMEOUT')).toBe('timeout');
  });

  it('prioritizes auth over other error types when multiple match', () => {
    // Auth keywords should win
    expect(classifyFallbackError('401 rate limit server timeout')).toBe('auth');
  });

  it('prioritizes rate-limit over server/network when auth does not match', () => {
    expect(classifyFallbackError('429 server error network timeout')).toBe('rate-limit');
  });
});

// ─── isRetryableError ───────────────────────────────────────────────────────

describe('isRetryableError', () => {
  it('returns false for auth errors', () => {
    expect(isRetryableError('auth')).toBe(false);
  });

  it.each(['rate-limit', 'server', 'network', 'timeout', 'unknown'])(
    'returns true for %s errors',
    (type) => {
      expect(isRetryableError(type as any)).toBe(true);
    },
  );
});

// ─── ProviderFallback class ─────────────────────────────────────────────────

describe('ProviderFallback', () => {
  let fallback: ProviderFallback;

  beforeEach(() => {
    vi.clearAllMocks();
    fallback = new ProviderFallback(mockConfigManager as unknown as ConfigManager, { retryDelayMs: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getFallbackChain ────────────────────────────────────────────────────

  describe('getFallbackChain', () => {
    it('places primary provider first in the chain', () => {
      const chain = fallback.getFallbackChain('gemini');
      expect(chain[0]).toBe('gemini');
    });

    it('includes configured fallback providers after primary', () => {
      const chain = fallback.getFallbackChain('groq');
      expect(chain).toContain('groq');
      expect(chain).toContain('nim');
      expect(chain).toContain('gemini');
      expect(chain).toContain('openrouter');
      expect(chain).toContain('local');
    });

    it('does not duplicate primary provider in the chain', () => {
      const chain = fallback.getFallbackChain('groq');
      const groqCount = chain.filter((p) => p === 'groq').length;
      expect(groqCount).toBe(1);
    });

    it('includes plugin providers at the end of the chain', () => {
      const chain = fallback.getFallbackChain('groq');
      expect(chain).toContain('custom-ai');
      // Plugin providers should be after built-in providers
      const customAiIndex = chain.indexOf('custom-ai');
      const groqIndex = chain.indexOf('groq');
      expect(customAiIndex).toBeGreaterThan(groqIndex);
    });

    it('excludes providers in cooldown', () => {
      // Manually add a circuit breaker state with active cooldown
      (fallback as any).circuitBreakers.set('groq', {
        failures: 3,
        lastFailure: Date.now(),
        cooldownUntil: Date.now() + 60_000, // Active cooldown
      });

      const chain = fallback.getFallbackChain('groq');
      expect(chain).not.toContain('groq');
      // Should still have other providers
      expect(chain).toContain('nim');
      expect(chain).toContain('gemini');
    });

    it('includes providers whose cooldown has expired', () => {
      (fallback as any).circuitBreakers.set('groq', {
        failures: 3,
        lastFailure: Date.now() - 120_001,
        cooldownUntil: Date.now() - 1000, // Cooldown expired 1s ago
      });

      const chain = fallback.getFallbackChain('groq');
      expect(chain).toContain('groq');
    });

    it('returns empty chain when all providers are in cooldown', () => {
      for (const p of ['groq', 'nim', 'gemini', 'openrouter', 'local', 'custom-ai']) {
        (fallback as any).circuitBreakers.set(p, {
          failures: 3,
          lastFailure: Date.now(),
          cooldownUntil: Date.now() + 60_000,
        });
      }

      const chain = fallback.getFallbackChain('groq');
      expect(chain).toHaveLength(0);
    });

    it('handles empty provider config gracefully', () => {
      const emptyFallback = new ProviderFallback(
        mockConfigManager as unknown as ConfigManager,
        { providers: [] },
      );
      const chain = emptyFallback.getFallbackChain();
      // Should still include plugin providers
      expect(chain).toContain('custom-ai');
    });

    it('uses configured fallback providers order', () => {
      const ordered = new ProviderFallback(
        mockConfigManager as unknown as ConfigManager,
        { providers: ['openrouter', 'local', 'groq'] },
      );
      const chain = ordered.getFallbackChain();
      const oIndex = chain.indexOf('openrouter');
      const lIndex = chain.indexOf('local');
      const gIndex = chain.indexOf('groq');
      expect(oIndex).toBeLessThan(lIndex);
      expect(lIndex).toBeLessThan(gIndex);
    });
  });

  // ── callWithFallback ────────────────────────────────────────────────────

  describe('callWithFallback', () => {
    it('returns success when primary provider works', async () => {
      const result = await fallback.callWithFallback(
        'groq',
        async (provider) => provider.generate('test prompt', {}),
      );

      expect(result.response).toBeTruthy();
      expect(result.provider).toBe('groq');
      expect(result.attempts).toBe(1);
      expect(result.attemptsMade).toHaveLength(1);
    });

    it('falls back to next provider when primary fails', async () => {
      // Override the primary to fail
      const provider = createMockProvider('Groq', {
        generate: vi.fn().mockRejectedValue(new Error('429 Rate limited')),
      });
      (fallback as any).getProvider = vi.fn().mockImplementation((type: string) => {
        if (type === 'groq') return provider;
        return createMockProvider(type, {
          generate: vi.fn().mockResolvedValue(`response from ${type}`),
        });
      });

      const result = await fallback.callWithFallback(
        'groq',
        async (p, type) => p.generate('test', {}),
      );

      expect(result.response).toBeTruthy();
      expect(result.attempts).toBeGreaterThan(1);
      expect(result.attemptsMade.length).toBeGreaterThanOrEqual(2);
    });

    it('throws when all providers fail', async () => {
      (fallback as any).getProvider = vi.fn().mockImplementation((type: string) => {
        const provider = createMockProvider(type, {
          generate: vi.fn().mockRejectedValue(new Error('Server error')),
        });
        return provider;
      });

      await expect(
        fallback.callWithFallback('groq', async (p, type) => p.generate('test', {})),
      ).rejects.toThrow('All providers exhausted');
    });

    it('does not retry on auth errors (throws immediately)', async () => {
      const provider = createMockProvider('Groq', {
        generate: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
      });
      (fallback as any).getProvider = vi.fn().mockReturnValue(provider);

      await expect(
        fallback.callWithFallback('groq', async (p, type) => p.generate('test', {})),
      ).rejects.toThrow('401 Unauthorized');
    });

    it('throws immediately when fallback is disabled', async () => {
      const disabledFallback = new ProviderFallback(
        mockConfigManager as unknown as ConfigManager,
        { enabled: false, retryDelayMs: 1 },
      );

      const result = await disabledFallback.callWithFallback(
        'groq',
        async (provider) => provider.generate('test prompt', {}),
      );

      expect(result.provider).toBe('groq');
      expect(result.attempts).toBe(1);
    });

    it('throws original error when fallback disabled and primary fails', async () => {
      const disabledFallback = new ProviderFallback(
        mockConfigManager as unknown as ConfigManager,
        { enabled: false, retryDelayMs: 1 },
      );

      const provider = createMockProvider('Groq', {
        generate: vi.fn().mockRejectedValue(new Error('Connection failed')),
      });
      (disabledFallback as any).getProvider = vi.fn().mockReturnValue(provider);

      await expect(
        disabledFallback.callWithFallback('groq', async (p, type) => p.generate('test', {})),
      ).rejects.toThrow('Connection failed');
    });

    it('skips providers that cannot be created', async () => {
      (fallback as any).getProvider = vi.fn().mockImplementation((type: string) => {
        if (type === 'groq') return null; // Cannot create groq
        const provider = createMockProvider(type, {
          generate: vi.fn().mockResolvedValue(`response from ${type}`),
        });
        return provider;
      });

      const result = await fallback.callWithFallback(
        'groq',
        async (p, type) => p.generate('test', {}),
      );

      // Should have fallen back to nim (second provider that can be created)
      expect(result.response).toBeTruthy();
      expect(result.attempts).toBeGreaterThanOrEqual(2);
    });

    it('records attempts made including errors', async () => {
      (fallback as any).getProvider = vi.fn().mockImplementation((type: string) => {
        if (type === 'groq') {
          return createMockProvider('Groq', {
            generate: vi.fn().mockRejectedValue(new Error('429 Rate limited')),
          });
        }
        return createMockProvider(type, {
          generate: vi.fn().mockResolvedValue(`response from ${type}`),
        });
      });

      const result = await fallback.callWithFallback(
        'groq',
        async (p, type) => p.generate('test', {}),
      );

      // First attempt should have error
      expect(result.attemptsMade[0].error).toContain('Rate limited');
      // Last attempt should have no error (success)
      const lastAttempt = result.attemptsMade[result.attemptsMade.length - 1];
      expect(lastAttempt.error).toBeUndefined();
    });

    it('passes the provider type to callFn', async () => {
      const callFn = vi.fn().mockResolvedValue('response');
      (fallback as any).getProvider = vi.fn().mockReturnValue(
        createMockProvider('Groq', { generate: callFn }),
      );

      await fallback.callWithFallback(
        'groq',
        async (p, type) => {
          return callFn(p, type);
        },
      );

      // callFn should have received 'groq' as second arg
      expect(callFn).toHaveBeenCalledWith(expect.anything(), 'groq');
    });
  });

  // ── Circuit Breaker ─────────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('records failures and triggers cooldown after threshold', () => {
      // Simulate 3 failures for groq
      (fallback as any).recordFailure('groq');
      (fallback as any).recordFailure('groq');
      (fallback as any).recordFailure('groq');

      const circuitBreakers = (fallback as any).circuitBreakers;
      const state = circuitBreakers.get('groq');

      expect(state).toBeDefined();
      expect(state.failures).toBe(0); // Reset after opening
      expect(state.cooldownUntil).toBeGreaterThan(Date.now());
    });

    it('resets failure count when outside cooldown window', () => {
      (fallback as any).recordFailure('groq');
      let state = (fallback as any).circuitBreakers.get('groq');
      expect(state.failures).toBe(1);

      // Manually set lastFailure to be >60s in the past to simulate expiry
      state.lastFailure = Date.now() - 61_000;
      (fallback as any).circuitBreakers.set('groq', state);

      // This failure should reset the counter since last failure was > 60s ago
      (fallback as any).recordFailure('groq');
      state = (fallback as any).circuitBreakers.get('groq');
      expect(state.failures).toBe(1); // Reset to 1, not incremented to 2
    });

    it('resetCircuitBreaker removes specific provider', () => {
      (fallback as any).recordFailure('groq');
      (fallback as any).recordFailure('nim');

      fallback.resetCircuitBreaker('groq');
      expect((fallback as any).circuitBreakers.has('groq')).toBe(false);
      expect((fallback as any).circuitBreakers.has('nim')).toBe(true);
    });

    it('resetCircuitBreaker clears all when no provider specified', () => {
      (fallback as any).recordFailure('groq');
      (fallback as any).recordFailure('nim');
      (fallback as any).recordFailure('gemini');

      fallback.resetCircuitBreaker();
      expect((fallback as any).circuitBreakers.size).toBe(0);
    });

    it('getCircuitBreakerStatus returns current state', () => {
      (fallback as any).recordFailure('groq');
      (fallback as any).recordFailure('nim');

      const status = fallback.getCircuitBreakerStatus();
      expect(status.length).toBeGreaterThanOrEqual(2);
      const groqStatus = status.find((s) => s.provider === 'groq');
      expect(groqStatus).toBeDefined();
      expect(groqStatus!.failures).toBeGreaterThanOrEqual(1);
    });
  });

  // ── updateConfig / getConfig ────────────────────────────────────────────

  describe('updateConfig / getConfig', () => {
    it('returns the config passed at construction', () => {
      const config = fallback.getConfig();
      expect(config.enabled).toBe(true);
      expect(config.providers).toContain('groq');
      expect(config.maxAttempts).toBe(3);
    });

    it('updates config when updateConfig is called', () => {
      fallback.updateConfig({ maxAttempts: 5, enabled: false });
      const config = fallback.getConfig();
      expect(config.maxAttempts).toBe(5);
      expect(config.enabled).toBe(false);
    });

    it('preserves other fields when updating one field', () => {
      fallback.updateConfig({ maxAttempts: 5 });
      const config = fallback.getConfig();
      expect(config.maxAttempts).toBe(5);
      expect(config.enabled).toBe(true); // Preserved from default
      expect(config.retryDelayMs).toBe(1); // Preserved from constructor override
    });
  });

  // ── invalidateCaches ────────────────────────────────────────────────────

  describe('invalidateCaches', () => {
    it('clears provider cache', () => {
      (fallback as any).providerCache.set('groq', { provider: {} as any, expiresAt: Date.now() + 60_000 });
      (fallback as any).pluginProviderCache = ['custom-ai'];

      fallback.invalidateCaches();

      expect((fallback as any).providerCache.size).toBe(0);
      expect((fallback as any).pluginProviderCache).toBeNull();
    });
  });
});

// ─── Singleton ──────────────────────────────────────────────────────────────

describe('singleton', () => {
  afterEach(() => {
    resetProviderFallback();
  });

  it('getProviderFallback creates an instance with configManager', () => {
    const instance = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    expect(instance).toBeInstanceOf(ProviderFallback);
  });

  it('getProviderFallback returns the same instance on repeated calls', () => {
    const a = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    const b = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    expect(a).toBe(b);
  });

  it('resetProviderFallback creates a new instance on next getProviderFallback', () => {
    const a = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    resetProviderFallback();
    const b = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    expect(a).not.toBe(b);
  });

  it('getProviderFallback applies overrides on subsequent calls', () => {
    const instance = getProviderFallback(mockConfigManager as unknown as ConfigManager);
    instance.updateConfig = vi.fn();

    getProviderFallback(mockConfigManager as unknown as ConfigManager, { maxAttempts: 5 });
    expect(instance.updateConfig).toHaveBeenCalledWith({ maxAttempts: 5 });
  });

  it('getProviderFallback throws without configManager on first call', () => {
    resetProviderFallback();
    expect(() => getProviderFallback()).toThrow('ProviderFallback not initialized');
  });

  it('throws without configManager when no instance exists', () => {
    resetProviderFallback();
    expect(() => getProviderFallback()).toThrow('ProviderFallback not initialized');
  });
});
