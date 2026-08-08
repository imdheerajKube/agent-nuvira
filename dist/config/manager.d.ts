import { BuffConfig, ProviderConfig } from './types.js';
/** True when a key value is a docs placeholder / env-var name, not a real credential. */
export declare function isPlaceholderApiKey(key: string | undefined | null): boolean;
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
     * Override API keys from environment variables.
     * Environment variables take priority over the config file.
     *
     * DYNAMIC (Issue 001): every catalog provider's standard env var is mapped,
     * so a user who sets ANY of the 17+ provider keys (OPENAI_API_KEY,
     * ANTHROPIC_API_KEY, MISTRAL_API_KEY, ...) sees that provider become a
     * routing/probing candidate — not just the original four hardcoded vars.
     */
    private overrideFromEnv;
    /**
     * Get configuration for a specific provider.
     * The 'auto' routing directive is resolved here to the best currently-
     * available provider (registry-verified → configured → local) so callers
     * never see a literal 'auto' reach an adapter factory.
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
     * ISSUE-004 (4b): remove a provider's API key from the config file after it
     * has been proven invalid (consecutive 401/403s).
     *
     * `failedKey` is the SPECIFIC credential that 401'd (undefined = the primary
     * `apiKey`). It is removed wherever it lives — the primary field, or a
     * matching entry in the `apiKeys[]` rotation list (M2.3), so a dead rotation
     * key can't keep failing while the provider's other keys stay usable.
     *
     * Env-sourced keys (loaded via `overrideFromEnv`) are re-injected on every
     * load, so they cannot be removed from the file — the caller is told which
     * env var to fix instead (`envSourced: true` + the var name). Only keys
     * written to the FILE are actually cleared. Best-effort — never throws (a
     * failed clear must never break a live call).
     */
    clearProviderApiKey(provider: string, failedKey?: string): {
        cleared: boolean;
        envSourced: boolean;
        envVar?: string;
    };
    /**
     * Check if a provider has a REAL, usable API key.
     *
     * A non-empty string is NOT enough: docs placeholders ("openrouter-env-key",
     * "new-key", "<your-key>") pass a bare truthiness check and then fail with a
     * guaranteed 401 on the first call — which is exactly how a provider with a
     * fake key can be routed into while real-keyed providers sit idle. Placeholder
     * keys are treated as NOT configured so the router skips them predictively
     * and only surfaces an error after every genuinely-configured option fails.
     */
    hasRequiredCredentials(provider: string): boolean;
    /**
     * Log a clear, one-time warning for providers holding placeholder API keys,
     * so the user knows why a provider is skipped by auto routing (instead of
     * discovering it via repeated 401s). Best-effort — never throws.
     */
    warnPlaceholderKeys(): void;
}
//# sourceMappingURL=manager.d.ts.map