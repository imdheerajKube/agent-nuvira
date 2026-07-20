/**
 * ProviderFallback — Automatic provider failover routing with circuit breaker.
 *
 * Features:
 * 1. Prioritized fallback chain (user-configurable)
 * 2. Circuit breaker — temporarily marks failed providers as unavailable
 * 3. Automatic retry with next provider on auth/rate-limit/server/network errors
 * 4. Transparent logging of which provider was used
 * 5. Per-session failure tracking
 *
 * Usage:
 *   const fallback = new ProviderFallback(configManager);
 *   const result = await fallback.callWithFallback(
 *     'groq',
 *     (provider) => provider.generate(prompt, options),
 *     { context: 'chat', label: 'Generate response' },
 *   );
 *   // On failure, automatically tries nim → gemini → openrouter → local
 *   // Returns { response, provider: 'gemini', model: '...', attempts: 2 }
 */

import { ProviderFactory } from '../inference/factory.js';
import { InferenceProvider } from '../inference/interface.js';
import { ProviderType } from '../config/types.js';
import type { ConfigManager } from '../config/manager.js';
import { getPluginRegistry } from '../plugins/registry.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for provider fallback behavior */
export interface ProviderFallbackConfig {
  /** Whether automatic fallback is enabled (default: true) */
  enabled: boolean;
  /** Prioritized list of fallback providers to try if primary fails */
  providers: string[];
  /** Max providers to try before giving up (default: 3) */
  maxAttempts: number;
  /** Milliseconds to wait before retrying a failed provider (default: 1000) */
  retryDelayMs: number;
}

/** Result from a fallback call */
export interface FallbackResult {
  /** The response from the successful provider */
  response: string;
  /** The provider type that succeeded */
  provider: string;
  /** The model used */
  model?: string;
  /** Number of providers attempted before success */
  attempts: number;
  /** All providers that were attempted (successful one is last) */
  attemptsMade: Array<{ provider: string; error?: string; duration: number }>;
  /** Total elapsed time in ms */
  totalDuration: number;
}

/** Internal circuit breaker state for a single provider */
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  /** Prevent retrying this provider for this many ms after failure */
  cooldownUntil: number;
}

/** Error categories for deciding what's retryable */
export type FallbackErrorType = 'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'unknown';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_FALLBACK_CHAIN: string[] = ['groq', 'nim', 'gemini', 'openrouter', 'local'];

const DEFAULT_FALLBACK_CONFIG: ProviderFallbackConfig = {
  enabled: true,
  providers: DEFAULT_FALLBACK_CHAIN,
  maxAttempts: 3,
  retryDelayMs: 1000,
};

/** Circuit breaker: after 3 failures in 60s, cooldown for 120s */
const MAX_FAILURES_BEFORE_COOLDOWN = 3;
const COOLDOWN_WINDOW_MS = 60_000;
const COOLDOWN_DURATION_MS = 120_000;

// ─── Error Classification ───────────────────────────────────────────────────

/**
 * Classify an error to determine if fallback is appropriate.
 * Auth and unknown errors are NOT automatically retried (they'd fail on all providers).
 * Rate-limit, server, network, and timeout errors ARE retried on other providers.
 */
export function classifyFallbackError(err: unknown): FallbackErrorType {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key') || lower.includes('auth')) {
    return 'auth';
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota exceeded') || lower.includes('rate_limit')) {
    return 'rate-limit';
  }
  if (lower.includes('500') || lower.includes('502') || lower.includes('503') || lower.includes('server error') || lower.includes('internal server')) {
    return 'server';
  }
  if (lower.includes('fetch failed') || lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('econnreset') || lower.includes('enotempty') || lower.includes('network') || lower.includes('eai_again')) {
    return 'network';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout';
  }
  return 'unknown';
}

/**
 * Check if an error type is retryable on a *different* provider.
 * Auth errors won't help by switching (all providers need valid keys).
 * Unknown errors might or might not — we try anyway since we're failing over.
 */
export function isRetryableError(errorType: FallbackErrorType): boolean {
  return errorType !== 'auth';
}

// ─── Provider Fallback Engine ───────────────────────────────────────────────

/**
 * ProviderFallback — Automatic provider failover with circuit breaker.
 *
 * This class manages:
 * - A prioritized fallback chain of providers
 * - Per-provider circuit breakers to avoid repeatedly hammering failed providers
 * - Session-level failure tracking
 * - Transparent logging of fallback decisions
 */
export class ProviderFallback {
  private configManager: ConfigManager;
  private fallbackConfig: ProviderFallbackConfig;
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private providerCache: Map<string, { provider: InferenceProvider; expiresAt: number }> = new Map();
  private pluginProviderCache: string[] | null = null;

  constructor(
    configManager: ConfigManager,
    overrides?: Partial<ProviderFallbackConfig>,
  ) {
    this.configManager = configManager;
    this.fallbackConfig = { ...DEFAULT_FALLBACK_CONFIG, ...overrides };
  }

