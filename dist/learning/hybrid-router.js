/**
 * HybridModelRouter — Intelligent model selection engine.
 *
 * Enhances the existing ModelRouter with:
 * 1. Task complexity analysis — detects complexity from goal/description
 * 2. Cost budget awareness — respects user's cost limits per session
 * 3. Multi-model consensus — runs critical tasks through multiple models
 * 4. Automatic fallback chains — if primary fails, try alternatives
 * 5. Routing decisions exposed for user override
 *
 * Integration:
 * - The Orchestrator calls `resolveRouting()` before each agent step
 * - Returns a `RoutingDecision` that the Orchestrator can inspect/override
 * - In verbose mode, decisions are logged for user visibility
 * - Users can set `--provider`/`--model` CLI flags to override any decision
 */
import { recommendModel } from './model-router.js';
import { getCostTracker, calculateCost } from './cost-tracker.js';
import { getBenchmarkRuns } from './benchmark.js';
import { logger } from '../utils/logger.js';
// ─── Complexity Analysis ────────────────────────────────────────────────────
/** Keywords that indicate task complexity */
const COMPLEXITY_KEYWORDS = {
    trivial: [
        /format|lint|comment|indent|rename/i,
        /typo|spelling|trivial/i,
        /simple\s+(change|fix|edit)/i,
    ],
    simple: [
        /refactor|extract|inline|move/i,
        /add\s+(method|function|route|endpoint)/i,
        /fix\s+(bug|issue|error)/i,
        /implement\s+(small|simple)/i,
    ],
    moderate: [
        /implement|create|build|develop/i,
        /add\s+(feature|module|component)/i,
        /integrate|migrate|convert/i,
        /auth|authentication|authorization|api/i,
    ],
    complex: [
        /architecture|architect|design\s+system/i,
        /security\s+(audit|review|scan)/i,
        /optimize|performance|scale/i,
        /multi[- ]?thread|concurrent|parallel/i,
        /database|migration|schema/i,
        /distributed|microservice/i,
    ],
    critical: [
        /production|deploy|release|rollout/i,
        /critical|urgent|emergency|p0|p1/i,
        /security\s+(fix|patch|vulnerability)/i,
        /consensus|vote|multiple\s+models/i,
        /data\s+(loss|breach|corruption)/i,
    ],
};
/**
 * Analyze a task description or user goal to determine its complexity level.
 *
 * @param text — The task description or user goal
 * @returns The detected complexity level
 */
export function analyzeComplexity(text) {
    // Check critical first (highest priority)
    for (const keyword of COMPLEXITY_KEYWORDS.critical) {
        if (keyword.test(text))
            return 'critical';
    }
    // Check complex
    for (const keyword of COMPLEXITY_KEYWORDS.complex) {
        if (keyword.test(text))
            return 'complex';
    }
    // Check moderate
    for (const keyword of COMPLEXITY_KEYWORDS.moderate) {
        if (keyword.test(text))
            return 'moderate';
    }
    // Check simple
    for (const keyword of COMPLEXITY_KEYWORDS.simple) {
        if (keyword.test(text))
            return 'simple';
    }
    // Check trivial
    for (const keyword of COMPLEXITY_KEYWORDS.trivial) {
        if (keyword.test(text))
            return 'trivial';
    }
    // Default: moderate (safe default)
    return 'moderate';
}
/**
 * Get the recommended provider based on complexity and preference mode.
 *
 * @param complexity - Detected complexity level
 * @param mode - Preference mode (default: 'balanced')
 * @returns The recommended provider type
 */
