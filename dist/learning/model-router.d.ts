/**
 * ModelRouter — Recommends the optimal inference provider and model
 * for different types of agent tasks.
 *
 * Task categories and their recommended providers:
 *
 * | Task Type              | Recommended Provider       | Rationale                     |
 * |------------------------|---------------------------|-------------------------------|
 * | code-format, lint      | local (small model)       | Fast, private, cheap          |
 * | simple-edit, refactor  | groq / nim                | Low latency, good quality     |
 * | architect, plan        | gemini / openrouter       | Large context, strong reasoning |
 * | security-audit, review | openrouter (GPT-4/Claude) | Best at finding subtle issues |
 * | test-generation        | any capable               | Depends on test framework     |
 *
 * The mapping is fully configurable — users can override via config file.
 * The router integrates with Orchestrator's `agentModels` option.
 */
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
 * the recommended model routing.
 *
 * Example:
 * ```json
 * {
 *   "planner": "gemini-2.0-flash-exp",
 *   "writer": "groq/llama-3.3-70b-versatile",
 *   "reviewer": "openrouter/meta-llama/llama-3.1-8b-instruct"
 * }
 * ```
 */
export type AgentModelMap = Record<string, string>;
/**
 * Get the recommended model string for a given agent type.
 * Format: "provider/model" or just "model" to use the default provider.
 */
export declare function recommendModel(agentType: string): ModelRecommendation;
/**
 * Build an `agentModels` map for the Orchestrator's `execute` options.
 * This can be passed directly to automatically route each agent to
 * its recommended model.
 *
 * @param overrides Optional overrides to customize specific agent models
 */
export declare function buildAgentModelMap(overrides?: AgentModelMap): AgentModelMap;
/**
 * Get the recommended provider type for a task type.
 */
export declare function recommendProvider(taskType: TaskType): ProviderType;
/**
 * Get the task type for an agent type.
 */
export declare function getTaskType(agentType: string): TaskType;
/**
 * Check whether a provider is well-suited for a given task type.
 * Returns true if the provider matches or is a reasonable alternative.
 */
export declare function isProviderSuitable(provider: string, taskType: TaskType): boolean;
//# sourceMappingURL=model-router.d.ts.map