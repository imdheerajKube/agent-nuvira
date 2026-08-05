/**
 * Supported built-in inference providers.
 */
export type BuiltInProviderType = 'nim' | 'gemini' | 'openrouter' | 'groq' | 'local' | 'nuvira';

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
  /**
   * Optional gateway headers merged into every request (Nuvira-Router P1):
   * e.g. enterprise gateway API keys or tenant headers. Keys are validated
   * against header-injection (no CR/LF/colon); values must be plain strings.
   */
  headers?: Record<string, unknown>;
  /** Request timeout in ms (default 30_000 for the nuvira adapter). */
  timeoutMs?: number;
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
 * Memory / vector-store configuration.
 * Set via `buff config set memory.<key> <value>` or directly in .buffconfig.json.
 */
export interface MemoryConfig {
  /**
   * Vector search backend:
   *   - `auto` (default) — FAISS-style backend (native @faiss-node/native when
   *     installed AND built, otherwise the pure-JS IVF-flat ANN) when usable,
   *     falling back to the exact JSON backend on any failure.
   *   - `faiss` — prefer the FAISS-style backend; still falls back to JSON on
   *     native failure (semantic search never breaks).
   *   - `json` — exact flat cosine scan (the original behavior).
   */
  vectorBackend?: 'auto' | 'faiss' | 'json';
}

/**
 * Per-provider quota limits for the central quota ledger.
 * Set via `buff config set routing.quota.<provider>.<field> <value>` or directly
 * in .buffconfig.json. The ledger parks a provider once it exhausts its current
 * reset window and AUTO RE-ENABLES it when the window rolls (calendar-aware).
 */
export interface QuotaLimit {
  /** Max tokens (input+output) per reset window */
  tokensPerWindow?: number;
  /** Max requests per reset window */
  requestsPerWindow?: number;
  /** Reset window length in ms (default: 24h = 86400000) */
  windowMs?: number;
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
  /**
   * Central quota limits per provider (free-tier token/request caps with reset
   * windows). When a provider exhausts its window it is parked (excluded from
   * Auto routing) and auto re-enabled when the window resets. The ledger
   * ALWAYS tracks usage; it only parks when limits are configured here.
   */
  quota?: Record<string, QuotaLimit>;
  /**
   * Free/local-first gate. When false, providers whose typical call is PAID
   * (non-zero cost) are excluded from Auto routing for non-complex tasks
   * (trivial/simple/moderate) — paid/high-capacity models are reserved for
   * complex/critical work or when every free/local option is exhausted or
   * parked. Default: true (paid providers always allowed).
   */
  allowPaid?: boolean;
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
   * Confirm before auto mode fails over mid-session. When true, a provider
   * that fails in Auto mode shows the next-ranked candidate and asks the user
   * to confirm the switch (or pick a provider manually) instead of switching
   * silently. Default: false (silent auto-failover — never get stuck).
   */
  promptOnFailover?: boolean;
  /**
   * Minimum diverged A/B decisions before the promotion gate (bandit-vs-
   * heuristic) evaluates as meaningful. Surfaced by `buff model bandit`.
   * Default: 20.
   */
  promotionMinDecisions?: number;
  /**
   * Enable the M2.1 capability-fit soft signal in Auto routing scoring: a
   * task type's required model-catalog tags (plan → reasoning, quick edit →
   * code, …) are matched against each provider's offered tags, nudging
   * equally-scored candidates toward the one whose strengths match the task.
   * Default: true. Set to false to revert to pure dimension-weight scoring
   * (the signal becomes fully inert — scores, reasons and the explain view
   * drop the capability-fit component).
   */
  capabilityFit?: boolean;
  /**
   * Keep the dashboard's quota file watcher armed permanently instead of only
   * while an SSE client is connected. When true, the server watches the memory
   * dir from startup (never disarming on client disconnect), so quota events
   * are always current the moment a dashboard connects — useful when the
   * dashboard is left running between viewing sessions. Default: false.
   */
  alwaysWatchQuota?: boolean;
  /**
   * Vector retrieval (token-efficient context). Large gathered contexts are
   * chunked, embedded locally (bge-small-en-v1.5 via @huggingface/transformers),
   * and reduced to the top-k semantically relevant chunks before the LLM call
   * — saving tokens so free quotas stretch further. Small contexts pass
   * through untouched (zero overhead). Failures fall back to full context.
   */
  retrieval?: {
    /** Master switch. Default: true (cheap for small contexts, big win for large). */
    enabled?: boolean;
    /** Top-k chunks to retrieve. Default: 5. */
    topK?: number;
    /** Chunk size in tokens. Default: 512. */
    chunkTokens?: number;
    /** Overlap between adjacent chunks (tokens). Default: 64. */
    overlapTokens?: number;
    /** Contexts above this token count are vectorized. Default: 12000. */
    thresholdTokens?: number;
    /** Embedding model override (default Xenova/bge-small-en-v1.5). */
    model?: string;
  };
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
  /** Memory / vector-store configuration */
  memory?: MemoryConfig;
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
