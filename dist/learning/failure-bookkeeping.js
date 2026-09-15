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
import { getQuotaLedger, accountIdForKey } from './quota-ledger.js';
import { getKeyHygiene } from './key-hygiene.js';
import { classifyFallbackError, extractRetryAfterMs, getProviderFallback, MIN_RATE_LIMIT_PARK_MS, recordRegistryFailure, } from './provider-fallback.js';
// ─── Session state ──────────────────────────────────────────────────────────
/**
 * Per-session failure state that the caller owns (so the helper stays pure and
 * the caller controls lifecycle). Chat keeps exactly this shape today.
 */
/**
 * M2.3: park a specific provider account/key in the quota ledger so key
 * rotation skips it while other keys of the same provider stay usable.
 * Best-effort — never throws; no-ops when no key was supplied.
 */
function parkAccountForKey(providerType, apiKey, until, reason) {
    if (!apiKey)
        return;
    try {
        getQuotaLedger().parkAccount(providerType, accountIdForKey(apiKey), until, reason);
    }
    catch {
        // Best-effort — account bookkeeping must not crash a call.
    }
}
/** How many DISTINCT models of one provider must rate-limit before the limit
 * is treated as provider-wide (shared TPM) and escalated to a provider park. */
export const PROVIDER_RATE_LIMIT_ESCALATION_MODELS = 2;
/** Session-exclusion key for a single provider × model. */
export function modelExclusionKey(providerType, model) {
    return `${providerType}|${model}`;
}
/**
 * Is this exact provider × model excluded for the session right now?
 * Best-effort — a caller without model tracking (undefined map) always returns
 * false, preserving the older provider-only behavior.
 */
export function isModelSessionExcluded(session, providerType, model, now = Date.now()) {
    if (!model || !session.sessionFailedModels)
        return false;
    const expiresAt = session.sessionFailedModels.get(modelExclusionKey(providerType, model));
    return expiresAt !== undefined && expiresAt > now;
}
// ─── Exclusion windows ──────────────────────────────────────────────────────
/**
 * How long a rate-limit failure excludes a provider from auto routing (ms).
 * Aligned with the circuit breaker's COOLDOWN_DURATION_MS (120s) so the
 * session-level exclusion and the breaker's scoring cooldown expire together.
 */
export const RATE_LIMIT_EXCLUSION_MS = 2 * 60 * 1000;
/**
 * How long a server/network/timeout/unknown failure excludes a provider from
 * auto routing (ms). Shorter than rate-limit so a flaky-but-alive provider is
 * re-admitted quickly, but long enough that the very NEXT message never
 * re-picks a provider that just failed.
 */
