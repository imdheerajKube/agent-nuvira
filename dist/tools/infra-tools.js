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
import { existsSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
// ─── Lazy Dependencies ────────────────────────────────────────────────────
export class LazyDependencyLoader {
    loaded = new Map();
    loading = new Map();
    /**
     * Load a dependency lazily.
     */
    async load(name, loader) {
        if (this.loaded.has(name))
            return this.loaded.get(name);
        if (this.loading.has(name))
            return this.loading.get(name);
        const promise = loader().then((mod) => {
            this.loaded.set(name, mod);
            this.loading.delete(name);
            return mod;
        });
        this.loading.set(name, promise);
        return promise;
    }
    /**
     * Check if a dependency is loaded.
     */
    isLoaded(name) {
        return this.loaded.has(name);
    }
    /**
     * Get loaded dependencies.
     */
    getLoaded() {
        return Array.from(this.loaded.keys());
    }
}
export class ToolSearchEngine {
    tools = [];
    /**
     * Index tools for search.
     */
    index(tools) {
        this.tools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            keywords: t.keywords || [],
        }));
    }
    /**
     * Search tools by query.
     */
    search(query, limit = 10) {
        const queryLower = query.toLowerCase();
        const words = queryLower.split(/\s+/);
        const scored = this.tools.map((tool) => {
            let score = 0;
            const nameLower = tool.name.toLowerCase();
            const descLower = tool.description.toLowerCase();
            // Exact name match
            if (nameLower === queryLower)
                score += 100;
            // Name contains query
            else if (nameLower.includes(queryLower))
                score += 50;
            // Description contains query
            if (descLower.includes(queryLower))
                score += 30;
            // Word matches
            for (const word of words) {
                if (nameLower.includes(word))
                    score += 20;
                if (descLower.includes(word))
                    score += 10;
                if (tool.keywords.some((k) => k.includes(word)))
                    score += 15;
            }
            return { name: tool.name, description: tool.description, relevance: score };
        });
        return scored
            .filter((r) => r.relevance > 0)
            .sort((a, b) => b.relevance - a.relevance)
            .slice(0, limit);
    }
}
// ─── Tool Output Limits ──────────────────────────────────────────────────
export class ToolOutputLimiter {
    limits = new Map();
    defaultLimit = 1024 * 1024; // 1MB
    /**
     * Set output limit for a tool.
     */
    setLimit(toolName, maxBytes) {
        this.limits.set(toolName, maxBytes);
    }
    /**
     * Truncate output to limit.
     */
    truncate(toolName, output) {
        const limit = this.limits.get(toolName) || this.defaultLimit;
        const originalLength = Buffer.byteLength(output);
        if (originalLength <= limit) {
            return { truncated: false, output, originalLength };
        }
        const truncated = output.slice(0, limit);
        return { truncated: true, output: truncated + '\n... [truncated]', originalLength };
    }
}
export class ToolResultStorage {
    results = new Map();
    storageDir;
    maxResults = 1000;
    constructor() {
        this.storageDir = join(resolveNuviraHome(), 'cache', 'tool-results');
        if (!existsSync(this.storageDir)) {
            mkdirSync(this.storageDir, { recursive: true });
        }
    }
    /**
     * Store a result.
     */
    store(toolName, result) {
        const id = `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const stored = { id, toolName, result, timestamp: Date.now() };
        this.results.set(id, stored);
        // Enforce max
        if (this.results.size > this.maxResults) {
            const oldest = Array.from(this.results.values()).sort((a, b) => a.timestamp - b.timestamp)[0];
            if (oldest)
                this.results.delete(oldest.id);
        }
        return stored;
    }
    /**
     * Retrieve a result.
     */
    retrieve(id) {
        return this.results.get(id) || null;
    }
    /**
     * Get recent results for a tool.
     */
    getRecent(toolName, limit = 10) {
        return Array.from(this.results.values())
            .filter((r) => r.toolName === toolName)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }
}
export class BudgetManager {
    config = {
        maxTokensPerRequest: 100_000,
        maxTokensPerDay: 10_000_000,
        maxCostPerDay: 50,
        currentUsage: { tokens: 0, cost: 0, requests: 0 },
    };
    /**
     * Check if a request is within budget.
     */
    canSpend(estimatedTokens, estimatedCost) {
        if (estimatedTokens > this.config.maxTokensPerRequest) {
            return { allowed: false, reason: `Exceeds max tokens per request (${this.config.maxTokensPerRequest})` };
        }
        if (this.config.currentUsage.tokens + estimatedTokens > this.config.maxTokensPerDay) {
            return { allowed: false, reason: `Exceeds daily token limit` };
        }
        if (this.config.currentUsage.cost + estimatedCost > this.config.maxCostPerDay) {
            return { allowed: false, reason: `Exceeds daily cost limit` };
        }
        return { allowed: true };
    }
    /**
     * Record usage.
     */
    record(tokens, cost) {
        this.config.currentUsage.tokens += tokens;
        this.config.currentUsage.cost += cost;
        this.config.currentUsage.requests++;
    }
    /**
     * Reset daily usage.
     */
    resetDaily() {
        this.config.currentUsage = { tokens: 0, cost: 0, requests: 0 };
    }
    /**
     * Get current config.
     */
    getConfig() {
        return { ...this.config };
    }
}
// ─── Fuzzy Match ──────────────────────────────────────────────────────────
export class FuzzyMatcher {
    /**
     * Calculate Levenshtein distance.
     */
    distance(a, b) {
        const m = a.length;
        const n = b.length;
        const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++)
            dp[i][0] = i;
        for (let j = 0; j <= n; j++)
            dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1];
                }
                else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
                }
            }
        }
        return dp[m][n];
    }
    /**
     * Fuzzy match a query against a list of items.
     */
    match(query, items, getKey, limit = 5) {
        const queryLower = query.toLowerCase();
        return items
            .map((item) => {
            const key = getKey(item).toLowerCase();
            const dist = this.distance(queryLower, key);
            const score = Math.max(0, 100 - dist * 10);
            return { item, score };
        })
            .filter((r) => r.score > 50)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}
// ─── Exports ──────────────────────────────────────────────────────────────
export function getLazyDependencyLoader() { return new LazyDependencyLoader(); }
export function getToolSearchEngine() { return new ToolSearchEngine(); }
export function getToolOutputLimiter() { return new ToolOutputLimiter(); }
export function getToolResultStorage() { return new ToolResultStorage(); }
export function getBudgetManager() { return new BudgetManager(); }
export function getFuzzyMatcher() { return new FuzzyMatcher(); }
//# sourceMappingURL=infra-tools.js.map