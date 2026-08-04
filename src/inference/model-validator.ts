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
 * model) is also validated. Adapter hardcoded defaults can be deprecated too
 * (Gemini's is still `gemini-2.0-flash-exp`), so 'default' resolves to a
 * verified-working model from the live list when one is available.
 */

import type { InferenceProvider, ModelDescriptor } from './interface.js';
import { logger } from '../utils/logger.js';
import { getModelRegistry } from '../learning/model-registry.js';

// ─── Curated known-good default models per provider ─────────────────────────
// These are checked BEFORE generic fallback so Auto routing prefers models
// that are stable, chat-capable, and known to work on each provider.

/** Preferred repair models per provider id, best first. */
export const PREFERRED_MODELS: Record<string, string[]> = {
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'],
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'],
  openrouter: ['openai/gpt-4o-mini', 'meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-7b-instruct'],
  nim: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct'],
  local: [], // Ollama models vary per machine — use the live list
};

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
 * Called automatically by `buff config set providers.*` (a provider key/model/
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
 * @returns A model id guaranteed (best-effort) to exist on the provider.
 */
export async function resolveWorkingModel(
  provider: InferenceProvider,
  providerType: string,
  desiredModel?: string,
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
    // No pin: prefer a curated known-good model the registry has verified.
    const curated = registry.resolveVerifiedModel(providerType, PREFERRED_MODELS[providerType] || []);
    if (curated) return curated;
  }

  // Registry didn't have the answer — fall back to the live model list
  // (cached in-memory with a short TTL by the validator).
  const live = await fetchLiveModels(provider, providerType);

  // ── 1. Desired model is live → use it ─────────────────────────────────
  if (explicit && live.some((m) => m.id === explicit)) {
    return explicit;
  }

  // ── 2. Curated known-good default for this provider ───────────────────
  const preferred = PREFERRED_MODELS[providerType] || [];
  for (const candidate of preferred) {
    if (live.some((m) => m.id === candidate)) {
      if (explicit) {
        logger.warn(
          `♻️  Auto routing: model '${explicit}' is not available on '${providerType}' — using '${candidate}' (verified working).`,
        );
      }
      return candidate;
    }
  }

  // ── 3. Generic fallback: first usable model from the live list ────────
  if (live.length > 0) {
    const ranked = [...live].sort((a, b) => modelFallbackScore(a) - modelFallbackScore(b));
    const usable = ranked.find((m) => modelFallbackScore(m) < 100);
    if (usable) {
      if (explicit) {
        logger.warn(
          `♻️  Auto routing: model '${explicit}' is not available on '${providerType}' — using '${usable.id}'.`,
        );
      }
      return usable.id;
    }
  }

  // ── 4. Can't validate (list unavailable / only speech models) ─────────
  // Let the adapter surface the real error if the model is truly gone.
  return explicit ?? 'default';
}
