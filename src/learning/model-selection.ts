/**
 * Dynamic model selection — the single authority for "which provider/model
 * should we use right now".
 *
 * PRINCIPLE: nothing here hardcodes a provider preference order or a model
 * name. Every decision is derived at runtime from:
 *   1. the user's EXPLICIT config (pins, keys, routing.* overrides — honored
 *      by the callers, health-checked against the live lists),
 *   2. the Model Availability Registry — what probing (`buff models refresh`)
 *      and real usage VERIFIED actually works for THIS user, ranked by learned
 *      health (error rate, then latency),
 *   3. providers with credentials configured but nothing verified yet (cold
 *      start — the model-health validator resolves a live model on first use),
 *   4. local models (Ollama etc.) — zero-config last resort,
 *   5. onboarding guidance when nothing at all is available — never a silent
 *      hardcoded fallback into a dead provider.
 *
 * The only static data here is the BUILTIN_PROVIDERS adapter catalog (the
 * code that speaks each vendor API) and generic provider-level capability
 * metadata (nominal context windows) — a catalog, never a selection.
 */

import type { ConfigManager } from '../config/manager.js';
import { getModelRegistry } from './model-registry.js';
import {
  CATALOG_PROVIDER_IDS,
  CATALOG_KEYLESS_IDS,
  isCatalogKeyless,
  catalogContextWindow,
} from '../inference/provider-catalog.js';

/** Built-in provider adapters shipped with the CLI — a catalog, not a preference. */
export const BUILTIN_PROVIDERS = ['local', 'groq', 'gemini', 'nim', 'openrouter', 'nuvira'] as const;

/**
 * Nominal provider-level context windows (tokens), used ONLY for the soft
 * context-fit estimate. Seeded from the provider catalog (the metadata home);
 * users override per-model via `routing.contextWindows[model]` when the
 * probe's live descriptors know better.
 */
export const PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {};
for (const id of CATALOG_PROVIDER_IDS) {
  const window = catalogContextWindow(id);
  if (window !== undefined) PROVIDER_CONTEXT_WINDOWS[id] = window;
}

/**
 * Keyless providers — usable with zero configuration (reachability still
 * probed). Derived from the catalog so every keyless entry participates
 * (local, nuvira, lmstudio, vllm, ...).
 */
export const KEYLESS_PROVIDERS: string[] = [...CATALOG_KEYLESS_IDS];

/**
 * True when the user has the credentials to actually use this provider.
 * Keyless zero-config providers are always "configured" by definition — their
 * reachability is probed later by isAvailable(), never assumed here.
 */
export function hasCredentials(configManager: ConfigManager, provider: string): boolean {
  if (isCatalogKeyless(provider) || KEYLESS_PROVIDERS.includes(provider)) return true;
  try {
    return configManager.hasRequiredCredentials(provider);
  } catch {
    return false;
  }
}

/**
 * Verified working models for a provider, ranked by learned health:
 * lowest error rate first, then lowest latency, then most recently verified.
 * Empty when nothing has been verified yet (cold start / no keys).
 */
export function preferredModelsFor(provider: string): string[] {
  const registry = getModelRegistry();
  return registry
    .getVerifiedModels(provider)
    .sort((a, b) => {
      const ea = registry.getEntry(provider, a);
      const eb = registry.getEntry(provider, b);
      const ra = ea?.errorRate ?? 0;
      const rb = eb?.errorRate ?? 0;
      if (ra !== rb) return ra - rb;
      const la = ea?.latencyMs ?? Number.MAX_SAFE_INTEGER;
      const lb = eb?.latencyMs ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      return (eb?.lastVerifiedAt ?? 0) - (ea?.lastVerifiedAt ?? 0);
    });
}

