import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BuffConfig, ProviderType, ProviderConfig } from './types.js';
import { resolveBuffConfigDir } from './paths.js';
import { loadEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { resolveDefaultProvider } from '../learning/model-selection.js';
import { CATALOG_ENV_VARS, isCatalogKeyless } from '../inference/provider-catalog.js';
import { Vault, isVaultRef, VAULT_REF_PREFIX } from '../enterprise/vault.js';
import { WorkspaceStore, getWorkspaceStore } from './workspace.js';

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

/**
 * Count how many provider keys are vault refs vs plaintext (used by
 * `buff config vault status` and `buff doctor`). Placeholder/sentinel keys are
 * counted as plaintext (they're in the file), which matches the hygiene story.
 */
export function countKeyStates(config: BuffConfig): { refs: number; plaintext: number } {
  let refs = 0;
  let plaintext = 0;
  for (const p of Object.values(config.providers || {})) {
    if (isVaultRef(p?.apiKey)) refs++;
    else if (p?.apiKey) plaintext++;
    if (Array.isArray(p?.apiKeys)) {
      for (const k of p.apiKeys) {
        if (isVaultRef(k)) refs++;
        else if (k) plaintext++;
      }
    }
  }
  return { refs, plaintext };
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
  // I1 toolsets: empty by default = every toolset enabled (absent = enabled).
  tools: {
    toolsets: {},
  },
};

export class ConfigManager {
  private config: BuffConfig;
  private env: Record<string, string | undefined>;
  private configDir: string;
  /** mtime of the config file when `this.config` was last loaded (live re-read). */
  private configMtimeMs = 0;
  private configPath: string;
  /**
   * Phase A1 secret vault. When attached, provider key reads/writes route
   * through the vault (`buffconfig.json` holds `vault:` refs instead of
   * plaintext). Null → legacy behavior (plaintext keys in the file), fully
   * backwards-compatible.
   */
  private vault: Vault | null = null;
  /** Phase A2 workspace store (lazy — see getWorkspaceStore). */
  private workspaceStore: WorkspaceStore | null = null;

  constructor(configDir?: string) {
    this.env = loadEnv();
    // BUFF_CONFIG_DIR override — the RBAC role file and credential store
    // already honor it, so the config manager must too: a hermetic run pointed
    // at BUFF_CONFIG_DIR must never read/write the real ~/.buff config.
    this.configDir = resolveBuffConfigDir(configDir);
    this.configPath = join(this.configDir, 'buffconfig.json');
    // Phase A1: auto-open the secret vault so refs resolve at READ time. Every
    // runtime command (BaseCommand, Orchestrator) constructs its OWN fresh
    // ConfigManager — boot-time hydration in index.ts only touches a throwaway
    // instance, so it can never be the only resolution path. Opening here means
    // a provider whose key was migrated to `vault:<account>` is transparently
    // resolved the moment getProviderConfig()/hasRequiredCredentials() runs,
    // in ANY process (chat, execute, router, doctor, probes).
    try {
      this.vault = Vault.open({ configDir: this.configDir });
    } catch {
      this.vault = null; // vault failure must never break config loading
    }
    this.config = this.loadConfig();
    this.configMtimeMs = this.statMtime();
  }

  /** Best-effort current mtime of the config file (0 when absent). */
  private statMtime(): number {
    try {
      return statSync(this.configPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Live re-read (Session 36 — "update as and when"): a running process
   * (chat/execute/dashboard) must honor budget/limit changes the user makes
   * via `buff model quota set` or the dashboard's Daily Budget panel — even on
   * the SAME instance. statSync is ~µs; the JSON re-read happens only when the
   * file actually changed. save() stamps the mtime so our own writes don't
   * trigger a redundant re-read.
   */
  private refreshIfChanged(): void {
    const mtime = this.statMtime();
    if (mtime !== this.configMtimeMs) {
      try {
        this.config = this.loadConfig();
        this.configMtimeMs = mtime;
      } catch {
        // A concurrent writer mid-writeFileSync can leave a partial file whose
        // mtime already changed — keep the last GOOD config (never crash a
        // routing hot path over a transient read). The next getAll() retries.
      }
    }
  }

  /** Attach the secret vault (Phase A1). No-op-safe: callers may pass null. */
  attachVault(vault: Vault | null): void {
    this.vault = vault;
  }

  /** The attached vault (null when not attached / unavailable). */
  getVault(): Vault | null {
    return this.vault;
  }

  /**
   * Phase A2: the workspace store (project registry + workspace state) bound
   * to THIS config dir. Lazy + cached per instance: the DB handle opens on
   * first use, so the many ConfigManager instantiations per CLI run never pay
   * for an unused handle.
   */
  getWorkspaceStore(): WorkspaceStore {
    if (!this.workspaceStore) {
      this.workspaceStore = getWorkspaceStore(this.configDir);
    }
    return this.workspaceStore;
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

    // Deep clone tools (toolsets) defaults
    config.tools = { toolsets: { ...(DEFAULT_CONFIG.tools?.toolsets || {}) } };

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

        // Merge toolsets config (deep per toolset — separate toggles preserve
        // each other; a missing entry means enabled).
        if (userConfig.tools) {
          config.tools = {
            ...(config.tools || {}),
            ...userConfig.tools,
            toolsets: { ...(config.tools?.toolsets || {}), ...(userConfig.tools.toolsets || {}) },
          };
        }

        // Merge I7 skills config (disabled[] + registries[]) — whole-array
        // semantics: an empty array is meaningful ("nothing disabled") and
        // must survive a load.
        if (userConfig.skills) {
          config.skills = {
            ...(config.skills || {}),
            ...(userConfig.skills.disabled !== undefined ? { disabled: userConfig.skills.disabled } : {}),
            ...(userConfig.skills.registries !== undefined ? { registries: userConfig.skills.registries } : {}),
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
   * Override API keys from environment variables.
   * Environment variables take priority over the config file.
   *
   * DYNAMIC (Issue 001): every catalog provider's standard env var is mapped,
   * so a user who sets ANY of the 17+ provider keys (OPENAI_API_KEY,
   * ANTHROPIC_API_KEY, MISTRAL_API_KEY, ...) sees that provider become a
   * routing/probing candidate — not just the original four hardcoded vars.
   */
  private overrideFromEnv(config: BuffConfig): void {
    // Debug logging to help troubleshoot env var detection
    const envVarsChecked: string[] = [];

    for (const [provider, envVar] of Object.entries(CATALOG_ENV_VARS)) {
      const value = this.env[envVar];
      if (value) {
        if (!config.providers[provider]) {
          config.providers[provider] = { model: 'default', temperature: 0.7, maxTokens: 4096 };
        }
        config.providers[provider].apiKey = value;
        envVarsChecked.push(envVar);
      }
    }

    // Azure OpenAI: the ENDPOINT (resource base URL) is required alongside the
    // key — map AZURE_OPENAI_ENDPOINT into providers.azure.baseUrl so the
    // generic adapter targets the resource, not the localhost fallback.
    if (this.env.AZURE_OPENAI_ENDPOINT) {
      if (!config.providers.azure) {
        config.providers.azure = { model: 'default', temperature: 0.7, maxTokens: 4096 };
      }
      config.providers.azure.baseUrl = this.env.AZURE_OPENAI_ENDPOINT.trim().replace(/\/+$/, '');
    }

    if (envVarsChecked.length > 0) {
      logger.debug(`Config: Loaded API keys from env vars: ${envVarsChecked.join(', ')}`);
    } else {
      logger.debug('Config: No API keys found in environment variables. Use --debug to see more.');
    }
  }

  /**
   * Hydrate provider keys that are stored as vault refs (`vault:<account>`)
   * into the in-memory config. Called once at CLI boot after `attachVault`.
   * Sync callers (adapters, router) then see real keys. Returns the number of
   * refs resolved. Never throws.
   *
   * CRITICAL: a ref that fails to resolve is REMOVED (primary key deleted,
   * rotation entry dropped), never left as a literal `vault:...` string — a
   * literal ref would pass `hasRequiredCredentials` and be sent to the API as
   * the real key, guaranteeing a 401 (the placeholder-key class of bug).
   */
  async hydrateVaultRefs(): Promise<number> {
    if (!this.vault) return 0;
    let hydrated = 0;
    for (const provider of Object.keys(this.config.providers)) {
      const cfg = this.config.providers[provider];
      if (!cfg) continue;
      const primaryKey = cfg.apiKey;
      if (typeof primaryKey === 'string' && isVaultRef(primaryKey)) {
        const resolved = await this.vault.getPassword(primaryKey.slice(VAULT_REF_PREFIX.length));
        if (resolved) {
          cfg.apiKey = resolved;
          hydrated++;
        } else {
          // Unresolved ref → remove the key so the provider reads unconfigured.
          delete cfg.apiKey;
        }
      }
      if (Array.isArray(cfg.apiKeys)) {
        const resolvedKeys: string[] = [];
        for (const k of cfg.apiKeys) {
          if (typeof k === 'string' && isVaultRef(k)) {
            const r = await this.vault.getPassword(k.slice(VAULT_REF_PREFIX.length));
            if (r) {
              resolvedKeys.push(r);
              hydrated++;
            }
            // else: unresolved rotation ref → drop it (never keep a literal ref)
          } else {
            resolvedKeys.push(k);
          }
        }
        cfg.apiKeys = resolvedKeys;
      }
    }
    return hydrated;
  }

  /**
   * Phase A1 migration: move every plaintext provider key (apiKey + apiKeys[])
   * from `buffconfig.json` into the attached vault and rewrite the file with
   * `vault:` refs. Returns per-provider results. Requires an attached vault
   * with a usable tier; otherwise throws a clear error.
   */
  async migrateKeysToVault(): Promise<{ migrated: number; providers: string[] }> {
    if (!this.vault) {
      throw new Error('No vault attached — call attachVault() first (buff config vault status).');
    }
    const st = this.vault.status();
    if (st.tier === 'none') {
      throw new Error(
        'Vault unavailable (no OS keyring and no BUFF_VAULT_PASSPHRASE). ' +
        'Set BUFF_VAULT_PASSPHRASE to enable the encrypted-file tier.',
      );
    }
    let migrated = 0;
    const providers: string[] = [];
    const updated: Record<string, ProviderConfig> = {};

    for (const [provider, cfg] of Object.entries(this.config.providers)) {
      if (!cfg) continue;
      const next: ProviderConfig = { ...cfg };
      let changed = false;

      // Primary key → vault ref. Placeholder keys (docs examples / env-var
      // names like 'openrouter-env-key', 'new-key') are NOT credentials and are
      // never vaulted — they stay in the config so warnPlaceholderKeys still
      // flags them for the user. A failed vault WRITE aborts the whole
      // migration (throwing) so we never write a ref pointing at nothing.
      if (
        typeof cfg.apiKey === 'string' &&
        cfg.apiKey.length > 0 &&
        !isVaultRef(cfg.apiKey) &&
        !isPlaceholderApiKey(cfg.apiKey)
      ) {
        const account = Vault.accountFor(provider, 'apiKey');
        const write = await this.vault.setPassword(account, cfg.apiKey);
        if (!write.ok) {
          throw new Error(`migrate-keys: failed to store ${provider} key in the vault — ${write.reason}`);
        }
        next.apiKey = Vault.refFor(account);
        changed = true;
        migrated++;
      }

      // Rotation keys → vault refs (same placeholder exclusion + write check).
      if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
        const refs: string[] = [];
        for (let i = 0; i < cfg.apiKeys.length; i++) {
          const k = cfg.apiKeys[i];
          if (typeof k !== 'string' || k.length === 0 || isVaultRef(k) || isPlaceholderApiKey(k)) {
            refs.push(k);
            continue;
          }
          const account = Vault.accountFor(provider, 'apiKeys', i);
          const write = await this.vault.setPassword(account, k);
          if (!write.ok) {
            throw new Error(`migrate-keys: failed to store ${provider} rotation key ${i} — ${write.reason}`);
          }
          refs.push(Vault.refFor(account));
          migrated++;
          changed = true;
        }
        next.apiKeys = refs;
      }

      if (changed) {
        updated[provider] = next;
        providers.push(provider);
      }
    }

    if (Object.keys(updated).length > 0) {
      this.save({ providers: updated });
    }
    return { migrated, providers };
  }

  /**
   * Resolve any `vault:` refs in a provider config onto a CLONE of the stored
   * config (never throws). Refs that cannot resolve are DELETED from the clone
   * — never left as a literal `vault:...` string that would be sent to the API
   * as a key (the placeholder-key class of bug).
   *
   * CRITICAL: resolution happens on a copy, never on this.config. If the live
   * config were mutated, a later save() would write RESOLVED REAL KEYS back to
   * buffconfig.json in plaintext — silently defeating the vault.
   */
  private resolveVaultRefs(config: ProviderConfig): ProviderConfig {
    if (!this.vault) return config;
    // Fast path: no refs → return the SAME reference (callers that mutate the
    // returned config to fill model defaults keep working exactly as before).
    const hasRef =
      (typeof config.apiKey === 'string' && isVaultRef(config.apiKey)) ||
      (Array.isArray(config.apiKeys) && config.apiKeys.some((k) => typeof k === 'string' && isVaultRef(k)));
    if (!hasRef) return config;
    const resolved: ProviderConfig = { ...config };
    if (typeof resolved.apiKey === 'string' && isVaultRef(resolved.apiKey)) {
      const secret = this.vault.resolveRefSync(resolved.apiKey);
      if (secret) resolved.apiKey = secret;
      else delete resolved.apiKey;
    }
    if (Array.isArray(resolved.apiKeys)) {
      const keys: string[] = [];
      for (const k of resolved.apiKeys) {
        if (typeof k === 'string' && isVaultRef(k)) {
          const r = this.vault.resolveRefSync(k);
          if (r) keys.push(r); // unresolved ref → dropped (never literal)
        } else {
          keys.push(k);
        }
      }
      resolved.apiKeys = keys;
    }
    return resolved;
  }

  /**
   * Get configuration for a specific provider.
   * The 'auto' routing directive is resolved here to the best currently-
   * available provider (registry-verified → configured → local) so callers
   * never see a literal 'auto' reach an adapter factory.
   *
   * Phase A1: `vault:` refs are resolved synchronously (on a clone) before
   * returning, so the adapter factory always receives REAL keys — the file
   * keeps refs and a later save() never writes plaintext back.
   */
  getProviderConfig(provider?: string): { type: string; config: ProviderConfig } {
    let type = provider || this.config.defaultProvider;
    if (type === 'auto') {
      type = resolveDefaultProvider(this);
    }
    const config = this.resolveVaultRefs(this.config.providers[type] || {});

    return { type, config };
  }

  /**
   * Get the full config
   */
  getAll(): BuffConfig {
    this.refreshIfChanged();
    return { ...this.config };
  }

  /**
   * Save current configuration to disk
   */
  save(config: Partial<BuffConfig>): void {
    // Session 36 "update as and when": the dashboard and CLI can edit the SAME
    // config concurrently — refresh before merging so a save() never clobbers
    // a newer external write (lost-update guard).
    this.refreshIfChanged();
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

    if (config.tools) {
      this.config.tools = {
        ...(this.config.tools || {}),
        ...config.tools,
        toolsets: { ...(this.config.tools?.toolsets || {}), ...(config.tools.toolsets || {}) },
      };
    }

    if (config.skills) {
      // I7 P0/P1: `skills.disabled` (exclusion list) + `skills.registries`
      // (ordered multi-source list) — whole-array semantics, not per-key merge
      // (an empty list is meaningful: "nothing disabled" / "use the default").
      this.config.skills = {
        ...(this.config.skills || {}),
        ...(config.skills.disabled !== undefined ? { disabled: config.skills.disabled } : {}),
        ...(config.skills.registries !== undefined ? { registries: config.skills.registries } : {}),
      };
    }

    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    // Stamp the mtime so the live re-read skips content we just wrote.
    this.configMtimeMs = this.statMtime();
  }

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
  clearProviderApiKey(
    provider: string,
    failedKey?: string,
  ): { cleared: boolean; envSourced: boolean; envVar?: string } {
    try {
      const envVar = CATALOG_ENV_VARS[provider];
      const envValue = envVar ? this.env[envVar] : undefined;
      const cfg = this.config.providers[provider];
      if (!cfg) return { cleared: false, envSourced: false };
      const target = failedKey ?? cfg.apiKey;
      if (!target) return { cleared: false, envSourced: false };
      // A key whose value equals its catalog env var was injected from the
      // environment — the file can't clear it (it re-injects on load).
      if (envValue && target === envValue) {
        return { cleared: false, envSourced: true, envVar };
      }
      let removed = false;
      const primaryKey = cfg.apiKey;
      if (typeof primaryKey === 'string' && primaryKey === target) {
        // Phase A1: a vault-ref key also purges its vault entry (dead-key
        // hygiene must not orphan secrets in the keychain/file vault).
        if (isVaultRef(primaryKey) && this.vault) {
          void this.vault.deletePassword(primaryKey.slice(VAULT_REF_PREFIX.length));
        }
        delete cfg.apiKey;
        removed = true;
      }
      if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.includes(target)) {
        cfg.apiKeys = cfg.apiKeys.filter((k) => {
          if (typeof k === 'string' && k === target && isVaultRef(k) && this.vault) {
            void this.vault.deletePassword(k.slice(VAULT_REF_PREFIX.length));
          }
          return k !== target;
        });
        removed = true;
      }
      if (removed) this.save({ providers: { [provider]: cfg } });
      return { cleared: removed, envSourced: false };
    } catch {
      // Best-effort — never break a live call over key hygiene.
      return { cleared: false, envSourced: false };
    }
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
    // Issue 001: catalog keyless providers (LM Studio, vLLM/TGI, ...) need no
    // API key — they count as configured and reachability is probed instead.
    if (isCatalogKeyless(provider)) return true;
    const apiKey = this.config.providers[provider]?.apiKey;
    if (!apiKey) return false;
    // Phase A1: a `vault:` ref counts as configured ONLY if the vault can
    // resolve it to a real secret. A ref that can't resolve (key deleted from
    // the keychain, wrong passphrase on the AES tier) reads as NOT configured
    // — never as a literal ref that would pass this check and then 401.
    if (isVaultRef(apiKey)) {
      return this.vault?.resolveRefSync(apiKey) != null;
    }
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
