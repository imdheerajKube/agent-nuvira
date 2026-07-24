import { NIMAdapter } from './nim-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
import { GroqAdapter } from './groq-adapter.js';
import { LocalAdapter } from './local-adapter.js';
import { getPluginRegistry } from '../plugins/registry.js';
/**
 * Factory to create the appropriate inference provider
 * based on configuration and type.
 *
 * Supports built-in providers (nim, gemini, openrouter, groq, local)
 * and auto-discovered plugin providers from ~/.buff/plugins/.
 */
export class ProviderFactory {
    /**
     * Create an inference provider instance.
     *
     * For built-in types, returns the standard adapter.
     * For unknown types, checks the plugin registry for a matching plugin.
     * Throws if no built-in or plugin provider is found for the type.
     */
    static createProvider(type, config) {
        switch (type) {
            case 'nim':
                return new NIMAdapter(config);
            case 'gemini':
                return new GeminiAdapter(config);
            case 'openrouter':
                return new OpenRouterAdapter(config);
            case 'groq':
                return new GroqAdapter(config);
            case 'local':
                return new LocalAdapter(config);
            default: {
                // Check plugin registry for auto-discovered providers
                const registry = getPluginRegistry();
                if (registry.hasPlugin(type)) {
                    return registry.createProviderFromPlugin(type, config);
                }
                throw new Error(`Unknown provider type: '${type}'. Available built-in: nim, gemini, openrouter, groq, local. ` +
                    `Check ~/.buff/plugins/ for auto-discovered plugins.`);
            }
        }
    }
}
//# sourceMappingURL=factory.js.map