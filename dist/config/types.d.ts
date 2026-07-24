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