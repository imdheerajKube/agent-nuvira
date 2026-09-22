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

import { getModelRegistry, type ModelRegistryEntry } from './model-registry.js';
import { spotCheckModel, refreshModelRegistry } from '../inference/model-probe.js';
import { detectCredentialChange } from './credential-fingerprint.js';
import { ProviderFactory } from '../inference/factory.js';
import type { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Every bound this module spends against a free tier, in one place and
 * OVERRIDABLE.
 *
 * These were module constants, which made the sweep's cost a property of the
 * build rather than of the user's plan. The sweep is safe because it is bounded,
 * so the bounds are exactly what an operator needs to see and tune — for a free
 * tier one probe per cycle may be right, for a paid key tens are harmless. Env
 * overrides keep that a configuration decision, never a source edit and a
 * rebuild.
 */
export interface WarmupConfig {
  /** How often the daemon runs a cycle (ms). */
  intervalMs: number;
  /** Minimum time between warmups of the same model (ms). */
  warmThrottleMs: number;
  /** Max HOT (already-in-use) models warmed per cycle. */
  hotPerCycle: number;
  /** Max NEVER-VERIFIED models spot-checked per cycle (the exploration budget). */
  explorePerCycle: number;
  /** Never re-probe the same unverified model more often than this (ms). */
  exploreThrottleMs: number;
  /** Models used within this window are "hot" (ms). */
  hotWindowMs: number;
  /** Models used within this window are "warm" (ms). */
  warmWindowMs: number;
}

/** Parse a positive-integer env override; anything else falls back. */
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve the sweep's bounds (env overrides → defaults).
 *
 * Read per call, not captured at import, so a test — or a long-running daemon
 * whose env was set after boot — observes the value in force at that moment.
 */
export function warmupConfig(env: NodeJS.ProcessEnv = process.env): WarmupConfig {
  return {
    intervalMs: positiveInt(env.NUVIRA_WARMUP_INTERVAL_MS, 60_000),
    warmThrottleMs: positiveInt(env.NUVIRA_WARMUP_THROTTLE_MS, 300_000),
    hotPerCycle: positiveInt(env.NUVIRA_WARMUP_HOT_PER_CYCLE, 10),
    explorePerCycle: positiveInt(env.NUVIRA_WARMUP_EXPLORE_PER_CYCLE, 6),
    exploreThrottleMs: positiveInt(env.NUVIRA_WARMUP_EXPLORE_THROTTLE_MS, 600_000),
    hotWindowMs: positiveInt(env.NUVIRA_WARMUP_HOT_WINDOW_MS, 30_600_000),
    warmWindowMs: positiveInt(env.NUVIRA_WARMUP_WARM_WINDOW_MS, 86_400_000),
  };
}

/**
 * HOW MANY NEVER-VERIFIED MODELS ONE CYCLE MAY SPOT-CHECK (the exploration
 * budget) — now `explorePerCycle` in {@link warmupConfig}.
 *
 * WHY THE POOL WAS FROZEN (Models-page audit). The cycle only ever considered
 * `usageMap` — the models THIS process had already used — so a model that had
 * never served a call could never be a candidate, could never be verified, and
 * therefore could never serve a call. Verified-and-in-use models win every pick,
 * so the pool was self-sealing: 12 verified models (3 providers) against 496
 * unverified ones, with `gemini-3.1-flash-lite` taking 223 of 255 calls in a day.
 * The consequence is not just narrow model choice — the registry's own 7-day
 * staleness rule then RETIRES models nothing re-verifies, so the pool shrinks
 * (4 of the 12 were already at 142.8h).
 *
 * A spot-check is a 1-token generation, so this is cheap AND bounded: six per
 * cycle by default, six per model at most every ten minutes, and the sweep is
 * self-terminating (a model leaves the candidate set once it is verified or
 * marked unavailable).
 */

// ─── Usage Tracking ─────────────────────────────────────────────────────────

interface UsageRecord {
  provider: string;
  model: string;
  lastUsedAt: number;
  useCount: number;
}

/** In-memory usage tracker (persisted to registry via telemetry). */
const usageMap = new Map<string, UsageRecord>();

function usageKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Record a model usage event.
 * Called after every successful LLM call to track which models are hot.
 */
export function recordModelUsage(provider: string, model: string): void {
  const key = usageKey(provider, model);
  const existing = usageMap.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    existing.useCount++;
  } else {
    usageMap.set(key, {
      provider,
      model,
      lastUsedAt: Date.now(),
      useCount: 1,
    });
  }
}

