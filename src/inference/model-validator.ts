/**
 * Model Health Validator — "only working models, no errors".
 *
 * Auto routing scores PROVIDERS, but the actual model used for a call comes
 * from the provider's pinned `config.model` (via resolveModel()). That pinned
 * model can go stale — e.g. Gemini retired `gemini-2.0-flash-exp` (404) and
 * NIM configs can hold placeholder names. When Auto picks such a provider, the
 * call 404s even though the provider itself is configured and available.
 *
 * This module validates a resolved model against the provider's LIVE model
 * list (`listModels()`) and repairs it to a known-working model:
 *   1. If the desired model is present in the live list → use it.
 *   2. Otherwise prefer a curated known-good default for the provider.
 *   3. Otherwise pick the first non-speech / chat-capable model from the list.
 *   4. If the list can't be fetched (offline / no key) → keep the desired model
 *      so the error (if any) stays accurate and the user sees a real message.
 *
 * IMPORTANT: `desiredModel === 'default'` (a provider key set but no pinned
 * model) is also validated. A 'default' pin means "the agent decides": it
 * resolves to a verified-working model from the registry, or from the live
 * list when the registry hasn't verified anything yet.
 */

import type { InferenceProvider, ModelDescriptor } from './interface.js';
import { logger } from '../utils/logger.js';
import { getModelRegistry } from '../learning/model-registry.js';
import { preferredModelsFor } from '../learning/model-selection.js';
import { nonDowngradeCandidates } from '../learning/model-capability.js';
import { getDefaultModel } from './provider-catalog.js';

// ─── Dynamic preference — never hardcoded model names ──────────────────────
// Repair/selection prefers models the registry has VERIFIED working for this
// user (probe + real usage), ranked by learned health — see
// `preferredModelsFor()`. Nothing here names a model; a provider with no
// verified models falls through to the live list ranked by generic
// capability scoring (modelFallbackScore below).

// ─── Live model-list cache ─────────────────────────────────────────────────
// resolveProvider() constructs a FRESH adapter per call, so an instance-keyed
// cache would never hit. But the provider TYPE is stable, so we cache the live
// list by provider type with a short TTL. This kills the repeated listModels()
// GETs that happened on every auto-routed chat message (a real first-run and
// per-message latency win) while staying fresh enough that new models show up
// within a minute.
const MODEL_LIST_TTL_MS = 60_000;
const modelListCache = new Map<string, { expiresAt: number; models: ModelDescriptor[] }>();

/**
 * Clear the module-level model-list cache.
 *
 * Called automatically by `nuvira config set providers.*` (a provider key/model/
 * baseURL change can invalidate the cached live list) and used by tests to
 * isolate TTL behavior. Public so tooling/embeddings can force a fresh fetch.
 */
export function clearModelListCache(): void {
  modelListCache.clear();
}

async function fetchLiveModels(provider: InferenceProvider, providerType?: string): Promise<ModelDescriptor[]> {
  const key = providerType || provider.name;
  const cached = modelListCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.models;
  }
  try {
    const models = await provider.listModels();
    modelListCache.set(key, { expiresAt: Date.now() + MODEL_LIST_TTL_MS, models });
    return models;
  } catch {
    // Don't cache failures — a transient network error must not pin an empty
    // list for the TTL window.
    return [];
  }
}

/**
 * Score a model for generic fallback (lower = preferred).
 * Speech/audio models are never chat-compatible, so they sink to the bottom.
 */
function modelFallbackScore(m: ModelDescriptor): number {
  const id = (m.id || '').toLowerCase();
  const tags = m.tags || [];
  let score = 0;
  // Speech / audio / transcription models are NOT usable for chat generation
  if (
    tags.includes('speech') ||
    /(whisper|tts|stt|speech|audio|transcrib|voice|tts-1|eleven)/.test(id)
  ) {
    score += 100;
  }
  // Vision-only previews are less suitable for general chat
  if (tags.includes('vision') && !tags.includes('chat')) score += 20;
  // Preview / experimental models are last resorts
  if (/(preview|exp$)/.test(id)) score += 10;
  return score;
}

/**
 * Validate a model against the provider's live model list and return a
 * working model:
 *
 * @param provider      The inference provider instance (for listModels()).
 * @param providerType  Provider id (e.g. 'gemini', 'groq') for curated defaults.
 * @param desiredModel  The model Auto routing resolved (may be stale/'default').
 * @param announce      Also print the repair here. DEFAULT `false`: every caller
 *   now goes through `resolveRoute()`, which owns the reporting (print + routing
 *   history + run trace). Announcing in both places produced TWO lines for one
 *   substitution, and in strict mode it announced a swap that then threw
 *   instead of happening — worse than silence.
 * @returns A model id guaranteed (best-effort) to exist on the provider.
 */