/** Aggregate health score for a provider (its best verified model). Lower = better. */
function providerHealth(provider: string): number {
  const registry = getModelRegistry();
  let best = Number.MAX_SAFE_INTEGER;
  for (const model of preferredModelsFor(provider)) {
    const entry = registry.getEntry(provider, model);
    const score = (entry?.errorRate ?? 0) * 1_000 + (entry?.latencyMs ?? 0);
    if (score < best) best = score;
  }
  return best;
}

export interface RankedProvider {
  provider: string;
  /** Verified models for this provider, health-ranked (empty on cold start). */
  verifiedModels: string[];
  configured: boolean;
}

/**
 * Providers the user can actually use right now, ranked:
 *   1. providers with verified+usable models (health order),
 *   2. providers with credentials configured but nothing verified yet,
 *   3. keyless zero-config providers (local, then the optional nuvira
 *      gateway) — last resort.
 * Providers the registry has definitively blocked (all tracked models
 * unavailable/quota-parked) are excluded — routing never fails into them.
 */
export function rankAvailableProviders(configManager: ConfigManager): RankedProvider[] {
  const registry = getModelRegistry();
  let blocked = new Set<string>();
  try {
    blocked = new Set(registry.getBlockedProviders());
  } catch {
    // Best-effort — registry bookkeeping must never break selection.
  }
  const usable = new Set(registry.getUsableProviders());

  // DYNAMIC candidate set (Issue 001): every catalog provider the user can
  // actually use — keyed providers with real credentials, plus keyless ones
  // (local, nuvira, lmstudio, vllm, ...) — AND any provider the user has
  // explicitly configured (config.providers / plugin providers), so custom
  // providers join routing the moment they appear in config. Nothing is
  // hardcoded to the 6 built-ins anymore.
  let configuredIds: string[] = [];
  try {
    configuredIds = Object.keys(configManager.getAll?.()?.providers ?? {});
  } catch {
    // Best-effort.
  }
  const candidates = [...new Set([...CATALOG_PROVIDER_IDS, ...configuredIds])].filter((p) => {
    if (blocked.has(p)) return false;
    // Keyless runners BEYOND `local` (nuvira, lmstudio, vllm) only join when the
    // registry has VERIFIED them or the user explicitly configured them — a
    // not-running localhost endpoint must never out-rank running local on a
    // cold start (Issue 001 review feedback). `local` is the universal
    // zero-config fallback (Ollama); the others are optional local runners.
    if (isCatalogKeyless(p) && p !== 'local') {
      const explicit = configuredIds.includes(p);
      const verified = usable.has(p);
      if (!explicit && !verified) return false;
    }
    return hasCredentials(configManager, p);
  });

  const verified = candidates.filter((p) => usable.has(p)).sort((a, b) => {
    const healthDiff = providerHealth(a) - providerHealth(b);
    if (healthDiff !== 0) return healthDiff;
    // Health tiebreak: verified KEYLESS providers sink below verified cloud
    // providers (a verified local/gateway model and a verified cloud model at
    // equal health — the cloud provider wins the tie, matching the historical
    // keyed-first candidate order now that the catalog drives discovery).
    const az = KEYLESS_PROVIDERS.includes(a) ? 1 : 0;
    const bz = KEYLESS_PROVIDERS.includes(b) ? 1 : 0;
    return az - bz;
  });
  const rest = candidates
    .filter((p) => !usable.has(p))
    .sort((a, b) => {
      // zero-config (keyless) providers last; local before the others
      const az = KEYLESS_PROVIDERS.includes(a) ? 1 : 0;
      const bz = KEYLESS_PROVIDERS.includes(b) ? 1 : 0;
      if (az !== bz) return az - bz;
      if (a === 'local') return -1;
      if (b === 'local') return 1;
      return 0;
    });

  return [...verified, ...rest].map((p) => ({
    provider: p,
    verifiedModels: preferredModelsFor(p),
    configured: hasCredentials(configManager, p),
  }));
}

/**
 * The default provider to use right now — always the best currently-available
 * one, never a hardcoded name. 'local' is the zero-config last resort; when
 * even local is unreachable the caller's availability gate shows guidance.
 */
