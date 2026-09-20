/**
 * Provider revival — the "one more round of check" before giving up on a
 * provider that failed transiently.
 *
 * THE BUG THIS FIXES (verified): a provider that fails transiently (server /
 * network / timeout) is put in a short session exclusion AND, separately, marked
 * in a `transientFailed` set that carries the documented promise — "awaiting a
 * quick on-demand spot-check before re-admission (never re-pick without proof)".
 * That promise was kept in exactly ONE place: `chat.ts`'s session loop. Every
 * other entry path allocated the marker and never read it:
 *
 *   path               allocates   reads (revives)
 *   chat.ts            ✅          ✅
 *   orchestrator.ts    ✅          ✅  (covers execute.ts's pipeline path)
 *   resilient-call.ts  ✅          ✅
 *   edit.ts            ✅          ✅  (via the runSingleShotAuto `revive` hook)
 *   execute.ts         ✅          ✅  (the follow-up path that bypasses the
 *                                      orchestrator sweeps its own session)
 *   plan.ts            ✅          ✅  (via the runSingleShotAuto `revive` hook)
 *
 * Every allocating path now reads what it arms. When this was not true, an
 * exhausted provider stayed
 * excluded for the rest of the session even after it recovered, and the run
 * either degraded or died — while the machinery to prove recovery in seconds sat
 * unused. Live evidence: a pipeline run hit a Gemini 503, the breaker parked the
 * provider, context-gatherer fell back to "0 relevant files", and the writer then
 * edited blind. A single capacity spike at one endpoint became a wrong answer.
 *
 * WHY A STORE ADAPTER: the callers keep their session state in two different
 * shapes — `FailureSessionState` (chat/orchestrator/edit/plan/execute) and
 * resilient-call's own `{ expiresAt, kind }` maps. Rather than duplicate the
 * probe logic per shape (the duplication that caused this bug), the probe works
 * against this small port and each caller adapts.
 *
 * Cycle safety: `auto-router.js` is imported LAZILY (only when a caller does not
 * supply its own model resolver), so this module can be imported from the
 * router's own dependencies without creating a static cycle.
 */

import { spotCheckModel } from '../inference/model-probe.js';
import { getModelRegistry } from './model-registry.js';
import { TRANSIENT_FAILURE_EXCLUSION_MS, type FailureSessionState } from './failure-bookkeeping.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';

/** The outcome shape `spotCheckModel` returns, without importing its name. */
type ProbeOutcome = Awaited<ReturnType<typeof spotCheckModel>>;

/**
 * The port a caller adapts its failure state to. Deliberately tiny: the sweep
 * needs to enumerate candidates, ask whether an exclusion is still active, and
 * either clear or re-arm one.
 */
export interface RevivalStore {
  /** Providers currently marked as transiently failed. */
  transientProviders(): Iterable<string>;
  /** Is this provider's exclusion still in force at `now`? */
  isExclusionActive(provider: string, now: number): boolean;
  /** Re-admit the provider (clear its exclusion + its transient marker). */
  clearProvider(provider: string): void;
  /** Keep it excluded for another transient window. */
  reArmProvider(provider: string, until: number): void;
  /** The concrete model to probe for this provider. */
  resolveProbeModel?(provider: string): string | undefined;
}

export interface RevivalSweepResult {
  /** Providers actually probed (network calls made). */
  probed: string[];
  /** Providers now re-admitted — either proven alive or no longer blocked. */
  revived: string[];
  /** Providers that failed the probe and keep their exclusion. */
  stillDown: string[];
}

export interface RevivalSweepOptions {
  /**
   * Max providers probed per sweep. Each probe is a 1-token generation, so this
   * bounds the latency a sweep can add to a foreground turn. Default 3.
   */
  maxProbes?: number;
  /** Agent type used when resolving a probe model (default 'chat'). */
  agentType?: string;
  /** Injectable probe (tests). Defaults to the real 1-token spot-check. */
  probe?: (provider: string, model: string, configManager: ConfigManager) => Promise<ProbeOutcome>;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Visibility hook — a revival is worth showing in the console/trace. */
  onEvent?: (line: string) => void;
}

const DEFAULT_MAX_PROBES = 3;

/**
 * Adapt a raw (exclusions, transient markers) pair to the revival port. This is
 * the shape every CLI path holds, including chat, whose two collections are
 * instance fields rather than a `FailureSessionState` object.
 */
