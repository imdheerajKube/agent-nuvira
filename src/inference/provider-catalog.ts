/**
 * Provider Catalog — the single source of truth for every provider Agent-Nuvira
 * knows how to reach. This is a CATALOG (adapter metadata), never a selection:
 * which providers actually get routed to is decided at runtime from the user's
 * configured credentials + the Model Availability Registry (see
 * rankAvailableProviders / getDefaultAllowedProviders). A provider with no key
 * configured simply never enters the candidate pool.
 *
 * Why this exists (Issue 001): the router used to consider only the 6 built-in
 * providers (DEFAULT_AUTO_PROVIDERS), so a user who set OPENAI_API_KEY /
 * ANTHROPIC_API_KEY / MISTRAL_API_KEY etc. never saw those providers routed to.
 * The catalog makes provider discovery DYNAMIC: every catalog provider whose
 * env var (or config key) is present is a candidate, so all 17+ advertised
 * providers participate in routing, probing, and the provider list.
 *
 * Fields:
 *   - envVar           — the standard env var that carries the API key
 *   - baseUrl          — default OpenAI-compatible base URL (chat/completions)
 *   - openAICompat     — speaks the OpenAI /v1/chat/completions protocol
 *   - keyless          — no API key needed (local runners, self-hosted servers)
 *   - apiKeyHeader     — auth header name ('Authorization' = Bearer, azure = 'api-key')
 *   - capabilities     — static baseline profile (0–1; real usage data overrides)
 *   - pricing          — approximate USD per 1K tokens (configurable via pricing.*)
 *   - contextWindow    — nominal input context window (tokens), provider-level
 *
 * Prices are approximate list prices and ALWAYS overridable via
 * `buff config set pricing.<provider>.*`. Measured wire-token cost replaces the
 * estimate once the provider reports real usage (M2.2).
 */

export interface CatalogCapabilities {
  reasoning: number;
  speed: number;
  cost: number;
  privacy: number;
  reliability: number;
}

export interface CatalogProviderEntry {
  /** Stable provider id (used in config.providers, routing, registry). */
  id: string;
  /** Human label for UIs. */
  label: string;
  /** Terminal icon. */
  icon: string;
  /** Standard API-key env var (undefined for keyless providers). */
  envVar?: string;
  /** Default OpenAI-compatible base URL (for openAICompat providers). */
  baseUrl?: string;
  /** Speaks OpenAI /v1/chat/completions (the generic OpenAI-compat adapter). */
  openAICompat?: boolean;
  /** True when no API key is needed (reachability is still probed). */
  keyless?: boolean;
  /** Auth header name (default 'Authorization' → `Bearer <key>`). */
  apiKeyHeader?: string;
  /**
   * Extra query string appended to every request URL (Azure OpenAI needs
   * `api-version=...`). Default none.
   */
  apiVersionQuery?: string;
  /** Native adapter family when NOT openAICompat (e.g. 'anthropic'). */
  nativeAdapter?: 'anthropic';
  /**
   * Azure OpenAI shape: chat lives at `/openai/deployments/{model}/chat/completions`
   * (the model id IS the deployment name). The generic adapter uses this to
   * build correct request URLs.
   */
  azureDeployments?: boolean;
  /** Static capability baseline (0–1, higher is better per dimension). */
  capabilities: CatalogCapabilities;
  /** Approximate USD per 1K tokens (input/output). */
  pricing: { inputPer1K: number; outputPer1K: number };
  /** Nominal input context window (tokens), provider-level estimate. */
  contextWindow: number;
}

/**
 * The catalog. Built-in providers carry their real metadata; the extended
 * providers (openai, anthropic, mistral, …) carry the metadata needed for the
 * generic OpenAI-compatible adapter / native adapters, env-var discovery,
 * routing capability scores, pricing, and context preflight.
 *
 * NOTE: the built-in capability profiles here deliberately mirror the
 * auto-router's DEFAULT_PROFILES for those ids (the catalog is the metadata
 * home; the router reads from it). Real pricing + measured tokens override the
 * static baselines at routing time.
 */
