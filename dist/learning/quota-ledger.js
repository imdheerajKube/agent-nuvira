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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
// ─── Storage ────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h default reset window
function memoryDir() {
    return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}
function ledgerPath() {
    return join(memoryDir(), 'quota-ledger.json');
}
function emptyState() {
    return { version: CURRENT_VERSION, entries: {} };
}
function entryKey(provider, model) {
    return `${provider}|${model || 'default'}`;
}
// ─── QuotaLedger ────────────────────────────────────────────────────────────
/**
 * Central quota ledger — tracks usage per provider/model across reset windows
 * and parks exhausted providers until the window rolls (auto re-enable).
 */
export class QuotaLedger {
    state;
    constructor() {
        this.state = this.load();
    }
    /** Load persisted state (best-effort). */
    load() {
        try {
            if (!existsSync(ledgerPath()))
                return emptyState();
            const raw = readFileSync(ledgerPath(), 'utf-8');
            const data = JSON.parse(raw);
            if (!data || typeof data !== 'object' || !data.entries)
                return emptyState();
            return { ...emptyState(), ...data };
        }
        catch {
            return emptyState();
        }
    }
    save() {
        try {
            if (!existsSync(memoryDir()))
                mkdirSync(memoryDir(), { recursive: true });
            writeFileSync(ledgerPath(), JSON.stringify(this.state, null, 2), 'utf-8');
        }
        catch {
            // Best-effort — never break routing on a failed write.
        }
    }
    /** Get the entry for provider/model, creating it with the given window. */
    getOrCreate(provider, model, windowLengthMs) {
        const key = entryKey(provider, model);
        let entry = this.state.entries[key];
        if (!entry) {
            entry = {
                provider,
                model,
                tokensConsumed: 0,
                requests: 0,
                windowStart: Date.now(),
                windowLengthMs: windowLengthMs || DEFAULT_WINDOW_MS,
                cooldownUntil: 0,
            };
            this.state.entries[key] = entry;
        }
        return entry;
    }
    /**
     * Lazily rotate an entry's window. When the window has elapsed, counters
     * reset and windowStart advances — this is the calendar-aware AUTO
     * RE-ENABLE: a provider parked for exhaustion un-parks the moment its
     * reset window rolls. Explicit cooldowns (cooldownUntil) survive rotation
     * so a manual park isn't wiped by an unrelated window roll.
     */
    rotateWindow(entry) {
        const now = Date.now();
        if (now - entry.windowStart >= entry.windowLengthMs) {
            entry.tokensConsumed = 0;
            entry.requests = 0;
            entry.windowStart = now;
        }
    }
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
    recordUsage(provider, model, inputTokens, outputTokens, windowMs) {
        try {
            const entry = this.getOrCreate(provider, model, windowMs || DEFAULT_WINDOW_MS);
            if (windowMs)
                entry.windowLengthMs = windowMs;
            this.rotateWindow(entry);
            entry.tokensConsumed += Math.max(0, inputTokens) + Math.max(0, outputTokens);
            entry.requests += 1;
            this.save();
        }
        catch {
            // Best-effort — a failed ledger write must never break an LLM call.
        }
    }
    /**
     * Explicitly park a provider until a given epoch ms (used by chat failover
     * and quota-killed providers so the exclusion survives across sessions).
     * Parked providers are excluded from Auto routing until `until`.
     */
    parkProvider(provider, until) {
        try {
            const now = Date.now();
            // Park every model entry for the provider (plus a provider-level entry
            // so providers that never recorded a model are still covered).
            for (const key of Object.keys(this.state.entries)) {
                const e = this.state.entries[key];
                if (e.provider === provider && until > now)
                    e.cooldownUntil = until;
            }
            const defaultKey = entryKey(provider, 'default');
            if (!this.state.entries[defaultKey]) {
                const entry = this.getOrCreate(provider, 'default', DEFAULT_WINDOW_MS);
                if (until > now)
                    entry.cooldownUntil = until;
            }
            this.save();
        }
        catch {
            // Best-effort.
        }
    }
    /** Clear an explicit cooldown for a provider (manual re-enable). */
    releaseProvider(provider) {
        try {
            for (const key of Object.keys(this.state.entries)) {
                if (this.state.entries[key].provider === provider) {
                    this.state.entries[key].cooldownUntil = 0;
                }
            }
            this.save();
        }
        catch {
            // Best-effort.
        }
    }
    /**
     * Is a provider parked (explicit cooldown OR over its configured limit in
     * the current window)? Limits come from `routing.quota.<provider>` config.
     */
    isExhausted(provider, model, limit) {
        const now = Date.now();
        const key = entryKey(provider, model || 'default');
        const entry = this.state.entries[key];
        if (entry) {
            if (entry.cooldownUntil > now)
                return true;
            this.rotateWindow(entry);
            if (limit) {
                if (limit.requestsPerWindow !== undefined && entry.requests >= limit.requestsPerWindow)
                    return true;
                if (limit.tokensPerWindow !== undefined && entry.tokensConsumed >= limit.tokensPerWindow)
                    return true;
            }
            return false;
        }
        // No entry — check a provider-level entry as fallback.
        const providerEntry = this.state.entries[entryKey(provider, 'default')];
        if (providerEntry) {
            if (providerEntry.cooldownUntil > now)
                return true;
            this.rotateWindow(providerEntry);
            if (limit) {
                if (limit.requestsPerWindow !== undefined && providerEntry.requests >= limit.requestsPerWindow)
                    return true;
                if (limit.tokensPerWindow !== undefined && providerEntry.tokensConsumed >= limit.tokensPerWindow)
                    return true;
            }
        }
        return false;
    }
    /**
     * Effective quota limits for a provider from config (`routing.quota`).
     */
    limitsFor(configManager, provider) {
        return configManager?.getAll().routing?.quota?.[provider];
    }
    /**
     * Build the router's "parked providers" feed — providers that must sink
     * below healthy candidates because they are exhausted or in cooldown.
     * Shape mirrors `circuitBreakerStatus` so the AutoModelRouter consumes it
     * identically.
     *
     * @returns Array of `{ provider, cooldownRemaining }` with cooldownRemaining > 0
     */
    getRouterQuotaStatus(configManager) {
        const now = Date.now();
        const parked = new Map();
        // 1. Explicit cooldowns (failover / quota-killed providers).
        for (const entry of Object.values(this.state.entries)) {
            if (entry.cooldownUntil > now) {
                const remaining = entry.cooldownUntil - now;
                const current = parked.get(entry.provider) ?? 0;
                if (remaining > current)
                    parked.set(entry.provider, remaining);
            }
        }
        // 2. Configured-limit exhaustion within the current window.
        const quotaCfg = configManager?.getAll().routing?.quota || {};
        for (const provider of Object.keys(quotaCfg)) {
            const limit = quotaCfg[provider];
            if (!limit)
                continue;
            // Any model entry for this provider counts toward the provider cap.
            const entries = Object.values(this.state.entries).filter((e) => e.provider === provider);
            let requests = 0;
            let tokens = 0;
            let latestWindowEnd = now;
            for (const e of entries) {
                this.rotateWindow(e);
                requests += e.requests;
                tokens += e.tokensConsumed;
                latestWindowEnd = Math.max(latestWindowEnd, e.windowStart + e.windowLengthMs);
            }
            const exhausted = (limit.requestsPerWindow !== undefined && requests >= limit.requestsPerWindow) ||
                (limit.tokensPerWindow !== undefined && tokens >= limit.tokensPerWindow);
            if (exhausted) {
                const remaining = Math.max(0, latestWindowEnd - now);
                const current = parked.get(provider) ?? 0;
                if (remaining > current)
                    parked.set(provider, remaining);
            }
        }
        return [...parked.entries()].map(([provider, cooldownRemaining]) => ({ provider, cooldownRemaining }));
    }
    /**
     * Filter a candidate list down to providers that are NOT parked/exhausted.
     * Never returns an empty list — if everything is parked, returns the input
     * unchanged so the router's caller still gets a decision (and surfaces
     * availability to the user instead of a silent blank).
     */
    getBestAvailable(providers, configManager) {
        const parked = new Set(this.getRouterQuotaStatus(configManager).map((s) => s.provider));
        const usable = providers.filter((p) => !parked.has(p));
        return usable.length > 0 ? usable : providers;
    }
    /** Full per-entry status snapshot (dashboard / CLI / tests). */
    getStatus(configManager) {
        const now = Date.now();
        const limits = configManager?.getAll().routing?.quota || {};
        return Object.values(this.state.entries)
            .map((e) => {
            this.rotateWindow(e);
            const limit = limits[e.provider];
            const overLimit = !!limit &&
                ((limit.requestsPerWindow !== undefined && e.requests >= limit.requestsPerWindow) ||
                    (limit.tokensPerWindow !== undefined && e.tokensConsumed >= limit.tokensPerWindow));
            const cooldownRemaining = Math.max(0, e.cooldownUntil - now);
            const resetsInMs = Math.max(0, e.windowStart + e.windowLengthMs - now);
            return {
                provider: e.provider,
                model: e.model,
                tokensConsumed: e.tokensConsumed,
                requests: e.requests,
                windowLengthMs: e.windowLengthMs,
                resetsInMs,
                parked: cooldownRemaining > 0 || overLimit,
                cooldownRemaining,
            };
        })
            .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    }
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
    getCostSummary() {
        // Free-tier providers whose DEFAULT pricing is $0. NOTE: a user-configured
        // `pricing.gemini` override would make Gemini paid — this follows the
        // DEFAULT pricing table (the ledger doesn't store pricing), matching the
        // dashboard's readQuotaData().
        const FREE_PROVIDERS = new Set(['local', 'gemini']);
        // Conservative blended rate (USD per 1K tokens) for the "would have cost"
        // estimate — mirrors the auto router's default pricing for a mid-tier model.
        const AVG_PAID_RATE_PER_1K = 0.0005;
        let freeTokens = 0;
        let freeRequests = 0;
        let paidTokens = 0;
        let paidRequests = 0;
        for (const e of Object.values(this.state.entries)) {
            // Rotate first so the summary agrees with getStatus()/formatStatus()
            // rendered in the same CLI output (counters reset on window roll).
            this.rotateWindow(e);
            if (FREE_PROVIDERS.has(e.provider)) {
                freeTokens += e.tokensConsumed;
                freeRequests += e.requests;
            }
            else {
                paidTokens += e.tokensConsumed;
                paidRequests += e.requests;
            }
        }
        const estimatedSavedUsd = Math.round((freeTokens / 1000) * AVG_PAID_RATE_PER_1K * 100000) / 100000;
        return { freeTokens, freeRequests, paidTokens, paidRequests, estimatedSavedUsd };
    }
    /** Raw persisted state (tests / CLI). */
    getState() {
        return {
            version: this.state.version,
            entries: Object.fromEntries(Object.entries(this.state.entries).map(([k, v]) => [k, { ...v }])),
        };
    }
    /** Clear all entries (used by tests and `buff model quota reset`). */
    reset() {
        this.state = emptyState();
        this.save();
    }
    /** Remove all entries for one provider. */
    resetProvider(provider) {
        for (const key of Object.keys(this.state.entries)) {
            if (this.state.entries[key].provider === provider)
                delete this.state.entries[key];
        }
        this.save();
    }
    /** Human-readable summary (CLI). */
    formatStatus(configManager) {
        const statuses = this.getStatus(configManager);
        if (statuses.length === 0) {
            return '📒 Quota ledger is empty — run Auto-routed tasks to record usage.';
        }
        const lines = ['📒 Quota Ledger (per provider × model)', ''];
        for (const s of statuses) {
            const state = s.parked
                ? s.cooldownRemaining > 0
                    ? `⏸ parked (${Math.ceil(s.cooldownRemaining / 1000)}s cooldown)`
                    : '⛔ exhausted — auto re-enables on window reset'
                : '✅ available';
            lines.push(`   ${s.provider.padEnd(12)} ${(s.model || 'default').padEnd(28)} ` +
                `tokens ${String(s.tokensConsumed).padStart(9)}  req ${String(s.requests).padStart(5)}  ` +
                `resets in ${formatDuration(s.resetsInMs)}  ${state}`);
        }
        lines.push('', 'Reset: `buff model quota reset` · JSON: `buff model quota --json`');
        return lines.join('\n');
    }
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0)
        return `${h}h ${m}m`;
    if (m > 0)
        return `${m}m`;
    return `${Math.ceil(ms / 1000)}s`;
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let ledgerInstance = null;
/** Get or create the QuotaLedger singleton. */
export function getQuotaLedger() {
    if (!ledgerInstance) {
        ledgerInstance = new QuotaLedger();
    }
    return ledgerInstance;
}
/** Reset the singleton (useful for testing). */
export function resetQuotaLedger() {
    ledgerInstance = null;
}
/** Log helper kept tiny so the module stays dependency-light. */
export { logger };
//# sourceMappingURL=quota-ledger.js.map