// ─── Priority Scoring ───────────────────────────────────────────────────────

interface WarmupCandidate {
  provider: string;
  model: string;
  priority: number; // Higher = more urgent to warm up
}

/**
 * Score a model for warmup priority.
 * Factors:
 *   1. Recency: recently used = higher priority
 *   2. Frequency: frequently used = higher priority
 *   3. Verification: verified models = higher priority (don't warm unavailable ones)
 *   4. Latency: slow models benefit more from warmup
 */
function scoreWarmupPriority(
  record: UsageRecord,
  registryEntry: ModelRegistryEntry | undefined,
): number {
  const now = Date.now();

  // Recency score: 0-1 (1 = just used, 0 = used long ago)
  const timeSinceUse = now - record.lastUsedAt;
  const recencyScore = Math.max(0, 1 - (timeSinceUse / warmupConfig().hotWindowMs));

  // Frequency score: 0-1 (1 = used many times)
  const frequencyScore = Math.min(1, record.useCount / 100);

  // Verification score: verified = 1, unverified = 0.5, unavailable = 0
  let verificationScore = 0.5;
  if (registryEntry) {
    if (registryEntry.status === 'verified') verificationScore = 1.0;
    else if (registryEntry.status === 'unavailable') verificationScore = 0.0;
  }

  // Latency score: slower models benefit more from warmup (0-1)
  let latencyScore = 0.5;
  if (registryEntry?.latencyMs) {
    // Models with > 2000ms latency benefit most from warmup
    latencyScore = Math.min(1, registryEntry.latencyMs / 3000);
  }

  // Combined score (weighted)
  return (
    recencyScore * 0.35 +
    frequencyScore * 0.25 +
    verificationScore * 0.20 +
    latencyScore * 0.20
  );
}

// ─── Warmup Daemon ──────────────────────────────────────────────────────────

let warmupTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the warmup daemon.
 * Runs periodically to keep frequently-used models warm — and to GROW the
 * verified pool (see {@link selectExplorationCandidates}).
 */
export function startWarmupDaemon(configManager: ConfigManager, deps: WarmupDeps = {}): void {
  if (warmupTimer) return; // Already running

  const intervalMs = warmupConfig().intervalMs;
  logger.info(`[warmup] Starting model warmup daemon (every ${intervalMs}ms)`);
  warmupTimer = setInterval(() => {
    if (!isRunning) {
      isRunning = true;
      runWarmupCycle(configManager, deps).finally(() => { isRunning = false; });
    }
  }, intervalMs);
  // The daemon must never hold the process open.
  //
  // Without this, starting it on a normal run would hang every CLI command
  // forever — which is why it was only ever started from the COLD-START branch
  // (`getUsableProviders().length === 0`). That made the whole module dead in
  // practice: once ANY model was verified, nothing ever warmed or verified
  // another one. `unref()` is the same idiom the model probe already uses, and
  // it is what makes starting this on every run safe.
  (warmupTimer as unknown as { unref?: () => void }).unref?.();

  // Run first cycle immediately
  isRunning = true;
  runWarmupCycle(configManager, deps).finally(() => { isRunning = false; });
}

/**
 * Stop the warmup daemon.
 */
export function stopWarmupDaemon(): void {
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
    logger.info('[warmup] Stopped model warmup daemon');
  }
}

