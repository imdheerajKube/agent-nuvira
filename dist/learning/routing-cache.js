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
/** Module-level store — one cache per process (single-user CLI). */
const store = new Map();
/** Default TTL: short enough to bound staleness, long enough to cover a chat turn's repeated resolves. */
export const DEFAULT_ROUTING_CACHE_TTL_MS = 30_000;
/** Upper bound on entries — a pathological key-space cannot grow the map unbounded. */
const MAX_ENTRIES = 256;
/**
 * Build the inputs signature from the STABLE routing inputs. Every part is
 * stringified; null/undefined/'' parts are skipped (their absence IS signal —
 * e.g. no NLU intent hint). Order-normalized: callers pass parts in a fixed
 * order, but we join with '|' so collisions across part counts are visible.
 */
export function routingCacheSignature(parts) {
    return parts
        .map((p) => (p === null || p === undefined || p === '' ? '∅' : String(p)))
        .join('|');
}
/**
 * Get a cached routing decision. Returns undefined on miss/expiry.
 * Expired entries are lazily dropped (no background sweeper — the CLI is
 * single-user and resolve-frequency is bounded by turn count).
 */
export function getRoutingCache(signature) {
    const entry = store.get(signature);
    if (!entry)
        return undefined;
    if (Date.now() >= entry.expiresAt) {
        store.delete(signature);
        return undefined;
    }
    return entry.value;
}
/** Store a decision under a signature with the given TTL. */
export function setRoutingCache(signature, value, ttlMs = DEFAULT_ROUTING_CACHE_TTL_MS) {
    // Bound the map: drop the EXPIRED entries first, then (rare) evict oldest.
    if (store.size >= MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of store) {
            if (now >= v.expiresAt)
                store.delete(k);
        }
        if (store.size >= MAX_ENTRIES) {
            const oldest = store.keys().next().value;
            if (oldest !== undefined)
                store.delete(oldest);
        }
    }
    store.set(signature, { value, expiresAt: Date.now() + Math.max(0, ttlMs), signature });
}
/**
 * Memoize wrapper: return the cached decision for this signature, or compute
 * + store. `compute` throwing propagates (never cache a failure — a transient
 * registry read failure must not pin a degraded route for the TTL).
 */
export function withRoutingCache(signature, ttlMs, compute) {
    const cached = getRoutingCache(signature);
    if (cached !== undefined)
        return cached;
    const value = compute();
    setRoutingCache(signature, value, ttlMs);
    return value;
}
/** Clear the whole cache (registry refresh, tests, `nuvira models explain`). */
export function invalidateRoutingCache() {
    store.clear();
}
/** Test/inspection helper: current entry count. */
export function routingCacheSize() {
    return store.size;
}
//# sourceMappingURL=routing-cache.js.map