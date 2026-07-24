/**
 * CostTracker — Tracks API usage costs per provider per session.
 *
 * Stores cost data as JSON at ~/.buff/memory/cost-tracker.json
 * and provides CLI commands to view costs.
 *
 * Cost per 1K tokens (approximate, in USD):
 * - Groq: llama-3.3-70b = $0.59/$0.79, llama-3.1-8b = $0.05/$0.08
 * - NVIDIA NIM: varies by model, typically $0.10-$0.50/$1K
 * - Google Gemini: free tier (limited), paid tier ~$0.10/$1K
 * - OpenRouter: varies by model (pass-through pricing)
 * - Local: free
 *
 * Costs are configurable via config file for accuracy.
 */
export interface CostEntry {
    /** Provider name (e.g., 'groq', 'gemini', 'openrouter', 'nim', 'local') */
    provider: string;
    /** Model name used */
    model: string;
    /** Timestamp of the request */
    timestamp: number;
    /** Input tokens used */
    inputTokens: number;
    /** Output tokens generated */
    outputTokens: number;
    /** Total tokens */
    totalTokens: number;
    /** Estimated cost in USD (micro-cents precision) */
    costUsd: number;
    /** The task/goal that triggered this request */
    task?: string;
}
export interface CostSummary {
    /** Total cost in USD across all time */
    totalCost: number;
    /** Total cost by provider */
    byProvider: Record<string, number>;
    /** Total cost by model */
    byModel: Record<string, number>;
    /** Total tokens consumed */
    totalTokens: number;
    /** Total requests made */
    totalRequests: number;
    /** Number of entries in the current session */
    sessionRequests: number;
    /** Session cost in USD */
    sessionCost: number;
    /** Session start timestamp */
    sessionStart: number;
}
/**
 * Estimate the number of tokens from text length.
 * Rough heuristic: ~4 characters per token for code, ~5 for prose.
 */
export declare function estimateTokens(text: string): number;
/**
 * Calculate the cost for a given provider, model, and token counts.
 */
export declare function calculateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number;
/**
 * Tracks API usage costs per provider.
 */
export declare class CostTracker {
    private sessionStart;
    private sessionEntries;
    constructor();
    /**
     * Record a single API call's cost.
     *
     * @param provider  Provider name
     * @param model     Model name
     * @param inputTokens  Input tokens used (or estimated)
     * @param outputTokens Output tokens generated (or estimated)
     * @param task      Optional task description
     */
    recordCall(provider: string, model: string, inputTokens: number, outputTokens: number, task?: string): CostEntry;
    /**
     * Record a call with estimated tokens from prompt/response lengths.
     * Useful when the API doesn't return exact token counts.
     */
    recordCallEstimated(provider: string, model: string, promptText: string, responseText: string, task?: string): CostEntry;
    /**
     * Get cost summary across all time and current session.
     */
    getSummary(): CostSummary;
    /**
     * Format cost summary as a human-readable string.
     */
    formatSummary(): string;
    /**
     * Clear all cost tracking data.
     */
    clear(): void;
    /**
     * Get all cost entries (for export).
     */
    getAllEntries(): CostEntry[];
}
export declare function getCostTracker(): CostTracker;
//# sourceMappingURL=cost-tracker.d.ts.map