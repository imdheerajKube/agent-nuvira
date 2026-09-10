import type { ConfigManager } from '../config/manager.js';
import type { AutoRouterOptions } from './auto-router.js';
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
export declare function buildAutoResolveOptions(configManager: ConfigManager, extra?: {
    contextHintTokens?: number;
    verbose?: boolean;
}): AutoRouterOptions;
//# sourceMappingURL=resolve-options.d.ts.map