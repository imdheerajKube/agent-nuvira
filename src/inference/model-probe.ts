/**
 * Model Probe — keeps the ModelRegistry fresh ("ping and gather statistics").
 *
 * Three layers, mirroring the ModelAvailabilityRegistry's feed design:
 *
 *   1. `probeProviderList()` — listModels() per provider (free). Marks every
 *      returned model as listed/unverified in the registry and confirms the
 *      provider is reachable with the configured key.
 *   2. `spotCheckModel()` — a 1-token generation against a candidate model.
 *      This is what separates "listed" from "actually usable": a configured key
 *      whose account can't purchase/access a model surfaces as 403/404 here
 *      and the registry marks it `unavailable` BEFORE routing ever picks it.
 *      Throttled so repeated refreshes don't burn the free tier.
 *   3. `refreshModelRegistry()` — orchestrates probes + spot-checks across all
 *      configured providers and writes the registry (JSON mirror + vector
 *      mirror). `watchModelRegistry()` runs it on a schedule as the standalone
 *      maintenance daemon (`buff models watch`).
 *
 * All providers are resolved through ProviderFactory with the user's configured
 * credentials; a missing key simply skips the provider (never throws).
 */

import { ProviderFactory } from './factory.js';
import type { ConfigManager } from '../config/manager.js';
import type { InferenceProvider } from './interface.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { classifyFallbackError, type FallbackErrorType } from '../learning/provider-fallback.js';
import { getEventBus, EventNames } from '../observability/event-bus.js';
import { CATALOG_PROVIDER_IDS, isCatalogKeyless } from './provider-catalog.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Fallback provider set for the probe when nothing is configured (kept for
 * backward-compat imports). `defaultProbeProviders()` below is the DYNAMIC
 * set (Issue 001): every catalog provider the user has credentials for.
 */
export const PROBE_PROVIDERS = ['local', 'groq', 'gemini', 'nim', 'openrouter'];

/**
 * DYNAMIC default probe set (Issue 001): every catalog provider the user can
 * actually reach — keyed providers with a real key, plus keyless providers
 * (local, nuvira, lmstudio, vllm — reachability is probed, never assumed).
 * A user who sets OPENAI_API_KEY / ANTHROPIC_API_KEY / ... gets those
 * providers probed + spot-checked automatically.
 */
export function defaultProbeProviders(configManager: ConfigManager): string[] {
  try {
    const withCreds = CATALOG_PROVIDER_IDS.filter((p) => {
      try {
        return isCatalogKeyless(p) || configManager.hasRequiredCredentials(p);
      } catch {
        return false;
      }
    });
    return withCreds.length > 0 ? withCreds : PROBE_PROVIDERS;
  } catch {
    return PROBE_PROVIDERS;
  }
}

/** The one-token probe prompt — tiny, deterministic, near-free. */
export const SPOT_CHECK_PROMPT = 'Reply with the single word: ok';

/** Minimum gap between spot-checks of the SAME model (ms) — protects free tiers. */
export const SPOT_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 min

/** Generation timeout for a spot-check (ms). */
export const SPOT_CHECK_TIMEOUT_MS = 20_000;

/** In-flight throttle: how many spot-checks can run concurrently per refresh. */
const SPOT_CHECK_CONCURRENCY = 3;

// ─── Provider resolution ────────────────────────────────────────────────────

/**
 * Build an inference provider for a provider type using the user's configured
 * credentials. Returns null when the type is unknown or has no key (local is
 * always attempted — it needs no key).
 */
export function buildProvider(providerType: string, configManager: ConfigManager): InferenceProvider | null {
  try {
    const { config } = configManager.getProviderConfig(providerType as never);
    if (!configManager.hasRequiredCredentials(providerType) && providerType !== 'local') {
      return null;
    }
    return ProviderFactory.createProvider(providerType, config);
  } catch {
    return null;
  }
}

// ─── Layer 1: listModels probe ──────────────────────────────────────────────

/**
 * Probe a provider's live model list and record it in the registry.
 * Returns the model ids listed (empty on failure) — never throws.
 */
export async function probeProviderList(providerType: string, configManager: ConfigManager): Promise<string[]> {
  const provider = buildProvider(providerType, configManager);
  if (!provider) return [];
  try {
    const models = await provider.listModels();
    const ids = models.map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      // Pass the full descriptors so the registry records the provider's
      // advertised context window (live preflight data) alongside availability.
      getModelRegistry().markListed(providerType, models);
    }
    return ids;
  } catch {
    return [];
  }
}