/** What one cycle did — returned, so the caller reports it instead of guessing. */
export interface WarmupCycleResult {
  /** Hot models spot-checked (already in use — the original behaviour). */
  warmed: number;
  /** NEVER-VERIFIED models spot-checked to grow the routing pool. */
  explored: number;
  /** Spot-checks of either kind that came back `verified`. */
  verified: number;
  /** Hot candidates the per-cycle cap left for the next cycle. */
  skipped: number;
  /**
   * True when the credential shape changed, so this cycle forced a full catalog
   * re-probe before spot-checking. Reported because it explains why one cycle
   * did noticeably more network work than its neighbours.
   */
  catalogRefreshed: boolean;
}

/** Injectable seams for tests — the real spot-check talks to a provider. */
export interface WarmupDeps {
  spotCheck?: (
    provider: string,
    model: string,
    cm: ConfigManager,
  ) => Promise<'verified' | 'unavailable' | 'skipped' | 'error'>;
  /**
   * Seam for the credential-change catalog re-probe. Defaults to the real
   * `refreshModelRegistry`; injected so a test asserts the re-probe HAPPENS
   * without any provider traffic.
   */
  refreshCatalog?: (cm: ConfigManager) => Promise<unknown>;
  /** Seam for credential-change detection (defaults to the real sidecar). */
  detectCredentialChange?: (cm: ConfigManager) => { changed: boolean };
}

/** Can this provider actually serve? Real adapter + credentials. */
function isServable(provider: string, configManager: ConfigManager): boolean {
  try {
    if (!ProviderFactory.isConstructible(provider)) return false;
    return configManager.hasRequiredCredentials(provider) === true;
  } catch {
    return false;
  }
}

/**
 * Pick unverified models worth a one-token spot-check — the models the router
 * cannot currently see.
 *
 * The ORDER is the fix. Providers with the FEWEST verified models come first,
 * because that is where the routing pool is thinnest: broadening a *provider*
 * is what breaks winner-take-all, while verifying a thirteenth model on the
 * provider that already wins every pick changes nothing about how the agent
 * behaves. Unservable providers are excluded outright, so a cycle can never
 * spend its whole budget on something that cannot answer.
 */
