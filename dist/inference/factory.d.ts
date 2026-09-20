import { InferenceProvider } from './interface.js';
import { ProviderType, ProviderConfig } from '../config/types.js';
/**
 * Factory to create the appropriate inference provider based on configuration
 * and type.
 *
 * Built-in providers use their dedicated adapters (vendor-specific behavior).
 * Every OTHER catalog provider (Issue 001: the full 17+ set) is served by the
 * generic OpenAICompatAdapter driven by provider-catalog metadata — or the
 * native Anthropic adapter for Anthropic's non-OpenAI-compatible API. Unknown
 * types fall back to auto-discovered plugin providers, then a clear error.
 */
export declare class ProviderFactory {
    /**
     * Create an inference provider instance.
     *
     * For built-in types, returns the standard adapter. For catalog types,
     * returns the generic OpenAI-compat (or native) adapter. For unknown types,
     * checks the plugin registry for a matching plugin. Throws if no built-in,
     * catalog, or plugin provider is found for the type.
     */
    /**
     * True when a provider id can actually be CONSTRUCTED — a built-in adapter,
     * a catalog provider that speaks the OpenAI protocol, or an installed
     * plugin. Non-throwing twin of `createProvider`.
     *
     * Why routing needs this: catalog ids exist for providers we have no adapter
     * for (e.g. `bedrock` is in the catalog but is neither built-in nor
     * `openAICompat`). Such an id is *credentialed* — a user can have an
     * AWS_BEARER_TOKEN — so credential checks alone let it into the failover
     * candidate pool, where resolution then silently fell back to a DIFFERENT
     * provider and mislabeled its models (live: "model 'anthropic.claude-3-5-
     * sonnet-20241022-v1:0' is not available on 'bedrock' — using 'qwen2.5:0.5b'",
     * i.e. a local Ollama model presented as a Bedrock one). Filtering the pool
     * by constructibility keeps unusable providers out entirely.
     */
    static isConstructible(type: string): boolean;
    static createProvider(type: ProviderType | string, config: ProviderConfig): InferenceProvider;
}
//# sourceMappingURL=factory.d.ts.map