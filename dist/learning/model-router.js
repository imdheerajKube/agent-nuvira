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
// ─── Default Mappings ───────────────────────────────────────────────────────
/** Maps agent types to their recommended model strings */
const DEFAULT_AGENT_MODELS = {
    planner: 'gemini-2.0-flash-exp',
    'context-gatherer': 'groq/llama-3.3-70b-versatile',
    writer: 'groq/llama-3.3-70b-versatile',
    reviewer: 'openrouter/meta-llama/llama-3.1-8b-instruct',
    tester: 'groq/llama-3.3-70b-versatile',
    debugger: 'openrouter/meta-llama/llama-3.1-8b-instruct',
};
/**
 * Maps task types to their ideal provider (used for config-level routing).
 * Agent-level routing is more specific and takes precedence.
 */
const TASK_TO_PROVIDER = {
    'code-format': 'local',
    lint: 'local',
    'simple-edit': 'groq',
    refactor: 'nim',
    architect: 'gemini',
    plan: 'gemini',
    'security-audit': 'openrouter',
    'code-review': 'openrouter',
    'test-generation': 'groq',
    'context-gather': 'groq',
    debug: 'groq',
    default: 'groq',
};
/** Maps agent types to their task type */
const AGENT_TO_TASK = {
    planner: 'plan',
    'context-gatherer': 'context-gather',
    writer: 'simple-edit',
    reviewer: 'code-review',
    tester: 'test-generation',
    debugger: 'debug',
};
// ─── Router ────────────────────────────────────────────────────────────────
/**
 * Get the recommended model string for a given agent type.
 * Format: "provider/model" or just "model" to use the default provider.
 */
export function recommendModel(agentType) {
    const modelStr = DEFAULT_AGENT_MODELS[agentType];
    if (!modelStr) {
        // Fall back to default
        return {
            provider: TASK_TO_PROVIDER.default,
            reason: `No specific recommendation for '${agentType}', using default`,
        };
    }
    // Parse "provider/model" format
    const slashIdx = modelStr.indexOf('/');
    if (slashIdx > 0) {
        const provider = modelStr.slice(0, slashIdx);
        const model = modelStr.slice(slashIdx + 1);
        return {
            provider,
            model,
            reason: `Recommended for '${agentType}' tasks`,
        };
    }
    // Just a model name — use its task type's preferred provider
    const taskType = AGENT_TO_TASK[agentType] || 'default';
    const provider = TASK_TO_PROVIDER[taskType];
    return {
        provider,
        model: modelStr,
        reason: `Recommended for '${agentType}' tasks`,
    };
}
/**
 * Build an `agentModels` map for the Orchestrator's `execute` options.
 * This can be passed directly to automatically route each agent to
 * its recommended model.
 *
 * @param overrides Optional overrides to customize specific agent models
 */
export function buildAgentModelMap(overrides) {
    const map = {};
    for (const agentType of Object.keys(DEFAULT_AGENT_MODELS)) {
        if (overrides?.[agentType]) {
            map[agentType] = overrides[agentType];
        }
        else {
            map[agentType] = DEFAULT_AGENT_MODELS[agentType];
        }
    }
    return map;
}
/**
 * Get the recommended provider type for a task type.
 */
export function recommendProvider(taskType) {
    return TASK_TO_PROVIDER[taskType] || TASK_TO_PROVIDER.default;
}
/**
 * Get the task type for an agent type.
 */
export function getTaskType(agentType) {
    return AGENT_TO_TASK[agentType] || 'default';
}
/**
 * Check whether a provider is well-suited for a given task type.
 * Returns true if the provider matches or is a reasonable alternative.
 */
export function isProviderSuitable(provider, taskType) {
    const recommended = TASK_TO_PROVIDER[taskType] || TASK_TO_PROVIDER.default;
    if (provider === recommended)
        return true;
    // Reasonable alternatives
    const alternatives = {
        'simple-edit': ['groq', 'nim', 'gemini'],
        refactor: ['nim', 'groq', 'gemini'],
        plan: ['gemini', 'openrouter'],
        'code-review': ['openrouter', 'gemini'],
    };
    const alt = alternatives[taskType];
    if (alt)
        return alt.includes(provider);
    return false;
}
//# sourceMappingURL=model-router.js.map