/**
 * ModelRegistry — persistent Model Availability Registry ("known vs usable").
 *
 * The gap this closes: an API key being configured (`hasRequiredCredentials`)
 * does NOT mean the models you route to actually work. OpenRouter lists 300+
 * models even when credits can't buy most; Gemini paid models 403 without
 * billing; NIM exposes entries that aren't served. Auto routing needs to know
 * "which provider × model combos are VERIFIED to work right now" — fast.
 *
 * Design (enterprise-grade, zero hard dependencies):
 * - A **canonical JSON mirror** (`~/.nuvira/memory/model-registry.json`) is the
 *   source of truth for READS: loaded synchronously into memory once, so every
 *   `isUsable()` / `getVerifiedModels()` is a sub-ms map lookup — model
 *   selection never blocks on I/O or the network.
 * - The same data is **mirrored to a VectorStore namespace** (`model-registry`)
 *   whenever the vector stack is usable. The VectorStore ALREADY auto-tiers
 *   native FAISS → pure-JS IVF → JSON, so "vector DB when available, JSON
 *   otherwise" is satisfied with zero extra failure modes — the JSON mirror is
 *   the guaranteed fallback that can never break.
 * - **Writes are best-effort**: a failed save must never break routing or a
 *   live LLM call (same contract as QuotaLedger / CostTracker).
 *
 * Three data feeds keep it fresh:
 *   1. **Probe** (listModels)  → marks models `unverified`-listed
 *   2. **Spot-check** (1-token generation) → `verified` (works) or `unavailable`
 *      (403 permission / 404 / auth) — catches "key exists but model not
 *      purchasable" up front
 *   3. **Telemetry** (real usage) → success upgrades to `verified`, latency EMA
 *      updates, auth failures mark unavailable, rate-limit failures park
 *      quota without demoting (auto-recovery after the window)
 *
 * Quota integration: `syncQuota()` reads the QuotaLedger's router feed and
 * applies `quotaParkedUntil` to every entry of a parked provider, so a token-
 * exhausted provider is excluded predictively (same source the AutoModelRouter
 * already consumes).
 */