// ─── Layer 2: spot-check (1-token generation) ───────────────────────────────

/**
 * Verify a model actually serves requests with a 1-token generation.
 * Success → `verified` (with measured latency). 401/403/404 → `unavailable`
 * (the "key exists but model not purchasable" case). 429 → unavailable +
 * quota-parked. Network/timeout → left untouched (transient).
 *
 * Returns the outcome for callers that want to render a summary.
 */
export async function spotCheckModel(
  providerType: string,
  model: string,
  configManager: ConfigManager,
): Promise<'verified' | 'unavailable' | 'skipped' | 'error'> {
  const registry = getModelRegistry();
  const now = Date.now();

  // Throttle: skip models verified recently — don't burn the free tier on
  // every refresh cycle.
  const existing = registry.getEntry(providerType, model);
  if (existing?.status === 'verified' && now - existing.lastVerifiedAt < SPOT_CHECK_MIN_INTERVAL_MS) {
    return 'skipped';
  }

  const provider = buildProvider(providerType, configManager);
  if (!provider) return 'error';

  const startedAt = Date.now();
  try {
    const result = await withTimeout(
      provider.generate(SPOT_CHECK_PROMPT, {
        model,
        maxTokens: 1,
        temperature: 0,
      }),
      SPOT_CHECK_TIMEOUT_MS,
    );
    // A usable model returns non-empty text. (Some providers echo nothing on a
    // maxTokens=1 stop — treat "returned" as success regardless of content.)
    void result;
    const latencyMs = Date.now() - startedAt;
    registry.markVerified(providerType, model, 'spot-check', latencyMs, 'spot-check');
    return 'verified';
  } catch (err) {
    const type = classifyFallbackError(err);
    const msg = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
    if (type === 'auth' || isPermissionError(msg)) {
      registry.markUnavailable(providerType, model, `${type}: ${msg}`, 'spot-check', 0, 'spot-check');
      return 'unavailable';
    }
    if (type === 'rate-limit') {
      registry.markUnavailable(providerType, model, 'rate-limit (quota parked)', 'spot-check', 0, 'spot-check');
      return 'unavailable';
    }
    // Transient (network/timeout/server/unknown) — leave the entry as-is so a
    // blip never flips a good model to unavailable.
    logger.debug(`Model probe: ${providerType}/${model} transient error (${type}) — ignored`);
    return 'error';
  }
}

