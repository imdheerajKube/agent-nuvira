/**
 * Supported inference provider identifiers
 */
export type ProviderType = 'nim' | 'gemini' | 'openrouter' | 'groq' | 'local';

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
 * Full configuration schema for .buffconfig.json
 */
export interface BuffConfig {
  defaultProvider: ProviderType;
  providers: Record<ProviderType, ProviderConfig>;
  /** Team collaboration config */
  team?: TeamConfig;
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
