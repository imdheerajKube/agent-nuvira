/**
 * Cold-start gate: ensures the model registry is warmed before routing.
 *
 * On a FRESH INSTALL (no registry data), this runs a synchronous
 * `refreshModelRegistry` so the first routed message gets model-level
 * intelligence instead of falling back to provider-level static metadata.
 *
 * On UPGRADES (registry already has data), the gate is a no-op — zero delay.
 *
 * Detection mechanism: a flag file `~/.nuvira/.registry-initialized` is created
 * after the first successful probe. If it exists, the gate is skipped.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getModelRegistry } from './model-registry.js';
import { refreshModelRegistry, type RefreshResult } from '../inference/model-probe.js';
import type { ConfigManager } from '../config/manager.js';
import { resolveNuviraConfigDir } from '../config/paths.js';
import { logger } from '../utils/logger.js';

const FLAG_FILENAME = '.registry-initialized';

/** Max age for the registry data before we consider it stale (7 days). */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function getFlagPath(configManager?: ConfigManager): string {
  const dir = resolveNuviraConfigDir();
  return join(dir, FLAG_FILENAME);
}

/**
 * Check if the registry has been initialized at least once.
 * Returns true if the flag file exists (upgrade scenario).
 */
export function isRegistryInitialized(configManager?: ConfigManager): boolean {
  try {
    return existsSync(getFlagPath(configManager));
  } catch {
    return false;
  }
}

/**
 * Check if the registry is genuinely cold — no usable providers AND no
 * tracked models at all. Returns true only on a fresh install.
 */
export function isRegistryCold(): boolean {
  try {
    const registry = getModelRegistry();
    if (registry.getUsableProviders().length > 0) return false;
    // Check if ANY provider has ANY tracked models (even unverified).
    // If models exist but are all unavailable, the registry is warmed but
    // providers are down — not a cold start.
    const allProviders = ['groq', 'gemini', 'local', 'openai', 'anthropic',
      'nim', 'openrouter', 'nuvira', 'azure', 'bedrock'];
    for (const p of allProviders) {
      if (registry.getAllModelsForProvider(p).length > 0) return false;
    }
    return true;
  } catch {
    return true; // Registry not accessible → treat as cold
  }
}

/**
 * Check if registry data is stale (older than STALE_MS).
 * Used for background refresh on upgrades — never blocks.
 */
export function isRegistryStale(): boolean {
  try {
    const registry = getModelRegistry();
    const allProviders = ['groq', 'gemini', 'local', 'openai', 'anthropic',
      'nim', 'openrouter', 'nuvira', 'azure', 'bedrock'];
    let latestActivity = 0;
    for (const p of allProviders) {
      for (const entry of registry.getAllModelsForProvider(p)) {
        const ts = (entry as any).lastVerifiedAt || (entry as any).lastProbedAt || 0;
        if (ts > latestActivity) latestActivity = ts;
      }
    }
    if (latestActivity === 0) return true; // No data at all
    return Date.now() - latestActivity > STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Mark the registry as initialized by creating the flag file.
 */
function markInitialized(configManager?: ConfigManager): void {
  try {
    const flagPath = getFlagPath(configManager);
    const dir = dirname(flagPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({
      initializedAt: new Date().toISOString(),
      version: '1',
    }), 'utf-8');
  } catch {
    // Best-effort — flag file creation must never break routing.
  }
}

/**
 * Ensure the model registry is warmed. This is the main entry point:
 *
 * - If the flag file exists (upgrade): returns immediately (zero delay).
 * - If the registry has usable providers (warm): creates flag, returns.
 * - If the registry is cold (fresh install): runs synchronous probe, creates flag.
 *
 * Returns the refresh result for callers that want to show warm-up status.
 * The refresh is time-bounded: if it takes > 10s, it's aborted and the flag
 * is still created (partial data is better than no data).
 *
 * @returns RefreshResult if a probe was run, null if skipped (already warm/initialized).
 */
export async function ensureRegistryWarmed(
  configManager: ConfigManager,
  options?: { onProgress?: (msg: string) => void },
): Promise<RefreshResult | null> {
  // ── Fast path: flag file exists (upgrade) ──────────────────────────────
  if (isRegistryInitialized(configManager)) {
    // Optional: background refresh if stale (fire-and-forget)
    if (isRegistryStale()) {
      void refreshModelRegistry(configManager, { spotCheck: true }).catch(() => {});
    }
    return null; // No blocking probe needed
  }

  // ── Fast path: registry already has usable providers ───────────────────
  // (e.g. another terminal session already warmed it, or registry was
  //  manually populated).
  if (!isRegistryCold()) {
    markInitialized(configManager);
    return null;
  }

  // ── Cold start: synchronous probe ──────────────────────────────────────
  options?.onProgress?.('🔍 First run — warming up model registry (one-time, ~5s)...');

  try {
    // Run with a timeout: if the probe takes too long, abort gracefully.
    const probePromise = refreshModelRegistry(configManager, { spotCheck: true });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('cold-start probe timeout')), 15_000),
    );

    const result = await Promise.race([probePromise, timeoutPromise]);

    markInitialized(configManager);

    const msg = `✅ Registry warmed: ${result.verified} verified model(s), ${result.unavailable} unavailable`;
    options?.onProgress?.(msg);
    logger.info(`   ${msg}`);

    return result;
  } catch (err) {
    // Probe failed or timed out — still create the flag so we don't retry
    // on every startup. The fire-and-forget in the orchestrator will try
    // again with more time.
    markInitialized(configManager);
    const msg = '⚠️ Registry warm-up incomplete — routing will use provider-level defaults';
    options?.onProgress?.(msg);
    logger.warn(`   ${msg}`);
    return null;
  }
}
