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
import { logger } from '../utils/logger.js';
/** Cache: providerType → resolved model id */
const resolvedCache = new Map();
/** Cache TTL: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheTimestamps = new Map();
/**
 * Curated known-good defaults per provider.
 * These are the first models we'd pick if the provider's listModels() is
 * unavailable or returns an empty list.
 */
const CURATED_DEFAULTS = {
    groq: 'qwen/qwen3.6-27b',
    gemini: 'gemini-2.5-flash',
    openrouter: 'openai/gpt-4o-mini',
    nim: 'meta/llama-3.3-70b-instruct',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022',
    mistral: 'mistral-small-latest',
    together: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    deepinfra: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    fireworks: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    local: 'default',
    azure: 'gpt-4o-mini',
    bedrock: 'anthropic.claude-3-haiku-20240307-v1:0',
    perplexity: 'llama-3.1-sonar-small-128k-online',
    xai: 'grok-2',
    deepseek: 'deepseek-chat',
    vllm: 'default',
    lmstudio: 'default',
};
/**
 * Filter tags that indicate a model is NOT suitable for chat completions.
 * Speech, audio, image generation, embedding, and safety models are excluded.
 */
const NON_CHAT_TAGS = new Set(['speech', 'audio', 'embedding', 'safety', 'guard', 'image', 'video', 'tts']);
function isChatCompatible(model) {
    if (!model.tags || model.tags.length === 0)
        return true; // Unknown → assume compatible
    return !model.tags.some((t) => NON_CHAT_TAGS.has(t));
}
/**
 * Resolve the 'default' or undefined model to a real model.
 *
 * @param provider - The inference provider adapter
 * @param providerType - The provider type string (e.g., 'groq', 'gemini')
 * @param requestedModel - The model requested by the caller ('default', undefined, or a real model)
 * @returns A real model id that can be sent to the provider API
 */
export async function resolveDefaultModel(provider, providerType, requestedModel) {
    // If a real model was specified, return it as-is
    if (requestedModel && requestedModel !== 'default') {
        return requestedModel;
    }
    // Check cache (avoid repeated listModels calls)
    const now = Date.now();
    const cached = resolvedCache.get(providerType);
    const cachedAt = cacheTimestamps.get(providerType) || 0;
    if (cached && now - cachedAt < CACHE_TTL_MS) {
        logger.debug(`ModelResolver: Using cached model for ${providerType}: ${cached}`);
        return cached;
    }
    // Try to get the curated default
    const curated = CURATED_DEFAULTS[providerType];
    if (curated && curated !== 'default') {
        // Verify the curated model is available via listModels
        try {
            const models = await provider.listModels?.();
            if (models && models.length > 0) {
                const curatedExists = models.some((m) => m.id === curated);
                if (curatedExists) {
                    resolvedCache.set(providerType, curated);
                    cacheTimestamps.set(providerType, now);
                    logger.info(`ModelResolver: Resolved ${providerType} default → ${curated} (curated)`);
                    return curated;
                }
                // Curated model not in live list — pick the first chat-compatible model
                const chatModel = models.find(isChatCompatible);
                if (chatModel) {
                    resolvedCache.set(providerType, chatModel.id);
                    cacheTimestamps.set(providerType, now);
                    logger.info(`ModelResolver: Resolved ${providerType} default → ${chatModel.id} (first chat model)`);
                    return chatModel.id;
                }
            }
        }
        catch {
            // listModels failed — use curated default as best-effort
            logger.debug(`ModelResolver: listModels failed for ${providerType}, using curated default: ${curated}`);
        }
        resolvedCache.set(providerType, curated);
        cacheTimestamps.set(providerType, now);
        return curated;
    }
    // No curated default — try listModels
    try {
        const models = await provider.listModels?.();
        if (models && models.length > 0) {
            const chatModel = models.find(isChatCompatible);
            if (chatModel) {
                resolvedCache.set(providerType, chatModel.id);
                cacheTimestamps.set(providerType, now);
                logger.info(`ModelResolver: Resolved ${providerType} default → ${chatModel.id} (first chat model from list)`);
                return chatModel.id;
            }
        }
    }
    catch {
        // Best-effort
    }
    // Last resort — return 'default' and hope the provider handles it
    logger.warn(`ModelResolver: Could not resolve default model for ${providerType}, using 'default'`);
    return 'default';
}
/** Clear the cache (for tests or after config changes) */
export function clearModelResolverCache() {
    resolvedCache.clear();
    cacheTimestamps.clear();
}
//# sourceMappingURL=default-model-resolver.js.map