import { BuffConfig, ProviderConfig } from './types.js';
export declare class ConfigManager {
    private config;
    private env;
    private configDir;
    private configPath;
    constructor(configDir?: string);
    /**
     * Load config from disk, merging with defaults and env vars
     */
    private loadConfig;
    /**
     * Override API keys from environment variables
     * Environment variables take priority over the config file.
     */
    private overrideFromEnv;
    /**
     * Get configuration for a specific provider
     */
    getProviderConfig(provider?: string): {
        type: string;
        config: ProviderConfig;
    };
    /**
     * Get the full config
     */
    getAll(): BuffConfig;
    /**
     * Save current configuration to disk
     */
    save(config: Partial<BuffConfig>): void;
    /**
     * Check if a provider has the required API key
     */
    hasRequiredCredentials(provider: string): boolean;
}
//# sourceMappingURL=manager.d.ts.map