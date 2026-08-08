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
    static createProvider(type: ProviderType | string, config: ProviderConfig): InferenceProvider;
}
//# sourceMappingURL=factory.d.ts.map