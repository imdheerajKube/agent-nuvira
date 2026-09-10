/**
 * DefaultModelResolver — resolves the 'default' sentinel to a real model.
 *
 * When no model is specified (--model flag, config, or active state), adapters
 * receive 'default' or undefined. Sending 'default' to a provider API causes
 * 404 errors. This module queries the provider's live model list and picks the
 * best chat-capable model.
 *
 * Resolution strategy:
 * 1. Try the curated known-good defaults for each provider
 * 2. Fall back to the first chat-capable model from listModels()
 * 3. Fall back to 'default' only if listModels() fails
 *
 * Results are cached per provider to avoid repeated API calls.
 */
import type { InferenceProvider } from './interface.js';
/**
 * Resolve the 'default' or undefined model to a real model.
 *
 * @param provider - The inference provider adapter
 * @param providerType - The provider type string (e.g., 'groq', 'gemini')
 * @param requestedModel - The model requested by the caller ('default', undefined, or a real model)
 * @returns A real model id that can be sent to the provider API
 */
export declare function resolveDefaultModel(provider: InferenceProvider, providerType: string, requestedModel?: string | null): Promise<string>;
/** Clear the cache (for tests or after config changes) */
export declare function clearModelResolverCache(): void;
//# sourceMappingURL=default-model-resolver.d.ts.map