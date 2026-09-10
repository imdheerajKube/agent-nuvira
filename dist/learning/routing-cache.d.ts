/**
 * Routing decision cache (`src/learning/routing-cache.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 2.
 *
 * The loop-first engine calls the AutoModelRouter on EVERY model turn. Each
 * resolve() scores 22+ catalog providers across 5 dimensions (+ capability
 * fit, context preflight, bandit sampling, registry filtering) — meaningful
 * CPU work repeated for turns whose ROUTING INPUTS are identical.
 *
 * The cache keys on the STABLE routing inputs only — never the raw message
 * text (every message is unique, so a message-keyed cache would never hit).
 * Two turns hit the same entry when all of the following match:
 *   agent type · task intent · complexity · preference mode · provider-health
 *   signature (session exclusions + breaker + quota) · registry usable-count
 * · cacheable resolve-option flags.
 *
 * Correctness rules:
 * 1. Provider health is part of the KEY, so a provider failing mid-session
 *    changes the key and can never be served a stale healthy-route.
 * 2. TTL (default 30s) bounds staleness of everything NOT in the key
 *    (benchmarks recorded by concurrent runs, bandit draws).
 * 3. Non-deterministic layers are opt-out at the call site: when the caller
 *    enables `useBandit` or `useMlRouter` with default settings, the cache
 *    is still safe for SELECTION (deterministic at cold start) but a caller
 *    may force-bypass via `bypass` for benchmark/explain flows that must
 *    observe the live ranking.
 * 4. `invalidateRoutingCache()` is called by the model registry refresh and
 *    is safe to call anywhere — worst case one extra resolve.
 */
export interface RoutingCacheEntry<T> {
    value: T;
    /** Epoch ms when the entry becomes stale. */
    expiresAt: number;
    /** Inputs signature the entry was computed under. */
    signature: string;
}
/** Default TTL: short enough to bound staleness, long enough to cover a chat turn's repeated resolves. */
export declare const DEFAULT_ROUTING_CACHE_TTL_MS = 30000;
/**
 * Build the inputs signature from the STABLE routing inputs. Every part is
 * stringified; null/undefined/'' parts are skipped (their absence IS signal —
 * e.g. no NLU intent hint). Order-normalized: callers pass parts in a fixed
 * order, but we join with '|' so collisions across part counts are visible.
 */
export declare function routingCacheSignature(parts: Array<string | number | boolean | null | undefined>): string;
/**
 * Get a cached routing decision. Returns undefined on miss/expiry.
 * Expired entries are lazily dropped (no background sweeper — the CLI is
 * single-user and resolve-frequency is bounded by turn count).
 */
export declare function getRoutingCache<T>(signature: string): T | undefined;
/** Store a decision under a signature with the given TTL. */
export declare function setRoutingCache<T>(signature: string, value: T, ttlMs?: number): void;
/**
 * Memoize wrapper: return the cached decision for this signature, or compute
 * + store. `compute` throwing propagates (never cache a failure — a transient
 * registry read failure must not pin a degraded route for the TTL).
 */
export declare function withRoutingCache<T>(signature: string, ttlMs: number | undefined, compute: () => T): T;
/** Clear the whole cache (registry refresh, tests, `nuvira models explain`). */
export declare function invalidateRoutingCache(): void;
/** Test/inspection helper: current entry count. */
export declare function routingCacheSize(): number;
//# sourceMappingURL=routing-cache.d.ts.map