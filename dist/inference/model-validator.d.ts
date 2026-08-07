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
import type { InferenceProvider } from './interface.js';
/**
 * Clear the module-level model-list cache.
 *
 * Called automatically by `buff config set providers.*` (a provider key/model/
 * baseURL change can invalidate the cached live list) and used by tests to
 * isolate TTL behavior. Public so tooling/embeddings can force a fresh fetch.
 */
export declare function clearModelListCache(): void;
/**
 * Validate a model against the provider's live model list and return a
 * working model:
 *
 * @param provider      The inference provider instance (for listModels()).
 * @param providerType  Provider id (e.g. 'gemini', 'groq') for curated defaults.
 * @param desiredModel  The model Auto routing resolved (may be stale/'default').
 * @returns A model id guaranteed (best-effort) to exist on the provider.
 */
export declare function resolveWorkingModel(provider: InferenceProvider, providerType: string, desiredModel?: string): Promise<string>;
//# sourceMappingURL=model-validator.d.ts.map