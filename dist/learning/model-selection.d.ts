/**
 * Dynamic model selection — the single authority for "which provider/model
 * should we use right now".
 *
 * PRINCIPLE: nothing here hardcodes a provider preference order or a model
 * name. Every decision is derived at runtime from:
 *   1. the user's EXPLICIT config (pins, keys, routing.* overrides — honored
 *      by the callers, health-checked against the live lists),
 *   2. the Model Availability Registry — what probing (`nuvira models refresh`)
 *      and real usage VERIFIED actually works for THIS user, ranked by learned
 *      health (error rate, then latency),
 *   3. providers with credentials configured but nothing verified yet (cold
 *      start — the model-health validator resolves a live model on first use),
 *   4. local models (Ollama etc.) — zero-config last resort,
 *   5. onboarding guidance when nothing at all is available — never a silent
 *      hardcoded fallback into a dead provider.
 *
 * The only static data here is the BUILTIN_PROVIDERS adapter catalog (the
 * code that speaks each vendor API) and generic provider-level capability
 * metadata (nominal context windows) — a catalog, never a selection.
 */
import type { ConfigManager } from '../config/manager.js';
/** Built-in provider adapters shipped with the CLI — a catalog, not a preference. */
export declare const BUILTIN_PROVIDERS: readonly ["local", "groq", "gemini", "nim", "openrouter", "nuvira"];
/**
 * Nominal provider-level context windows (tokens), used ONLY for the soft
 * context-fit estimate. Seeded from the provider catalog (the metadata home);
 * users override per-model via `routing.contextWindows[model]` when the
 * probe's live descriptors know better.
 */
export declare const PROVIDER_CONTEXT_WINDOWS: Record<string, number>;
/**
 * Keyless providers — usable with zero configuration (reachability still
 * probed). Derived from the catalog so every keyless entry participates
 * (local, nuvira, lmstudio, vllm, ...).
 */
export declare const KEYLESS_PROVIDERS: string[];
/**
 * True when the user has the credentials to actually use this provider.
 * Keyless zero-config providers are always "configured" by definition — their
 * reachability is probed later by isAvailable(), never assumed here.
 */
export declare function hasCredentials(configManager: ConfigManager, provider: string): boolean;
/**
 * The error rate above which a model is DEPRIORITIZED (not excluded): at 0.6 it
 * fails roughly 3 times in 5, so preferring a healthier sibling is worth it —
 * but if it is the only verified option it must still be usable, because a
 * weak candidate beats no candidate.
 *
 * Observed live: routing served `groq/compound-mini` at errorRate 0.89 while
 * healthy siblings sat available, and every turn answered by it was poor or
 * failed outright.
 */
export declare const MODEL_HEALTH_CEILING = 0.6;
/**
 * Verified working models for a provider, ranked by learned health:
 * lowest error rate first, then lowest latency, then most recently verified.
 * Empty when nothing has been verified yet (cold start / no keys).
 *
 * MODELS AT/ABOVE `MODEL_HEALTH_CEILING` SORT AFTER THE HEALTHY ONES but are
 * never removed: "deprioritize, never exclude" — a burning provider you can
 * still fall back TO is worth more than a clean-looking empty pool.
 */
export declare function preferredModelsFor(provider: string): string[];
export interface RankedProvider {
    provider: string;
    /** Verified models for this provider, health-ranked (empty on cold start). */
    verifiedModels: string[];
    configured: boolean;
}
/**
 * Providers the user can actually use right now, ranked:
 *   1. providers with verified+usable models (health order),
 *   2. providers with credentials configured but nothing verified yet,
 *   3. keyless zero-config providers (local, then the optional nuvira
 *      gateway) — last resort.
 * Providers the registry has definitively blocked (all tracked models
 * unavailable/quota-parked) are excluded — routing never fails into them.
 */
export declare function rankAvailableProviders(configManager: ConfigManager): RankedProvider[];
/**
 * The default provider to use right now — always the best currently-available
 * one, never a hardcoded name. 'local' is the zero-config last resort; when
 * even local is unreachable the caller's availability gate shows guidance.
 */
export declare function resolveDefaultProvider(configManager: ConfigManager): string;
/** Capability profile for a task/agent — expressed as needs, never as names. */
export interface CapabilityProfile {
    context?: 'large' | 'medium' | 'small';
    reasoning?: 'high' | 'medium' | 'low';
    speed?: 'high' | 'medium' | 'low';
}
/**
 * Pick the best available provider + model for a capability profile.
 * Returns undefined when the user has nothing usable at all (callers surface
 * onboarding guidance instead of inventing a model).
 *
 * @param configManager Optional — when omitted, ranking is registry-only
 *   (verified models), which is what the learning layer can see without CLI
 *   config access.
 */
export declare function bestAvailable(profile: CapabilityProfile, configManager?: ConfigManager): {
    provider: string;
    model: string;
} | undefined;
/**
 * Last-resort model for an ADAPTER call when the caller didn't pass one:
 * the user's configured pin (unless it's the 'default' sentinel), else the
 * best registry-verified model for the provider, else undefined — the caller
 * gets a clear error instead of an invented name.
 */
export declare function resolveAdapterDefault(providerType: string, configuredModel?: string): string | undefined;
/**
 * Adapter last-resort model that NEVER invents a name: the configured pin,
 * else the best registry-verified model, else a clear onboarding error.
 */
export declare function requireAdapterModel(providerType: string, configuredModel?: string): string;
/** Human-readable guidance when the user has no usable provider/model configured. */
export declare function buildOnboardingGuidance(configManager: ConfigManager): string;
//# sourceMappingURL=model-selection.d.ts.map