export function selectExplorationCandidates(
  registry: ReturnType<typeof getModelRegistry>,
  configManager: ConfigManager,
  now: number,
  limit: number,
): WarmupCandidate[] {
  if (limit <= 0) return [];
  const rows: Array<WarmupCandidate & { verifiedInProvider: number }> = [];

  const exploreThrottleMs = warmupConfig().exploreThrottleMs;
  for (const provider of registry.getTrackedProviders()) {
    if (!isServable(provider, configManager)) continue;
    const verifiedInProvider = registry.getProviderStats(provider).verified;
    for (const entry of registry.getAllModelsForProvider(provider)) {
      if (entry.status !== 'unverified') continue;
      // The config sentinel is not a model id (same guard the router uses).
      if (!entry.model || entry.model === 'default') continue;
      if (entry.quotaParkedUntil > now) continue;
      if (now - (entry.lastProbedAt ?? 0) < exploreThrottleMs) continue;
      rows.push({ provider, model: entry.model, priority: -verifiedInProvider, verifiedInProvider });
    }
  }

  rows.sort(
    (a, b) =>
      a.verifiedInProvider - b.verifiedInProvider ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
  return rows.slice(0, limit).map(({ provider, model, priority }) => ({ provider, model, priority }));
}

/**
 * Run one warmup cycle: keep hot models warm, and grow the verified pool.
 *
 * Both halves matter and neither is optional. The hot half keeps in-use models
 * from going stale; the exploration half is what stops the pool from freezing —
 * and note it runs even when `usageMap` is empty, which is exactly the state of
 * a fresh process (the old `if (records.length === 0) return;` made the first
 * cycle of every short-lived CLI run a no-op).
 */
export async function runWarmupCycle(
  configManager: ConfigManager,
  deps: WarmupDeps = {},
): Promise<WarmupCycleResult> {
  const registry = getModelRegistry();
  const now = Date.now();
  const cfg = warmupConfig();
  const spotCheck = deps.spotCheck ?? spotCheckModel;
  const result: WarmupCycleResult = {
    warmed: 0,
    explored: 0,
    verified: 0,
    skipped: 0,
    catalogRefreshed: false,
  };

  // ── Half 0: did the KEY SET change since the last run? ──────────────────
  // The pool can only hold models a probe has verified, and there is no
  // per-model entitlement API to ask — so the one case a user notices ("I just
  // bought credits, where are the models?") was invisible until an unrelated
  // cold start happened to re-probe. Noticing the change and forcing the probe
  // is cheap and idempotent, and it fires ONCE per change (the sidecar records
  // the new shape before returning).
  try {
    const detect = deps.detectCredentialChange ?? detectCredentialChange;
    if (detect(configManager).changed) {
      const refresh = deps.refreshCatalog ?? ((cm: ConfigManager) => refreshModelRegistry(cm, { spotCheck: true }));
      result.catalogRefreshed = true;
      logger.info('[warmup] Credentials changed — re-probing the catalog');
      await refresh(configManager);
    }
  } catch {
    // Best-effort — a failed re-probe must never break warmup.
  }

  // ── Half 1: models already in use (hot → keep them warm) ────────────────
  const hot: WarmupCandidate[] = [];
  for (const record of usageMap.values()) {
    const entry = registry.getEntry(record.provider, record.model);
    if (entry && entry.lastUsedAt && now - entry.lastUsedAt < cfg.warmThrottleMs) continue;
    if (entry?.status === 'unavailable') continue;
    if (now - record.lastUsedAt > cfg.warmWindowMs) continue;
    const priority = scoreWarmupPriority(record, entry);
    if (priority > 0.1) hot.push({ provider: record.provider, model: record.model, priority });
  }
  hot.sort((a, b) => b.priority - a.priority);

  const toWarm = hot.slice(0, cfg.hotPerCycle);
  result.skipped = hot.length - toWarm.length;

  // ── Half 2: never-verified models (the pool the router cannot see) ──────
  const exploration = selectExplorationCandidates(
    registry,
    configManager,
    now,
    cfg.explorePerCycle,
  );

  const exploreKeys = new Set(exploration.map((c) => usageKey(c.provider, c.model)));
  const cycle = [...toWarm, ...exploration];
  if (cycle.length === 0) return result;

  logger.debug(
    `[warmup] ${toWarm.length} hot · ${exploration.length} unverified candidates`,
  );

  for (const candidate of cycle) {
    const key = usageKey(candidate.provider, candidate.model);
    try {
      const outcome = await spotCheck(candidate.provider, candidate.model, configManager);
      if (outcome === 'verified') result.verified += 1;
      if (exploreKeys.has(key)) result.explored += 1;
      else result.warmed += 1;
      if (outcome === 'verified') {
        const record = usageMap.get(key);
        if (record) record.lastUsedAt = now; // Reset the clock
      }
    } catch {
      // Best-effort — warmup must never break routing
    }
  }

  return result;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

/**
 * Get warmup statistics (for dashboard display).
 */
export function getWarmupStats(): {
  trackedModels: number;
  hotModels: number;
  warmModels: number;
  lastCycleAt: number;
} {
  const now = Date.now();
  const cfg = warmupConfig();
  const records = Array.from(usageMap.values());

  let hotModels = 0;
  let warmModels = 0;

  for (const record of records) {
    const timeSinceUse = now - record.lastUsedAt;
    if (timeSinceUse < cfg.hotWindowMs) hotModels++;
    else if (timeSinceUse < cfg.warmWindowMs) warmModels++;
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
export function getTrackedModels(): Array<{
  provider: string;
  model: string;
  lastUsedAt: number;
  useCount: number;
  status: 'hot' | 'warm' | 'cold';
}> {
  const now = Date.now();
  const cfg = warmupConfig();
  return Array.from(usageMap.values()).map(record => {
    const timeSinceUse = now - record.lastUsedAt;
    let status: 'hot' | 'warm' | 'cold' = 'cold';
    if (timeSinceUse < cfg.hotWindowMs) status = 'hot';
    else if (timeSinceUse < cfg.warmWindowMs) status = 'warm';

    return {
      provider: record.provider,
      model: record.model,
      lastUsedAt: record.lastUsedAt,
      useCount: record.useCount,
      status,
    };
  });
}