import type { ModelDescriptor } from '../inference/interface.js';
import type { ConfigManager } from '../config/manager.js';
/** How an entry's status was established. */
export type ModelRegistrySource = 'probe' | 'spot-check' | 'telemetry';
/** Availability status of one provider × model combo. */
export type ModelAvailabilityStatus = 'verified' | 'unverified' | 'unavailable';
/** One entry in the model registry — provider × model → availability. */
export interface ModelRegistryEntry {
    provider: string;
    model: string;
    status: ModelAvailabilityStatus;
    /** Epoch ms of the last successful verification (spot-check or telemetry). */
    lastVerifiedAt: number;
    /** Epoch ms this model was last seen in a listModels probe. */
    lastProbedAt: number;
    /** Epoch ms of the last real usage. */
    lastUsedAt: number;
    /** Rolling average latency (ms) — measured by spot-checks. */
    latencyMs?: number;
    /**
     * Live provider-advertised nominal context window (tokens) for this model,
     * recorded from the listModels probe when the endpoint exposes it (Ollama
     * `general.context_length`, OpenRouter `context_length`). The auto-router's
     * context preflight prefers this LIVE descriptor over the static
     * provider-level default. Undefined = the provider doesn't advertise it.
     */
    contextWindowTokens?: number;
    /** Rolling EMA of input tokens per call, from provider-reported usage. */
    measuredInputTokens?: number;
    /** Rolling EMA of output tokens per call, from provider-reported usage. */
    measuredOutputTokens?: number;
    /** How many measured calls contributed to the token EMAs. */
    measuredSamples?: number;
    /** Rolling error rate 0–1 (telemetry failures / calls). */
    errorRate: number;
    /**
     * P4 M4.4 rolling mid-stream flakiness 0–1 (EMA): how often this provider ×
     * model STARTED streaming but DIED before completion (partial). Distinct
     * from `errorRate` — a partial is not an error (the model is real and
     * authenticated) but it IS a reliability signal: the router deprioritizes
     * flaky mid-stream providers. Never flips status (a partial today may
     * complete tomorrow); decays toward 0 on clean successes.
     */
    partialRate?: number;
    /**
     * P4 M4.4: recent mid-stream flakiness EMA samples [{ t, rate }] — newest
     * last, capped at MAX_PARTIAL_HISTORY. Powers the dashboard's "flakiness
     * over time" sparkline: a trend toward 0 = the provider is HEALING via
     * clean successes; climbing = flakiness accumulating.
     */
    partialHistory?: Array<{
        t: number;
        rate: number;
    }>;
    /** Epoch ms until which the entry is quota-parked (0 = not parked). */
    quotaParkedUntil: number;
    /**
     * FIX (Gemini parking bug): when true, the parking was set by a provider-
     * level operation (parkProvider / syncQuota) rather than a model-specific
     * failure (recordCall). Verified models skip provider-level parking — a
     * verified model has proven it works and should not be blanket-blocked
     * because a DIFFERENT model in the same provider hit a rate limit.
     */
    providerParked?: boolean;
    /** Where the current status came from. */
    source: ModelRegistrySource;
    /** Human reason for `unavailable` (e.g. '403 permission denied'). */
    lastError?: string;
    /** Tokens consumed in the current quota window (0 = no window tracked). */
    tokensConsumed?: number;
    /** Requests made in the current quota window. */
    requests?: number;
    /** Ms until the current quota window resets (0 = no window tracked). */
    resetsInMs?: number;
    /** Tokens remaining in the window (-1 = no limit configured / unlimited). */
    remainingTokens?: number;
}
/** Persisted registry state (JSON mirror + vector metadata shape). */
export interface ModelRegistryData {
    version: number;
    updatedAt: number;
    /** Key: `${provider}|${model}` */
    entries: Record<string, ModelRegistryEntry>;
}
/** Public status snapshot (CLI / dashboard / tests). */
export interface ModelRegistryStatus {
    backend: string;
    vectorMirrored: boolean;
    total: number;
    verified: number;
    unverified: number;
    unavailable: number;
    parked: number;
    updatedAt: number;
    /** Per-provider breakdown. */
    providers: Array<{
        provider: string;
        total: number;
        verified: number;
        unavailable: number;
        parked: number;
        models: ModelRegistryEntry[];
    }>;
}
/**
 * One "learned from real usage" event — which ACTION taught the registry what.
 * Written by chat / execute / plan / edit / skill / learn / ci / doctor calls
 * (and probe/spot-check maintenance) so the dashboard can show exactly which
 * action killed or verified each provider × model — the predictive skips.
 */
