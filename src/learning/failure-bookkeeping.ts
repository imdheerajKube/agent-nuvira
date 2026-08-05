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
import {
  classifyFallbackError,
  getProviderFallback,
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
export function recordActionFailure(
  session: FailureSessionState,
  providerType: string,
  err: unknown,
  configManager: ConfigManager,
  options?: { model?: string; action?: string; apiKey?: string },
): void {
  const failureKind = classifyFallbackError(err);
  const now = Date.now();

  // ── 1. Session-level exclusion ────────────────────────────────────────
  if (failureKind === 'auth') {
    // Expired token/key — definitive for the rest of the session.
    session.sessionFailedProviders.set(providerType, Number.MAX_SAFE_INTEGER);
    // M2.3: this SPECIFIC key is dead for the session — park its account so
    // key rotation skips it while OTHER keys of the same provider stay usable.
    parkAccountForKey(providerType, options?.apiKey, Number.MAX_SAFE_INTEGER, failureKind);
  } else if (failureKind === 'rate-limit') {
    // Exhausted quota / token-limit — usually transient, so only a short
    // cooldown before the provider is re-admitted to auto routing.
    session.sessionFailedProviders.set(providerType, now + RATE_LIMIT_EXCLUSION_MS);
    // Park the provider in the CENTRAL quota ledger until its reset window
    // rolls so the exclusion survives across chat sessions (the ledger is
    // read by the auto router before every pick, so the next session skips
    // the exhausted provider predictively instead of failing reactively).
    let windowMs = 24 * 60 * 60 * 1000;
    try {
      const limit = configManager.getAll().routing?.quota?.[providerType];
      windowMs = limit?.windowMs ?? windowMs;
      getQuotaLedger().parkProvider(providerType, now + windowMs, failureKind);
    } catch {
      // Best-effort — ledger bookkeeping must not crash a call.
    }
    // M2.3: park the SPECIFIC account/key too (rotation skips it while
    // other keys of the same provider stay usable).
    parkAccountForKey(providerType, options?.apiKey, now + windowMs, failureKind);
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
  try {
    getProviderFallback(configManager).recordFailure(providerType);
  } catch {
    // Best-effort — circuit-breaker bookkeeping must not crash a call.
  }
}