export async function resolveWorkingModel(
  provider: InferenceProvider,
  providerType: string,
  desiredModel?: string,
  announce = false,
): Promise<string> {
  const explicit = desiredModel && desiredModel !== 'default' ? desiredModel : undefined;

  // ── 0. FAST PATH — the Model Availability Registry (sub-ms, no network) ─
  // When the registry has already verified this model works (via a prior
  // spot-check or real telemetry), trust it WITHOUT hitting listModels():
  // model selection drops from a ~300-900ms live fetch to a map lookup.
  const registry = getModelRegistry();
  if (explicit && registry.isUsable(providerType, explicit)) {
    return explicit;
  }
  if (!explicit) {
    // No pin: prefer a verified-working model (registry, health-ranked).
    const verified = preferredModelsFor(providerType)[0];
    if (verified) return verified;
  }
  // A pin the registry has DEFINITIVELY ruled out (unavailable / quota-parked
  // from real telemetry or a probe) is repaired SILENTLY — the registry
  // already verified a working replacement, so there is nothing new to learn
  // and nothing to warn about. Re-warning "model X is not available" on every
  // message (chat start, each message, each failover) is the recursive UX
  // that made auto routing look broken. NOTE: a merely-unverified pin is NOT
  // replaced here — the live-list check below keeps it when it exists; only a
  // pin the registry has learned is dead is silently swapped.
  if (explicit) {
    const entry = registry.getEntry(providerType, explicit);
    const pinDead = !!entry && (entry.status === 'unavailable' || entry.quotaParkedUntil > Date.now());
    if (pinDead) {
      // CAPABILITY-AWARE REPAIR — a dead pin is replaced by a model at least as
      // capable, not merely by the healthiest one. `preferredModelsFor` ranks by
      // error rate then latency, which a small/fast model always wins: found
      // live, a quota-parked `openai/gpt-oss-120b` was repaired to the only
      // never-rate-limited sibling — `allam-2-7b`, a 7B toy — while a 27B and a
      // 120B were both verified-usable. `nonDowngradeCandidates` narrows the
      // health ranking to models in the request's capability band or above
      // (order preserved), and falls back to the full list when nothing is that
      // capable — so this can never dead-end, only avoid a silent downgrade.
      const verified = nonDowngradeCandidates(explicit, preferredModelsFor(providerType))[0];
      if (verified) return verified;
    }
  }

  // A model the registry has marked unavailable or quota-parked must NEVER be
  // resurrected by the live-list repair below — the registry learned it fails
  // (auth/rate-limit telemetry) and repair is supposed to route AROUND it,
  // not back into it.
  const registryBlocks = (model: string): boolean => {
    const entry = registry.getEntry(providerType, model);
    return !!entry && (entry.status === 'unavailable' || entry.quotaParkedUntil > Date.now());
  };

  // Registry didn't have the answer — fall back to the live model list
  // (cached in-memory with a short TTL by the validator).
  const live = await fetchLiveModels(provider, providerType);

  // ── 1. Desired model is live → use it ─────────────────────────────────
  if (explicit && live.some((m) => m.id === explicit) && !registryBlocks(explicit)) {
    return explicit;
  }

  // ── Teach the registry: the pinned model is absent from the provider's
  // successfully-fetched live list. Marking it unavailable makes BOTH the auto
  // router (resolveModel) and this validator skip it on the next route — the
  // repair is LEARNED once instead of re-performed with a warning on every
  // message (the recursion the user saw). Only when the list actually came
  // back (non-empty fetch) is the absence definitive; an empty/failed list
  // keeps the desired model and stays silent (step 4).
  //
  // SAFETY GATE: only teach when the provider already has a VERIFIED usable
  // model. getBlockedProviders() blocks a provider when ALL its tracked models
  // are unavailable/parked with no verified alternative — marking the pin dead
  // on a cold registry (replacement not yet verified/untracked) would flip the
  // whole provider into the blocked set, and routeMessageAuto's candidate
  // filter would then skip it on the very next message → straight to local
  // WITHOUT ever trying the working replacement. Teaching only when a verified
  // model exists keeps the provider routable (it retains a usable entry) while
  // still killing the recursion for the next route.
  if (explicit && live.length > 0 && registry.getVerifiedModels(providerType).length > 0) {
    try {
      registry.markUnavailable(providerType, explicit, 'not in live model list', 'probe');
    } catch {
      // Best-effort — a registry write must never break repair.
    }
  }

  // ── 2+3. Repair target: verified models first, then the live list ranked
  // by generic capability scoring. NEVER resurrect a model the registry has
  // definitively ruled out — a live-list entry is not proof the model works
  // (listModels can list models the key can't actually use), but an
  // `unavailable`/quota-parked registry entry is proof it FAILED. Repair
  // routes AROUND it, not into it.
  if (live.length > 0) {
    const liveRanked = [...live].sort((a, b) => modelFallbackScore(a) - modelFallbackScore(b));
    const preferred = [...preferredModelsFor(providerType), ...liveRanked.map((m) => m.id)];
    // Never pick speech/audio (score >= 100) or a registry-blocked model.
    const chosen = preferred.find((id) => {
      const m = live.find((mm) => mm.id === id);
      return !!m && modelFallbackScore(m) < 100 && !registryBlocks(id);
    });
    if (chosen) {
      // (capability-aware narrowing happens on the DEAD-pin path above; the
    // live-list path keeps its curated/health-first behavior so a stale pin is
    // still repaired to the provider's known-good model.)
    if (explicit && announce) {
        const fromVerified = preferredModelsFor(providerType).includes(chosen);
        logger.warn(
          `♻️  Auto routing: model '${explicit}' is not available on '${providerType}' — using '${chosen}'${fromVerified ? ' (verified working)' : ''}.`,
        );
      }
      return chosen;
    }
  }

  // ── 4. Can't validate (list unavailable / only speech models) ─────────
  // NEVER hand the literal 'default' sentinel to a provider API — it 404s
  // (`The model \`default\` does not exist`, observed live on Groq when the
  // listModels fetch failed mid-pipeline). Fall back to the CATALOG's curated
  // real model name for this provider instead; only an unknown catalog
  // provider (which never reaches a real API anyway) keeps the old behavior.
  if (explicit) return explicit;
  const catalogDefault = getDefaultModel(providerType);
  if (catalogDefault && catalogDefault !== 'default') return catalogDefault;
  return explicit ?? 'default';
}
