import type { ConfigManager } from '../config/manager.js';
import type { AutoRouterOptions } from './auto-router.js';
import { getModelRegistry } from './model-registry.js';
import { capabilityRoutingPolicy, resolveCapabilityMode } from '../config/capability-mode.js';

/**
 * ISSUE-003: ONE resolve-options assembly for every action point.
 *
 * chat.ts and the orchestrator each hand the auto-router the FULL feature set
 * (bandit learning, quota-ledger status, runtime stats, cost/speed/reasoning
 * floors, escalation, paid-model gate). Plan, eval, benchmark, model explain,
 * and the edit auto-route walk build theirs through this helper so no mode
 * gets a degraded, "fixed-in-chat-only" routing experience.
 *
 * Lives in the learning layer (not cli) because BOTH the orchestrator (agents)
 * and the CLI commands consume it — importing a cli module from the agents
 * layer would invert the dependency direction.
 */
export function buildAutoResolveOptions(
  configManager: ConfigManager,
  extra: { contextHintTokens?: number; verbose?: boolean } = {},
): AutoRouterOptions {
  const routing = configManager.getAll().routing || {};
  // Quota-ledger parked providers sink below healthy ones — same unified
  // read path as chat/orchestrator (registry is the read model, ledger the
  // writer). Best-effort: routing must never crash on ledger bookkeeping.
  let quotaStatus: Array<{ provider: string; cooldownRemaining: number }> = [];
  try {
    quotaStatus = getModelRegistry().getRouterQuotaStatus(configManager);
  } catch {
    // Best-effort — routing must never crash on ledger bookkeeping.
  }
  // Capability mode — 'balanced' (default) leaves every knob untouched so the
  // existing behaviour is byte-identical; 'max' relaxes the cost gates (paid
  // always allowed, no per-call ceiling) and prefers capability over price. The
  // mode is applied LAST so it can only widen eligibility, never narrow it.
  const capability = capabilityRoutingPolicy(resolveCapabilityMode(configManager));

  return {
    verbose: extra.verbose,
    useRuntimeStats: true,
    // ISSUE-002: bandit learning is ON by default (opt-out via `nuvira config
    // set routing.bandit false`). Cold start is deterministic (Beta(1,1)
    // samples the mean), so this never randomizes an unlearned ranking.
    useBandit: routing.bandit !== false,
    // ML task-similarity router — opt-in (`routing.mlRouter`). Off by default;
    // when enabled it rides the SAME resolve options as every other feature so
    // no action point gets a degraded experience.
    useMlRouter: routing.mlRouter === true,
    mlK: routing.mlK,
    mlMinSamples: routing.mlMinSamples,
    mlStrength: routing.mlStrength,
    // Promotion-gate enforcement — opt-in (`routing.promotionEnforce`). A
    // learned layer must prove itself (promotion criteria) before it can
    // change picks.
    enforcePromotion: routing.promotionEnforce === true,
    promotionMinDecisions: routing.promotionMinDecisions,
    maxCostUsd: capability.maxCostUsd !== undefined ? capability.maxCostUsd : routing.maxCostUsd,
    minSpeed: routing.minSpeed,
    // `max` sets a reasoned floor so it routes to a strong model, not merely an
    // allowed one; `balanced` leaves the configured value untouched. The floor
    // only ever RAISES the configured value (Math.max), so enabling `max` can
    // never weaken a stricter user/admin floor.
    minReasoning:
      capability.minReasoning !== undefined
        ? Math.max(capability.minReasoning, routing.minReasoning ?? 0)
        : routing.minReasoning,
    escalationMinSamples: routing.escalationMinSamples,
    quotaStatus,
    allowPaid: capability.allowPaid !== undefined ? capability.allowPaid : routing.allowPaid,
    preferenceMode: capability.preferenceMode ?? routing.preferenceMode,
    contextHintTokens: extra.contextHintTokens,
  };
}
