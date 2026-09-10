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
import { getModelRegistry } from './model-registry.js';
import { spotCheckModel } from '../inference/model-probe.js';
import { logger } from '../utils/logger.js';
// ─── Configuration ──────────────────────────────────────────────────────────
/** How often to run the warmup cycle (ms). */
const WARMUP_INTERVAL_MS = 60_000; // 1 minute
/** Minimum time between warmups of the same model (ms). */
const WARMUP_THROTTLE_MS = 300_000; // 5 minutes
/** Maximum models to warm up per cycle. */
const MAX_WARMUPS_PER_CYCLE = 10;
/** Models used within this window are considered "hot" (ms). */
const HOT_WINDOW_MS = 30_600_000; // ~8.5 hours
/** Models used within this window are considered "warm" (ms). */
const WARM_WINDOW_MS = 86_400_000; // 24 hours
/** In-memory usage tracker (persisted to registry via telemetry). */
const usageMap = new Map();
function usageKey(provider, model) {
    return `${provider}:${model}`;
}
/**
 * Record a model usage event.
 * Called after every successful LLM call to track which models are hot.
 */
export function recordModelUsage(provider, model) {
    const key = usageKey(provider, model);
    const existing = usageMap.get(key);
    if (existing) {
        existing.lastUsedAt = Date.now();
        existing.useCount++;
    }
    else {
        usageMap.set(key, {
            provider,
            model,
            lastUsedAt: Date.now(),
            useCount: 1,
        });
    }
}
/**
 * Score a model for warmup priority.
 * Factors:
 *   1. Recency: recently used = higher priority
 *   2. Frequency: frequently used = higher priority
 *   3. Verification: verified models = higher priority (don't warm unavailable ones)
 *   4. Latency: slow models benefit more from warmup
 */
function scoreWarmupPriority(record, registryEntry) {
    const now = Date.now();
    // Recency score: 0-1 (1 = just used, 0 = used long ago)
    const timeSinceUse = now - record.lastUsedAt;
    const recencyScore = Math.max(0, 1 - (timeSinceUse / HOT_WINDOW_MS));
    // Frequency score: 0-1 (1 = used many times)
    const frequencyScore = Math.min(1, record.useCount / 100);
    // Verification score: verified = 1, unverified = 0.5, unavailable = 0
    let verificationScore = 0.5;
    if (registryEntry) {
        if (registryEntry.status === 'verified')
            verificationScore = 1.0;
        else if (registryEntry.status === 'unavailable')
            verificationScore = 0.0;
    }
    // Latency score: slower models benefit more from warmup (0-1)
    let latencyScore = 0.5;
    if (registryEntry?.latencyMs) {
        // Models with > 2000ms latency benefit most from warmup
        latencyScore = Math.min(1, registryEntry.latencyMs / 3000);
    }
    // Combined score (weighted)
    return (recencyScore * 0.35 +
        frequencyScore * 0.25 +
        verificationScore * 0.20 +
        latencyScore * 0.20);
}
// ─── Warmup Daemon ──────────────────────────────────────────────────────────
let warmupTimer = null;
let isRunning = false;
/**
 * Start the warmup daemon.
 * Runs periodically to keep frequently-used models warm.
 */
export function startWarmupDaemon(configManager) {
    if (warmupTimer)
        return; // Already running
    logger.info('[warmup] Starting model warmup daemon');
    warmupTimer = setInterval(() => {
        if (!isRunning) {
            isRunning = true;
            runWarmupCycle(configManager).finally(() => { isRunning = false; });
        }
    }, WARMUP_INTERVAL_MS);
    // Run first cycle immediately
    isRunning = true;
    runWarmupCycle(configManager).finally(() => { isRunning = false; });
}
/**
 * Stop the warmup daemon.
 */
export function stopWarmupDaemon() {
    if (warmupTimer) {
        clearInterval(warmupTimer);
        warmupTimer = null;
        logger.info('[warmup] Stopped model warmup daemon');
    }
}
/**
 * Run one warmup cycle.
 */
async function runWarmupCycle(configManager) {
    const registry = getModelRegistry();
    const now = Date.now();
    // Get all usage records
    const records = Array.from(usageMap.values());
    if (records.length === 0)
        return;
    // Score and sort by priority
    const candidates = [];
    for (const record of records) {
        // Skip if warmed up recently
        const key = usageKey(record.provider, record.model);
        const entry = registry.getEntry(record.provider, record.model);
        if (entry && entry.lastUsedAt && now - entry.lastUsedAt < WARMUP_THROTTLE_MS) {
            continue;
        }
        // Skip unavailable models
        if (entry?.status === 'unavailable')
            continue;
        // Skip if not used recently enough
        if (now - record.lastUsedAt > WARM_WINDOW_MS)
            continue;
        const priority = scoreWarmupPriority(record, entry);
        if (priority > 0.1) { // Minimum threshold
            candidates.push({
                provider: record.provider,
                model: record.model,
                priority,
            });
        }
    }
    // Sort by priority (highest first)
    candidates.sort((a, b) => b.priority - a.priority);
    // Warm up top N models
    const toWarmup = candidates.slice(0, MAX_WARMUPS_PER_CYCLE);
    if (toWarmup.length === 0)
        return;
    logger.debug(`[warmup] Warming up ${toWarmup.length} models`);
    for (const candidate of toWarmup) {
        try {
            const result = await spotCheckModel(candidate.provider, candidate.model, configManager);
            if (result === 'verified') {
                // Update usage record
                const key = usageKey(candidate.provider, candidate.model);
                const record = usageMap.get(key);
                if (record) {
                    record.lastUsedAt = now; // Reset the clock
                }
            }
        }
        catch {
            // Best-effort — warmup must never break routing
        }
    }
}
// ─── Statistics ─────────────────────────────────────────────────────────────
/**
 * Get warmup statistics (for dashboard display).
 */
export function getWarmupStats() {
    const now = Date.now();
    const records = Array.from(usageMap.values());
    let hotModels = 0;
    let warmModels = 0;
    for (const record of records) {
        const timeSinceUse = now - record.lastUsedAt;
        if (timeSinceUse < HOT_WINDOW_MS)
            hotModels++;
        else if (timeSinceUse < WARM_WINDOW_MS)
            warmModels++;
    }
    return {
        trackedModels: records.length,
        hotModels,
        warmModels,
        lastCycleAt: now,
    };
}
/**
 * Get all tracked models with their warmup status.
 */
export function getTrackedModels() {
    const now = Date.now();
    return Array.from(usageMap.values()).map(record => {
        const timeSinceUse = now - record.lastUsedAt;
        let status = 'cold';
        if (timeSinceUse < HOT_WINDOW_MS)
            status = 'hot';
        else if (timeSinceUse < WARM_WINDOW_MS)
            status = 'warm';
        return {
            provider: record.provider,
            model: record.model,
            lastUsedAt: record.lastUsedAt,
            useCount: record.useCount,
            status,
        };
    });
}
//# sourceMappingURL=model-warmup.js.map