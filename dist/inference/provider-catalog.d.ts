/**
 * Provider Catalog — the single source of truth for every provider Agent-Nuvira
 * knows how to reach. This is a CATALOG (adapter metadata), never a selection:
 * which providers actually get routed to is decided at runtime from the user's
 * configured credentials + the Model Availability Registry (see
 * rankAvailableProviders / getDefaultAllowedProviders). A provider with no key
 * configured simply never enters the candidate pool.
 *
 * Why this exists (Issue 001): the router used to consider only the 6 built-in
 * providers (DEFAULT_AUTO_PROVIDERS), so a user who set OPENAI_API_KEY /
 * ANTHROPIC_API_KEY / MISTRAL_API_KEY etc. never saw those providers routed to.
 * The catalog makes provider discovery DYNAMIC: every catalog provider whose
 * env var (or config key) is present is a candidate, so all 17+ advertised
 * providers participate in routing, probing, and the provider list.
 *
 * Fields:
 *   - envVar           — the standard env var that carries the API key
 *   - baseUrl          — default OpenAI-compatible base URL (chat/completions)
 *   - openAICompat     — speaks the OpenAI /v1/chat/completions protocol
 *   - keyless          — no API key needed (local runners, self-hosted servers)
 *   - apiKeyHeader     — auth header name ('Authorization' = Bearer, azure = 'api-key')
 *   - capabilities     — static baseline profile (0–1; real usage data overrides)
 *   - pricing          — approximate USD per 1K tokens (configurable via pricing.*)
 *   - contextWindow    — nominal input context window (tokens), provider-level
 *
 * Prices are approximate list prices and ALWAYS overridable via
 * `nuvira config set pricing.<provider>.*`. Measured wire-token cost replaces the
 * estimate once the provider reports real usage (M2.2).
 */
export interface CatalogCapabilities {
    reasoning: number;
    speed: number;
    cost: number;
    privacy: number;
    reliability: number;
}
export interface CatalogProviderEntry {
    /** Stable provider id (used in config.providers, routing, registry). */
    id: string;
    /** Human label for UIs. */
    label: string;
    /** Terminal icon. */
    icon: string;
    /** Standard API-key env var (undefined for keyless providers). */
    envVar?: string;
    /** Default OpenAI-compatible base URL (for openAICompat providers). */
    baseUrl?: string;
    /** Speaks OpenAI /v1/chat/completions (the generic OpenAI-compat adapter). */
    openAICompat?: boolean;
    /** True when no API key is needed (reachability is still probed). */
    keyless?: boolean;
    /** Auth header name (default 'Authorization' → `Bearer <key>`). */
    apiKeyHeader?: string;
    /**
     * Extra query string appended to every request URL (Azure OpenAI needs
     * `api-version=...`). Default none.
     */
    apiVersionQuery?: string;
    /** Native adapter family when NOT openAICompat (e.g. 'anthropic'). */
    nativeAdapter?: 'anthropic';
    /**
     * Azure OpenAI shape: chat lives at `/openai/deployments/{model}/chat/completions`
     * (the model id IS the deployment name). The generic adapter uses this to
     * build correct request URLs.
     */
    azureDeployments?: boolean;
    /** Static capability baseline (0–1, higher is better per dimension). */
    capabilities: CatalogCapabilities;
    /** Approximate USD per 1K tokens (input/output). */
    pricing: {
        inputPer1K: number;
        outputPer1K: number;
    };
    /** Nominal input context window (tokens), provider-level estimate. */
    contextWindow: number;
    /**
     * Curated default model for this provider — used when no model is pinned
     * and the registry has no verified models yet (cold start). This ensures
     * the auto-router NEVER sends 'default' as a model name to an API.
     */
    defaultModel: string;
}
/**
 * The catalog. Built-in providers carry their real metadata; the extended
 * providers (openai, anthropic, mistral, …) carry the metadata needed for the
 * generic OpenAI-compatible adapter / native adapters, env-var discovery,
 * routing capability scores, pricing, and context preflight.
 *
 * NOTE: the built-in capability profiles here deliberately mirror the
 * auto-router's DEFAULT_PROFILES for those ids (the catalog is the metadata
 * home; the router reads from it). Real pricing + measured tokens override the
 * static baselines at routing time.
 */
export declare const PROVIDER_CATALOG: Record<string, CatalogProviderEntry>;
/** Every catalog provider id (the full 17+ set). */
export declare const CATALOG_PROVIDER_IDS: string[];
/** Catalog providers that need no API key (reachability is probed instead). */
export declare const CATALOG_KEYLESS_IDS: string[];
/** Providers served by the generic OpenAI-compatible adapter. */
export declare const CATALOG_OPENAI_COMPAT_IDS: string[];
/** Providers served by a native (non-OpenAI-compatible) adapter. */
export declare const CATALOG_NATIVE_IDS: string[];
/**
 * Get the curated default model for a provider. Used by resolveModel() to
 * ensure it NEVER returns 'default' — every provider always resolves to a
 * real, known-working model name.
 */
export declare function getDefaultModel(providerId: string): string;
/**
 * Look up a catalog entry (undefined for unknown/plugin providers).
 * For Bedrock, the baseUrl is resolved dynamically from BEDROCK_REGION
 * (defaults to us-east-1) so the runtime always targets the correct region.
 */
export declare function getCatalogProvider(id: string): CatalogProviderEntry | undefined;
/** The standard env var for a provider's API key (undefined when keyless). */
export declare function catalogEnvVar(id: string): string | undefined;
/** True when the provider is catalog-known and keyless (no key required). */
export declare function isCatalogKeyless(id: string): boolean;
/** Capability profile for a provider (catalog baseline; undefined for unknown). */
export declare function catalogCapabilities(id: string): CatalogCapabilities | undefined;
/** Pricing table entry for a provider (approximate USD per 1K tokens). */
export declare function catalogPricing(id: string): {
    inputPer1K: number;
    outputPer1K: number;
} | undefined;
/** Nominal input context window for a provider (tokens). */
export declare function catalogContextWindow(id: string): number | undefined;
/**
 * Env vars the ConfigManager should auto-map into config.providers.<id>.apiKey.
 * Excludes keyless providers (no key to map) — they are always considered
 * configured and reachability is probed.
 */
export declare const CATALOG_ENV_VARS: Record<string, string>;
//# sourceMappingURL=provider-catalog.d.ts.map