export const PROVIDER_CATALOG: Record<string, CatalogProviderEntry> = {
  // ── Built-in providers ──────────────────────────────────────────────────
  local: {
    id: 'local',
    label: 'Local (Ollama)',
    icon: '💻',
    keyless: true,
    capabilities: { reasoning: 0.30, speed: 0.55, cost: 1.00, privacy: 1.00, reliability: 0.60 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 8_192,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    icon: '⚡',
    envVar: 'GROQ_API_KEY',
    openAICompat: true,
    capabilities: { reasoning: 0.55, speed: 1.00, cost: 0.85, privacy: 0.15, reliability: 0.85 },
    pricing: { inputPer1K: 0.00059, outputPer1K: 0.00079 },
    contextWindow: 131_072,
  },
  nim: {
    id: 'nim',
    label: 'NVIDIA NIM',
    icon: '🎮',
    envVar: 'NVIDIA_NIM_API_KEY',
    openAICompat: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    capabilities: { reasoning: 0.72, speed: 0.70, cost: 0.55, privacy: 0.15, reliability: 0.82 },
    pricing: { inputPer1K: 0.00010, outputPer1K: 0.00050 },
    contextWindow: 128_000,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    icon: '🌀',
    envVar: 'GEMINI_API_KEY',
    capabilities: { reasoning: 0.85, speed: 0.80, cost: 0.40, privacy: 0.10, reliability: 0.88 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 1_048_576,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    icon: '🌐',
    envVar: 'OPENROUTER_API_KEY',
    openAICompat: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    capabilities: { reasoning: 0.95, speed: 0.55, cost: 0.15, privacy: 0.10, reliability: 0.78 },
    pricing: { inputPer1K: 0.00250, outputPer1K: 0.01000 },
    contextWindow: 128_000,
  },
  nuvira: {
    id: 'nuvira',
    label: 'Nuvira Gateway',
    icon: '🧭',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://127.0.0.1:20128/v1',
    capabilities: { reasoning: 0.50, speed: 0.50, cost: 0.50, privacy: 0.50, reliability: 0.70 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 131_072,
  },

  // ── Extended OpenAI-compatible providers (Issue 001: 17+ in routing) ────
  openai: {
    id: 'openai',
    label: 'OpenAI',
    icon: '🤖',
    envVar: 'OPENAI_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { reasoning: 0.92, speed: 0.78, cost: 0.35, privacy: 0.10, reliability: 0.90 },
    pricing: { inputPer1K: 0.00125, outputPer1K: 0.00500 },
    contextWindow: 128_000,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    icon: '🔮',
    envVar: 'ANTHROPIC_API_KEY',
    nativeAdapter: 'anthropic',
    capabilities: { reasoning: 0.95, speed: 0.65, cost: 0.30, privacy: 0.10, reliability: 0.92 },
    pricing: { inputPer1K: 0.00300, outputPer1K: 0.01500 },
    contextWindow: 200_000,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    icon: '🌀',
    envVar: 'MISTRAL_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.mistral.ai/v1',
    capabilities: { reasoning: 0.72, speed: 0.82, cost: 0.60, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00090, outputPer1K: 0.00270 },
    contextWindow: 128_000,
  },
  cohere: {
    id: 'cohere',
    label: 'Cohere',
    icon: '🧠',
    envVar: 'COHERE_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.cohere.com/v1',
    capabilities: { reasoning: 0.65, speed: 0.75, cost: 0.70, privacy: 0.10, reliability: 0.82 },
    pricing: { inputPer1K: 0.00015, outputPer1K: 0.00060 },
    contextWindow: 128_000,
  },
  together: {
    id: 'together',
    label: 'Together AI',
    icon: '🟢',
    envVar: 'TOGETHER_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.together.ai/v1',
    capabilities: { reasoning: 0.68, speed: 0.85, cost: 0.65, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00060 },
    contextWindow: 32_768,
  },
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    icon: '🌐',
    envVar: 'DEEPINFRA_TOKEN',
    openAICompat: true,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    capabilities: { reasoning: 0.65, speed: 0.88, cost: 0.75, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00010, outputPer1K: 0.00020 },
    contextWindow: 32_768,
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    icon: '🎆',
    envVar: 'FIREWORKS_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    capabilities: { reasoning: 0.70, speed: 0.90, cost: 0.70, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00060 },
    contextWindow: 32_768,
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    icon: '❓',
    envVar: 'PERPLEXITY_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.perplexity.ai',
    capabilities: { reasoning: 0.75, speed: 0.72, cost: 0.55, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00100 },
    contextWindow: 128_000,
  },
  azure: {
    id: 'azure',
    label: 'Azure OpenAI',
    icon: '🔵',
    envVar: 'AZURE_OPENAI_API_KEY',
    openAICompat: true,
    // Endpoint comes from AZURE_OPENAI_ENDPOINT (e.g. https://<res>.openai.azure.com)
    // — mapped into providers.azure.baseUrl by the ConfigManager; the model id
    // IS the deployment name. api-version is required on every request.
    azureDeployments: true,
    apiKeyHeader: 'api-key',
    apiVersionQuery: 'api-version=2024-10-21',
    capabilities: { reasoning: 0.90, speed: 0.78, cost: 0.35, privacy: 0.35, reliability: 0.92 },
    pricing: { inputPer1K: 0.00250, outputPer1K: 0.01000 },
    contextWindow: 128_000,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    icon: '🎨',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://localhost:1234/v1',
    capabilities: { reasoning: 0.40, speed: 0.60, cost: 1.00, privacy: 1.00, reliability: 0.70 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 32_768,
  },
  anyscale: {
    id: 'anyscale',
    label: 'Anyscale',
    icon: '🔷',
    envVar: 'ANYSCALE_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    capabilities: { reasoning: 0.72, speed: 0.80, cost: 0.60, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00060, outputPer1K: 0.00200 },
    contextWindow: 65_536,
  },
  vllm: {
    id: 'vllm',
    label: 'vLLM / TGI',
    icon: '⚡',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://localhost:8000/v1',
    capabilities: { reasoning: 0.50, speed: 0.65, cost: 1.00, privacy: 0.85, reliability: 0.72 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 32_768,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    icon: '🐳',
    envVar: 'DEEPSEEK_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: { reasoning: 0.80, speed: 0.75, cost: 0.80, privacy: 0.10, reliability: 0.86 },
    pricing: { inputPer1K: 0.00027, outputPer1K: 0.00110 },
    contextWindow: 64_000,
  },
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    icon: '🕶️',
    envVar: 'XAI_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.x.ai/v1',
    capabilities: { reasoning: 0.88, speed: 0.70, cost: 0.30, privacy: 0.10, reliability: 0.88 },
    pricing: { inputPer1K: 0.00300, outputPer1K: 0.01500 },
    contextWindow: 131_072,
  },
  replicate: {
    id: 'replicate',
    label: 'Replicate',
    icon: '🔁',
    envVar: 'REPLICATE_API_TOKEN',
    openAICompat: true,
    baseUrl: 'https://api.replicate.com/v1',
    capabilities: { reasoning: 0.70, speed: 0.72, cost: 0.55, privacy: 0.10, reliability: 0.80 },
    pricing: { inputPer1K: 0.00040, outputPer1K: 0.00160 },
    contextWindow: 8_192,
  },
};

/** Every catalog provider id (the full 17+ set). */
export const CATALOG_PROVIDER_IDS: string[] = Object.keys(PROVIDER_CATALOG);

/** Catalog providers that need no API key (reachability is probed instead). */
export const CATALOG_KEYLESS_IDS: string[] = CATALOG_PROVIDER_IDS.filter((id) => PROVIDER_CATALOG[id]?.keyless);

/** Providers served by the generic OpenAI-compatible adapter. */
export const CATALOG_OPENAI_COMPAT_IDS: string[] = CATALOG_PROVIDER_IDS.filter((id) => PROVIDER_CATALOG[id]?.openAICompat);

/** Providers served by a native (non-OpenAI-compatible) adapter. */
export const CATALOG_NATIVE_IDS: string[] = CATALOG_PROVIDER_IDS.filter((id) => PROVIDER_CATALOG[id]?.nativeAdapter);

/** Look up a catalog entry (undefined for unknown/plugin providers). */
export function getCatalogProvider(id: string): CatalogProviderEntry | undefined {
  return PROVIDER_CATALOG[id];
}

/** The standard env var for a provider's API key (undefined when keyless). */
export function catalogEnvVar(id: string): string | undefined {
  return PROVIDER_CATALOG[id]?.envVar;
}

/** True when the provider is catalog-known and keyless (no key required). */
export function isCatalogKeyless(id: string): boolean {
  return PROVIDER_CATALOG[id]?.keyless === true;
}

/** Capability profile for a provider (catalog baseline; undefined for unknown). */
export function catalogCapabilities(id: string): CatalogCapabilities | undefined {
  return PROVIDER_CATALOG[id]?.capabilities;
}

/** Pricing table entry for a provider (approximate USD per 1K tokens). */
export function catalogPricing(id: string): { inputPer1K: number; outputPer1K: number } | undefined {
  return PROVIDER_CATALOG[id]?.pricing;
}

/** Nominal input context window for a provider (tokens). */
export function catalogContextWindow(id: string): number | undefined {
  return PROVIDER_CATALOG[id]?.contextWindow;
}

/**
 * Env vars the ConfigManager should auto-map into config.providers.<id>.apiKey.
 * Excludes keyless providers (no key to map) — they are always considered
 * configured and reachability is probed.
 */
export const CATALOG_ENV_VARS: Record<string, string> = {};
for (const id of CATALOG_PROVIDER_IDS) {
  const envVar = catalogEnvVar(id);
  if (envVar) CATALOG_ENV_VARS[id] = envVar;
}