  /**
   * Get the effective fallback chain (ordered list of provider types to try).
   * Merges user config with defaults and excludes providers in cooldown.
   */
  getFallbackChain(primaryProvider?: string): string[] {
    const configured = this.fallbackConfig.providers;
    const allProviders = new Set<string>();

    // Primary is first if specified
    if (primaryProvider) {
      allProviders.add(primaryProvider);
    }

    // Add configured chain (excluding primary to avoid duplicates)
    for (const p of configured) {
      allProviders.add(p);
    }

    // Add any plugin providers
    for (const p of this.getPluginProviderTypes()) {
      allProviders.add(p);
    }

    // Build the ordered chain: primary → configured chain order → plugins
    const chain: string[] = [];
    const added = new Set<string>();

    if (primaryProvider && !added.has(primaryProvider)) {
      chain.push(primaryProvider);
      added.add(primaryProvider);
    }

    for (const p of configured) {
      if (!added.has(p)) {
        chain.push(p);
        added.add(p);
      }
    }

    for (const p of this.getPluginProviderTypes()) {
      if (!added.has(p)) {
        chain.push(p);
        added.add(p);
      }
    }

    // Exclude providers currently in cooldown
    const now = Date.now();
    return chain.filter((p) => {
      const cb = this.circuitBreakers.get(p);
      if (cb && now < cb.cooldownUntil) {
        logger.debug(`  🔒 ${p} in cooldown (${((cb.cooldownUntil - now) / 1000).toFixed(0)}s remaining)`);
        return false;
      }
      return true;
    });
  }

  /**
   * Get or create an InferenceProvider instance, cached for 60s.
   */
  private getProvider(providerType: string): InferenceProvider | null {
    const cacheKey = providerType;

    // Check cache
    const cached = this.providerCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.provider;
    }

