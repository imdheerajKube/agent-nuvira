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
import { getQuotaLedger, accountIdForKey } from './quota-ledger.js';
import { getKeyHygiene } from './key-hygiene.js';
import {
  classifyFallbackError,
  extractRetryAfterMs,
  getProviderFallback,
  isHarnessFault,
  MIN_RATE_LIMIT_PARK_MS,
  recordRegistryFailure,
  type FallbackErrorType,
} from './provider-fallback.js';

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
function parkAccountForKey(
  providerType: string,
  apiKey: string | undefined,
  until: number,
  reason: string,
): void {
  if (!apiKey) return;
  try {
    getQuotaLedger().parkAccount(providerType, accountIdForKey(apiKey), until, reason);
  } catch {
    // Best-effort — account bookkeeping must not crash a call.
  }
}

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
  /**
   * `provider|model` → expiry of a MODEL-scoped session exclusion.
   *
   * A rate limit on ONE model must not exclude its siblings: free tiers meter
   * per-model (RPD/TPM), so 429s land here whenever the failing model is known
   * and only escalate to `sessionFailedProviders` when the limit is genuinely
   * shared (several distinct models of the provider rate-limited) or when the
   * failing model is unknown. Optional — callers that don't track it keep the
   * historical provider-wide behavior.
   */
  sessionFailedModels?: Map<string, number>;
  /**
   * T4 — provider → recent failure timestamps (ms epoch) for the RPM/TPM
   * rapid-failure breaker. Scoped to THIS session/turn on purpose: a burst of
   * failures inside one tool loop is what escalates, and state must never leak
   * across unrelated runs. Optional — callers that omit it just never escalate.
   */
  rapidFailures?: Map<string, number[]>;
}

/** How many DISTINCT models of one provider must rate-limit before the limit
 * is treated as provider-wide (shared TPM) and escalated to a provider park. */
export const PROVIDER_RATE_LIMIT_ESCALATION_MODELS = 2;

/** Session-exclusion key for a single provider × model. */
export function modelExclusionKey(providerType: string, model: string): string {
  return `${providerType}|${model}`;
}

/**
 * Is this exact provider × model excluded for the session right now?
 * Best-effort — a caller without model tracking (undefined map) always returns
 * false, preserving the older provider-only behavior.
 */
export function isModelSessionExcluded(
  session: FailureSessionState,
  providerType: string,
  model: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!model || !session.sessionFailedModels) return false;
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
 * How long a provider × model pair is excluded after it resolved with NOTHING
 * usable — an HTTP 200 carrying neither answer text nor a tool call (see
 * `response-usability.ts`).
 *
 * MODEL-scoped on purpose, and never escalated to the provider: the transport
 * worked and the provider answered, so its OTHER models are very often
 * perfectly healthy — the live case was one local model returning nothing on
 * five consecutive steps while Gemini sat configured and unused. Two minutes is
 * long enough to cover a turn plus its retries, short enough that a genuinely
 * transient empty self-heals with no user action.
 *
 * The failover walk (`resilient-call.ts`) uses this same constant for its own
 * pair exclusion, so the session and cross-pipeline windows cannot drift.
 */
export const EMPTY_RESPONSE_SESSION_EXCLUSION_MS = 2 * 60 * 1000;

// ─── T4 — RPM/TPM rapid-failure breaker ─────────────────────────────────────
//
// Free tiers meter requests/tokens PER MINUTE, but a 429 with no reset hint
// only parked the provider for MIN_RATE_LIMIT_PARK_MS (10s) — shorter than the
// minute an RPM window needs. A tool-heavy loop then re-picked the same free
// provider on its very next step and 429ed again (observed live on the loop
// engine: gemini free tier, limit 15 RPM, rapid tool-call steps). This breaker
// watches for REPEATED failures of one provider inside a short window and
// raises the park floor to a full minute, so the provider rests for the rest of
// the window instead of hot-looping against it.

export const RAPID_FAILURE_WINDOW_MS = 60 * 1000;

export const RAPID_FAILURE_THRESHOLD = 3;

export const RAPID_FAILURE_COOLDOWN_MS = 60 * 1000;

/**
 * Record one failure for a provider and report whether it has now failed
 * `RAPID_FAILURE_THRESHOLD` times inside `RAPID_FAILURE_WINDOW_MS` — the point
 * at which waiting the base park length would be pointless. State lives on the
 * caller's session so a burst is measured per turn/run, never globally.
 */
export function recordRapidFailure(
  session: FailureSessionState,
  providerType: string,
  now: number = Date.now(),
): boolean {
  const map = (session.rapidFailures ??= new Map<string, number[]>());
  const times = (map.get(providerType) ?? []).filter((t) => now - t < RAPID_FAILURE_WINDOW_MS);
  times.push(now);
  map.set(providerType, times);
  return times.length >= RAPID_FAILURE_THRESHOLD;
}

