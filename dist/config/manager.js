import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';
const DEFAULT_CONFIG = {
    defaultProvider: 'local',
    providers: {
        nim: { model: 'meta/llama-3.1-8b-instruct', temperature: 0.7, maxTokens: 4096 },
        gemini: { model: 'gemini-2.0-flash-exp', temperature: 0.7, maxTokens: 8192 },
        openrouter: { model: 'mistralai/mistral-7b-instruct', temperature: 0.7, maxTokens: 4096 },
        groq: { model: 'llama-3.3-70b-versatile', temperature: 0.7, maxTokens: 4096 },
        local: { runner: 'ollama', model: 'llama2', temperature: 0.7, maxTokens: 4096 },
    },
    history: {
        retentionDays: 30,
        semanticSearch: true,
    },
    fallback: {
        enabled: true,
        providers: ['groq', 'nim', 'gemini', 'openrouter', 'local'],
        maxAttempts: 3,
        retryDelayMs: 1000,
    },
};
export class ConfigManager {
    config;
    env;
    configDir;
    configPath;
    constructor(configDir) {
        this.env = loadEnv();
        this.configDir = configDir || join(homedir(), '.buff');
        this.configPath = join(this.configDir, 'buffconfig.json');
        this.config = this.loadConfig();
    }
    /**
     * Load config from disk, merging with defaults and env vars
     */
    loadConfig() {
        // Deep clone DEFAULT_CONFIG to avoid mutating the module-level constant
        const config = {
            ...DEFAULT_CONFIG,
            providers: {
                ...DEFAULT_CONFIG.providers,
            },
        };
        // Deep merge providers defaults
        for (const key of Object.keys(config.providers)) {
            config.providers[key] = { ...config.providers[key] };
        }
        // Deep clone history defaults
        config.history = { ...DEFAULT_CONFIG.history };
        // Deep clone fallback defaults
        config.fallback = { ...(DEFAULT_CONFIG.fallback || {}) };
        if (existsSync(this.configPath)) {
            try {
                const raw = readFileSync(this.configPath, 'utf-8');
                const userConfig = JSON.parse(raw);
                if (userConfig.defaultProvider) {
                    config.defaultProvider = userConfig.defaultProvider;
                }
                if (userConfig.providers) {
                    for (const [key, value] of Object.entries(userConfig.providers)) {
                        const provider = key;
                        if (config.providers[provider]) {
                            config.providers[provider] = { ...config.providers[provider], ...value };
                        }
                        else {
                            config.providers[provider] = value;
                        }
                    }
                }
                // Merge history config
                if (userConfig.history) {
                    config.history = { ...config.history, ...userConfig.history };
                }
                // Merge fallback config
                if (userConfig.fallback) {
                    config.fallback = { ...config.fallback, ...userConfig.fallback };
                }
            }
            catch {
                // If config is corrupted, fall back to defaults
            }
        }
        // Override API keys from environment variables
        this.overrideFromEnv(config);
        return config;
    }
    /**
     * Override API keys from environment variables
     * Environment variables take priority over the config file.
     */
    overrideFromEnv(config) {
        // Debug logging to help troubleshoot env var detection
        const envVarsChecked = [];
        if (this.env.NVIDIA_NIM_API_KEY) {
            config.providers.nim.apiKey = this.env.NVIDIA_NIM_API_KEY;
            envVarsChecked.push('NVIDIA_NIM_API_KEY');
        }
        if (this.env.GEMINI_API_KEY) {
            config.providers.gemini.apiKey = this.env.GEMINI_API_KEY;
            envVarsChecked.push('GEMINI_API_KEY');
        }
        if (this.env.OPENROUTER_API_KEY) {
            config.providers.openrouter.apiKey = this.env.OPENROUTER_API_KEY;
            envVarsChecked.push('OPENROUTER_API_KEY');
        }
        if (this.env.GROQ_API_KEY) {
            config.providers.groq.apiKey = this.env.GROQ_API_KEY;
            envVarsChecked.push('GROQ_API_KEY');
        }
        if (envVarsChecked.length > 0) {
            logger.debug(`Config: Loaded API keys from env vars: ${envVarsChecked.join(', ')}`);
        }
        else {
            logger.debug('Config: No API keys found in environment variables. Use --debug to see more.');
        }
    }
    /**
     * Get configuration for a specific provider
     */
    getProviderConfig(provider) {
        const type = provider || this.config.defaultProvider;
        const config = this.config.providers[type] || {};
        return { type, config };
    }
    /**
     * Get the full config
     */
    getAll() {
        return { ...this.config };
    }
    /**
     * Save current configuration to disk
     */
    save(config) {
        if (!existsSync(this.configDir)) {
            mkdirSync(this.configDir, { recursive: true });
        }
        // Merge with existing
        if (config.defaultProvider) {
            this.config.defaultProvider = config.defaultProvider;
        }
        if (config.providers) {
            for (const [key, value] of Object.entries(config.providers)) {
                const provider = key;
                this.config.providers[provider] = {
                    ...this.config.providers[provider],
                    ...value,
                };
            }
        }
        if (config.history) {
            this.config.history = {
                ...this.config.history,
                ...config.history,
            };
        }
        if (config.fallback) {
            this.config.fallback = {
                ...this.config.fallback,
                ...config.fallback,
            };
        }
        writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    }
    /**
     * Check if a provider has the required API key
     */
    hasRequiredCredentials(provider) {
        if (provider === 'local')
            return true; // Local doesn't need API key
        return !!this.config.providers[provider]?.apiKey;
    }
}
//# sourceMappingURL=manager.js.map