export interface ActionTelemetryEntry {
    /** Epoch ms of the write. */
    timestamp: number;
    /** The action that produced the call (chat / execute / plan / edit / ...). */
    action: string;
    provider: string;
    model: string;
    /** What the action learned: verified (works), unavailable (killed), error (transient decay). */
    outcome: 'verified' | 'unavailable' | 'error' | 'partial';
    /** Classified reason when outcome is unavailable/error (auth / rate-limit / model not found / ...). */
    errorType?: string;
    /** Measured round-trip latency (ms) of the call — feeds the Requests panel p50/p95/p99 (P3-M3.2). */
    latencyMs?: number;
    /** Measured cost (USD) of the call when the caller had usage data — feeds the Requests panel cost column. */
    costUsd?: number;
    /** Correlation id of the call when the caller has one (traceability). */
    callId?: string;
    /**
     * P4 M4.4: tokens already streamed before a `partial` (mid-stream
     * interruption) — the bigger the number, the more "almost finished" the
     * provider was. Only set for outcome 'partial'.
     */
    streamedChunks?: number;
}
/** Aggregated "learned from real usage" view — per action (dashboard panel). */
export interface ActionTelemetryInsights {
    enabled: boolean;
    /** Total logged events (capped at MAX_ACTION_LOG_ENTRIES). */
    total: number;
    updatedAt: number;
    /** Per-action aggregates (actions with at least one event, sorted by name). */
    actions: Array<{
        action: string;
        /** Events where the action verified a provider × model. */
        verified: number;
        /** Events where the action marked a provider × model unavailable (predictive skip). */
        killed: number;
        /** Events where a transient failure decayed health (no flip). */
        transient: number;
        /**
         * Events where the action hit a MID-STREAM interruption (P4 M4.4 partial
         * learning) — the provider started streaming then died before completion.
         * A distinct signal from `transient` (a failed request) because a provider
         * that starts-but-can't-finish is worse than one that errors cleanly: the
         * router learns to deprioritize flaky mid-stream providers.
         */
        partial: number;
        /** Provider × model combos this action verified (latest event each). */
        verifiedModels: Array<{
            provider: string;
            model: string;
            at: number;
        }>;
        /** Provider × model combos this action killed (latest event each). */
        killedModels: Array<{
            provider: string;
            model: string;
            reason?: string;
            at: number;
        }>;
        /**
         * Provider × model combos this action interrupted MID-STREAM (latest
         * event each) — P4 M4.4 partial learning: the provider started streaming
         * then died before completion. Surfaced as chips in the dashboard so a
         * flaky-but-responsive provider is distinguishable from a clean error.
         */
        partialModels: Array<{
            provider: string;
            model: string;
            reason?: string;
            at: number;
            streamedChunks?: number;
        }>;
        /**
         * Daily buckets over the last TIMELINE_DAYS — verified vs killed vs
         * transient vs partial counts per day (ascending), so the dashboard can
         * render a "learned from real usage over time" sparkline/bar chart per
         * action. Each bucket also carries the RAW events that landed that day,
         * so the chart can be scrubbed day-by-day to show that day's exact chips
         * (which provider × model the action killed or verified).
         */
        timeline: Array<{
            /** Start of the UTC day bucket (epoch ms). */
            day: number;
            verified: number;
            killed: number;
            transient: number;
            /** Mid-stream partial-interruption events that day (P4 M4.4). */
            partial: number;
            /** Raw events that day — the chips the scrubbable chart shows per day. */
            events: Array<{
                provider: string;
                model: string;
                outcome: 'verified' | 'unavailable' | 'error' | 'partial';
                errorType?: string;
                /** Epoch ms of the event. */
                at: number;
                /** P4 M4.4: chunks streamed before a partial died (surfaced in the chip tooltip). */
                streamedChunks?: number;
            }>;
        }>;
    }>;
}
/** Action-telemetry JSONL log — which action killed/verified which provider × model. */
export declare const ACTION_LOG_FILENAME = "model-registry-actions.jsonl";
/** Keep at most this many action-log lines (rotated, newest kept). */
export declare const MAX_ACTION_LOG_ENTRIES = 2000;
/** Days of per-action daily buckets included in the telemetry timeline. */
export declare const TIMELINE_DAYS = 14;
/** Cap on per-entry partialRate history samples (dashboard sparkline points). */
export declare const MAX_PARTIAL_HISTORY = 16;
/** Verified entries older than this are demoted to `unverified` on prune. */
export declare const DEFAULT_STALE_MS: number;
/**
 * Minimum unavailable entries (with zero verified models) before a provider is
 * deemed DEGRADED by `getDegradedProviders()` — the registry pre-filter that
 * stops the router from scoring a provider it already knows is dead. ISSUE-002.
 */
export declare const DEGRADED_UNAVAILABLE_THRESHOLD = 3;
/**
 * How far a single SUCCESS decays the error-rate EMA (mirrors the 0.1 partial-
 * rate heal step). errorRate must heal on success, otherwise a transient blip
 * permanently penalizes a recovered model in preferredModelsFor().
 */
export declare const ERROR_RATE_HEAL_STEP = 0.1;
/**
 * The config value `'default'` is a SENTINEL meaning "use the provider's
 * default model" — it is NOT a model id. Telemetry must never track it: a
 * `groq|default` entry marked `verified` (observed live, its lastError being
 * "model not found") ranked first by error-rate and was handed to the adapter
 * as a literal model name. Every registry WRITE ignores the sentinel.
 */
export declare function isSentinelModel(model: string | undefined | null): boolean;
/**
 * Aggregate raw action-telemetry entries into the per-action dashboard view.
 * Pure + sync — the dashboard server calls this on the raw JSONL lines, and
 * the registry uses it for `getActionTelemetry()`. Dedupes repeated writes of
 * the same provider × model within an action (latest event wins) for the
 * "verified/killed" chips; counts stay raw so volumes are honest.
 */
/**
 * Parse a model-registry-actions.jsonl file into entries (skips corrupt lines).
 * Shared by the registry's getActionTelemetry() AND the dashboard server, so
 * both always agree on the parse — and on the filename (ACTION_LOG_FILENAME).
 */
