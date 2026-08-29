import { BuffConfig, ProviderConfig } from './types.js';
import { Vault } from '../enterprise/vault.js';
import { WorkspaceStore } from './workspace.js';
/** True when a key value is a docs placeholder / env-var name, not a real credential. */
export declare function isPlaceholderApiKey(key: string | undefined | null): boolean;
/**
 * Count how many provider keys are vault refs vs plaintext (used by
 * `nuvira config vault status` and `nuvira doctor`). Placeholder/sentinel keys are
 * counted as plaintext (they're in the file), which matches the hygiene story.
 */
export declare function countKeyStates(config: BuffConfig): {
    refs: number;
    plaintext: number;
};
export declare class ConfigManager {
    private config;
    private env;
    private configDir;
    /** mtime of the config file when `this.config` was last loaded (live re-read). */
    private configMtimeMs;
    private configPath;
    /**
     * Phase A1 secret vault. When attached, provider key reads/writes route
     * through the vault (`buffconfig.json` holds `vault:` refs instead of
     * plaintext). Null → legacy behavior (plaintext keys in the file), fully
     * backwards-compatible.
     */
    private vault;
    /** Phase A2 workspace store (lazy — see getWorkspaceStore). */
    private workspaceStore;
    constructor(configDir?: string);
    /** Best-effort current mtime of the config file (0 when absent). */
    private statMtime;
    /**
     * Live re-read (Session 36 — "update as and when"): a running process
     * (chat/execute/dashboard) must honor budget/limit changes the user makes
     * via `nuvira model quota set` or the dashboard's Daily Budget panel — even on
     * the SAME instance. statSync is ~µs; the JSON re-read happens only when the
     * file actually changed. save() stamps the mtime so our own writes don't
     * trigger a redundant re-read.
     */
    private refreshIfChanged;
    /** Attach the secret vault (Phase A1). No-op-safe: callers may pass null. */
    attachVault(vault: Vault | null): void;
    /** The attached vault (null when not attached / unavailable). */
    getVault(): Vault | null;
    /**
     * Phase A2: the workspace store (project registry + workspace state) bound
     * to THIS config dir. Lazy + cached per instance: the DB handle opens on
     * first use, so the many ConfigManager instantiations per CLI run never pay
     * for an unused handle.
     */
    getWorkspaceStore(): WorkspaceStore;
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
    hydrateVaultRefs(): Promise<number>;
    /**
     * Phase A1 migration: move every plaintext provider key (apiKey + apiKeys[])
     * from `buffconfig.json` into the attached vault and rewrite the file with
     * `vault:` refs. Returns per-provider results. Requires an attached vault
     * with a usable tier; otherwise throws a clear error.
     */
    migrateKeysToVault(): Promise<{
        migrated: number;
        providers: string[];
    }>;
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
    private resolveVaultRefs;
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