    try {
      const { config } = this.configManager.getProviderConfig(providerType as ProviderType);
      const provider = ProviderFactory.createProvider(providerType, config);
      this.providerCache.set(cacheKey, { provider, expiresAt: Date.now() + 60_000 });
      return provider;
    } catch (err) {
      logger.debug(`  ⚠️  Failed to create provider ${providerType}: ${err}`);
      return null;
    }
  }

  /**
   * Call a provider with automatic fallback.
   *
   * @param primaryProvider - The preferred provider type to try first
   * @param callFn - Async function that calls the provider (e.g., provider.generate)
   * @param options
   * @returns FallbackResult with the successful response
   * @throws Error if all providers fail or fallback is disabled
   */
  async callWithFallback(
    primaryProvider: string | undefined,
    callFn: (provider: InferenceProvider, providerType: string) => Promise<string>,
    options?: { context?: string; label?: string },
  ): Promise<FallbackResult> {
    const startTime = Date.now();
    const chain = this.getFallbackChain(primaryProvider);
    const maxAttempts = this.fallbackConfig.maxAttempts;
    const attemptsMade: Array<{ provider: string; error?: string; duration: number }> = [];

    // Check if fallback is enabled
    const isEnabled = this.fallbackConfig.enabled;

    if (!isEnabled) {
      // Fallback disabled — just try the primary
      const primary = chain[0] || primaryProvider || 'groq';
      const provider = this.getProvider(primary);
      if (!provider) {
        throw new Error(`Provider '${primary}' could not be created and fallback is disabled`);
      }

      const t0 = Date.now();
      try {
        const response = await callFn(provider, primary);
        return {
          response,
          provider: primary,
          attempts: 1,
          attemptsMade: [{ provider: primary, duration: Date.now() - t0 }],
          totalDuration: Date.now() - startTime,
        };
      } catch (err) {
        throw err; // Let it propagate — no fallback
      }
    }

    // Try each provider in the chain
    for (let i = 0; i < Math.min(chain.length, maxAttempts); i++) {
      const pt = chain[i];
      const provider = this.getProvider(pt);

      if (!provider) {
        attemptsMade.push({ provider: pt, error: 'Could not create provider instance', duration: 0 });
        continue;
      }

      // Note: we skip isAvailable() pre-check to avoid extra latency.
      // The actual callFn will fail fast if the provider is down.
      const t0 = Date.now();
      try {
        const response = await callFn(provider, pt);
        const duration = Date.now() - t0;

        // Success — reset circuit breaker for this provider
        this.circuitBreakers.delete(pt);

        logger.success(`  ✅ ${options?.label || 'Call'} succeeded on ${pt} (${duration}ms)`);

        return {
          response,
          provider: pt,
          attempts: i + 1,
          attemptsMade: [...attemptsMade, { provider: pt, duration }],
          totalDuration: Date.now() - startTime,
        };
      } catch (err) {
        const duration = Date.now() - t0;
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorType = classifyFallbackError(err);

        // Track failure in circuit breaker
        this.recordFailure(pt);

        attemptsMade.push({ provider: pt, error: errorMsg.slice(0, 200), duration });

        if (!isRetryableError(errorType)) {
          // Auth errors and similar — don't retry on other providers
          logger.error(`  ❌ ${pt}: ${errorType} error (not retryable) — ${errorMsg.slice(0, 100)}`);
          throw err;
        }

        // If this is the last attempt, throw
        if (i >= Math.min(chain.length, maxAttempts) - 1) {
          logger.error(`  ❌ All ${i + 1} provider(s) exhausted`);
          throw new Error(
            `All providers exhausted after ${i + 1} attempts:\n` +
            attemptsMade.map((a) => `  ${a.provider}: ${a.error || 'ok'}`).join('\n'),
          );
        }

        // Wait before retrying (for rate-limit errors, wait longer)
        const delay = errorType === 'rate-limit'
          ? this.fallbackConfig.retryDelayMs * 3
          : this.fallbackConfig.retryDelayMs;

        logger.warn(`  ⚠️  ${pt} failed (${errorType}): ${errorMsg.slice(0, 80)} — trying next in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should not reach here, but just in case
    throw new Error(
      `Provider fallback exhausted after ${attemptsMade.length} attempt(s)` +
      (attemptsMade.length > 0 ? `: last error: ${attemptsMade[attemptsMade.length - 1].error}` : ''),
    );
  }

  /**
   * Record a provider failure in the circuit breaker.
   */
  private recordFailure(providerType: string): void {
    const now = Date.now();
    let state = this.circuitBreakers.get(providerType);

    if (!state || now - state.lastFailure > COOLDOWN_WINDOW_MS) {
      // Reset counter if outside the cooldown window
      state = { failures: 1, lastFailure: now, cooldownUntil: 0 };
    } else {
      state.failures++;
      state.lastFailure = now;
    }

    // If too many failures, activate cooldown
    if (state.failures >= MAX_FAILURES_BEFORE_COOLDOWN) {
      state.cooldownUntil = now + COOLDOWN_DURATION_MS;
      logger.warn(`  🔒 Circuit breaker opened for ${providerType} — cooling down for ${COOLDOWN_DURATION_MS / 1000}s`);
      state.failures = 0; // Reset counter after opening
    }

    this.circuitBreakers.set(providerType, state);
  }

  /**
   * Reset circuit breaker for a specific provider (user explicitly configured it).
   */
  resetCircuitBreaker(providerType?: string): void {
    if (providerType) {
      this.circuitBreakers.delete(providerType);
    } else {
      this.circuitBreakers.clear();
    }
  }

  /**
   * Get circuit breaker status for all providers.
   */
  getCircuitBreakerStatus(): Array<{ provider: string; failures: number; cooldownRemaining: number }> {
    const now = Date.now();
    const status: Array<{ provider: string; failures: number; cooldownRemaining: number }> = [];

    for (const [provider, state] of this.circuitBreakers) {
      status.push({
        provider,
        failures: state.failures,
        cooldownRemaining: Math.max(0, state.cooldownUntil - now),
      });
    }

    return status;
  }

  /**
   * Update fallback configuration.
   */
  updateConfig(overrides: Partial<ProviderFallbackConfig>): void {
    this.fallbackConfig = { ...this.fallbackConfig, ...overrides };
  }

  /**
   * Get current config.
   */
  getConfig(): ProviderFallbackConfig {
    return { ...this.fallbackConfig };
  }

  /**
   * Get plugin provider types (cached).
   */
  private getPluginProviderTypes(): string[] {
    if (this.pluginProviderCache === null) {
      const registry = getPluginRegistry();
      this.pluginProviderCache = registry.getAllPlugins().map((p) => p.getProviderType());
    }
    return this.pluginProviderCache;
  }

  /**
   * Invalidate caches (e.g., after plugin discovery).
   */
  invalidateCaches(): void {
    this.providerCache.clear();
    this.pluginProviderCache = null;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let fallbackInstance: ProviderFallback | null = null;

/**
 * Get or create the ProviderFallback singleton.
 *
 * If an instance already exists and `overrides` are provided,
 * they are applied via `updateConfig()` so the singleton stays current.
 */
export function getProviderFallback(
  configManager?: ConfigManager,
  overrides?: Partial<ProviderFallbackConfig>,
): ProviderFallback {
  if (!fallbackInstance) {
    if (!configManager) {
      throw new Error('ProviderFallback not initialized. Call getProviderFallback(configManager) first.');
    }
    fallbackInstance = new ProviderFallback(configManager, overrides);
  } else if (overrides) {
    // Apply overrides to existing instance so singleton stays current
    fallbackInstance.updateConfig(overrides);
  }
  return fallbackInstance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetProviderFallback(): void {
  fallbackInstance = null;
}
