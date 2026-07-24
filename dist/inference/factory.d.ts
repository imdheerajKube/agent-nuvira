import { InferenceProvider } from './interface.js';
import { ProviderType, ProviderConfig } from '../config/types.js';
/**
 * Factory to create the appropriate inference provider
 * based on configuration and type.
 *
 * Supports built-in providers (nim, gemini, openrouter, groq, local)
 * and auto-discovered plugin providers from ~/.buff/plugins/.
 */
export declare class ProviderFactory {
    /**
     * Create an inference provider instance.
     *
     * For built-in types, returns the standard adapter.
     * For unknown types, checks the plugin registry for a matching plugin.
     * Throws if no built-in or plugin provider is found for the type.
     */
    static createProvider(type: ProviderType | string, config: ProviderConfig): InferenceProvider;
}
//# sourceMappingURL=factory.d.ts.map