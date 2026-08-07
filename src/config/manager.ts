import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BuffConfig, ProviderType, ProviderConfig } from './types.js';
import { resolveBuffConfigDir } from './paths.js';
import { loadEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { resolveDefaultProvider } from '../learning/model-selection.js';

// NO hardcoded provider/model defaults: the default provider is the routing
// directive 'auto' (the best AVAILABLE provider is resolved at runtime from
// the user's keys + verified models — see resolveDefaultProvider), and every
// provider's model pin is the 'default' sentinel (the agent resolves a
// verified working model at call time). A user who pins a provider/model
// explicitly still overrides these (explicit wins, health-checked).
/**
 * Sentinel/placeholder API keys — values that LOOK like a key but are docs
 * placeholders or env-var names copy-pasted as the value (e.g. the literal
 * string "openrouter-env-key", "new-key", "your-key", "<key>"). A provider
 * whose key is a placeholder must NOT count as "configured": the router would
 * otherwise route into it and burn real attempts on a guaranteed 401 (the
 * observed failure: OpenRouter/NIM had placeholder keys, were treated as
 * configured, and were routed into while groq/gemini/local — real keys — sat
 * idle). Real keys never match these patterns (gsk_*, AQ.*, sk-or-v1-*,
 * nvapi-*, AIza*, sk-ant-*...).
 */
const PLACEHOLDER_KEY_PATTERNS: RegExp[] = [
  /-env-key$/i, // "openrouter-env-key" — env var NAME used as the value
  /^(new|your|my|some|sample|demo|test|fake|placeholder|changeme|change-me)[-_ ]?key$/i,
  /^<[^>]+>$/, // "<your-api-key>"
  /^sk-$/i,
  /^sk-[a-z]+$/i, // "sk-test", "sk-abc" — no real token
  /^x{4,}$/i, // "xxxx"
  /^(OPENROUTER|GROQ|GEMINI|NVIDIA_NIM|NIM|OPENAI|ANTHROPIC|DEEPSEEK|MISTRAL|TOGETHER|PERPLEXITY|XAI|COHERE|REPLICATE|AZURE)_API_KEY$/i,
];

/** True when a key value is a docs placeholder / env-var name, not a real credential. */
export function isPlaceholderApiKey(key: string | undefined | null): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  if (trimmed.length === 0) return false;
  return PLACEHOLDER_KEY_PATTERNS.some((re) => re.test(trimmed));
}

const DEFAULT_CONFIG: BuffConfig = {
  defaultProvider: 'auto',
  providers: {
    nim: { model: 'default', temperature: 0.7, maxTokens: 4096 },
    gemini: { model: 'default', temperature: 0.7, maxTokens: 8192 },
    openrouter: { model: 'default', temperature: 0.7, maxTokens: 4096 },
    groq: { model: 'default', temperature: 0.7, maxTokens: 4096 },
    local: { runner: 'ollama', model: 'default', temperature: 0.7, maxTokens: 4096 },
  },
  history: {
    retentionDays: 30,
    semanticSearch: true,
  },
  memory: {
    vectorBackend: 'auto',
  },
  // Empty by default: the fallback chain is derived at runtime from what the
  // user has configured + verified (rankAvailableProviders), never a fixed
  // provider list. Users may still set fallback.providers explicitly.
  fallback: {
    enabled: true,
    providers: [],
    maxAttempts: 3,
    retryDelayMs: 1000,
  },
};

export class ConfigManager {
  private config: BuffConfig;
  private env: Record<string, string | undefined>;
  private configDir: string;
  private configPath: string;