/** 403/404 = "you can't buy/access this model" — treat as unavailable, not transient. */
function isPermissionError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('403') ||
    lower.includes('404') ||
    lower.includes('permission denied') ||
    lower.includes('not found') ||
    lower.includes('does not exist') ||
    lower.includes('model not found') ||
    lower.includes('access denied') ||
    lower.includes('billing') ||
    lower.includes('not enabled')
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('probe timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── Layer 3: refresh orchestration ─────────────────────────────────────────

/** Options for a registry refresh pass. */
export interface RefreshOptions {
  /** Restrict to these providers (default: all PROBE_PROVIDERS with keys). */
  providers?: string[];
  /** Also run 1-token spot-checks against candidate models (default: true). */
  spotCheck?: boolean;
  /**
   * Extra candidate models per provider to spot-check on TOP of the curated
   * live-list candidates + configured pin (default: []).
   */
  extraModels?: Record<string, string[]>;
  /** Max spot-checks per provider per pass (default: 5 — protects free tiers). */
  maxSpotChecksPerProvider?: number;
  /** Callback fired after each provider pass (daemon progress reporting). */
  onProgress?: (label: string, detail: string) => void;
}

export interface RefreshResult {
  providersProbed: string[];
  modelsListed: number;
  verified: number;
  unavailable: number;
  skipped: number;
  errors: number;
  /** ISSUE-004 (4c): stale local-model entries purged (user deleted the model). */
  prunedLocal: number;
}

/**
 * One refresh pass: probe every configured provider's list, then spot-check
 * candidate models (curated defaults + configured pin + user extras) against
 * the LIVE API, throttled by the registry's last-verified timestamps.
 */
export async function refreshModelRegistry(configManager: ConfigManager, options: RefreshOptions = {}): Promise<RefreshResult> {
  const registry = getModelRegistry();
  // Dynamic default (Issue 001): all configured providers, not just the 5
  // built-ins — a configured OPENAI_API_KEY gets probed without hardcoding.
  const providers = options.providers || defaultProbeProviders(configManager);
  const spotCheckEnabled = options.spotCheck !== false;
  const maxChecks = options.maxSpotChecksPerProvider ?? 5;

  const result: RefreshResult = {
    providersProbed: [],
    modelsListed: 0,
    verified: 0,
    unavailable: 0,
    skipped: 0,
    errors: 0,
    prunedLocal: 0,
  };

  for (const providerType of providers) {
    const label = `  🔎 ${providerType}`;
    try {
      const listed = await probeProviderList(providerType, configManager);
      result.modelsListed += listed.length;
      if (listed.length === 0) {
        options.onProgress?.(label, 'no models listed (no key / unreachable)');
        continue;
      }
      // ISSUE-004 (4c): for KEYLESS/LOCAL runners the live list is
      // AUTHORITATIVE — if the user deleted a model from the system (e.g.
      // `ollama rm`), purge its stale registry entry so it stops being checked
      // every time. Never prunes keyed providers (their lists are portals to
      // large catalogs, not the local disk).
      if (isCatalogKeyless(providerType)) {
        try {
          const pruned = getModelRegistry().pruneAbsentModels(providerType, listed);
          if (pruned > 0) {
            result.prunedLocal += pruned;
            options.onProgress?.(label, `${pruned} stale local model(s) removed (deleted from system)`);
          }
        } catch {
          // Best-effort — pruning must never break the refresh.
        }
      }
      result.providersProbed.push(providerType);
      options.onProgress?.(label, `${listed.length} models listed`);

      if (!spotCheckEnabled) continue;

      // Candidate models to spot-check — all derived from the LIVE list, never
      // a hardcoded catalog: the configured pin (if set), previously verified
      // models, user extras, then the live list ranked by generic capability
      // scoring (chat-capable, non-speech, stable over preview). Dedupe, cap.
      const configuredModel = getConfiguredModel(configManager, providerType);
      const candidates = [
        ...(configuredModel && configuredModel !== 'default' ? [configuredModel] : []),
        ...registry.getVerifiedModels(providerType),
        ...(options.extraModels?.[providerType] || []),
        ...rankProbeCandidates(listed),
      ].filter((m, i, arr) => arr.indexOf(m) === i && listed.includes(m));
      const toCheck = candidates.slice(0, maxChecks);

      // Throttle concurrency so bursts of spot-checks don't hammer a free tier.
      let idx = 0;
      const worker = async (): Promise<void> => {
        while (idx < toCheck.length) {
          const model = toCheck[idx++];
          const outcome = await spotCheckModel(providerType, model, configManager);
          if (outcome === 'verified') result.verified++;
          else if (outcome === 'unavailable') result.unavailable++;
          else if (outcome === 'skipped') result.skipped++;
          else result.errors++;
          options.onProgress?.(`  🎯 ${providerType}/${model}`, outcome);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SPOT_CHECK_CONCURRENCY, toCheck.length) }, worker));
    } catch (err) {
      result.errors++;
      options.onProgress?.(label, `error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sync quota parks from the ledger + demote stale verified entries.
  try {
    registry.syncQuota(configManager);
    registry.pruneStale();
  } catch {
    // Best-effort.
  }

  return result;
}

/** Read the configured model pin for a provider ('' when none). */
/**
 * Generic capability ranking for probe spot-check candidates — no specific
 * model names: speech/audio sinks, then preview/experimental sinks, so
 * stable chat-capable models are verified first.
 */
function rankProbeCandidates(ids: string[]): string[] {
  const score = (id: string): number => {
    const l = id.toLowerCase();
    let s = 0;
    if (/(whisper|tts|stt|speech|audio|transcrib|voice)/.test(l)) s += 100;
    if (/(preview|exp$|latest)/.test(l)) s += 10;
    return s;
  };
  return [...ids].sort((a, b) => score(a) - score(b));
}

function getConfiguredModel(configManager: ConfigManager, providerType: string): string | undefined {
  try {
    const { config } = configManager.getProviderConfig(providerType as never);
    return config?.model;
  } catch {
    return undefined;
  }
}

// ─── Watch daemon (standalone maintainer) ───────────────────────────────────

/**
 * Run a maintenance pass immediately, then every `intervalMs`. Used by
 * `buff models watch` as the dedicated background agent that keeps the
 * registry fresh even when the CLI isn't running a pipeline.
 *
 * Returns a stop function that also cleans up signal handlers — designed for
 * the CLI command's lifecycle (the command awaits a stop signal).
 */
export function startRegistryWatcher(
  configManager: ConfigManager,
  options: RefreshOptions & { intervalMs?: number } = {},
): { stop: () => void; runOnce: () => Promise<RefreshResult> } {
  const intervalMs = options.intervalMs ?? 10 * 60 * 1000; // 10 min default
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const runOnce = async (): Promise<RefreshResult> => {
    if (stopped) return { providersProbed: [], modelsListed: 0, verified: 0, unavailable: 0, skipped: 0, errors: 0, prunedLocal: 0 };
    const result = await refreshModelRegistry(configManager, options);
    logger.info(
      `Model registry refreshed — ${result.providersProbed.length} provider(s), ` +
      `${result.modelsListed} listed, ${result.verified} verified, ${result.unavailable} unavailable, ${result.skipped} skipped`,
    );
    return result;
  };

  // ── Event-driven wakeup ────────────────────────────────────────────────────
  // The watch daemon is the dedicated MODEL-HEALTH AGENT. Mid-session state
  // changes (a chat/orchestrator failure that flipped a model unavailable, a
  // quota park, a release) are REPORTED to it via MODEL_REGISTRY_UPDATED and
  // it reacts IMMEDIATELY by re-verifying the affected provider — so recovery
  // is discovered in seconds, not at the next scheduled cycle. This closes the
  // "staleness window" between periodic probes without probing on every call.
  let unsubscribeEvent: (() => void) | null = null;
  // Per-provider throttle so a burst of failure events (e.g. a chat session
  // failing the same provider repeatedly) can't trigger a spot-check storm.
  const lastEventVerify = new Map<string, number>();
  const EVENT_REVERIFY_MIN_INTERVAL_MS = 30 * 1000; // 30s per provider
  try {
    unsubscribeEvent = getEventBus().on(EventNames.MODEL_REGISTRY_UPDATED, (record) => {
      if (stopped) return;
      const data = record?.data as { providers?: string[]; source?: string } | undefined;
      // Ignore the watcher's OWN writes (probe/spot-check): re-verifying a
      // provider because ITS re-verification marked something unavailable would
      // self-trigger forever. Only mid-session TELEMETRY (chat/orchestrator
      // failures) and QUOTA parks/releases wake the daemon.
      if (data?.source === 'probe' || data?.source === 'spot-check') return;
      const providers = data?.providers || [];
      const now = Date.now();
      const toVerify = providers.filter((p) => {
        const last = lastEventVerify.get(p) ?? 0;
        if (now - last < EVENT_REVERIFY_MIN_INTERVAL_MS) return false;
        lastEventVerify.set(p, now);
        return true;
      });
      if (toVerify.length === 0) return;
      // Fire-and-forget: never block the event emitter on probe network I/O.
      void refreshModelRegistry(configManager, {
        ...options,
        providers: toVerify,
        // Event-driven re-verification is a targeted health check — probe the
        // provider's list + spot-check its candidate models right away.
        spotCheck: options.spotCheck !== false,
      }).then((result) => {
        logger.info(
          `Model registry event → re-verified ${result.providersProbed.join(', ')} ` +
          `(${result.verified} verified, ${result.unavailable} unavailable)`,
        );
      });
    });
  } catch {
    // Best-effort — the daemon must never crash on event-bus wiring.
  }

  // Immediate first pass, then the scheduled loop.
  void runOnce();
  timer = setInterval(() => void runOnce(), intervalMs);
  if (timer.unref) timer.unref(); // Don't hold the process open on the timer alone.

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unsubscribeEvent) {
      try {
        unsubscribeEvent();
      } catch {
        // Best-effort.
      }
      unsubscribeEvent = null;
    }
  };

  return { stop, runOnce };
}

// ─── Re-export for callers that need to classify probe errors ───────────────

export type { FallbackErrorType };
