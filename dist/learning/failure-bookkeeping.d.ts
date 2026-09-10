/**
 * FailureBookkeeping — shared composition of everything that must happen when
 * a real LLM call fails, so EVERY action (chat / execute / plan / edit / ...)
 * records failures identically instead of each maintaining its own copy.
 *
 * This is Nuvira-Router M0.2 Stage A: a behavior-identical extraction of
 * ChatCommand.recordAutoProviderFailure's composition into a reusable helper.
 *
 * What it composes (order preserved from the chat path):
 *   1. classify the failure (auth / rate-limit / server / network / timeout / unknown)
 *   2. session-level exclusion (auth = rest of session; rate-limit = short
 *      cooldown; transient = short cooldown + "needs re-verification" marker)
 *   3. rate-limit → park the provider in the central quota ledger
 *   4. registry write-through (per-action telemetry; model-not-found → unavailable)
 *   5. quota-timeline failover event
 *   6. shared circuit-breaker feed
 *
 * Best-effort: never throws, so failure bookkeeping can never crash a call.
 */
import type { ConfigManager } from '../config/manager.js';
export interface FailureSessionState {
    /**
     * Provider → expiry (ms epoch) of its session-level exclusion.
     * - auth        → Number.MAX_SAFE_INTEGER (rest of the session)
     * - rate-limit  → now + RATE_LIMIT_EXCLUSION_MS (short cooldown, then re-admit)
     * - transient   → now + TRANSIENT_FAILURE_EXCLUSION_MS (short cooldown)
     */
    sessionFailedProviders: Map<string, number>;
    /**
     * Providers whose transient exclusion EXPIRED and are awaiting a quick
     * on-demand spot-check before re-admission (never re-pick without proof).
     */
    sessionTransientFailedProviders: Set<string>;
}
/**
 * How long a rate-limit failure excludes a provider from auto routing (ms).
 * Aligned with the circuit breaker's COOLDOWN_DURATION_MS (120s) so the
 * session-level exclusion and the breaker's scoring cooldown expire together.
 */
export declare const RATE_LIMIT_EXCLUSION_MS: number;
/**
 * How long a server/network/timeout/unknown failure excludes a provider from
 * auto routing (ms). Shorter than rate-limit so a flaky-but-alive provider is
 * re-admitted quickly, but long enough that the very NEXT message never
 * re-picks a provider that just failed.
 */
export declare const TRANSIENT_FAILURE_EXCLUSION_MS: number;
/**
 * Record a provider failure with the FULL composition every routing path uses:
 * session exclusion → (rate-limit) ledger park → registry write-through →
 * quota timeline event → circuit breaker.
 *
 * @param session     The caller-owned session failure state (mutated in place).
 * @param providerType The provider that failed (e.g. 'gemini').
 * @param err          The failure.
 * @param configManager Needed for the quota config + circuit-breaker singleton.
 * @param options.model  The model that was attempted (registry attribution).
 * @param options.action The action that hit the failure (chat / execute / plan /
 *   ...) — attributed in the per-action "learned from real usage" telemetry.
 *   OMITTING the action still updates health scores but produces NO per-action
 *   dashboard row — Stage B callers (execute/plan/edit) must always pass it.
 *
 * Best-effort: never throws, so failover bookkeeping can't crash a call.
 */
export declare function recordActionFailure(session: FailureSessionState, providerType: string, err: unknown, configManager: ConfigManager, options?: {
    model?: string;
    action?: string;
    apiKey?: string;
}): void;
//# sourceMappingURL=failure-bookkeeping.d.ts.map