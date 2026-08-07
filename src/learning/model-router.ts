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
import { bestAvailable, rankAvailableProviders, type CapabilityProfile } from './model-selection.js';
import { getModelRegistry } from './model-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Categories of coding tasks that map to different model requirements */
export type TaskType =
  | 'code-format'
  | 'lint'
  | 'simple-edit'
  | 'refactor'
  | 'architect'
  | 'plan'
  | 'security-audit'
  | 'code-review'
  | 'test-generation'
  | 'context-gather'
  | 'debug'
  | 'default';

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

// ─── Capability Profiles (needs, never names) ───────────────────────────────

/** Maps agent types to their capability needs (used to pick the best AVAILABLE model). */
const AGENT_CAPABILITIES: Record<string, CapabilityProfile> = {
  planner: { context: 'large', reasoning: 'high' },
  'context-gatherer': { context: 'large' },
  writer: { speed: 'high' },
  reviewer: { reasoning: 'high' },
  tester: { speed: 'high' },
  debugger: { reasoning: 'medium' },
};

/** Maps task types to their capability needs. */
const TASK_CAPABILITIES: Record<TaskType, CapabilityProfile> = {
  'code-format': { speed: 'high' },
  lint: { speed: 'high' },
  'simple-edit': { speed: 'high' },
  refactor: { reasoning: 'medium' },
  architect: { context: 'large', reasoning: 'high' },
  plan: { context: 'large', reasoning: 'high' },
  'security-audit': { reasoning: 'high' },
  'code-review': { reasoning: 'high' },
  'test-generation': { speed: 'high' },
  'context-gather': { context: 'large' },
  debug: { speed: 'high' },
  default: {},
};

/** Maps agent types to their task type (taxonomy — not a selection). */
const AGENT_TO_TASK: Record<string, TaskType> = {
  planner: 'plan',
  'context-gatherer': 'context-gather',
  writer: 'simple-edit',
  reviewer: 'code-review',
  tester: 'test-generation',
  debugger: 'debug',
};

// ─── Router ────────────────────────────────────────────────────────────────

/**
 * Recommend the best AVAILABLE model for an agent type — resolved at runtime
 * from verified/configured providers, never a hardcoded name.
 *
 * @param configManager Optional — when omitted, ranking is registry-only
 *   (what the learning layer can see without CLI config access).
 * Format of the returned `model`: 'default' means "let the agent resolve a
 * verified working model at call time".
 */
export function recommendModel(agentType: string, configManager?: ConfigManager): ModelRecommendation {
  const profile = AGENT_CAPABILITIES[agentType] || TASK_CAPABILITIES[getTaskType(agentType)] || {};
  const pick = bestAvailable(profile, configManager);
  if (pick) {
    return {
      provider: pick.provider as ProviderType,
      model: pick.model,
      reason: `Best available for '${agentType}' (discovered from live model availability)`,
    };
  }
  return {
    provider: 'local',
    reason: 'Nothing available yet — run `buff models refresh` or set an API key (local-only if Ollama is running)',
  };
}

/**
 * Build an `agentModels` map for the Orchestrator's `execute` options.
 * Values default to the 'default' sentinel (the agent resolves a verified
 * working model at call time); explicit overrides always win.
 */
export function buildAgentModelMap(overrides?: AgentModelMap): AgentModelMap {
  const map: AgentModelMap = {};
  for (const agentType of Object.keys(AGENT_CAPABILITIES)) {
    map[agentType] = overrides?.[agentType] ?? 'default';
  }
  return map;
}

/**
 * Recommend the best AVAILABLE provider for a task type — dynamic.
 */
export function recommendProvider(taskType: TaskType, configManager?: ConfigManager): ProviderType {
  const pick = bestAvailable(TASK_CAPABILITIES[taskType] || {}, configManager);
  return (pick?.provider as ProviderType) || 'local';
}

/**
 * Get the task type for an agent type.
 */
export function getTaskType(agentType: string): TaskType {
  return AGENT_TO_TASK[agentType] || 'default';
}

/**
 * Whether a provider is currently usable by this user (verified models or
 * credentials configured) — dynamic, no hardcoded suitability list.
 */
export function isProviderSuitable(provider: string, _taskType: TaskType, configManager?: ConfigManager): boolean {
  if (configManager) {
    return rankAvailableProviders(configManager).some((r) => r.provider === provider);
  }
  return getModelRegistry().getUsableProviders().includes(provider) || provider === 'local';
}
