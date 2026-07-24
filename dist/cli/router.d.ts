import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';
import { InferenceProvider } from '../inference/interface.js';
/**
 * Create and configure the CLI program
 */
export declare function createCLI(): Command;
/**
 * Resolve the inference provider from CLI options.
 *
 * Supports both built-in providers (local, nim, gemini, openrouter, groq)
 * and auto-discovered plugin providers from ~/.buff/plugins/.
 *
 * For plugin providers, the type string returned is the plugin's provider type.
 */
export declare function resolveProvider(configManager: ConfigManager, providerOption?: string): {
    type: string;
    provider: InferenceProvider;
};
//# sourceMappingURL=router.d.ts.map