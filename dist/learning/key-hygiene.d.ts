/**
 * KeyHygiene — ISSUE-004 (4b/4d): delete invalid API keys + show clear errors.
 *
 * A provider whose key returns 401/403 once might be transient; a provider
 * that returns 401/403 N consecutive times has a DEAD key. After the
 * threshold, the invalid key is removed from the config file and the user is
 * told exactly what happened and how to fix it — instead of the registry
 * re-learning the failure reactively on every call (the "why is it checking a
 * deleted model every time" feedback).
 *
 * Persisted JSON (memory dir) so the consecutive counter survives restarts —
 * a provider doesn't get a fresh slate just because the process restarted.
 * Best-effort everywhere: key hygiene must never break a live LLM call.
 */
import type { ConfigManager } from '../config/manager.js';
/** Consecutive auth (401/403) failures before the key is auto-cleared. */
export declare const AUTH_CLEAR_THRESHOLD = 3;
/** Outcome of recording an auth failure. */
export interface AuthFailureOutcome {
    consecutive: number;
    threshold: number;
    /** True when this failure crossed the threshold and the key was cleared. */
    cleared: boolean;
    /** True when the key could NOT be cleared because it came from an env var. */
    envSourced: boolean;
    /** The env var name when envSourced (so the user can fix the right thing). */
    envVar?: string;
}
/**
 * ISSUE-004 key-hygiene store. Lives in the learning layer because BOTH the
 * failure bookkeeping (learning) and CLI surfaces consume it, and it only
 * depends on config/logger.
 */
export declare class KeyHygiene {
    private data;
    constructor();
    private load;
    private persist;
    /**
     * Record a 401/403 auth failure for a provider. When the provider reaches
     * AUTH_CLEAR_THRESHOLD consecutive auth failures, the invalid key is cleared
     * from the config (or the user is told which env var to fix) and a clear
     * error is surfaced. Best-effort — never throws.
     *
     * `apiKey` is the SPECIFIC key that failed (undefined = the primary). It is
     * forwarded to `clearProviderApiKey` so the exact dead credential is removed
     * — the primary, or a matching rotation key in `apiKeys[]`.
     */
    recordAuthFailure(provider: string, configManager: ConfigManager, apiKey?: string): AuthFailureOutcome;
    /**
     * A real success on a provider proves its key works — reset the consecutive
     * auth-failure counter so one blip can never clear a valid key. Best-effort.
     */
    recordAuthSuccess(provider: string): void;
    /** Snapshot for tests / CLI (counters keyed by provider). */
    getState(): Record<string, number>;
    reset(): void;
}
export declare function getKeyHygiene(): KeyHygiene;
export declare function resetKeyHygiene(): void;
//# sourceMappingURL=key-hygiene.d.ts.map