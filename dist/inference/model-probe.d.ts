/**
 * Model Probe — keeps the ModelRegistry fresh ("ping and gather statistics").
 *
 * Three layers, mirroring the ModelAvailabilityRegistry's feed design:
 *
 *   1. `probeProviderList()` — listModels() per provider (free). Marks every
 *      returned model as listed/unverified in the registry and confirms the
 *      provider is reachable with the configured key.
 *   2. `spotCheckModel()` — a 1-token generation against a candidate model.
 *      This is what separates "listed" from "actually usable": a configured key
 *      whose account can't purchase/access a model surfaces as 403/404 here
 *      and the registry marks it `unavailable` BEFORE routing ever picks it.
 *      Throttled so repeated refreshes don't burn the free tier.
 *   3. `refreshModelRegistry()` — orchestrates probes + spot-checks across all
 *      configured providers and writes the registry (JSON mirror + vector
 *      mirror). `watchModelRegistry()` runs it on a schedule as the standalone
 *      maintenance daemon (`nuvira models watch`).
 *
 * All providers are resolved through ProviderFactory with the user's configured
 * credentials; a missing key simply skips the provider (never throws).
 */
import type { ConfigManager } from '../config/manager.js';
import type { InferenceProvider } from './interface.js';
import { type FallbackErrorType } from '../learning/provider-fallback.js';
/**
 * Fallback provider set for the probe when nothing is configured (kept for
 * backward-compat imports). `defaultProbeProviders()` below is the DYNAMIC
 * set (Issue 001): every catalog provider the user has credentials for.
 */
export declare const PROBE_PROVIDERS: string[];
/**
 * DYNAMIC default probe set (Issue 001): every catalog provider the user can
 * actually reach — keyed providers with a real key, plus keyless providers
 * (local, nuvira, lmstudio, vllm — reachability is probed, never assumed).
 * A user who sets OPENAI_API_KEY / ANTHROPIC_API_KEY / ... gets those
 * providers probed + spot-checked automatically.
 */
export declare function defaultProbeProviders(configManager: ConfigManager): string[];
/** The one-token probe prompt — tiny, deterministic, near-free. */
export declare const SPOT_CHECK_PROMPT = "Reply with the single word: ok";
/** Minimum gap between spot-checks of the SAME model (ms) — protects free tiers. */
export declare const SPOT_CHECK_MIN_INTERVAL_MS: number;
/** Generation timeout for a spot-check (ms). */
export declare const SPOT_CHECK_TIMEOUT_MS = 20000;
/**
 * How long a 429 during a spot-check parks the model (ms). SHORT on purpose: a
 * probe has no provider reset hint, and the authoritative exclusion is the quota
 * ledger (extended by syncQuota). Long enough to back off, short enough that a
 * recovered free-tier model returns on the next pass — never `unavailable`.
 */
export declare const PROBE_RATE_LIMIT_PARK_MS: number;
/**
 * Build an inference provider for a provider type using the user's configured
 * credentials. Returns null when the type is unknown or has no key (local is
 * always attempted — it needs no key).
 */
export declare function buildProvider(providerType: string, configManager: ConfigManager): InferenceProvider | null;
/**
 * Probe a provider's live model list and record it in the registry.
 * Returns the model ids listed (empty on failure) — never throws.
 */
export declare function probeProviderList(providerType: string, configManager: ConfigManager): Promise<string[]>;
/**
 * Verify a model actually serves requests with a 1-token generation.
 * Success → `verified` (with measured latency). 401/403/404 → `unavailable`
 * (the "key exists but model not purchasable" case). 429 → unavailable +
 * quota-parked. Network/timeout → left untouched (transient).
 *
 * Returns the outcome for callers that want to render a summary.
 */
export declare function spotCheckModel(providerType: string, model: string, configManager: ConfigManager): Promise<'verified' | 'unavailable' | 'skipped' | 'error'>;
/** Options for a registry refresh pass. */
export interface RefreshOptions {
    /** Restrict to these providers (default: all PROBE_PROVIDERS with keys). */
    providers?: string[];
    /** Also run 1-token spot-checks against candidate models (default: true). */
    spotCheck?: boolean;
    /**
     * Extra candidate models per provider to spot-check on TOP of the curated
     * live-list candidates + configured pin (default: []).
     */
    extraModels?: Record<string, string[]>;
    /** Max spot-checks per provider per pass (default: 5 — protects free tiers). */
    maxSpotChecksPerProvider?: number;
    /** Callback fired after each provider pass (daemon progress reporting). */
    onProgress?: (label: string, detail: string) => void;
}
export interface RefreshResult {
    providersProbed: string[];
    modelsListed: number;
    verified: number;
    unavailable: number;
    skipped: number;
    errors: number;
    /** ISSUE-004 (4c): stale local-model entries purged (user deleted the model). */
    prunedLocal: number;
}
/**
 * One refresh pass: probe every configured provider's list, then spot-check
 * candidate models (curated defaults + configured pin + user extras) against
 * the LIVE API, throttled by the registry's last-verified timestamps.
 */
export declare function refreshModelRegistry(configManager: ConfigManager, options?: RefreshOptions): Promise<RefreshResult>;
/**
 * Run a maintenance pass immediately, then every `intervalMs`. Used by
 * `nuvira models watch` as the dedicated background agent that keeps the
 * registry fresh even when the CLI isn't running a pipeline.
 *
 * Returns a stop function that also cleans up signal handlers — designed for
 * the CLI command's lifecycle (the command awaits a stop signal).
 */
export declare function startRegistryWatcher(configManager: ConfigManager, options?: RefreshOptions & {
    intervalMs?: number;
}): {
    stop: () => void;
    runOnce: () => Promise<RefreshResult>;
};
export type { FallbackErrorType };
//# sourceMappingURL=model-probe.d.ts.map