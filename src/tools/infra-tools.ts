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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── Lazy Dependencies ────────────────────────────────────────────────────

export class LazyDependencyLoader {
  private loaded: Map<string, unknown> = new Map();
  private loading: Map<string, Promise<unknown>> = new Map();

  /**
   * Load a dependency lazily.
   */
  async load<T>(name: string, loader: () => Promise<T>): Promise<T> {
    if (this.loaded.has(name)) return this.loaded.get(name) as T;
    if (this.loading.has(name)) return this.loading.get(name) as Promise<T>;

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
  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /**
   * Get loaded dependencies.
   */
  getLoaded(): string[] {
    return Array.from(this.loaded.keys());
  }
}

// ─── Tool Search ──────────────────────────────────────────────────────────

export interface ToolSearchResult {
  name: string;
  description: string;
  relevance: number;
}

export class ToolSearchEngine {
  private tools: Array<{ name: string; description: string; keywords: string[] }> = [];

  /**
   * Index tools for search.
   */
  index(tools: Array<{ name: string; description: string; keywords?: string[] }>): void {
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      keywords: t.keywords || [],
    }));
  }

  /**
   * Search tools by query.
   */
  search(query: string, limit: number = 10): ToolSearchResult[] {
    const queryLower = query.toLowerCase();
    const words = queryLower.split(/\s+/);

    const scored = this.tools.map((tool) => {
      let score = 0;
      const nameLower = tool.name.toLowerCase();
      const descLower = tool.description.toLowerCase();

      // Exact name match
      if (nameLower === queryLower) score += 100;
      // Name contains query
      else if (nameLower.includes(queryLower)) score += 50;
      // Description contains query
      if (descLower.includes(queryLower)) score += 30;
      // Word matches
      for (const word of words) {
        if (nameLower.includes(word)) score += 20;
        if (descLower.includes(word)) score += 10;
        if (tool.keywords.some((k) => k.includes(word))) score += 15;
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
  private limits: Map<string, number> = new Map();
  private defaultLimit: number = 1024 * 1024; // 1MB

  /**
   * Set output limit for a tool.
   */
  setLimit(toolName: string, maxBytes: number): void {
    this.limits.set(toolName, maxBytes);
  }

  /**
   * Truncate output to limit.
   */
  truncate(toolName: string, output: string): { truncated: boolean; output: string; originalLength: number } {
    const limit = this.limits.get(toolName) || this.defaultLimit;
    const originalLength = Buffer.byteLength(output);

    if (originalLength <= limit) {
      return { truncated: false, output, originalLength };
    }

    const truncated = output.slice(0, limit);
    return { truncated: true, output: truncated + '\n... [truncated]', originalLength };
  }
}

// ─── Tool Result Storage ──────────────────────────────────────────────────

export interface StoredResult {
  id: string;
  toolName: string;
  result: unknown;
  timestamp: number;
}

export class ToolResultStorage {
  private results: Map<string, StoredResult> = new Map();
  private storageDir: string;
  private maxResults: number = 1000;

  constructor() {
    this.storageDir = join(resolveNuviraHome(), 'cache', 'tool-results');
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Store a result.
   */
  store(toolName: string, result: unknown): StoredResult {
    const id = `result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stored: StoredResult = { id, toolName, result, timestamp: Date.now() };
    this.results.set(id, stored);

    // Enforce max
    if (this.results.size > this.maxResults) {
      const oldest = Array.from(this.results.values()).sort((a, b) => a.timestamp - b.timestamp)[0];
      if (oldest) this.results.delete(oldest.id);
    }

    return stored;
  }

  /**
   * Retrieve a result.
   */
  retrieve(id: string): StoredResult | null {
    return this.results.get(id) || null;
  }

  /**
   * Get recent results for a tool.
   */
  getRecent(toolName: string, limit: number = 10): StoredResult[] {
    return Array.from(this.results.values())
      .filter((r) => r.toolName === toolName)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

// ─── Budget Config ────────────────────────────────────────────────────────

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

export class BudgetManager {
  private config: BudgetConfig = {
    maxTokensPerRequest: 100_000,
    maxTokensPerDay: 10_000_000,
    maxCostPerDay: 50,
    currentUsage: { tokens: 0, cost: 0, requests: 0 },
  };

  /**
   * Check if a request is within budget.
   */
  canSpend(estimatedTokens: number, estimatedCost: number): { allowed: boolean; reason?: string } {
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
  record(tokens: number, cost: number): void {
    this.config.currentUsage.tokens += tokens;
    this.config.currentUsage.cost += cost;
    this.config.currentUsage.requests++;
  }

  /**
   * Reset daily usage.
   */
  resetDaily(): void {
    this.config.currentUsage = { tokens: 0, cost: 0, requests: 0 };
  }

  /**
   * Get current config.
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }
}

// ─── Fuzzy Match ──────────────────────────────────────────────────────────

export class FuzzyMatcher {
  /**
   * Calculate Levenshtein distance.
   */
  distance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Fuzzy match a query against a list of items.
   */
  match<T>(query: string, items: T[], getKey: (item: T) => string, limit: number = 5): Array<{ item: T; score: number }> {
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

export function getLazyDependencyLoader(): LazyDependencyLoader { return new LazyDependencyLoader(); }
export function getToolSearchEngine(): ToolSearchEngine { return new ToolSearchEngine(); }
export function getToolOutputLimiter(): ToolOutputLimiter { return new ToolOutputLimiter(); }
export function getToolResultStorage(): ToolResultStorage { return new ToolResultStorage(); }
export function getBudgetManager(): BudgetManager { return new BudgetManager(); }
export function getFuzzyMatcher(): FuzzyMatcher { return new FuzzyMatcher(); }
