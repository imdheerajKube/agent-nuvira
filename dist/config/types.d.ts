/**
 * Supported built-in inference providers.
 */
export type BuiltInProviderType = 'nim' | 'gemini' | 'openrouter' | 'groq' | 'local';
/**
 * Any provider identifier, including built-in and plugin-provided types.
 */
export type ProviderType = BuiltInProviderType | string;
/**
 * Local model runner options
 */
export type LocalRunner = 'ollama' | 'huggingface' | 'ggml';
/**
 * Provider-specific configuration
 */
export interface ProviderConfig {
    apiKey?: string;
    model?: string;
    runner?: LocalRunner;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
}
/**
 * Provider config map keyed by provider type.
 */
export type ProviderConfigMap = Record<string, ProviderConfig>;
/** Provider fallback routing configuration */
export interface FallbackConfig {
    /** Whether automatic fallback is enabled (default: true) */
    enabled?: boolean;
    /** Prioritized list of fallback provider types */
    providers?: string[];
    /** Max providers to try before giving up (default: 3) */
    maxAttempts?: number;
    /** Milliseconds to wait before retrying a failed provider (default: 1000) */
    retryDelayMs?: number;
}
/** Team collaboration settings */
export interface TeamConfig {
    /** Git URL for the team's shared memory/templates repo */
    repository?: string;
    /** Local path to the team data directory */
    localPath?: string;
    /** Branch to sync with */
    branch?: string;
    /** Auto-sync interval in minutes (0 = disabled) */
    autoSyncMinutes?: number;
    /** Whether to share trajectories with the team */
    shareTrajectories?: boolean;
}
/**
 * Per-provider pricing override for Auto model routing cost scoring.
 * Values are USD per 1K tokens (input/output). When unset, the built-in
 * pricing table (or the default) is used.
 */
export interface ProviderPricing {
    /** Input price per 1K tokens (USD) */
    inputPer1K?: number;
    /** Output price per 1K tokens (USD) */
    outputPer1K?: number;
}
/**
 * Pricing override map keyed by provider type.
 * Set via `buff config set pricing.<provider>.inputPer1K <usd>`.
 */
export type PricingConfigMap = Record<string, ProviderPricing>;
/**
 * Chat history configuration
 */
export interface HistoryConfig {
    /** Retention period in days — old sessions are auto-pruned on CLI startup */
    retentionDays?: number;
    /**
     * Enable semantic search indexing on session storage.
     * When true (default), each stored session is embedded and indexed in the VectorStore
     * for fast semantic search. Set to false to skip auto-embedding and only use keyword search.
     */
    semanticSearch?: boolean;
}
/**
 * Learning-router configuration (Thompson-sampling bandit + hard constraints).
 * Set via `buff config set routing.<key> <value>` or directly in .buffconfig.json.
 */
export interface RoutingConfig {
    /**
     * Enable Thompson-sampling bandit learning for Auto model routing.
     * Providers are scored by deterministic heuristics × a Beta draw learned
     * from real task outcomes (recorded automatically by the orchestrator).
     * Default: false.
     */
    bandit?: boolean;
    /** Hard max cost per call (USD) — providers whose typical call exceeds this are excluded */
    maxCostUsd?: number;
    /** Minimum speed score (0–1) for a candidate provider to be considered */
    minSpeed?: number;
    /** Minimum reasoning score (0–1) for a candidate provider to be considered */
    minReasoning?: number;
    /**
     * Minimum accumulated bandit samples (α+β) before a provider counts as
     * "learned". When the bandit's winner has fewer samples, Auto routing
     * escalates to the next-ranked provider WITH learned data (uncertainty-
     * driven escalation, ruflo model-router mirror). Default: 8.
     */
    escalationMinSamples?: number;
    /**
     * Minimum diverged A/B decisions before the promotion gate (bandit-vs-
     * heuristic) evaluates as meaningful. Surfaced by `buff model bandit`.
     * Default: 20.
     */
    promotionMinDecisions?: number;
}
/**
 * Full configuration schema for .buffconfig.json
 */
export interface BuffConfig {
    defaultProvider: ProviderType;
    providers: ProviderConfigMap;
    /** Provider fallback routing config */
    fallback?: FallbackConfig;
    /** Team collaboration config */
    team?: TeamConfig;
    /** Chat history configuration */
    history?: HistoryConfig;
    /** Per-provider pricing overrides for Auto model routing cost scoring */
    pricing?: PricingConfigMap;
    /** Learning-router config (bandit sampling + hard constraints) */
    routing?: RoutingConfig;
}
/**
 * Inference options passed to each generation call
 * Note: provider is string to allow plugin-based providers
 */
export interface InferenceOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    provider?: string;
    stream?: boolean;
}
//# sourceMappingURL=types.d.ts.map