function providerForComplexity(complexity, mode = 'balanced') {
    // privacy-first: always prefer local, fall back to groq only for complex work
    if (mode === 'privacy-first') {
        switch (complexity) {
            case 'trivial':
            case 'simple':
            case 'moderate': return 'local';
            case 'complex':
            case 'critical': return 'groq'; // minimal cloud exposure
        }
    }
    // cost-first: always choose the cheapest adequate provider
    if (mode === 'cost-first') {
        switch (complexity) {
            case 'trivial':
            case 'simple':
            case 'moderate': return 'local';
            case 'complex': return 'groq';
            case 'critical': return 'gemini';
        }
    }
    // performance-first: push harder tasks to stronger providers earlier
    if (mode === 'performance-first') {
        switch (complexity) {
            case 'trivial': return 'groq';
            case 'simple': return 'groq';
            case 'moderate': return 'gemini';
            case 'complex': return 'openrouter';
            case 'critical': return 'openrouter';
        }
    }
    // Default balanced mode
    switch (complexity) {
        case 'trivial': return 'local';
        case 'simple': return 'groq';
        case 'moderate': return 'groq';
        case 'complex': return 'gemini';
        case 'critical': return 'openrouter';
    }
}
/**
 * Estimate cost for a model call based on provider, model, and estimated token usage.
 * Reuses CostTracker's calculateCost and estimateTokens for consistent pricing.
 */
function estimateCallCost(provider, model, inputTokens, outputTokens) {
    return calculateCost(provider, model, inputTokens ?? 1000, outputTokens ?? 500);
}
// ─── Fallback Chain Builder ─────────────────────────────────────────────────
/**
 * Build a fallback chain for a given agent type and complexity.
 * The chain is ordered: primary → secondary → tertiary.
 * Respects preference mode and optionally uses runtime stats.
 *
 * @param agentType - The agent type (e.g., 'writer', 'planner')
 * @param complexity - Detected complexity level
 * @param options - Router options (budget, overrides, preferenceMode)
 * @param runtimeModel - Optional model name from runtime stats (overrides recommendation.model)
 * @returns An ordered array of model candidates
 */
export function buildFallbackChain(agentType, complexity, options = {}, runtimeModel) {
    const chain = [];
    const mode = options.preferenceMode || 'balanced';
    // If user explicitly set provider/model, that's the only option
    if (options.userProvider && options.userModel) {
        chain.push({
            provider: options.userProvider,
            model: options.userModel,
            estimatedCost: estimateCallCost(options.userProvider, options.userModel),
            qualityScore: 0.7,
            reason: 'User-specified provider/model',
        });
        return chain;
    }
    // Get the recommended model from the existing ModelRouter
    const recommendation = recommendModel(agentType);
    // Build fallback chain based on complexity and preference mode
    const preferredProvider = options.userProvider || providerForComplexity(complexity, mode);
    // Use runtime-adjusted model if available (overrides recommendation.model)
    const primaryModel = runtimeModel || recommendation.model || 'default';
    // Quality score baseline adjusted by preference mode
    const qualityBoost = mode === 'performance-first' ? 0.1
        : mode === 'privacy-first' ? -0.05
            : 0;
    // Primary: the complexity-matched or user-specified provider
    const primaryReason = runtimeModel
        ? `Primary choice (stats-adjusted: ${runtimeModel})`
        : `Primary choice for ${complexity} complexity`;
    chain.push({
        provider: preferredProvider,
        model: primaryModel,
        estimatedCost: estimateCallCost(preferredProvider, primaryModel),
        qualityScore: Math.min(1, (complexity === 'critical' ? 0.9 : complexity === 'complex' ? 0.8 : 0.7) + qualityBoost),
        reason: primaryReason,
    });
    // Secondary fallback: swap provider (adjusted for privacy-first mode)
    const secondaryProvider = mode === 'privacy-first' ? 'groq'
        : preferredProvider === 'local' ? 'groq'
            : preferredProvider === 'groq' ? 'nim'
                : preferredProvider === 'nim' ? 'gemini'
                    : preferredProvider === 'gemini' ? 'openrouter'
                        : 'groq';
    chain.push({
        provider: secondaryProvider,
        model: 'default',
        estimatedCost: estimateCallCost(secondaryProvider, 'default'),
        qualityScore: Math.min(1, 0.6 + qualityBoost),
        reason: `Fallback: switch to ${secondaryProvider}`,
    });
    // Tertiary fallback
    const tertiaryProvider = secondaryProvider === 'groq' ? 'gemini' : 'groq';
    chain.push({
        provider: tertiaryProvider,
        model: 'default',
        estimatedCost: estimateCallCost(tertiaryProvider, 'default'),
        qualityScore: Math.min(1, 0.5 + qualityBoost),
        reason: `Final fallback: switch to ${tertiaryProvider}`,
    });
    return chain;
}
// ─── Budget Check ───────────────────────────────────────────────────────────
/**
 * Check if the session has remaining budget for a model call.
 *
 * @param options - Router options (includes sessionBudget)
 * @param estimatedCost - Estimated cost of the proposed call
 * @returns True if within budget, false if over
 */