export declare function readActionTelemetryFile(path: string): ActionTelemetryEntry[];
/**
 * Daily buckets covering the last TIMELINE_DAYS days (ascending, oldest first).
 * Pure — used by aggregateActionTelemetry so the dashboard gets a per-action
 * verified/killed/transient series over time.
 */
export declare function buildActionTimeline(entries: ActionTelemetryEntry[], days?: number, now?: number): ActionTelemetryInsights['actions'][number]['timeline'];
export declare function aggregateActionTelemetry(entries: ActionTelemetryEntry[]): ActionTelemetryInsights;
/**
 * Persistent model availability registry with sub-ms synchronous reads.
 *
 * Reads hit an in-memory snapshot (loaded synchronously from the JSON mirror
 * at construction). Writes update the snapshot, persist to the JSON mirror
 * synchronously (best-effort), then mirror to the VectorStore namespace
 * asynchronously (best-effort) when the vector stack is available.
 */
export declare class ModelRegistry {
    private data;
    /** Cached VectorStore for the enterprise mirror (null until first mirror). */
    private vectorStore;
    /** Whether the vector mirror has been confirmed usable. */
    private vectorMirrored;
    /** Lines in the action-telemetry JSONL log (-1 = not yet counted). */
    private actionLogCount;
    constructor();
    /**
     * Is `provider/model` usable RIGHT NOW?
     * True when the entry is verified, not quota-parked, and not stale.
     * Sub-ms: in-memory lookup only.
     */
    isUsable(provider: string, model: string, now?: number): boolean;
    /**
     * All verified, usable models for a provider (best first: latest verified).
     * Sync — the fast path for routing and the model picker.
     */
    getVerifiedModels(provider: string, now?: number): string[];
    /**
     * ALL tracked models for a provider (verified + unverified + unavailable).
     * Returns full ModelRegistryEntry objects so callers can inspect context
     * windows, latency, error rates, etc. Sync.
     */
    getAllModelsForProvider(provider: string): ModelRegistryEntry[];
    /** Providers that currently have at least one verified, usable model. Sync. */
    getUsableProviders(now?: number): string[];
    /**
     * Providers the registry has DEFINITIVELY ruled out right now: every tracked
     * model for the provider is `unavailable` and/or quota-parked, with no
     * verified usable alternative. Sync + sub-ms (in-memory only) — the
     * predictive skip that lets routing avoid a provider the registry already
     * knows is dead instead of failing into it reactively.
     *
     * Providers with ONLY `unverified` entries are NOT blocked — "not yet
     * probed" is not "dead" — and a provider with any verified model stays
     * routable (model repair will pick the working one).
     */
    getBlockedProviders(now?: number): string[];
    /**
     * Providers the registry has effectively written off: ZERO verified models
     * AND at least DEGRADED_UNAVAILABLE_THRESHOLD (3) unavailable entries.
     *
     * Stronger than `getBlockedProviders()` (which requires EVERY tracked model
     * to be unusable): a provider that has never verified a single model while
     * accumulating ≥3 definitive failures is a dead candidate — it should not
     * be scored, because the registry already knows it will fail. It stays
     * excluded until a re-probe / spot-check verifies something or the user
     * unblocks it (unblockProvider demotes to unverified, which no longer
     * meets the degraded bar). Sync + sub-ms.
     */
    getDegradedProviders(now?: number): string[];
    /**
     * Per-provider availability snapshot for a provider (sync) — the raw counts
     * the router and `models explain` cite when a provider is excluded by
     * registry data ("openrouter excluded — 0 verified, 6 unavailable").
     */
    getProviderStats(provider: string, now?: number): {
        verified: number;
        unverified: number;
        unavailable: number;
        parked: number;
    };
    /** Get the raw entry (for diagnostics). Sync. */
    getEntry(provider: string, model: string): ModelRegistryEntry | undefined;
    /**
     * Resolve a WORKING model for a provider, preferring a curated known-good
     * verified model. Sync — used by the model validator's fast path.
     *
     * @param preferred Ordered candidate models (curated defaults first).
     * @returns The first candidate that is verified+usable, else undefined.
     */
    resolveVerifiedModel(provider: string, preferred: string[], now?: number): string | undefined;
    /**
     * P4 M4.4: append the entry's current partialRate to its history (newest
     * last, capped at MAX_PARTIAL_HISTORY). Callers invoke this right after a
     * partialRate mutation so the dashboard sparkline sees the exact trajectory.
     */
    private pushPartialHistory;
    /**
     * listModels probe: mark the model as seen (unverified unless already
     * verified). Does NOT downgrade a verified entry — real verification wins.
     * Accepts either bare ids (legacy callers) or full model descriptors; when
     * a descriptor carries the provider-advertised context window, it is
     * recorded so the router's context preflight can use the LIVE value.
     */
    markListed(provider: string, models: Array<string | ModelDescriptor>): void;
    /**
     * Mark a model verified (spot-check success or real telemetry success).
     * Optionally records measured latency (rolling EMA).
     *
     * A genuine verification CLEARS any quota park: a real 1-token spot-check or
     * a real usage success is direct evidence the provider serves requests again,
     * so a stale learned park (e.g. an hour-aligned rate-limit park) must not
     * keep a recovered provider blocked. This is safe because `syncQuota()`
     * re-applies genuine ledger parks on the next routing read — a provider that
     * is REALLY still quota-exhausted gets re-parked immediately, while one that
     * merely had a stale learned park stays routable (the recovery loop).
     *
     * Asymmetry note: parks set by the REGISTRY's own rate-limit telemetry
     * (`recordCall(ok=false, 'rate-limit')`) live only here and are NOT re-applied
     * by syncQuota (which mirrors ledger cooldowns). Clearing them on any
     * successful verification is deliberate and self-correcting: a probe or real
     * call that SUCCEEDED is proof the limit lifted; if the limit persists, the
     * next real call fails again and re-parks.
     */
    markVerified(provider: string, model: string, source: ModelRegistrySource, latencyMs?: number, action?: string, costUsd?: number, callId?: string): void;
    /**
     * M2.2: record EXACT tokens from a provider-reported usage payload. The
     * per-call token EMAs (α=0.3, matching latency) feed getMeasuredUsage(),
     * which Auto routing uses to replace TYPICAL-token estimates with measured
     * cost. Best-effort — never throws.
     */
    recordMeasuredUsage(provider: string, model: string, inputTokens: number, outputTokens: number): void;
    /**
     * M2.2: aggregated measured token profile for a provider (sample-weighted
     * average across its tracked models). Returns undefined when no measured
     * usage exists → callers fall back to TYPICAL-token estimates (flagged).
     * Sync + sub-ms.
     */
    getMeasuredUsage(provider: string): {
        inputTokens: number;
        outputTokens: number;
        samples: number;
    } | undefined;
    /**
     * Mark a model unavailable (spot-check auth/403/404, or telemetry failure).
     * Optionally applies a quota park (e.g. rate-limit).
     */
    markUnavailable(provider: string, model: string, reason: string, source: ModelRegistrySource, quotaParkedUntil?: number, action?: string): void;
    /**
     * Park a SINGLE model for a quota window (rate-limit / 429) WITHOUT demoting
     * its status.
     *
     * This is the probe-side counterpart to `recordCall(ok=false,'rate-limit')`:
     * a transient quota blip must never flip a model to `unavailable` (which
     * `isUsable()` then treats as permanently dead until a manual unblock), or a
     * single 429 during a refresh would exclude a perfectly good model forever.
     * The entry keeps its prior status (verified stays verified) and is gated
     * only by `quotaParkedUntil`, so it re-enters routing automatically the
     * moment the window lapses — "probed, and made available again when it is".
     *
     * @param until Absolute epoch ms when the park expires (must be > now to gate).
     */
    parkModel(provider: string, model: string, reason: string, until: number, source: ModelRegistrySource): void;
    /** Apply the quota ledger's parked-provider status to a provider's entries.
     *
     * FIX: Only park models that are NOT verified. A verified model has proven
     * it works — blanket-parking it because a DIFFERENT model in the same
     * provider hit a rate limit blocks working models unnecessarily (the
     * "Gemini parking bug"). The per-model parking from recordCall() already
     * handles the specific rate-limited model.
     */
    parkProvider(provider: string, until: number): void;
    /** Clear a quota park for a provider (manual re-enable / window reset). */
    releaseProvider(provider: string): void;
    /**
     * Manual escape hatch — `nuvira models unblock <provider>`.
     *
     * Releases a provider that routing has predictively blocked (`getBlockedProviders()`):
     * demotes every `unavailable` entry back to `unverified` and clears all quota
     * parks, so the provider is no longer skipped before scoring. `unverified`
     * alone never blocks ("not yet probed" ≠ "dead"), which is exactly the state
     * an unblock should produce — the caller then RE-PROBES against the live API
     * so the registry re-learns the truth: if the provider genuinely recovered it
     * becomes `verified` again; if it is still dead the re-probe flips it back to
     * `unavailable` (one honest probe, not a permanent skip).
     *
     * Also used by the ledger-sync boundary: the caller should release the central
     * quota ledger's cooldown too, otherwise `syncQuota()` re-parks the provider
     * on the very next routing read (this method only clears REGISTRY state).
     *
     * @returns How many entries were demoted / un-parked (0/0 when untracked).
     */
    unblockProvider(provider: string): {
        demoted: number;
        unparked: number;
    };
    /**
     * Telemetry write-through from a real LLM call.
     * Success → verified (source 'telemetry') + lastUsedAt. Failure → errorRate
     * bump; auth failures demote to unavailable; rate-limit failures park the
     * entry WITHOUT demoting it (transient exclusion, auto-recovery after the
     * window lapses).
     *
     * @param ok        Did the call succeed?
     * @param errorType Optional classified error type ('auth' | 'rate-limit' | ...)
     */
    recordCall(provider: string, model: string, ok: boolean, errorType?: string, action?: string, latencyMs?: number, costUsd?: number, callId?: string, 
    /** Provider-reported reset hint in ms (Retry-After / "try again in Ns"). */
    retryAfterMs?: number): void;
    /**
     * P4 M4.4: record a MID-STREAM interruption (the provider started streaming
     * then died before completion) as a distinct `partial` telemetry event.
     *
     * Unlike `recordCall(ok=false)` — which flips status for definitive failures
     * and decays errorRate — a partial death is neither a clean error nor a
     * definitive kill: the provider demonstrably STARTED serving (its model is
     * real and authenticated) but couldn't FINISH. That is the exact flaky-
     * mid-stream signal the roadmap wants the router to learn from, so it is
     * recorded as a dedicated outcome in the action log WITHOUT flipping status
     * or mutating health (a partial today may complete tomorrow).
     *
     * Best-effort — never throws, never breaks the streaming call.
     *
     * @param action     The action that hit the interruption (chat / execute / ...).
     * @param errorType  Classified reason (server / timeout / network / ...).
     * @param streamedChunks  How many tokens had already streamed (context for
     *   the dashboard — the bigger the partial, the more "almost finished").
     */
    recordPartial(provider: string, model: string, action: string, errorType?: string, streamedChunks?: number): void;
    /**
     * P4 M4.4: worst mid-stream flakiness (partialRate) across a provider's
     * tracked models — the router's single-number signal for "this provider
     * keeps starting streams that die." 0 = no partials recorded (or healed).
     */
    getProviderFlakiness(provider: string): number;
    /**
     * Action-attributed telemetry log (model-registry-actions.jsonl) — which
     * action killed or verified which provider × model, so the dashboard's
     * "learned from real usage" panel makes predictive skips visible. Capped
     * (rotation amortized). Best-effort — never breaks telemetry.
     */
    private appendActionLog;
    private countActionLogLines;
    /** Aggregated per-action "learned from real usage" view (dashboard / CLI). Sync. */
    getActionTelemetry(): ActionTelemetryInsights;
    /**
     * Sync quota parks AND full usage telemetry from the QuotaLedger, so the
     * registry's FAISS/JSON snapshot alone answers "is it healthy, how many
     * tokens remain, how long until the window resets". The ledger stays the
     * WRITER of usage; the registry is the enterprise READ model the router
     * consumes — one sub-ms sync store on the pick path.
     *
     * Parks are applied only when the new window actually EXTENDS the existing
     * park (no redundant writes), and the usage fields are only written when
     * they differ, so calling this on every routing decision is cheap and never
     * rewrites the mirror on a hot path.
     */
    syncQuota(configManager?: ConfigManager): void;
    /**
     * UNIFIED router feed: providers that must sink below healthy candidates
     * because they are quota-exhausted or in cooldown — computed from the
     * registry's own mirrored data (sub-ms, no I/O) with a cheap union fallback
     * to the in-memory ledger for providers the registry has never tracked (so
     * an exhausted-but-unprobed provider is still excluded). Shape mirrors
     * `circuitBreakerStatus` so the AutoModelRouter consumes it identically.
     * The ledger remains the WRITER of usage; the registry is the primary READ
     * model — the union is a same-process in-memory read, never disk or network.
     */
    getRouterQuotaStatus(configManager?: ConfigManager): Array<{
        provider: string;
        cooldownRemaining: number;
    }>;
    /**
     * Emit a MODEL_REGISTRY_UPDATED event so the watch daemon (the dedicated
     * model-health agent) learns about a mid-session state change IMMEDIATELY
     * and can re-verify the affected provider instead of waiting for its next
     * scheduled cycle. Best-effort — observability must never break the registry.
     *
     * @param source Who wrote the change: 'telemetry' (real session usage),
     *   'quota' (parks/releases), or 'probe' / 'spot-check' (the watcher's OWN
     *   writes). The watcher only reacts to telemetry/quota — it ignores its own
     *   probe writes so its re-verification can't self-trigger an infinite loop.
     */
    private emitUpdated;
    /**
     * Demote verified entries that haven't been re-verified recently to
     * `unverified` (they may have been retired / access revoked). Returns the
     * number demoted. Called by the watch daemon and refresh.
     */
    pruneStale(maxAgeMs?: number): number;
    /**
     * ISSUE-004 (4c): clean up entries for models that no longer exist on the
     * LOCAL system. When the user deletes a model (e.g. `ollama rm modelname`),
     * the registry was still holding its entry and every probe/stats pass kept
     * re-checking a model that's gone — the "deleted model is still checked every
     * time" feedback.
     *
     * Only call this with an AUTHORITATIVE live list (the refresh probe of a
     * keyless/local runner). Entries whose model is NOT in the list are handled:
     *   - UNVERIFIED / UNAVAILABLE entries are DELETED entirely (never checked
     *     again — they have no learned value worth keeping).
     *   - VERIFIED entries are DEMOTED to `unavailable` with reason "model
     *     deleted from local system" instead of being hard-deleted — a partial
     *     listModels response (a model mid-pull, a gateway hiccup) must not
     *     silently destroy the learned latency/token telemetry of a model that
     *     may merely be temporarily unlisted. The demote keeps it out of routing
     *     while preserving its history for re-verification.
     *
     * Returns the number of entries cleaned up (deleted + demoted). Best-effort
     * — never throws.
     */
    pruneAbsentModels(provider: string, liveModels: string[]): number;
    /** Load the JSON mirror synchronously (never throws). */
    private loadMirror;
    /**
     * Persist: JSON mirror synchronously (canonical, guaranteed), then mirror to
     * the VectorStore namespace asynchronously (best-effort, auto-tiers to JSON
     * when FAISS/native aren't installed — so it can never throw).
     */
    private persist;
    /**
     * Synchronous mirror to the vector-store namespace file.
     *
     * Writes the snapshot directly into the SHARED `vectors-model-registry.json`
     * file — the exact on-disk entry format every VectorStore backend (JSON,
     * pure-JS IVF, native FAISS) reads via `readNamespaceEntries`. This is
     * deliberately SYNCHRONOUS and pinned to the persist-time dir: an async
     * fire-and-forget write resolves its path lazily after awaits, so a dangling
     * promise from an earlier test would write to whatever NUVIRA_MEMORY_DIR is at
     * that later moment (the real ~/.nuvira/memory) and leak test data. A sync
     * write has no such race and is equally best-effort (never throws).
     */
    private mirrorToVector;
    /** Load the vector-store mirror into memory if it's newer than the JSON file. */
    hydrateFromVector(): Promise<boolean>;
    /** Name of the vector backend in use ('json' | 'faiss-ivf' | 'faiss-native' | 'unavailable'). */
    vectorBackendName(): Promise<string>;
    /** Full status snapshot (CLI `models status` / dashboard). */
    getStatus(): Promise<ModelRegistryStatus>;
    /** Human-readable summary for the CLI (incl. quota telemetry from the unified store). */
    formatStatus(): Promise<string>;
    /** Compact human duration (e.g. '3h 12m', '45s'). */
    private formatMs;
    /** Clear the registry (CLI / tests). */
    reset(): void;
}
/** Get or create the ModelRegistry singleton. */
export declare function getModelRegistry(): ModelRegistry;
/** Reset the singleton (tests + after vector-backend changes). */
export declare function resetModelRegistry(): void;
//# sourceMappingURL=model-registry.d.ts.map