export function collectionRevivalStore(
  sessionFailedProviders: Map<string, number>,
  sessionTransientFailedProviders: Set<string>,
): RevivalStore {
  return {
    transientProviders: () => sessionTransientFailedProviders,
    isExclusionActive: (provider, now) => {
      const expiresAt = sessionFailedProviders.get(provider);
      return expiresAt !== undefined && expiresAt > now;
    },
    clearProvider: (provider) => {
      sessionTransientFailedProviders.delete(provider);
      sessionFailedProviders.delete(provider);
    },
    reArmProvider: (provider, until) => {
      sessionFailedProviders.set(provider, until);
      sessionTransientFailedProviders.add(provider);
    },
  };
}

/** Adapt the shared `FailureSessionState` to the revival port. */
export function sessionRevivalStore(session: FailureSessionState): RevivalStore {
  return collectionRevivalStore(session.sessionFailedProviders, session.sessionTransientFailedProviders);
}

/**
 * Re-verify transiently-failed providers and re-admit the ones that recovered.
 *
 * Contract (identical to the chat path this was extracted from, so behaviour does
 * not change there):
 *   - a provider whose exclusion is still ACTIVE is left alone;
 *   - a provider the registry no longer blocks needs no probe — it is re-admitted;
 *   - otherwise a 1-token spot-check decides: verified/skipped → re-admit,
 *     anything else → re-arm the exclusion for another transient window.
 *
 * Never throws: revival is an optimisation and must never break a call.
 */
export async function sweepTransientFailures(
  store: RevivalStore,
  configManager: ConfigManager,
  options: RevivalSweepOptions = {},
): Promise<RevivalSweepResult> {
  const result: RevivalSweepResult = { probed: [], revived: [], stillDown: [] };
  const now = options.now ?? Date.now;
  const probe = options.probe ?? spotCheckModel;
  const maxProbes = options.maxProbes ?? DEFAULT_MAX_PROBES;
  const agentType = options.agentType ?? 'chat';

  try {
    // SNAPSHOT: clearProvider/reArmProvider mutate the set, and Set iteration can
    // revisit a re-added key — which would double-probe it.
    const candidates = [...store.transientProviders()];
    if (candidates.length === 0) return result;

    for (const provider of candidates) {
      if (result.probed.length >= maxProbes) break;

      const at = now();
      if (store.isExclusionActive(provider, at)) continue;

      // Optimistic: assume admitted, then re-arm if the probe says otherwise.
      // (A throw anywhere below leaves the provider admitted, exactly like the
      // chat path did — an unreachable registry must not freeze a provider out.)
      store.clearProvider(provider);

      const registry = getModelRegistry();
      if (!registry.getBlockedProviders().includes(provider)) {
        // Nothing to prove: the registry already considers it healthy (a
        // time-based park lapsed, or telemetry healed it).
        result.revived.push(provider);
        continue;
      }

      let desired: string | undefined;
      try {
        desired = store.resolveProbeModel?.(provider) ?? (await defaultProbeModel(provider, agentType, configManager));
      } catch {
        desired = undefined;
      }
      // No model to probe → the registry block is not about a specific model we
      // can verify; admit it rather than stranding the provider forever.
      if (!desired) {
        result.revived.push(provider);
        continue;
      }

      result.probed.push(provider);
      const outcome = await probe(provider, desired, configManager);
      // 'skipped' = the model was verified recently (inside the spot-check
      // throttle) — that is healthy, so it counts as a pass.
      if (outcome === 'verified' || outcome === 'skipped') {
        result.revived.push(provider);
        options.onEvent?.(`   ♻️ ${provider} is back — re-admitted after a spot-check`);
        logger.info(`   ♻️ ${provider} recovered (spot-check ${outcome}) — re-admitted to routing`);
      } else {
        store.reArmProvider(provider, at + TRANSIENT_FAILURE_EXCLUSION_MS);
        result.stillDown.push(provider);
      }
    }
  } catch {
    // Best-effort — a sweep failure must never break the call that triggered it.
  }

  return result;
}

/**
 * Default probe model: the router's own pick for this provider, so the sweep
 * verifies the model that routing would actually serve. Lazy import keeps this
 * module free of a static dependency on the router.
 */
async function defaultProbeModel(
  provider: string,
  agentType: string,
  configManager: ConfigManager,
): Promise<string | undefined> {
  const { getAutoRouter } = await import('./auto-router.js');
  const model = getAutoRouter().resolveModel(provider, agentType, configManager);
  return model && model !== 'default' ? model : undefined;
}
