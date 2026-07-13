import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BuffConfig, ProviderType, ProviderConfig } from './types.js';
import { loadEnv } from '../utils/env.js';

const DEFAULT_CONFIG: BuffConfig = {
  defaultProvider: 'local',
  providers: {
    nim: { model: 'meta/llama-3.1-70b-instruct', temperature: 0.7, maxTokens: 4096 },
    gemini: { model: 'gemini-2.0-flash-exp', temperature: 0.7, maxTokens: 8192 },
    openrouter: { model: 'mistralai/mistral-7b-instruct', temperature: 0.7, maxTokens: 4096 },
    local: { runner: 'ollama', model: 'llama2', temperature: 0.7, maxTokens: 4096 },
  },
};

export class ConfigManager {
  private config: BuffConfig;
  private env: Record<string, string | undefined>;
  private configDir: string;
  private configPath: string;

  constructor(configDir?: string) {
    this.env = loadEnv();
    this.configDir = configDir || join(homedir(), '.buff');
    this.configPath = join(this.configDir, 'buffconfig.json');
    this.config = this.loadConfig();
  }

  /**
   * Load config from disk, merging with defaults and env vars
   */
  private loadConfig(): BuffConfig {
    // Deep clone DEFAULT_CONFIG to avoid mutating the module-level constant
    const config: BuffConfig = {
      ...DEFAULT_CONFIG,
      providers: {
        ...DEFAULT_CONFIG.providers,
      },
    };

    // Deep merge providers defaults
    for (const key of Object.keys(config.providers) as ProviderType[]) {
      config.providers[key] = { ...config.providers[key] };
    }

    if (existsSync(this.configPath)) {
      try {
        const raw = readFileSync(this.configPath, 'utf-8');
        const userConfig = JSON.parse(raw) as Partial<BuffConfig>;

        if (userConfig.defaultProvider) {
          config.defaultProvider = userConfig.defaultProvider;
        }

        if (userConfig.providers) {
          for (const [key, value] of Object.entries(userConfig.providers)) {
            const provider = key as ProviderType;
            if (config.providers[provider]) {
              config.providers[provider] = { ...config.providers[provider], ...value };
            } else {
              config.providers[provider] = value as ProviderConfig;
            }
          }
        }
      } catch {
        // If config is corrupted, fall back to defaults
      }
    }

    // Override API keys from environment variables
    this.overrideFromEnv(config);

    return config;
  }

  /**
   * Override API keys from environment variables
   */
  private overrideFromEnv(config: BuffConfig): void {
    if (this.env.NVIDIA_NIM_API_KEY) {
      config.providers.nim.apiKey = this.env.NVIDIA_NIM_API_KEY;
    }
    if (this.env.GEMINI_API_KEY) {
      config.providers.gemini.apiKey = this.env.GEMINI_API_KEY;
    }
    if (this.env.OPENROUTER_API_KEY) {
      config.providers.openrouter.apiKey = this.env.OPENROUTER_API_KEY;
    }
  }

  /**
   * Get configuration for a specific provider
   */
  getProviderConfig(provider?: ProviderType): { type: ProviderType; config: ProviderConfig } {
    const type = provider || this.config.defaultProvider;
    const config = this.config.providers[type];

    if (!config) {
      throw new Error(`No configuration found for provider '${type}'`);
    }

    return { type, config };
  }

  /**
   * Get the full config
   */
  getAll(): BuffConfig {
    return { ...this.config };
  }

  /**
   * Save current configuration to disk
   */
  save(config: Partial<BuffConfig>): void {
    if (!existsSync(this.configDir)) {
      mkdirSync(this.configDir, { recursive: true });
    }

    // Merge with existing
    if (config.defaultProvider) {
      this.config.defaultProvider = config.defaultProvider;
    }

    if (config.providers) {
      for (const [key, value] of Object.entries(config.providers)) {
        const provider = key as ProviderType;
        this.config.providers[provider] = {
          ...this.config.providers[provider],
          ...value,
        };
      }
    }

    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  /**
   * Check if a provider has the required API key
   */
  hasRequiredCredentials(provider: ProviderType): boolean {
    if (provider === 'local') return true; // Local doesn't need API key
    return !!this.config.providers[provider]?.apiKey;
  }
}
