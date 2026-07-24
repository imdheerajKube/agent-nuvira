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
import { InferenceProvider } from '../inference/interface.js';
import type { ConfigManager } from '../config/manager.js';
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
    attemptsMade: Array<{
        provider: string;
        error?: string;
        duration: number;
    }>;
    /** Total elapsed time in ms */
    totalDuration: number;
}
/** Error categories for deciding what's retryable */
export type FallbackErrorType = 'auth' | 'rate-limit' | 'server' | 'network' | 'timeout' | 'unknown';
/**
 * Classify an error to determine if fallback is appropriate.
 * Auth and unknown errors are NOT automatically retried (they'd fail on all providers).
 * Rate-limit, server, network, and timeout errors ARE retried on other providers.
 */
export declare function classifyFallbackError(err: unknown): FallbackErrorType;
/**
 * Check if an error type is retryable on a *different* provider.
 * Auth errors won't help by switching (all providers need valid keys).
 * Unknown errors might or might not — we try anyway since we're failing over.
 */
export declare function isRetryableError(errorType: FallbackErrorType): boolean;
/**
 * ProviderFallback — Automatic provider failover with circuit breaker.
 *
 * This class manages:
 * - A prioritized fallback chain of providers
 * - Per-provider circuit breakers to avoid repeatedly hammering failed providers
 * - Session-level failure tracking
 * - Transparent logging of fallback decisions
 */
export declare class ProviderFallback {
    private configManager;
    private fallbackConfig;
    private circuitBreakers;
    private providerCache;
    private pluginProviderCache;
    constructor(configManager: ConfigManager, overrides?: Partial<ProviderFallbackConfig>);
    /**
     * Get the effective fallback chain (ordered list of provider types to try).
     * Merges user config with defaults and excludes providers in cooldown.
     */
    getFallbackChain(primaryProvider?: string): string[];
    /**
     * Get or create an InferenceProvider instance, cached for 60s.
     */
    private getProvider;
    /**
     * Call a provider with automatic fallback.
     *
     * @param primaryProvider - The preferred provider type to try first
     * @param callFn - Async function that calls the provider (e.g., provider.generate)
     * @param options
     * @returns FallbackResult with the successful response
     * @throws Error if all providers fail or fallback is disabled
     */
    callWithFallback(primaryProvider: string | undefined, callFn: (provider: InferenceProvider, providerType: string) => Promise<string>, options?: {
        context?: string;
        label?: string;
    }): Promise<FallbackResult>;
    /**
     * Record a provider failure in the circuit breaker.
     */
    private recordFailure;
    /**
     * Reset circuit breaker for a specific provider (user explicitly configured it).
     */
    resetCircuitBreaker(providerType?: string): void;
    /**
     * Get circuit breaker status for all providers.
     */
    getCircuitBreakerStatus(): Array<{
        provider: string;
        failures: number;
        cooldownRemaining: number;
    }>;
    /**
     * Update fallback configuration.
     */
    updateConfig(overrides: Partial<ProviderFallbackConfig>): void;
    /**
     * Get current config.
     */
    getConfig(): ProviderFallbackConfig;
    /**
     * Get plugin provider types (cached).
     */
    private getPluginProviderTypes;
    /**
     * Invalidate caches (e.g., after plugin discovery).
     */
    invalidateCaches(): void;
}
/**
 * Get or create the ProviderFallback singleton.
 *
 * If an instance already exists and `overrides` are provided,
 * they are applied via `updateConfig()` so the singleton stays current.
 */
export declare function getProviderFallback(configManager?: ConfigManager, overrides?: Partial<ProviderFallbackConfig>): ProviderFallback;
/**
 * Reset the singleton (useful for testing).
 */
export declare function resetProviderFallback(): void;
//# sourceMappingURL=provider-fallback.d.ts.map