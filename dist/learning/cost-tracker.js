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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ─── Constants ──────────────────────────────────────────────────────────────
const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const COST_PATH = join(MEMORY_DIR, 'cost-tracker.json');
const CURRENT_VERSION = 1;
/**
 * Default pricing per 1K tokens (input/output) in USD.
 * Users can override these via config file.
 * Source: provider pricing pages (approximate, may change).
 */
const DEFAULT_PRICING = {
    groq: { inputPer1K: 0.00059, outputPer1K: 0.00079 }, // Average across models
    nim: { inputPer1K: 0.00010, outputPer1K: 0.00050 }, // Varies by model
    gemini: { inputPer1K: 0, outputPer1K: 0 }, // Free tier by default
    openrouter: { inputPer1K: 0.00010, outputPer1K: 0.00010 }, // Minimum; most models cost more
    local: { inputPer1K: 0, outputPer1K: 0 }, // Free (local compute)
};
/** Maximum number of cost entries to keep */
const MAX_ENTRIES = 10000;
// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir() {
    if (!existsSync(MEMORY_DIR)) {
        mkdirSync(MEMORY_DIR, { recursive: true });
    }
}
function readCosts() {
    try {
        ensureDir();
        if (!existsSync(COST_PATH)) {
            return { entries: [], version: CURRENT_VERSION };
        }
        const raw = readFileSync(COST_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return { entries: [], version: CURRENT_VERSION };
    }
}
function writeCosts(data) {
    ensureDir();
    writeFileSync(COST_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
/**
 * Estimate the number of tokens from text length.
 * Rough heuristic: ~4 characters per token for code, ~5 for prose.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4.5);
}
/**
 * Calculate the cost for a given provider, model, and token counts.
 */
export function calculateCost(provider, model, inputTokens, outputTokens) {
    const pricing = DEFAULT_PRICING[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };
    // Model-specific pricing overrides for known expensive models
    const expensiveModels = {
        'llama-3.3-70b-versatile': { inputPer1K: 0.00059, outputPer1K: 0.00079 },
        'llama-3.1-405b-reasoning': { inputPer1K: 0.00279, outputPer1K: 0.00279 },
        'mixtral-8x7b-32768': { inputPer1K: 0.00024, outputPer1K: 0.00024 },
    };
    const modelPricing = expensiveModels[model];
    const p = modelPricing || pricing;
    const inputCost = (inputTokens / 1000) * p.inputPer1K;
    const outputCost = (outputTokens / 1000) * p.outputPer1K;
    return Math.round((inputCost + outputCost) * 100000) / 100000; // Micro-cent precision
}
// ─── CostTracker ────────────────────────────────────────────────────────────
/**
 * Tracks API usage costs per provider.
 */
export class CostTracker {
    sessionStart;
    sessionEntries = [];
    constructor() {
        this.sessionStart = Date.now();
    }
    /**
     * Record a single API call's cost.
     *
     * @param provider  Provider name
     * @param model     Model name
     * @param inputTokens  Input tokens used (or estimated)
     * @param outputTokens Output tokens generated (or estimated)
     * @param task      Optional task description
     */
    recordCall(provider, model, inputTokens, outputTokens, task) {
        const costUsd = calculateCost(provider, model, inputTokens, outputTokens);
        const entry = {
            provider,
            model,
            timestamp: Date.now(),
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUsd,
            task,
        };
        // Store in session
        this.sessionEntries.push(entry);
        // Persist to disk
        const data = readCosts();
        data.entries.push(entry);
        // Prune old entries if over limit
        if (data.entries.length > MAX_ENTRIES) {
            data.entries = data.entries.slice(-MAX_ENTRIES);
        }
        writeCosts(data);
        return entry;
    }
    /**
     * Record a call with estimated tokens from prompt/response lengths.
     * Useful when the API doesn't return exact token counts.
     */
    recordCallEstimated(provider, model, promptText, responseText, task) {
        const inputTokens = estimateTokens(promptText);
        const outputTokens = estimateTokens(responseText);
        return this.recordCall(provider, model, inputTokens, outputTokens, task);
    }
    /**
     * Get cost summary across all time and current session.
     */
    getSummary() {
        const data = readCosts();
        const allEntries = data.entries;
        const byProvider = {};
        const byModel = {};
        let totalCost = 0;
        let totalTokens = 0;
        for (const entry of allEntries) {
            totalCost += entry.costUsd;
            totalTokens += entry.totalTokens;
            byProvider[entry.provider] = (byProvider[entry.provider] || 0) + entry.costUsd;
            byModel[entry.model] = (byModel[entry.model] || 0) + entry.costUsd;
        }
        const sessionCost = this.sessionEntries.reduce((sum, e) => sum + e.costUsd, 0);
        return {
            totalCost: Math.round(totalCost * 100000) / 100000,
            byProvider,
            byModel,
            totalTokens,
            totalRequests: allEntries.length,
            sessionRequests: this.sessionEntries.length,
            sessionCost: Math.round(sessionCost * 100000) / 100000,
            sessionStart: this.sessionStart,
        };
    }
    /**
     * Format cost summary as a human-readable string.
     */
    formatSummary() {
        const summary = this.getSummary();
        const lines = [
            '💰 Cost Tracker',
            '',
            '── Session ──',
            `   Started: ${new Date(summary.sessionStart).toLocaleString()}`,
            `   Requests: ${summary.sessionRequests}`,
            `   Session cost: $${summary.sessionCost.toFixed(6)}`,
            '',
            '── All Time ──',
            `   Total requests: ${summary.totalRequests}`,
            `   Total tokens: ${summary.totalTokens.toLocaleString()}`,
            `   Total cost: $${summary.totalCost.toFixed(6)}`,
            '',
        ];
        if (Object.keys(summary.byProvider).length > 0) {
            lines.push('── By Provider ──');
            for (const [provider, cost] of Object.entries(summary.byProvider).sort(([, a], [, b]) => b - a)) {
                const pct = summary.totalCost > 0 ? (cost / summary.totalCost * 100).toFixed(1) : '0.0';
                lines.push(`   ${provider.padEnd(15)} $${cost.toFixed(6)} (${pct}%)`);
            }
            lines.push('');
        }
        if (Object.keys(summary.byModel).length > 0) {
            lines.push('── By Model ──');
            for (const [model, cost] of Object.entries(summary.byModel).sort(([, a], [, b]) => b - a).slice(0, 10)) {
                lines.push(`   ${model.padEnd(40)} $${cost.toFixed(6)}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    /**
     * Clear all cost tracking data.
     */
    clear() {
        this.sessionEntries = [];
        this.sessionStart = Date.now();
        writeCosts({ entries: [], version: CURRENT_VERSION });
    }
    /**
     * Get all cost entries (for export).
     */
    getAllEntries() {
        const data = readCosts();
        return [...data.entries];
    }
}
// Singleton instance
let trackerInstance = null;
export function getCostTracker() {
    if (!trackerInstance) {
        trackerInstance = new CostTracker();
    }
    return trackerInstance;
}
//# sourceMappingURL=cost-tracker.js.map