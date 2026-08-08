import type { ConfigManager } from '../config/manager.js';
import type { AutoRouterOptions } from './auto-router.js';
import { getModelRegistry } from './model-registry.js';

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
  return {
    verbose: extra.verbose,
    useRuntimeStats: true,
    // ISSUE-002: bandit learning is ON by default (opt-out via `buff config
    // set routing.bandit false`). Cold start is deterministic (Beta(1,1)
    // samples the mean), so this never randomizes an unlearned ranking.
    useBandit: routing.bandit !== false,
    maxCostUsd: routing.maxCostUsd,
    minSpeed: routing.minSpeed,
    minReasoning: routing.minReasoning,
    escalationMinSamples: routing.escalationMinSamples,
    quotaStatus,
    allowPaid: routing.allowPaid,
    contextHintTokens: extra.contextHintTokens,
  };
}
