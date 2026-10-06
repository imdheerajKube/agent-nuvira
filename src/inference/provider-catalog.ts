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
 * `nuvira config set pricing.<provider>.*`. Measured wire-token cost replaces the
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
  /**
   * One-paragraph "what is this and what does it do", shown in the dashboard's
   * provider editor next to the key fields. Optional — most providers are
   * self-explanatory; a gateway is not.
   */
  description?: string;
  /**
   * How to set the provider up (install/run/where the key comes from), shown
   * with the description. Plain text; the dashboard renders it as a hint block.
   */
  setup?: string;
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
  /**
   * Curated default model for this provider — used when no model is pinned
   * and the registry has no verified models yet (cold start). This ensures
   * the auto-router NEVER sends 'default' as a model name to an API.
   */
  defaultModel: string;
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
    defaultModel: 'llama3',
    label: 'Local (Ollama)',
    icon: '💻',
    description:
      'Ollama running on this machine — fully private and free, with no key. Used as a local fallback ' +
      'and for offline work; quality depends on the model you have pulled.',
    setup:
      'Install Ollama (ollama.com), run `ollama serve`, then pull a model: `ollama pull llama3`. ' +
      'Override the endpoint with providers.local.baseUrl if it is not on the default port.',
    keyless: true,
    capabilities: { reasoning: 0.30, speed: 0.55, cost: 1.00, privacy: 1.00, reliability: 0.60 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 8_192,
  },
  groq: {
    id: 'groq',
    defaultModel: 'llama-3.3-70b-versatile',
    label: 'Groq',
    icon: '⚡',
    description: 'Ultra-fast Llama/Mixtral inference on Groq LPU hardware — the speed leader, with a generous free tier.',
    setup: 'Create a key at console.groq.com/keys and paste it (or set GROQ_API_KEY).',
    envVar: 'GROQ_API_KEY',
    openAICompat: true,
    capabilities: { reasoning: 0.55, speed: 1.00, cost: 0.85, privacy: 0.15, reliability: 0.85 },
    pricing: { inputPer1K: 0.00059, outputPer1K: 0.00079 },
    contextWindow: 131_072,
  },
  nim: {
    id: 'nim',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    label: 'NVIDIA NIM',
    icon: '🎮',
    description: 'NVIDIA NIM microservices — hosted Llama, Nemotron and other open models on NVIDIA inference cloud.',
    setup: 'Create a key at build.nvidia.com, then paste it (or set NVIDIA_NIM_API_KEY).',
    envVar: 'NVIDIA_NIM_API_KEY',
    openAICompat: true,
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    capabilities: { reasoning: 0.72, speed: 0.70, cost: 0.55, privacy: 0.15, reliability: 0.82 },
    pricing: { inputPer1K: 0.00010, outputPer1K: 0.00050 },
    contextWindow: 128_000,
  },
  gemini: {
    id: 'gemini',
    defaultModel: 'gemini-2.0-flash',
    label: 'Google Gemini',
    icon: '🌀',
    description: 'Google Gemini — a very large context window (up to 1M tokens) with strong reasoning at low cost.',
    setup: 'Create a key at aistudio.google.com/apikey, then paste it (or set GEMINI_API_KEY).',
    envVar: 'GEMINI_API_KEY',
    capabilities: { reasoning: 0.85, speed: 0.80, cost: 0.40, privacy: 0.10, reliability: 0.88 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 1_048_576,
  },
  openrouter: {
    id: 'openrouter',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    label: 'OpenRouter',
    icon: '🌐',
    description: 'One API in front of hundreds of models from many labs, including free tiers and automatic failover.',
    setup: 'Create a key at openrouter.ai/keys, then paste it (or set OPENROUTER_API_KEY).',
    envVar: 'OPENROUTER_API_KEY',
    openAICompat: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    capabilities: { reasoning: 0.95, speed: 0.55, cost: 0.15, privacy: 0.10, reliability: 0.78 },
    pricing: { inputPer1K: 0.00250, outputPer1K: 0.01000 },
    contextWindow: 128_000,
  },
  nuvira: {
    id: 'nuvira',
    defaultModel: 'default',
    label: 'Nuvira Gateway',
    icon: '🧭',
    description: 'A local OpenAI-compatible gateway endpoint (default http://127.0.0.1:20128/v1). Keyless — the gateway holds the upstream credentials.',
    setup: 'Point providers.nuvira.baseUrl at your local gateway and make sure that process is running. For the managed OmniRoute gateway, use the `omniroute` entry below.',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://127.0.0.1:20128/v1',
    capabilities: { reasoning: 0.50, speed: 0.50, cost: 0.50, privacy: 0.50, reliability: 0.70 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 131_072,
  },
  /**
   * OmniRoute (https://github.com/diegosouzapw/OmniRoute) — an MIT, local-first
   * AI gateway that multiplexes hundreds of upstream providers behind ONE
   * OpenAI-compatible endpoint, with quota-aware failover and token
   * compression. It is not a routing BRAIN: our own multilayer router still
   * owns task-aware selection, while OmniRoute enlarges the provider supply a
   * single connection can draw on. `auto` is its zero-config model id (a
   * virtual combo scored live); it also exposes `auto/coding`, `auto/cheap`,
   * `auto/fast`. Overridable via `providers.omniroute.baseUrl` (OmniRoute's own
   * default port is 20128). Keyless: the gateway holds the upstream keys.
   */
  omniroute: {
    id: 'omniroute',
    defaultModel: 'auto',
    label: 'OmniRoute (AI gateway)',
    icon: '🔀',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://127.0.0.1:20128/v1',
    capabilities: { reasoning: 0.72, speed: 0.68, cost: 0.92, privacy: 0.50, reliability: 0.80 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 131_072,
    description:
      'A local AI gateway that multiplexes many upstream providers behind one OpenAI-compatible endpoint. ' +
      'Agent-nuvira still owns task-aware routing; OmniRoute is one candidate provider whose own combos ' +
      'fall over across the upstreams IT holds keys for. Use model `auto` for its balanced combo, or ' +
      '`auto/coding`, `auto/fast`, `auto/cheap`, `auto/offline`.',
    setup:
      'Install: `npm install -g omniroute` (or the Docker image). Start it: `omniroute` — it serves on ' +
      'http://127.0.0.1:20128 (dashboard + /v1 API). Connect upstream keys once so its combos have ' +
      'executable targets: `omniroute providers add deepseek --credential-stdin` (repeat for groq, gemini, …). ' +
      'Start and stop it from the Admin page (or `nuvira omniroute start|stop|status`). Switch it ON ' +
      'here to let the router include it, or leave it OFF and pin it explicitly with ' +
      '`nuvira execute "…" --provider omniroute --model auto`. No API key is needed on THIS side — the ' +
      'gateway holds the upstream keys.',
  },

  // ── Extended OpenAI-compatible providers (Issue 001: 17+ in routing) ────
  openai: {
    id: 'openai',
    defaultModel: 'gpt-4o-mini',
    label: 'OpenAI',
    icon: '🤖',
    description: 'OpenAI GPT models — the reference baseline for quality and reliability.',
    setup: 'Create a key at platform.openai.com/api-keys, then paste it (or set OPENAI_API_KEY).',
    envVar: 'OPENAI_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.openai.com/v1',
    capabilities: { reasoning: 0.92, speed: 0.78, cost: 0.35, privacy: 0.10, reliability: 0.90 },
    pricing: { inputPer1K: 0.00125, outputPer1K: 0.00500 },
    contextWindow: 128_000,
  },
  anthropic: {
    id: 'anthropic',
    defaultModel: 'claude-3-5-haiku-20241022',
    label: 'Anthropic',
    icon: '🔮',
    description: 'Anthropic Claude — strong reasoning and tool use with a long 200K-token context.',
    setup: 'Create a key at console.anthropic.com, then paste it (or set ANTHROPIC_API_KEY).',
    envVar: 'ANTHROPIC_API_KEY',
    nativeAdapter: 'anthropic',
    capabilities: { reasoning: 0.95, speed: 0.65, cost: 0.30, privacy: 0.10, reliability: 0.92 },
    pricing: { inputPer1K: 0.00300, outputPer1K: 0.01500 },
    contextWindow: 200_000,
  },
  mistral: {
    id: 'mistral',
    defaultModel: 'mistral-small-latest',
    label: 'Mistral AI',
    icon: '🌀',
    description: 'Mistral models — an efficient European family with a good speed/cost balance.',
    setup: 'Create a key at console.mistral.ai, then paste it (or set MISTRAL_API_KEY).',
    envVar: 'MISTRAL_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.mistral.ai/v1',
    capabilities: { reasoning: 0.72, speed: 0.82, cost: 0.60, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00090, outputPer1K: 0.00270 },
    contextWindow: 128_000,
  },
  cohere: {
    id: 'cohere',
    defaultModel: 'command-r',
    label: 'Cohere',
    icon: '🧠',
    description: 'Cohere Command models — chat and retrieval-friendly models at low cost.',
    setup: 'Create a key at dashboard.cohere.com, then paste it (or set COHERE_API_KEY).',
    envVar: 'COHERE_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.cohere.com/v1',
    capabilities: { reasoning: 0.65, speed: 0.75, cost: 0.70, privacy: 0.10, reliability: 0.82 },
    pricing: { inputPer1K: 0.00015, outputPer1K: 0.00060 },
    contextWindow: 128_000,
  },
  together: {
    id: 'together',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    label: 'Together AI',
    icon: '🟢',
    description: 'Together AI — a broad catalogue of hosted open-weight models (Llama, Mixtral, Qwen).',
    setup: 'Create a key at api.together.xyz, then paste it (or set TOGETHER_API_KEY).',
    envVar: 'TOGETHER_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.together.ai/v1',
    capabilities: { reasoning: 0.68, speed: 0.85, cost: 0.65, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00060 },
    contextWindow: 32_768,
  },
  deepinfra: {
    id: 'deepinfra',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    label: 'DeepInfra',
    icon: '🌐',
    description: 'DeepInfra serverless inference — among the cheapest per-token for many open-weight models.',
    setup: 'Create a token at deepinfra.com/dash/api_keys, then paste it (or set DEEPINFRA_TOKEN).',
    envVar: 'DEEPINFRA_TOKEN',
    openAICompat: true,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    capabilities: { reasoning: 0.65, speed: 0.88, cost: 0.75, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00010, outputPer1K: 0.00020 },
    contextWindow: 32_768,
  },
  fireworks: {
    id: 'fireworks',
    defaultModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    label: 'Fireworks AI',
    icon: '🎆',
    description: 'Fireworks AI — fast open-weight serving with function calling.',
    setup: 'Create a key at fireworks.ai/account/api-keys, then paste it (or set FIREWORKS_API_KEY).',
    envVar: 'FIREWORKS_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    capabilities: { reasoning: 0.70, speed: 0.90, cost: 0.70, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00060 },
    contextWindow: 32_768,
  },
  perplexity: {
    id: 'perplexity',
    defaultModel: 'llama-3.1-sonar-small-128k-online',
    label: 'Perplexity',
    icon: '❓',
    description: 'Perplexity Sonar models — search-grounded answers with live web citations.',
    setup: 'Create a key at perplexity.ai/settings/api, then paste it (or set PERPLEXITY_API_KEY).',
    envVar: 'PERPLEXITY_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.perplexity.ai',
    capabilities: { reasoning: 0.75, speed: 0.72, cost: 0.55, privacy: 0.10, reliability: 0.84 },
    pricing: { inputPer1K: 0.00020, outputPer1K: 0.00100 },
    contextWindow: 128_000,
  },
  azure: {
    id: 'azure',
    defaultModel: 'gpt-4o-mini',
    label: 'Azure OpenAI',
    icon: '🔵',
    description: 'Azure OpenAI — your own OpenAI deployments inside an Azure subscription (private networking, regional control).',
    setup: 'Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT. The Model field is the DEPLOYMENT name, not the model id. The api-version is appended automatically.',
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
    defaultModel: 'default',
    label: 'LM Studio',
    icon: '🎨',
    description: 'LM Studio local server — run models on your desktop through an OpenAI-compatible API. Keyless.',
    setup: 'In LM Studio, load a model and click Start Server (default http://localhost:1234/v1). No key required.',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://localhost:1234/v1',
    capabilities: { reasoning: 0.40, speed: 0.60, cost: 1.00, privacy: 1.00, reliability: 0.70 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 32_768,
  },
  anyscale: {
    id: 'anyscale',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    label: 'Anyscale',
    icon: '🔷',
    description: 'Anyscale Endpoints — hosted open-weight models with an OpenAI-compatible API.',
    setup: 'Create a key at anyscale.com, then paste it (or set ANYSCALE_API_KEY).',
    envVar: 'ANYSCALE_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.endpoints.anyscale.com/v1',
    capabilities: { reasoning: 0.72, speed: 0.80, cost: 0.60, privacy: 0.10, reliability: 0.85 },
    pricing: { inputPer1K: 0.00060, outputPer1K: 0.00200 },
    contextWindow: 65_536,
  },
  vllm: {
    id: 'vllm',
    defaultModel: 'default',
    label: 'vLLM / TGI',
    icon: '⚡',
    description: 'A self-hosted vLLM or TGI server — OpenAI-compatible, fully private, keyless.',
    setup: 'Start your vLLM/TGI server (default http://localhost:8000/v1) without an API key. No key required.',
    keyless: true,
    openAICompat: true,
    baseUrl: 'http://localhost:8000/v1',
    capabilities: { reasoning: 0.50, speed: 0.65, cost: 1.00, privacy: 0.85, reliability: 0.72 },
    pricing: { inputPer1K: 0, outputPer1K: 0 },
    contextWindow: 32_768,
  },
  deepseek: {
    id: 'deepseek',
    defaultModel: 'deepseek-chat',
    label: 'DeepSeek',
    icon: '🐳',
    description: 'DeepSeek V4 models — strong coding and reasoning at very low cost.',
    setup: 'Create a key at platform.deepseek.com, then paste it (or set DEEPSEEK_API_KEY).',
    envVar: 'DEEPSEEK_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.deepseek.com/v1',
    capabilities: { reasoning: 0.80, speed: 0.75, cost: 0.80, privacy: 0.10, reliability: 0.86 },
    pricing: { inputPer1K: 0.00027, outputPer1K: 0.00110 },
    contextWindow: 64_000,
  },
  xai: {
    id: 'xai',
    defaultModel: 'grok-2',
    label: 'xAI (Grok)',
    icon: '🕶️',
    description: 'xAI Grok models — large context and current-events reasoning.',
    setup: 'Create a key at console.x.ai, then paste it (or set XAI_API_KEY).',
    envVar: 'XAI_API_KEY',
    openAICompat: true,
    baseUrl: 'https://api.x.ai/v1',
    capabilities: { reasoning: 0.88, speed: 0.70, cost: 0.30, privacy: 0.10, reliability: 0.88 },
    pricing: { inputPer1K: 0.00300, outputPer1K: 0.01500 },
    contextWindow: 131_072,
  },
  replicate: {
    id: 'replicate',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    label: 'Replicate',
    icon: '🔁',
    description: 'Replicate — a hosted model API that proxies Llama and many other open models.',
    setup: 'Create a token at replicate.com/account/api-tokens, then paste it (or set REPLICATE_API_TOKEN).',
    envVar: 'REPLICATE_API_TOKEN',
    openAICompat: true,
    baseUrl: 'https://api.replicate.com/v1',
    capabilities: { reasoning: 0.70, speed: 0.72, cost: 0.55, privacy: 0.10, reliability: 0.80 },
    pricing: { inputPer1K: 0.00040, outputPer1K: 0.00160 },
    contextWindow: 8_192,
  },
  bedrock: {
    id: 'bedrock',
    defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v1:0',
    label: 'Amazon Bedrock',
    icon: '🟠',
    description: 'Amazon Bedrock — AWS-hosted Claude/Llama and other models via an OpenAI-compatible endpoint.',
    setup: 'Configure AWS credentials and set AWS_BEARER_TOKEN. Set BEDROCK_REGION to change the region (default us-east-1).',
    envVar: 'AWS_BEARER_TOKEN',
    openAICompat: true,
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    capabilities: { reasoning: 0.88, speed: 0.70, cost: 0.45, privacy: 0.40, reliability: 0.90 },
    pricing: { inputPer1K: 0.00080, outputPer1K: 0.00320 },
    contextWindow: 200_000,
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

/**
 * Get the curated default model for a provider. Used by resolveModel() to
 * ensure it NEVER returns 'default' — every provider always resolves to a
 * real, known-working model name.
 */
export function getDefaultModel(providerId: string): string {
  const entry = PROVIDER_CATALOG[providerId];
  return entry?.defaultModel || 'default';
}

/**
 * Look up a catalog entry (undefined for unknown/plugin providers).
 * For Bedrock, the baseUrl is resolved dynamically from BEDROCK_REGION
 * (defaults to us-east-1) so the runtime always targets the correct region.
 */
export function getCatalogProvider(id: string): CatalogProviderEntry | undefined {
  const entry = PROVIDER_CATALOG[id];
  if (id === 'bedrock' && entry) {
    const region = process.env.BEDROCK_REGION || 'us-east-1';
    return { ...entry, baseUrl: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1` };
  }
  return entry;
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