export function resolveDefaultProvider(configManager: ConfigManager): string {
  return rankAvailableProviders(configManager)[0]?.provider ?? 'local';
}

/** Capability profile for a task/agent — expressed as needs, never as names. */
export interface CapabilityProfile {
  context?: 'large' | 'medium' | 'small';
  reasoning?: 'high' | 'medium' | 'low';
  speed?: 'high' | 'medium' | 'low';
}

/**
 * Pick the best available provider + model for a capability profile.
 * Returns undefined when the user has nothing usable at all (callers surface
 * onboarding guidance instead of inventing a model).
 *
 * @param configManager Optional — when omitted, ranking is registry-only
 *   (verified models), which is what the learning layer can see without CLI
 *   config access.
 */
export function bestAvailable(
  profile: CapabilityProfile,
  configManager?: ConfigManager,
): { provider: string; model: string } | undefined {
  const registry = getModelRegistry();
  const ranked: RankedProvider[] = configManager
    ? rankAvailableProviders(configManager)
    : registry
        .getUsableProviders()
        .map((p) => ({ provider: p, verifiedModels: preferredModelsFor(p), configured: true }));
  if (ranked.length === 0) return undefined;

  // Nothing usable: no verified models anywhere AND no keyed provider whose
  // model the health validator could still resolve live. Callers surface
  // onboarding guidance instead of inventing a provider/model.
  const anyVerified = ranked.some((r) => r.verifiedModels.length > 0);
  const anyKeyed = configManager
    ? ranked.some((r) => !KEYLESS_PROVIDERS.includes(r.provider) && !isCatalogKeyless(r.provider))
    : false;
  if (!anyVerified && !anyKeyed) return undefined;

  let picks = ranked;
  if (profile.context === 'large') {
    // Prefer providers whose nominal window fits a large-context ask.
    const big = ranked.filter((p) => (PROVIDER_CONTEXT_WINDOWS[p.provider] ?? 0) >= 131_072);
    if (big.length > 0) picks = big;
  }
  const top = picks[0];
  return { provider: top.provider, model: top.verifiedModels[0] ?? 'default' };
}

/**
 * Last-resort model for an ADAPTER call when the caller didn't pass one:
 * the user's configured pin (unless it's the 'default' sentinel), else the
 * best registry-verified model for the provider, else undefined — the caller
 * gets a clear error instead of an invented name.
 */
export function resolveAdapterDefault(providerType: string, configuredModel?: string): string | undefined {
  if (configuredModel && configuredModel !== 'default') return configuredModel;
  return preferredModelsFor(providerType)[0];
}

/**
 * Adapter last-resort model that NEVER invents a name: the configured pin,
 * else the best registry-verified model, else a clear onboarding error.
 */
export function requireAdapterModel(providerType: string, configuredModel?: string): string {
  const model = resolveAdapterDefault(providerType, configuredModel);
  if (!model) {
    throw new Error(
      `No model resolved for '${providerType}' — run \`buff models refresh\` to discover available models, ` +
        `or set providers.${providerType}.model (or pass --model).`,
    );
  }
  return model;
}

/** Human-readable guidance when the user has no usable provider/model configured. */
export function buildOnboardingGuidance(configManager: ConfigManager): string {
  const hasCloudKey = CATALOG_PROVIDER_IDS.some(
    (p) => !KEYLESS_PROVIDERS.includes(p) && hasCredentials(configManager, p),
  );
  const parts: string[] = [];
  if (!hasCloudKey) {
    parts.push(
      'No API keys detected — set one to unlock cloud providers (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, NVIDIA_NIM_API_KEY).',
    );
  }
  parts.push('For zero-config local models, install Ollama and pull a model, e.g. `ollama pull gemma3` or `ollama pull qwen3`.');
  parts.push('Then run `buff models refresh` so the agent discovers what actually works on this machine.');
  return parts.join('\n');
}
