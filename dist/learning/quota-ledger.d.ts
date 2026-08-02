/**
 * QuotaLedger — central quota tracking for Auto model routing.
 *
 * The assessment-gap keystone: a persistent ledger of tokens consumed and
 * request counts per provider/model with configurable RESET WINDOWS (daily /
 * hourly free-tier limits). When a provider exhausts its window it is PARKED
 * (excluded from Auto routing) until the window rolls over — calendar-aware
 * auto re-enable, not an arbitrary timer.
 *
 * Mechanism:
 * - Every LLM call write-throughs usage via `recordUsage()` (hooked into
 *   CostTracker.recordCall, which all inference adapters already call).
 * - Windows are reset lazily: `rotateWindow()` zeros counters when
 *   `now - windowStart >= windowLengthMs`, so a parked provider auto
 *   re-enables exactly when its reset occurs.
 * - `getRouterQuotaStatus()` / `getBestAvailable()` feed the AutoModelRouter,
 *   chat, and the orchestrator so exhausted providers sink below healthy ones
 *   BEFORE a call is made (predictive, not reactive).
 *
 * Persisted to ~/.buff/memory/quota-ledger.json (honors BUFF_MEMORY_DIR).
 * All writes are best-effort — a failed write must never break routing.
 */
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
/** Per-provider quota limits for the central ledger. */
export interface QuotaLimit {
    /** Max tokens per reset window (input + output). */
    tokensPerWindow?: number;
    /** Max requests per reset window. */
    requestsPerWindow?: number;
    /** Reset window length in ms (default 24h). */
    windowMs?: number;
}
/** A single ledger entry — one provider/model within its current window. */
export interface QuotaEntry {
    provider: string;
    model: string;
    tokensConsumed: number;
    requests: number;
    /** Epoch ms when the current window started. */
    windowStart: number;
    /** Window length in ms (from config at first record; default 24h). */
    windowLengthMs: number;
    /** Epoch ms until which the entry is explicitly parked (0 = not parked). */
    cooldownUntil: number;
}
/** Persisted ledger state. */
export interface QuotaLedgerData {
    version: number;
    /** Key: `${provider}|${model}` */
    entries: Record<string, QuotaEntry>;
}
/** Computed status for one entry (dashboard / CLI / tests). */
export interface QuotaStatus {
    provider: string;
    model: string;
    tokensConsumed: number;
    requests: number;
    windowLengthMs: number;
    /** Ms until the current window resets (auto re-enable). */
    resetsInMs: number;
    /** Whether the entry is currently parked (exhausted or manually cooled). */
    parked: boolean;
    /** Remaining ms of an explicit cooldown (0 = none). */
    cooldownRemaining: number;
}
/**
 * Central quota ledger — tracks usage per provider/model across reset windows
 * and parks exhausted providers until the window rolls (auto re-enable).
 */
export declare class QuotaLedger {
    private state;
    constructor();
    /** Load persisted state (best-effort). */
    private load;
    private save;
    /** Get the entry for provider/model, creating it with the given window. */
    private getOrCreate;
    /**
     * Lazily rotate an entry's window. When the window has elapsed, counters
     * reset and windowStart advances — this is the calendar-aware AUTO
     * RE-ENABLE: a provider parked for exhaustion un-parks the moment its
     * reset window rolls. Explicit cooldowns (cooldownUntil) survive rotation
     * so a manual park isn't wiped by an unrelated window roll.
     */
    private rotateWindow;
    /**
     * Write-through a completed LLM call into the ledger.
     * Called from CostTracker.recordCall (every adapter) so usage is always
     * tracked — enforcement (parking) is opt-in via configured quota limits.
     *
     * @param provider     Provider id (e.g. 'gemini')
     * @param model        Model id (e.g. 'gemini-2.5-flash'); 'default' if unknown
     * @param inputTokens  Input tokens consumed (exact or estimated)
     * @param outputTokens Output tokens generated (exact or estimated)
     * @param windowMs     Optional reset window override (else entry default)
     */
    recordUsage(provider: string, model: string, inputTokens: number, outputTokens: number, windowMs?: number): void;
    /**
     * Explicitly park a provider until a given epoch ms (used by chat failover
     * and quota-killed providers so the exclusion survives across sessions).
     * Parked providers are excluded from Auto routing until `until`.
     */
    parkProvider(provider: string, until: number): void;
    /** Clear an explicit cooldown for a provider (manual re-enable). */
    releaseProvider(provider: string): void;
    /**
     * Is a provider parked (explicit cooldown OR over its configured limit in
     * the current window)? Limits come from `routing.quota.<provider>` config.
     */
    isExhausted(provider: string, model?: string, limit?: QuotaLimit): boolean;
    /**
     * Effective quota limits for a provider from config (`routing.quota`).
     */
    private limitsFor;
    /**
     * Build the router's "parked providers" feed — providers that must sink
     * below healthy candidates because they are exhausted or in cooldown.
     * Shape mirrors `circuitBreakerStatus` so the AutoModelRouter consumes it
     * identically.
     *
     * @returns Array of `{ provider, cooldownRemaining }` with cooldownRemaining > 0
     */
    getRouterQuotaStatus(configManager?: ConfigManager): Array<{
        provider: string;
        cooldownRemaining: number;
    }>;
    /**
     * Filter a candidate list down to providers that are NOT parked/exhausted.
     * Never returns an empty list — if everything is parked, returns the input
     * unchanged so the router's caller still gets a decision (and surfaces
     * availability to the user instead of a silent blank).
     */
    getBestAvailable(providers: string[], configManager?: ConfigManager): string[];
    /** Full per-entry status snapshot (dashboard / CLI / tests). */
    getStatus(configManager?: ConfigManager): QuotaStatus[];
    /**
     * Free/local-first cost optics (assessment #7 transparency): split tracked
     * usage into FREE providers (local Ollama, Gemini free tier — $0 default
     * pricing) vs PAID providers, and estimate what the free-tier tokens would
     * have cost on a typical paid provider. This is the "tokens saved / paid
     * usage triggered" transparency metric: free usage = savings, paid usage =
     * actual spend. Mirrors the dashboard's readQuotaData() classification.
     *
     * @returns Aggregated free/paid token & request counts plus estimated savings.
     */
    getCostSummary(): {
        freeTokens: number;
        freeRequests: number;
        paidTokens: number;
        paidRequests: number;
        estimatedSavedUsd: number;
    };
    /** Raw persisted state (tests / CLI). */
    getState(): QuotaLedgerData;
    /** Clear all entries (used by tests and `buff model quota reset`). */
    reset(): void;
    /** Remove all entries for one provider. */
    resetProvider(provider: string): void;
    /** Human-readable summary (CLI). */
    formatStatus(configManager?: ConfigManager): string;
}
/** Get or create the QuotaLedger singleton. */
export declare function getQuotaLedger(): QuotaLedger;
/** Reset the singleton (useful for testing). */
export declare function resetQuotaLedger(): void;
/** Log helper kept tiny so the module stays dependency-light. */
export { logger };
//# sourceMappingURL=quota-ledger.d.ts.map