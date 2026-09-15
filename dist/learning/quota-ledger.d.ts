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
 * Persisted to ~/.nuvira/memory/quota-ledger.json (honors NUVIRA_MEMORY_DIR).
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
    /**
     * Parking SCOPE — why this entry is parked:
     *   'provider' → a provider-WIDE park (shared quota, total outage). EVERY
     *     model on the provider is excluded, so the provider sinks in the
     *     router's provider-level quota feed.
     *   'model'    → ONE model's own limit (per-model RPD/TPM). Siblings stay
     *     routable; the provider is NOT reported as parked.
     * Undefined = legacy persisted entry. Before per-model parks existed only
     * `parkProvider` ever wrote a cooldown, so undefined is treated as
     * 'provider' (backwards compatible).
     */
    scope?: 'provider' | 'model';
}
/**
 * M2.3 multi-account state for ONE provider key (never stores the raw key —
 * only a stable fingerprint, e.g. `accountIdForKey`). Lets the failover
 * runner rotate to another key of the same provider when one account is
 * rate-limited/authed-out, instead of switching providers.
 */
export interface AccountState {
    /** Epoch ms until which this account/key is parked (0 = not parked). */
    parkedUntil: number;
    /** Short reason, e.g. 'rate-limit' | 'auth' | 'cooldown'. */
    reason?: string;
}
/** Persisted ledger state. */
export interface QuotaLedgerData {
    version: number;
    /** Key: `${provider}|${model}` */
    entries: Record<string, QuotaEntry>;
    /** M2.3: provider → account fingerprint → parked state (optional, additive). */
    accounts?: Record<string, Record<string, AccountState>>;
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
    /**
     * Why it is parked: 'provider' = provider-wide park (sinks the whole
     * provider), 'model' = this model's own limit only (siblings keep serving).
     * Undefined when not parked. The dashboard uses this to render "resting"
     * (per-model) vs "exhausted" (provider-wide).
     */
    scope?: 'provider' | 'model';
}
/** Event types recorded in the quota failover timeline (quota-events.jsonl). */
export type QuotaEventType = 'parked' | 're-enabled' | 'released' | 'failover';
/** One entry in the quota failover timeline (assessment #7 transparency). */
export interface QuotaEvent {
    type: QuotaEventType;
    provider: string;
    /** Short human reason, e.g. 'rate-limit', 'window reset', 'manual'. */
    reason?: string;
    timestamp: number;
}
/**
 * Central quota ledger — tracks usage per provider/model across reset windows
 * and parks exhausted providers until the window rolls (auto re-enable).
 */
export declare class QuotaLedger {
    private state;
    /** In-memory dedupe of emitted window-reset events (prevents read-path dupes). */
    private emittedResets;
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
     *
     * Records a `re-enabled` timeline event ONCE per real window roll (a window
     * that actually carried usage) — deduped by windowStart so the many read
     * paths that call rotateWindow (getStatus, getCostSummary, router feed)
     * can't emit the same reset twice. The rotation is PERSISTED (save()) so a
     * fresh process re-reading the ledger sees the advanced windowStart instead
     * of re-rotating and re-emitting a duplicate 're-enabled' event.
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
     * Explicitly park a PROVIDER until a given epoch ms (used for a genuine
     * provider-wide outage / shared quota and quota-killed providers, so the
     * exclusion survives across sessions). Every model on the provider is
     * excluded from Auto routing until `until` and the provider is reported in
     * the provider-level quota feed. For a single model's own limit use
     * `parkModel()` instead — parking the whole provider because ONE model 429ed
     * drags its perfectly good siblings down.
     * Records a `parked` timeline event (best-effort).
     */
    parkProvider(provider: string, until: number, reason?: string): void;
    /**
     * Park a SINGLE model until an epoch ms — the per-model quota key.
     *
     * A provider's models often have INDEPENDENT limits (per-model RPD/TPM on
     * free tiers), so one model hitting its ceiling must not exclude its
     * siblings. The park is tagged scope='model', which keeps the provider OUT
     * of the provider-level router feed while still gating that exact model
     * (isExhausted / getModelQuotaStatus) and — via the registry mirror — the
     * router's per-entry `isUsable()` check.
     *
     * Use `parkProvider` when the limit really is shared provider-wide.
     * Records a `parked` timeline event (best-effort).
     */
    parkModel(provider: string, model: string, until: number, reason?: string): void;
    /**
     * How many DISTINCT models of a provider are currently parked (model-scoped
     * parks only). The shared-quota escalation signal: when several different
     * models of the SAME provider all hit rate limits, the limit is almost
     * certainly provider-wide (e.g. Groq's free-tier TPM is shared across every
     * model) and the caller should escalate to `parkProvider()` instead of
     * round-robining 429s across siblings forever.
     */
    getParkedModelCount(provider: string): number;
    /** Clear an explicit cooldown for a provider (manual re-enable). */
    releaseProvider(provider: string): void;
    /** Park a single provider account/key until an epoch ms (rate-limit/auth). */
    parkAccount(provider: string, accountId: string, until: number, reason?: string): void;
    /** Clear a single account's park (e.g. a later call with the key succeeded). */
    releaseAccount(provider: string, accountId: string): void;
    /** Whether a specific provider account/key is currently parked. */
    isAccountParked(provider: string, accountId: string): boolean;
    /** Fingerprints of all currently-parked accounts for a provider. */
    getParkedAccounts(provider: string): Set<string>;
    /**
     * Append an event to the quota failover timeline (quota-events.jsonl,
     * capped at MAX_EVENTS). Best-effort: a failed write must never break
     * routing. Also exposed so callers (chat failover) can record `failover`
     * events directly.
     */
    recordEvent(type: QuotaEventType, provider: string, reason?: string): void;
    /**
     * Read the failover timeline, newest first (dashboard / CLI / tests).
     * Corrupt lines are skipped; best-effort.
     */
    listEvents(limit?: number): QuotaEvent[];
    /** Clear the persisted timeline (used by `nuvira model quota reset`). */
    clearEvents(): void;
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
     * Per-MODEL parked feed — the per-model counterpart to
     * `getRouterQuotaStatus()`. Reports every model-scoped park (and any
     * provider-wide park, which covers every model of that provider) so the
     * registry can mirror the park onto the EXACT entry and the dashboard can
     * show which model is resting while its siblings keep serving.
     *
     * @returns Array of `{ provider, model, cooldownRemaining }` with
     *   cooldownRemaining > 0, best-effort.
     */
    getModelQuotaStatus(configManager?: ConfigManager): Array<{
        provider: string;
        model: string;
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
    /** Clear all entries (used by tests and `nuvira model quota reset`). */
    reset(): void;
    /** Remove all entries for one provider. */
    resetProvider(provider: string): void;
    /** Human-readable summary (CLI). */
    formatStatus(configManager?: ConfigManager): string;
}
/**
 * M2.3: stable fingerprint for a provider API key — the ledger (and every
 * diagnostic surface) NEVER stores raw keys, only this. FNV-1a 32-bit:
 * cheap, deterministic, collision-safe enough for account identity.
 */
export declare function accountIdForKey(key: string): string;
/** Get or create the QuotaLedger singleton. */
export declare function getQuotaLedger(): QuotaLedger;
/** Reset the singleton (useful for testing). */
export declare function resetQuotaLedger(): void;
/** Log helper kept tiny so the module stays dependency-light. */
export { logger };
//# sourceMappingURL=quota-ledger.d.ts.map