/** True when this provider is currently inside a rapid-failure window. */
export function isRapidFailureProvider(
  session: FailureSessionState,
  providerType: string,
  now: number = Date.now(),
): boolean {
  const times = session.rapidFailures?.get(providerType);
  if (!times) return false;
  return times.filter((t) => now - t < RAPID_FAILURE_WINDOW_MS).length >= RAPID_FAILURE_THRESHOLD;
}

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
export function recordActionFailure(
  session: FailureSessionState,
  providerType: string,
  err: unknown,
  configManager: ConfigManager,
  options?: { model?: string; action?: string; apiKey?: string },
): void {
  const failureKind = classifyFallbackError(err);
  const now = Date.now();

  // ── 0. Harness faults are NOT provider or model failures ───────────────
  // A deterministic request-shape rejection (Gemini's "function call is
  // missing a thought_signature" being the live case that motivated this) fails
  // identically for EVERY model on that provider, forever. Attributing it to the
  // provider/model is the most corrupting thing that can happen to the learning
  // loop: it parks a healthy provider, decays a healthy model's health score,
  // opens the circuit breaker, and teaches the bandit "this model is weak" from
  // a bug that would have broken any model on that transport — so the router
  // then AVOIDS the model that was actually fine.
  //
  // Nothing is booked here on purpose: no session exclusion, no quota park, no
  // registry write-through, no breaker trip. The FAILOVER still happens (the
  // caller re-routes; a different provider's adapter may not share the defect) —
  // only the attribution is withheld. Recorded on the quota timeline so the dash
  // can show why a run failed without it ever touching routing scores.
  if (isHarnessFault(err)) {
    try {
      getQuotaLedger().recordEvent('failover', providerType, 'harness-fault (not attributed)');
    } catch {
      // Best-effort — event bookkeeping must not crash a call.
    }
    return;
  }

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
    } catch {
      // Best-effort — key hygiene must never crash a call.
    }
  } else if (failureKind === 'rate-limit') {
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
      session.sessionFailedModels!.set(
        modelExclusionKey(providerType, failingModel!),
        now + RATE_LIMIT_EXCLUSION_MS,
      );
    } else {
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
    let windowMs: number;
    let hasExplicitConfig = false;
    try {
      const limit = configManager.getAll().routing?.quota?.[providerType];
      if (limit?.windowMs != null) {
        windowMs = limit.windowMs;
        hasExplicitConfig = true;
      } else {
        windowMs = 60 * 1000; // 60s default (was 24h — far too long)
      }
    } catch {
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
    let parkMs =
      hintMs !== null
        ? Math.max(hintMs, MIN_RATE_LIMIT_PARK_MS) // provider hint wins (floored to prevent hot-loop)
        : hasExplicitConfig ? windowMs : MIN_RATE_LIMIT_PARK_MS;
    // T4 — RPM/TPM rapid-failure escalation. Repeated failures of one provider
    // inside the window mean its limit is being re-hit faster than it resets, so
    // a 10s base park is useless — raise the floor to a full minute (the RPM
    // window). A single blip still uses the short base park, so nothing regresses
    // for a provider that merely hiccupped once.
    if (recordRapidFailure(session, providerType, now)) {
      parkMs = Math.max(parkMs, RAPID_FAILURE_COOLDOWN_MS);
    }
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
      } else {
        ledger.parkProvider(providerType, now + parkMs, failureKind);
      }
    } catch {
      // Best-effort — ledger bookkeeping must not crash a call.
    }
    // M2.3: park the SPECIFIC account/key too (rotation skips it while
    // other keys of the same provider stay usable).
    parkAccountForKey(providerType, options?.apiKey, now + parkMs, failureKind);
  } else if (failureKind === 'empty-response') {
    // ── An empty completion is a MODEL failure, not a provider outage ──────
    // The provider answered (HTTP 200, a real response body) and simply carried
    // no text and no tool call. So the pair is what must rest — exclude it and
    // leave its SIBLINGS routable, or one dead model would take a healthy
    // provider's whole model list out of the running. No quota park: nothing was
    // rate-limited, and the registry already parks this exact pair for
    // `EMPTY_RESPONSE_PARK_MS` (see `model-registry.recordCall`).
    const failingModel = options?.model;
    if (session.sessionFailedModels && failingModel && failingModel !== 'default') {
      session.sessionFailedModels.set(
        modelExclusionKey(providerType, failingModel),
        now + EMPTY_RESPONSE_SESSION_EXCLUSION_MS,
      );
    } else {
      // No model attribution available — the provider is the only thing we can
      // hold back, so fall back to the transient provider exclusion.
      session.sessionFailedProviders.set(providerType, now + TRANSIENT_FAILURE_EXCLUSION_MS);
      session.sessionTransientFailedProviders.add(providerType);
    }
  } else {
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
  } catch {
    // Best-effort — timeline bookkeeping must not crash a call.
  }

  // ── 6. Shared circuit breaker ─────────────────────────────────────────
  // Repeated failures open the breaker so the auto router deprioritizes the
  // provider by scoring even for transient errors.
  //
  // EXCEPT for an empty-response: the breaker is PROVIDER-scoped, and an empty
  // completion is a MODEL property — the provider answered, on time, with a
  // well-formed HTTP 200. Tripping its breaker would deprioritize every healthy
  // sibling on that provider because one model returned nothing, which is the
  // same corruption the harness-fault guard at the top of this function exists
  // to prevent. The pair is already parked in the registry (see
  // `model-registry.recordCall`), so the model rests without the provider paying
  // for it.
  if (failureKind !== 'empty-response') {
    try {
      getProviderFallback(configManager).recordFailure(providerType);
    } catch {
      // Best-effort — circuit-breaker bookkeeping must not crash a call.
    }
  }
}