export const TRANSIENT_FAILURE_EXCLUSION_MS = 60 * 1000;
// ─── Shared composition ─────────────────────────────────────────────────────
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
export function recordActionFailure(session, providerType, err, configManager, options) {
    const failureKind = classifyFallbackError(err);
    const now = Date.now();
    // ── 1. Session-level exclusion ────────────────────────────────────────
    if (failureKind === 'auth') {
        // Expired token/key — definitive for the rest of the session.
        session.sessionFailedProviders.set(providerType, Number.MAX_SAFE_INTEGER);
        // M2.3: this SPECIFIC key is dead for the session — park its account so
        // key rotation skips it while OTHER keys of the same provider stay usable.
        parkAccountForKey(providerType, options?.apiKey, Number.MAX_SAFE_INTEGER, failureKind);
        // ISSUE-004 (4b/4d): N consecutive auth failures CLEARS the invalid key
        // from the config (or tells the user which env var to fix) and surfaces an
        // actionable error — the key stops being a routing candidate instead of
        // failing reactively forever. Best-effort — never breaks the call.
        try {
            getKeyHygiene().recordAuthFailure(providerType, configManager, options?.apiKey);
        }
        catch {
            // Best-effort — key hygiene must never crash a call.
        }
    }
    else if (failureKind === 'rate-limit') {
        // Exhausted quota / token-limit — usually transient, so only a short
        // cooldown before the provider is re-admitted to auto routing.
        //
        // PER-MODEL FIRST: when the failing model is known, exclude THAT model and
        // leave its siblings routable. Free tiers meter per-model (Groq's per-model
        // RPD, Gemini's per-model RPD), so excluding the whole provider here is what
        // made one 429 drain every model the user had. Only escalate to the
        // provider-level exclusion when the limit is genuinely shared (the caller
        // tracks models and several distinct ones are now parked) or when we don't
        // know which model failed.
        const failingModel = options?.model;
        const trackModels = !!session.sessionFailedModels && !!failingModel && failingModel !== 'default';
        if (trackModels) {
            session.sessionFailedModels.set(modelExclusionKey(providerType, failingModel), now + RATE_LIMIT_EXCLUSION_MS);
        }
        else {
            session.sessionFailedProviders.set(providerType, now + RATE_LIMIT_EXCLUSION_MS);
        }
        // Park the provider in the CENTRAL quota ledger until its reset window
        // rolls so the exclusion survives across chat sessions (the ledger is
        // read by the auto router before every pick, so the next session skips
        // the exhausted provider predictively instead of failing reactively).
        // FIX: Distinguish between user-configured window and bare default.
        // When the user explicitly configures windowMs, honor it (represents the
        // actual rate-limit reset window). When NO config exists, use a short
        // default (60s) instead of 24h — a bare 429 without Retry-After should
        // not strand a provider for a full day.
        let windowMs;
        let hasExplicitConfig = false;
        try {
            const limit = configManager.getAll().routing?.quota?.[providerType];
            if (limit?.windowMs != null) {
                windowMs = limit.windowMs;
                hasExplicitConfig = true;
            }
            else {
                windowMs = 60 * 1000; // 60s default (was 24h — far too long)
            }
        }
        catch {
            windowMs = 60 * 1000;
        }
        // Honor the provider's OWN reset hint when the 429 carries one
        // (Retry-After / "try again in 16s" / x-ratelimit-reset-* headers): a
        // provider that says "resets in 16 minutes" must be re-admitted in ~16
        // minutes, NOT parked for the full 24h default window. Fall back to the
        // configured window when no hint is present (a bare 429 gives us nothing
        // to trust, so the conservative window stands). Capped by windowMs and
        // floored by MIN_RATE_LIMIT_PARK_MS so a 1s hint can't hot-loop.
        const hintMs = extractRetryAfterMs(err);
        // Priority: provider hint > configured window > short default.
        // 1. Provider gives reset time → HONOR IT (the provider knows its own
        //    limits — "try again in 16s" means exactly that, not "wait 24 hours")
        // 2. No hint but user configured windowMs → use it (represents the known window)
        // 3. No hint, no config → short default (10s) — a bare 429 means "try soon"
        const parkMs = hintMs !== null
            ? Math.max(hintMs, MIN_RATE_LIMIT_PARK_MS) // provider hint wins (floored to prevent hot-loop)
            : hasExplicitConfig ? windowMs : MIN_RATE_LIMIT_PARK_MS;
        // PER-MODEL QUOTA KEY: park the model that ACTUALLY 429ed, not the whole
        // provider. Its siblings have their own limits and must stay routable
        // ("use every available model before giving up"). The registry mirrors the
        // model-level park onto the exact entry, so the router skips that entry and
        // still serves from the provider's other models.
        try {
            const ledger = getQuotaLedger();
            if (failingModel && failingModel !== 'default') {
                ledger.parkModel(providerType, failingModel, now + parkMs, failureKind);
                // SHARED-QUOTA ESCALATION: several DISTINCT models of the same provider
                // rate-limited ⇒ the limit is provider-wide (Groq's free-tier TPM is
                // shared across ALL of its models, so round-robining siblings can never
                // escape it). Escalate to a provider park instead of hot-looping 429s.
                if (ledger.getParkedModelCount(providerType) >= PROVIDER_RATE_LIMIT_ESCALATION_MODELS) {
                    ledger.parkProvider(providerType, now + parkMs, `${failureKind} (shared across models)`);
                    // The provider as a whole is now excluded, not just the model.
                    session.sessionFailedProviders.set(providerType, now + RATE_LIMIT_EXCLUSION_MS);
                }
            }
            else {
                ledger.parkProvider(providerType, now + parkMs, failureKind);
            }
        }
        catch {
            // Best-effort — ledger bookkeeping must not crash a call.
        }
        // M2.3: park the SPECIFIC account/key too (rotation skips it while
        // other keys of the same provider stay usable).
        parkAccountForKey(providerType, options?.apiKey, now + parkMs, failureKind);
    }
    else {
        // Server / network / timeout / unknown — transient but definitive enough
        // that the next message shouldn't re-pick this provider. Short cooldown,
        // then re-admit (it may have recovered). Tracked as transient so the
        // expiry path re-verifies with a spot-check before re-admitting.
        session.sessionFailedProviders.set(providerType, now + TRANSIENT_FAILURE_EXCLUSION_MS);
        session.sessionTransientFailedProviders.add(providerType);
    }
    // ── 4. Registry write-through (per-action telemetry) ──────────────────
    // auth/rate-limit flips the entry to `unavailable` (rate-limit also parks
    // it), model-not-found becomes a definitive block, and transient failures
    // decay the health score — getBlockedProviders() feeds all of it back into
    // routing as a predictive skip. The shared helper also honors the
    // BUFF_TELEMETRY_ACTION env override (VS Code extension spawns).
    recordRegistryFailure(providerType, options?.model, err, failureKind, options?.action);
    // ── 5. Quota-timeline failover event (dashboard visibility) ───────────
    try {
        getQuotaLedger().recordEvent('failover', providerType, failureKind);
    }
    catch {
        // Best-effort — timeline bookkeeping must not crash a call.
    }
    // ── 6. Shared circuit breaker ─────────────────────────────────────────
    // Repeated failures open the breaker so the auto router deprioritizes the
    // provider by scoring even for transient errors.
    try {
        getProviderFallback(configManager).recordFailure(providerType);
    }
    catch {
        // Best-effort — circuit-breaker bookkeeping must not crash a call.
    }
}
//# sourceMappingURL=failure-bookkeeping.js.map