  constructor(configDir?: string) {
    this.env = loadEnv();
    // BUFF_CONFIG_DIR override — the RBAC role file and credential store
    // already honor it, so the config manager must too: a hermetic run pointed
    // at BUFF_CONFIG_DIR must never read/write the real ~/.buff config.
    this.configDir = resolveBuffConfigDir(configDir);
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

    // Deep clone history defaults
    config.history = { ...DEFAULT_CONFIG.history };

    // Deep clone memory defaults
    config.memory = { ...(DEFAULT_CONFIG.memory || {}) };

    // Deep clone fallback defaults
    config.fallback = { ...(DEFAULT_CONFIG.fallback || {}) };

    // Deep clone pricing defaults
    config.pricing = { ...(DEFAULT_CONFIG.pricing || {}) };

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

        // Merge history config
        if (userConfig.history) {
          config.history = { ...config.history, ...userConfig.history };
        }

        // Merge fallback config
        if (userConfig.fallback) {
          config.fallback = { ...config.fallback, ...userConfig.fallback };
        }

        // Merge pricing overrides (deep — per provider)
        if (userConfig.pricing) {
          config.pricing = { ...config.pricing };
          for (const [provider, pricing] of Object.entries(userConfig.pricing)) {
            config.pricing[provider] = { ...(config.pricing[provider] || {}), ...pricing };
          }
        }

        // Merge routing config (learning router). FIX: this was previously
        // dropped entirely on load, so `buff config set routing.*` (bandit,
        // quota, governance, contextWindows, nuviraSidecar) never survived a
        // restart. Nested maps are deep-merged so separate sets preserve each
        // other (governance.allowProviders + governance.maxCostUsd coexist).
        if (userConfig.routing) {
          const loadedRouting = userConfig.routing;
          config.routing = {
            ...(config.routing || {}),
            ...loadedRouting,
            quota: { ...(config.routing?.quota || {}), ...(loadedRouting.quota || {}) },
            governance: { ...(config.routing?.governance || {}), ...(loadedRouting.governance || {}) },
            contextWindows: { ...(config.routing?.contextWindows || {}), ...(loadedRouting.contextWindows || {}) },
            nuviraSidecar: { ...(config.routing?.nuviraSidecar || {}), ...(loadedRouting.nuviraSidecar || {}) },
          };
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
   * Environment variables take priority over the config file.
   */
  private overrideFromEnv(config: BuffConfig): void {
    // Debug logging to help troubleshoot env var detection
    const envVarsChecked: string[] = [];

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
    } else {
      logger.debug('Config: No API keys found in environment variables. Use --debug to see more.');
    }
  }

  /**
   * Get configuration for a specific provider.
   * The 'auto' routing directive is resolved here to the best currently-
   * available provider (registry-verified → configured → local) so callers
   * never see a literal 'auto' reach an adapter factory.
   */
  getProviderConfig(provider?: string): { type: string; config: ProviderConfig } {
    let type = provider || this.config.defaultProvider;
    if (type === 'auto') {
      type = resolveDefaultProvider(this);
    }
    const config = this.config.providers[type] || {};

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

    if (config.pricing) {
      // Deep merge per provider so setting inputPer1K then outputPer1K via
      // `buff config set pricing.<provider>...` preserves both fields.
      this.config.pricing = { ...(this.config.pricing || {}) };
      for (const [provider, pricing] of Object.entries(config.pricing)) {
        this.config.pricing[provider] = { ...(this.config.pricing[provider] || {}), ...pricing };
      }
    }

    if (config.routing) {
      this.config.routing = {
        ...(this.config.routing || {}),
        ...config.routing,
      };
    }

    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

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
  hasRequiredCredentials(provider: string): boolean {
    if (provider === 'local') return true; // Local doesn't need API key
    // P5 M5.3: the Nuvira gateway is keyless-optional by design — a local
    // sidecar (default http://127.0.0.1:20128/v1) often needs NO token. The
    // adapter probes reachability (isAvailable) before use, so an unconfigured
    // gateway is harmlessly skipped at the availability walk, never failed into.
    if (provider === 'nuvira') return true;
    const apiKey = this.config.providers[provider]?.apiKey;
    if (!apiKey) return false;
    // A docs placeholder is NOT a credential — skip predictively.
    if (isPlaceholderApiKey(apiKey)) return false;
    return true;
  }

  /**
   * Log a clear, one-time warning for providers holding placeholder API keys,
   * so the user knows why a provider is skipped by auto routing (instead of
   * discovering it via repeated 401s). Best-effort — never throws.
   */
  warnPlaceholderKeys(): void {
    try {
      for (const [provider, cfg] of Object.entries(this.config.providers)) {
        if (cfg?.apiKey && isPlaceholderApiKey(cfg.apiKey)) {
          logger.warn(
            `      ⚠️ ${provider} has a placeholder API key ('${cfg.apiKey}') — this looks like ` +
            `a docs example or env-var name, not a real key. Auto routing will SKIP ${provider} ` +
            `until a valid key is set (buff config set provider.${provider}.apiKey ...).`,
          );
        }
      }
    } catch {
      // Best-effort — a config warning must never break startup.
    }
  }
}
