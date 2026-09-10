/**
 * Model Warmup — keeps frequently-used models "warm" with periodic 1-token requests.
 *
 * Problem it solves:
 * - When a model hasn't been used for a while, the first request has cold-start latency
 * - The provider's server may have spun down the inference endpoint
 * - The user waits 5-10 seconds for the first response, then 1-2 seconds for subsequent ones
 *
 * Solution:
 * - Track which models are being used frequently
 * - Send periodic 1-token requests to keep them warm
 * - This keeps the provider's inference endpoint alive
 * - Also updates latency metrics in the registry
 *
 * Design:
 * - Background daemon (non-blocking)
 * - Priority queue: frequently-used models warmed more often
 * - Throttling: don't burn free tiers
 * - Integration: uses existing spot-check infrastructure
 *
 * Usage:
 *   import { startWarmupDaemon, stopWarmupDaemon } from './model-warmup.js';
 *   startWarmupDaemon(configManager);
 *   // ... later ...
 *   stopWarmupDaemon();
 */
import type { ConfigManager } from '../config/manager.js';
/**
 * Record a model usage event.
 * Called after every successful LLM call to track which models are hot.
 */
export declare function recordModelUsage(provider: string, model: string): void;
/**
 * Start the warmup daemon.
 * Runs periodically to keep frequently-used models warm.
 */
export declare function startWarmupDaemon(configManager: ConfigManager): void;
/**
 * Stop the warmup daemon.
 */
export declare function stopWarmupDaemon(): void;
/**
 * Get warmup statistics (for dashboard display).
 */
export declare function getWarmupStats(): {
    trackedModels: number;
    hotModels: number;
    warmModels: number;
    lastCycleAt: number;
};
/**
 * Get all tracked models with their warmup status.
 */
export declare function getTrackedModels(): Array<{
    provider: string;
    model: string;
    lastUsedAt: number;
    useCount: number;
    status: 'hot' | 'warm' | 'cold';
}>;
//# sourceMappingURL=model-warmup.d.ts.map