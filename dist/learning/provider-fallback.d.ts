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
 * Write a failed real LLM call through to the Model Availability Registry so
 * EVERY routing path learns predictively — not just chat's auto-router:
 * execute/orchestrator and the fallback-based commands (plan / skill / learn /
 * edit) all feed the SAME store, so a provider that dies in one action is
 * skipped predictively by every other action on the next pick.
 *
 * - A model-not-found error (404 / "does not exist") is a DEFINITIVE no:
 *   classifyFallbackError buckets it as 'unknown' (transient), but a model
 *   that doesn't exist will never come back — mark it `unavailable` so the
 *   registry refuses to resurrect it across sessions.
 * - auth/rate-limit flip the entry to `unavailable` (rate-limit also parks it
 *   until the reset window), which `getBlockedProviders()` feeds back into
 *   routing as a predictive skip.
 * - transient (server/network/timeout/unknown) just decays the health score.
 *
 * Best-effort: never throws, so telemetry can never break a call or failover.
 *
 * @param providerType The provider id that failed (e.g. 'gemini').
 * @param model        The model that was attempted (defaults to 'default').
 * @param err          The failure (classified when errorType is omitted).
 * @param errorType    Optional pre-classified error type (avoids re-classifying).
 * @param action       The action that hit the failure (chat / execute / plan /
 *   edit / ...) — attributed in the per-action "learned from real usage" log.
 *   Omitted → health still updates, but no dashboard panel row is written.
 */
/**
 * Resolve the telemetry action tag for a registry write, honoring the
 * BUFF_TELEMETRY_ACTION env override.
 *
 * The VS Code extension spawns the CLI as a subprocess (`buff chat` /
 * `buff execute` / ...) and sets this env var at each spawn site, so IDE usage
 * is attributed to its own action tags (ide-chat / ide-inline / ide-execute)
 * instead of blending into terminal-driven usage in the per-action
 * "learned from real usage" log. When unset, the caller's explicit action tag
 * is used unchanged — the CLI's own calls keep their natural actions.
 *
 * NOTE: the override applies PROCESS-WIDE — every registry write from the
 * spawned CLI inherits the spawning action's tag, even writes that would
 * otherwise carry a different tag (e.g. a chat session that enters
 * developer-mode runs the orchestrator, whose `execute` writes get attributed
 * to the spawning `ide-chat`). That is deliberate: the whole subprocess is one
 * IDE action, and splitting it would fragment the per-action telemetry.
 *
 * @param defaultAction The action tag the caller intended (chat / execute /
 *   plan / ...), used when the env override is absent.
 * @returns The effective action tag (never an empty string — a blank override
 *   falls back to the caller's tag).
 */
export declare function resolveTelemetryAction(defaultAction?: string): string | undefined;
export declare function recordRegistryFailure(providerType: string, model: string | undefined, err: unknown, errorType?: FallbackErrorType, action?: string, latencyMs?: number): void;
/**
 * Write a successful real LLM call through to the Model Availability Registry
 * WITH its action tag, so the per-action "learned from real usage" telemetry
 * panel shows which action VERIFIED which provider × model (the mirror of
 * recordRegistryFailure). Success upgrades the entry to `verified` and proves
 * the combo works — the feed that populates getUsableProviders() over time.
 *
 * Best-effort: never throws, so telemetry can never break a call.
 *
 * @param providerType The provider id that succeeded (e.g. 'groq').
 * @param model        The model that was used (defaults to 'default').
 * @param action       The action that succeeded (chat / execute / plan / edit /
 *   ...) — attributed in the per-action log. Omitted → health still updates,
 *   but no dashboard panel row is written.
 */
export declare function recordRegistrySuccess(providerType: string, model: string | undefined, action?: string, latencyMs?: number): void;
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
     * Resolve the configured model for a provider ('' when none / config error).
     * Used by the Model Registry write-through on failure.
     */
    private resolveConfiguredModel;
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
     *
     * Public so auto-routing (chat's per-message failover) can feed the SAME
     * circuit breaker the fallback engine uses — repeated failures open the
     * breaker and the auto router deprioritizes/excludes in-cooldown providers.
     */
    recordFailure(providerType: string): void;
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