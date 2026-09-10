/**
 * Infrastructure Tools — Lazy deps, tool search, budget config, fuzzy match.
 *
 * Hermes equivalents:
 * - lazy_deps.py (1,197 lines) — Lazy dependency loading
 * - tool_search.py (1,078 lines) — Tool search
 * - tool_backend_helpers.py (311 lines) — Backend helpers
 * - tool_output_limits.py (110 lines) — Output size limits
 * - tool_result_storage.py (254 lines) — Result storage
 * - budget_config.py (114 lines) — Budget configuration
 * - fuzzy_match.py (1,108 lines) — Fuzzy string matching
 */
export declare class LazyDependencyLoader {
    private loaded;
    private loading;
    /**
     * Load a dependency lazily.
     */
    load<T>(name: string, loader: () => Promise<T>): Promise<T>;
    /**
     * Check if a dependency is loaded.
     */
    isLoaded(name: string): boolean;
    /**
     * Get loaded dependencies.
     */
    getLoaded(): string[];
}
export interface ToolSearchResult {
    name: string;
    description: string;
    relevance: number;
}
export declare class ToolSearchEngine {
    private tools;
    /**
     * Index tools for search.
     */
    index(tools: Array<{
        name: string;
        description: string;
        keywords?: string[];
    }>): void;
    /**
     * Search tools by query.
     */
    search(query: string, limit?: number): ToolSearchResult[];
}
export declare class ToolOutputLimiter {
    private limits;
    private defaultLimit;
    /**
     * Set output limit for a tool.
     */
    setLimit(toolName: string, maxBytes: number): void;
    /**
     * Truncate output to limit.
     */
    truncate(toolName: string, output: string): {
        truncated: boolean;
        output: string;
        originalLength: number;
    };
}
export interface StoredResult {
    id: string;
    toolName: string;
    result: unknown;
    timestamp: number;
}
export declare class ToolResultStorage {
    private results;
    private storageDir;
    private maxResults;
    constructor();
    /**
     * Store a result.
     */
    store(toolName: string, result: unknown): StoredResult;
    /**
     * Retrieve a result.
     */
    retrieve(id: string): StoredResult | null;
    /**
     * Get recent results for a tool.
     */
    getRecent(toolName: string, limit?: number): StoredResult[];
}
export interface BudgetConfig {
    /** Max tokens per request */
    maxTokensPerRequest: number;
    /** Max tokens per day */
    maxTokensPerDay: number;
    /** Max cost per day (USD) */
    maxCostPerDay: number;
    /** Current usage */
    currentUsage: {
        tokens: number;
        cost: number;
        requests: number;
    };
}
export declare class BudgetManager {
    private config;
    /**
     * Check if a request is within budget.
     */
    canSpend(estimatedTokens: number, estimatedCost: number): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Record usage.
     */
    record(tokens: number, cost: number): void;
    /**
     * Reset daily usage.
     */
    resetDaily(): void;
    /**
     * Get current config.
     */
    getConfig(): BudgetConfig;
}
export declare class FuzzyMatcher {
    /**
     * Calculate Levenshtein distance.
     */
    distance(a: string, b: string): number;
    /**
     * Fuzzy match a query against a list of items.
     */
    match<T>(query: string, items: T[], getKey: (item: T) => string, limit?: number): Array<{
        item: T;
        score: number;
    }>;
}
export declare function getLazyDependencyLoader(): LazyDependencyLoader;
export declare function getToolSearchEngine(): ToolSearchEngine;
export declare function getToolOutputLimiter(): ToolOutputLimiter;
export declare function getToolResultStorage(): ToolResultStorage;
export declare function getBudgetManager(): BudgetManager;
export declare function getFuzzyMatcher(): FuzzyMatcher;
//# sourceMappingURL=infra-tools.d.ts.map