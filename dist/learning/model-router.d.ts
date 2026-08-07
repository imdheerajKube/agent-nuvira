/**
 * ModelRouter — Recommends the optimal inference provider and model for
 * different types of agent tasks.
 *
 * NO hardcoded provider/model names: every task/agent maps to a CAPABILITY
 * PROFILE (needs like "large context" or "high reasoning"), and the
 * recommendation is resolved at runtime against what actually works for THIS
 * user — registry-verified models first (health-ranked), then configured
 * providers, then zero-config local. See `src/learning/model-selection.ts`.
 *
 * The mapping is fully configurable — users can override via config file
 * (providers.<type>.model pins, routing.* overrides, fallback.providers).
 * The router integrates with Orchestrator's `agentModels` option.
 */
import type { ConfigManager } from '../config/manager.js';
import type { ProviderType } from '../config/types.js';
/** Categories of coding tasks that map to different model requirements */
export type TaskType = 'code-format' | 'lint' | 'simple-edit' | 'refactor' | 'architect' | 'plan' | 'security-audit' | 'code-review' | 'test-generation' | 'context-gather' | 'debug' | 'default';
/** A recommended provider + model pair */
export interface ModelRecommendation {
    provider: ProviderType;
    model?: string;
    /** Human-readable reason for this recommendation */
    reason: string;
}
/**
 * A mapping from agent type strings (as used in task plans) to
 * the recommended model routing. Values are model ids, 'default'
 * (the agent resolves a verified working model at call time), or
 * 'provider/model' when an explicit override demands one.
 */
export type AgentModelMap = Record<string, string>;
/**
 * Recommend the best AVAILABLE model for an agent type — resolved at runtime
 * from verified/configured providers, never a hardcoded name.
 *
 * @param configManager Optional — when omitted, ranking is registry-only
 *   (what the learning layer can see without CLI config access).
 * Format of the returned `model`: 'default' means "let the agent resolve a
 * verified working model at call time".
 */
export declare function recommendModel(agentType: string, configManager?: ConfigManager): ModelRecommendation;
/**
 * Build an `agentModels` map for the Orchestrator's `execute` options.
 * Values default to the 'default' sentinel (the agent resolves a verified
 * working model at call time); explicit overrides always win.
 */
export declare function buildAgentModelMap(overrides?: AgentModelMap): AgentModelMap;
/**
 * Recommend the best AVAILABLE provider for a task type — dynamic.
 */
export declare function recommendProvider(taskType: TaskType, configManager?: ConfigManager): ProviderType;
/**
 * Get the task type for an agent type.
 */
export declare function getTaskType(agentType: string): TaskType;
/**
 * Whether a provider is currently usable by this user (verified models or
 * credentials configured) — dynamic, no hardcoded suitability list.
 */
export declare function isProviderSuitable(provider: string, _taskType: TaskType, configManager?: ConfigManager): boolean;
//# sourceMappingURL=model-router.d.ts.map