export function checkBudget(options, estimatedCost) {
    if (!options.sessionBudget) {
        return { withinBudget: true, remainingBudget: Infinity };
    }
    const tracker = getCostTracker();
    const summary = tracker.getSummary();
    const spent = summary.sessionCost;
    const remaining = options.sessionBudget - spent;
    return {
        withinBudget: estimatedCost <= remaining,
        remainingBudget: remaining,
    };
}
/**
 * Select a model candidate from the fallback chain that fits the budget.
 */
function selectWithinBudget(chain, options) {
    for (const candidate of chain) {
        const { withinBudget } = checkBudget(options, candidate.estimatedCost);
        if (withinBudget)
            return candidate;
    }
    // If nothing fits the budget, return the cheapest option
    return chain.reduce((cheapest, candidate) => candidate.estimatedCost < cheapest.estimatedCost ? candidate : cheapest);
}
/**
 * Compare two model outputs and determine if they agree at a high level.
 * Simple heuristic: checks if key terms/sections overlap.
 *
 * @param responseA — Output from model A
 * @param responseB — Output from model B
 * @param threshold — Similarity threshold (0–1, default 0.3)
 * @returns Whether the responses agree
 */
export function checkConsensus(responseA, responseB, threshold = 0.3) {
    // Tokenize into words (lowercase)
    const tokensA = new Set(responseA.toLowerCase().split(/\W+/).filter((t) => t.length > 3));
    const tokensB = new Set(responseB.toLowerCase().split(/\W+/).filter((t) => t.length > 3));
    if (tokensA.size === 0 || tokensB.size === 0)
        return true; // Fallback: assume agree
    // Calculate Jaccard similarity
    const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
    const union = new Set([...tokensA, ...tokensB]);
    const similarity = intersection.size / union.size;
    return similarity >= threshold;
}
// ─── Hybrid Model Router ────────────────────────────────────────────────────
/**
 * The main HybridModelRouter class.
 *
 * Usage:
 * ```ts
 * const router = new HybridModelRouter({ sessionBudget: 0.50, verbose: true });
 * const decision = await router.resolveRouting('writer', 'Implement auth module');
 * console.log(decision.explanation);
 * // → "Moderate complexity: using groq/llama-3.3-70b-versatile. Budget remaining: $0.48"
 *
 * // For critical tasks with consensus:
 * if (decision.useConsensus) {
 *   const consensus = await router.runConsensus(
 *     prompt,
 *     decision.fallbackChain[0],
 *     decision.fallbackChain[1],
 *   );
 * }
 * ```
 */
