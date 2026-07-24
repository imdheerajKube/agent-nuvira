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
/** Complexity levels for routing decisions */
export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'critical';
/** A single model candidate in a fallback chain */
export interface ModelCandidate {
    provider: string;
    model: string;
    /** Estimated cost for this call (USD) */
    estimatedCost: number;
    /** Estimated quality score (0–1) from benchmark data */
    qualityScore: number;
    /** Reason this candidate was selected */
    reason: string;
}
/** The final routing decision for a single LLM call */
export interface RoutingDecision {
    /** The agent type this decision is for */
    agentType: string;
    /** Detected complexity level */
    complexity: ComplexityLevel;
    /** The selected provider */
    provider: string;
    /** The selected model */
    model: string;
    /** Full fallback chain (primary is first) */
    fallbackChain: ModelCandidate[];
    /** Whether multi-model consensus was used */
    useConsensus: boolean;
    /** Whether the user explicitly overrode this decision */
    userOverridden: boolean;
    /** Human-readable explanation of this decision */
    explanation: string;
}
/**
 * Preference modes for model routing.
 * - `balanced`: Default — matches provider to complexity
 * - `performance-first`: Prefers faster, higher-quality providers even for simpler tasks
 * - `cost-first`: Prefers cheaper providers even for complex tasks
 * - `privacy-first`: Prefers local/offline providers, avoids cloud APIs
 */
export type PreferenceMode = 'balanced' | 'performance-first' | 'cost-first' | 'privacy-first';
/** Options for the hybrid router */
export interface HybridRouterOptions {
    /** User's cost budget for this session (USD) */
    sessionBudget?: number;
    /** Whether to use multi-model consensus for critical tasks */
    enableConsensus?: boolean;
    /** Whether the user has explicitly set --provider or --model */
    userProvider?: string;
    userModel?: string;
    /** Whether logging is enabled */
    verbose?: boolean;
    /** Preference mode for routing decisions (default: 'balanced') */
    preferenceMode?: PreferenceMode;
    /** Whether to use runtime agent stats to adjust model selection (default: false) */
    useRuntimeStats?: boolean;
}
/**
 * Analyze a task description or user goal to determine its complexity level.
 *
 * @param text — The task description or user goal
 * @returns The detected complexity level
 */
export declare function analyzeComplexity(text: string): ComplexityLevel;
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
export declare function buildFallbackChain(agentType: string, complexity: ComplexityLevel, options?: HybridRouterOptions, runtimeModel?: string): ModelCandidate[];
/**
 * Check if the session has remaining budget for a model call.
 *
 * @param options - Router options (includes sessionBudget)
 * @param estimatedCost - Estimated cost of the proposed call
 * @returns True if within budget, false if over
 */
export declare function checkBudget(options: HybridRouterOptions, estimatedCost: number): {
    withinBudget: boolean;
    remainingBudget: number;
};
/**
 * Results from a multi-model consensus run.
 */
export interface ConsensusResult {
    providerA: string;
    modelA: string;
    providerB: string;
    modelB: string;
    /** Whether the two models agreed */
    agreed: boolean;
    /** Combined/enhanced response (when agreed, uses A's response) */
    combinedResponse: string;
    /** Individual responses */
    responseA: string;
    responseB: string;
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
export declare function checkConsensus(responseA: string, responseB: string, threshold?: number): boolean;
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
export declare class HybridModelRouter {
    private options;
    constructor(options?: HybridRouterOptions);
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
    resolveRouting(agentType: string, taskDescription: string, overrides?: Partial<HybridRouterOptions>): Promise<RoutingDecision>;
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
    runConsensus(prompt: string, primary: ModelCandidate, secondary: ModelCandidate, callLLM: (prompt: string, provider: string, model: string) => Promise<string>): Promise<ConsensusResult>;
    /**
     * Try the fallback chain for a single call.
     * Returns the first successful result, or throws if all fail.
     *
     * @param prompt — The LLM prompt
     * @param chain — Fallback chain of model candidates
     * @param callLLM — Function to call a specific provider/model
     * @returns The response from the first successful model
     */
    tryFallbackChain(prompt: string, chain: ModelCandidate[], callLLM: (prompt: string, provider: string, model: string) => Promise<string>): Promise<{
        response: string;
        usedCandidate: ModelCandidate;
    }>;
    /**
     * Build a human-readable explanation of the routing decision.
     */
    private buildExplanation;
    /**
     * Update options (e.g., when user sets --budget).
     */
    updateOptions(options: Partial<HybridRouterOptions>): void;
    /**
     * Get current options.
     */
    getOptions(): HybridRouterOptions;
    /**
     * Get benchmark-driven recommendations for the best model for each agent type.
     * Uses data from ModelCompare and BenchmarkRunner.
     */
    getBenchmarkRecommendations(): Array<{
        agentType: string;
        recommendedModel: string;
        confidence: 'high' | 'medium' | 'low';
    }>;
}
/**
 * Get or create the default HybridModelRouter singleton.
 */
export declare function getHybridRouter(): HybridModelRouter;
/**
 * Reset the singleton (useful for testing).
 */
export declare function resetHybridRouter(): void;
//# sourceMappingURL=hybrid-router.d.ts.map