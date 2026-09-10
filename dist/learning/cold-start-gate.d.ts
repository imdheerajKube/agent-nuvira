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
import { type RefreshResult } from '../inference/model-probe.js';
import type { ConfigManager } from '../config/manager.js';
/**
 * Check if the registry has been initialized at least once.
 * Returns true if the flag file exists (upgrade scenario).
 */
export declare function isRegistryInitialized(configManager?: ConfigManager): boolean;
/**
 * Check if the registry is genuinely cold — no usable providers AND no
 * tracked models at all. Returns true only on a fresh install.
 */
export declare function isRegistryCold(): boolean;
/**
 * Check if registry data is stale (older than STALE_MS).
 * Used for background refresh on upgrades — never blocks.
 */
export declare function isRegistryStale(): boolean;
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
export declare function ensureRegistryWarmed(configManager: ConfigManager, options?: {
    onProgress?: (msg: string) => void;
}): Promise<RefreshResult | null>;
//# sourceMappingURL=cold-start-gate.d.ts.map