export class HybridModelRouter {
    options;
    constructor(options = {}) {
        this.options = {
            enableConsensus: true,
            verbose: false,
            ...options,
        };
    }
    /**
     * Resolve the optimal routing decision for a given agent type and task.
     *
     * Supports:
     * - Preference modes (performance-first, cost-first, privacy-first, balanced)
     * - Runtime stats integration (useRuntimeStats: reads agent-stats for best model)
     * - Budget awareness
     * - Consensus for critical tasks
     *
     * @param agentType — Agent type (e.g., 'writer', 'planner')
     * @param taskDescription — The task description or user goal
     * @param overrides — Optional per-call overrides
     * @returns A RoutingDecision with provider, model, fallback chain, and explanation
     */
    async resolveRouting(agentType, taskDescription, overrides) {
        const opts = { ...this.options, ...overrides };
        const mode = opts.preferenceMode || 'balanced';
        const complexity = analyzeComplexity(taskDescription);
        // Item 2: Runtime stats integration — adjust primary model based on historical performance
        let runtimeAdjustedModel;
        if (opts.useRuntimeStats) {
            try {
                const { getAgentStats } = await import('./agent-stats.js');
                const stats = getAgentStats();
                const bestModel = stats.getBestModel(agentType);
                if (bestModel) {
                    runtimeAdjustedModel = bestModel;
                    if (opts.verbose) {
                        logger.info(`  📊 Runtime stats: best model for '${agentType}' is ${bestModel}`);
                    }
                }
            }
            catch {
                // Non-critical — fall back to default routing
            }
        }
        // Build fallback chain with optionally runtime-adjusted model
        // Only apply runtime adjustment if user hasn't explicitly set --model
        const runtimeModel = runtimeAdjustedModel && !opts.userModel ? runtimeAdjustedModel : undefined;
        const fallbackChain = buildFallbackChain(agentType, complexity, opts, runtimeModel);
        // Select within budget
        const selected = selectWithinBudget(fallbackChain, opts);
        // Determine if consensus is needed
        const useConsensus = opts.enableConsensus !== false &&
            complexity === 'critical' &&
            !opts.userProvider;
        // Build explanation
        const explanation = this.buildExplanation(agentType, complexity, selected, fallbackChain, opts, runtimeAdjustedModel);
        if (opts.verbose) {
            logger.info(`  🔀 Routing: ${explanation}`);
        }
        return {
            agentType,
            complexity,
            provider: selected.provider,
            model: selected.model,
            fallbackChain,
            useConsensus,
            userOverridden: !!opts.userProvider,
            explanation,
        };
    }
    /**
     * Run multi-model consensus for a critical task.
     * Sends the same prompt to two different models and compares results.
     *
     * @param prompt — The LLM prompt
     * @param primary — Primary model (used if agreement reached)
     * @param secondary — Secondary model (for comparison)
     * @param callLLM — Function to call a specific provider/model
     * @returns Consensus result with combined response
     */
    async runConsensus(prompt, primary, secondary, callLLM) {
        logger.info('  🔀 Running multi-model consensus for critical task...');
        // Run both models in parallel
        const [responseA, responseB] = await Promise.all([
            callLLM(prompt, primary.provider, primary.model),
            callLLM(prompt, secondary.provider, secondary.model),
        ]);
        const agreed = checkConsensus(responseA, responseB);
        if (agreed) {
            logger.success('  ✅ Models agree — using primary model result');
        }
        else {
            logger.warn('  ⚠️  Models disagree — falling back to primary (higher quality score)');
        }
        return {
            providerA: primary.provider,
            modelA: primary.model,
            providerB: secondary.provider,
            modelB: secondary.model,
            agreed,
            combinedResponse: responseA,
            responseA,
            responseB,
        };
    }
    /**
     * Try the fallback chain for a single call.
     * Returns the first successful result, or throws if all fail.
     *
     * @param prompt — The LLM prompt
     * @param chain — Fallback chain of model candidates
     * @param callLLM — Function to call a specific provider/model
     * @returns The response from the first successful model
     */
    async tryFallbackChain(prompt, chain, callLLM) {
        const errors = [];
        for (const candidate of chain) {
            try {
                logger.debug(`  🔀 Trying fallback: ${candidate.provider}/${candidate.model}`);
                const response = await callLLM(prompt, candidate.provider, candidate.model);
                return { response, usedCandidate: candidate };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`${candidate.provider}/${candidate.model}: ${msg.slice(0, 100)}`);
                logger.warn(`  ⚠️  Fallback ${candidate.provider}/${candidate.model} failed: ${msg.slice(0, 100)}`);
                continue;
            }
        }
        throw new Error(`All models in fallback chain failed:\n${errors.join('\n')}`);
    }
    /**
     * Build a human-readable explanation of the routing decision.
     */
    buildExplanation(agentType, complexity, selected, chain, opts, runtimeModel) {
        const parts = [];
        const mode = opts.preferenceMode || 'balanced';
        // Complexity
        const complexityLabels = {
            trivial: '🟢 trivial',
            simple: '🔵 simple',
            moderate: '🟡 moderate',
            complex: '🟠 complex',
            critical: '🔴 critical',
        };
        parts.push(`${agentType} (${complexityLabels[complexity]})`);
        // Preference mode (if not balanced)
        if (mode !== 'balanced') {
            const modeIcon = mode === 'performance-first' ? '⚡'
                : mode === 'cost-first' ? '💰'
                    : '🔒'; // privacy-first
            parts.push(`${modeIcon} ${mode}`);
        }
        // Selected model
        parts.push(`→ ${selected.provider}/${selected.model}`);
        // Runtime stats indicator
        if (runtimeModel) {
            parts.push('📊 stats-adjusted');
        }
        // Budget info
        if (opts.sessionBudget) {
            const { remainingBudget } = checkBudget(opts, selected.estimatedCost);
            parts.push(`$${remainingBudget.toFixed(4)} remaining`);
        }
        // Fallback chain summary
        if (chain.length > 1) {
            const fallbacks = chain.slice(1)
                .map((c) => `${c.provider}/${c.model}`)
                .join(' → ');
            parts.push(`fallback: ${fallbacks}`);
        }
        // Consensus
        if (complexity === 'critical' && opts.enableConsensus) {
            parts.push('🔀 consensus enabled');
        }
        // User override
        if (opts.userProvider) {
            parts.push('👤 user override');
        }
        return parts.join(' | ');
    }
    /**
     * Update options (e.g., when user sets --budget).
     */
    updateOptions(options) {
        this.options = { ...this.options, ...options };
    }
    /**
     * Get current options.
     */
    getOptions() {
        return { ...this.options };
    }
    /**
     * Get benchmark-driven recommendations for the best model for each agent type.
     * Uses data from ModelCompare and BenchmarkRunner.
     */
    getBenchmarkRecommendations() {
        const runs = getBenchmarkRuns();
        if (runs.length === 0)
            return [];
        // Group runs by result characteristics (task IDs used as agent type proxy)
        const byAgent = {};
        for (const run of runs) {
            const key = `${run.provider}/${run.model}`;
            for (const result of run.results) {
                // Use taskId as the agent type proxy
                const agentType = result.taskId || 'default';
                if (!byAgent[agentType])
                    byAgent[agentType] = [];
                byAgent[agentType].push({ model: key, score: result.qualityScore });
            }
        }
        return Object.entries(byAgent).map(([agentType, entries]) => {
            const best = entries.sort((a, b) => b.score - a.score)[0];
            const confidence = entries.length >= 10 ? 'high'
                : entries.length >= 5 ? 'medium'
                    : 'low';
            return {
                agentType,
                recommendedModel: best.model,
                confidence,
            };
        });
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let routerInstance = null;
/**
 * Get or create the default HybridModelRouter singleton.
 */
export function getHybridRouter() {
    if (!routerInstance) {
        routerInstance = new HybridModelRouter();
    }
    return routerInstance;
}
/**
 * Reset the singleton (useful for testing).
 */
export function resetHybridRouter() {
    routerInstance = null;
}
//# sourceMappingURL=hybrid-router.js.map