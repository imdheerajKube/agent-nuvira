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

/**
 * Full configuration schema for .buffconfig.json
 */
export interface BuffConfig {
  defaultProvider: ProviderType;
  providers: Record<ProviderType, ProviderConfig>;
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
