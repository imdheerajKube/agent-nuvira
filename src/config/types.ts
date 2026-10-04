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
  /**
   * M2.3 multi-account rotation: ADDITIONAL API keys for the same provider
   * (the primary stays in `apiKey`). When the failover runner hits a
   * rate-limit/auth failure, it rotates to the next non-parked key of the
   * SAME provider before switching providers. Set directly in
   * .nuviraconfig.json (`providers.<type>.apiKeys: ["...", "..."]`); raw keys
   * are never stored in the quota ledger — only a stable fingerprint.
   */
  apiKeys?: string[];
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
 * Set via `nuvira config set pricing.<provider>.inputPer1K <usd>`.
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
 * Set via `nuvira config set memory.<key> <value>` or directly in .nuviraconfig.json.
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
  /**
   * Persist session transcripts across process death (default: true). On, a run
   * snapshots its conversation at each step boundary to
   * `~/.nuvira/memory/sessions/`, so a killed/crashed turn can be picked up by
   * the next one; a completed turn is closed and never resumed. Set false to
   * turn it off. Also `NUVIRA_SESSION_STORE=0` / `--no-session-store`.
   */
  sessionStore?: boolean;
  /**
   * Index finished asks for SEMANTIC recall and surface similar PAST asks
   * (default: true). Advisory history only — never a status. Set false to turn
   * it off. Also `NUVIRA_SESSION_RECALL=0` / `--no-session-recall`.
   */
  sessionRecall?: boolean;
}

/**
 * Per-provider quota limits for the central quota ledger.
 * Set via `nuvira config set routing.quota.<provider>.<field> <value>` or directly
 * in .nuviraconfig.json. The ledger parks a provider once it exhausts its current
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
 * Admin governance policy for Auto model routing (Nuvira-Router M2.4).
 * All fields optional + additive — an empty/unset policy is fully permissive,
 * so existing configurations behave exactly as before. Set via
 * `nuvira config set routing.governance.<key> ...` or directly in
 * .nuviraconfig.json.
 *
 * Enforcement happens inside the auto-router's existing hard-constraint slot
 * (violating providers are ELIMINATED, never just scored lower), and
 * `models explain` / the dashboard surface which providers policy blocked.
 */
export interface GovernanceConfig {
  /** Admin allow-list of provider ids (empty = all allowed). */
  allowProviders?: string[];
  /** Admin deny-list of provider ids (wins over allowProviders). */
  denyProviders?: string[];
  /**
   * Admin allow-list of model ids (empty = all allowed). A provider survives
   * only if at least one of its candidate models (configured pin OR curated
   * default) is on the list.
   */
  allowModels?: string[];
  /** Admin deny-list of model ids (wins over allowModels). */
  denyModels?: string[];
  /**
   * Admin hard max cost per call (USD). Providers whose typical/measured call
   * exceeds this are eliminated. Joins `routing.maxCostUsd` (the effective
   * cap is the stricter of the two).
   */
  maxCostUsd?: number;
  /**
   * PII / confidential-domain patterns (regex, case-insensitive). When a task
   * description matches ANY pattern, only providers whose privacy score is
   * >= `minPrivacyForPii` may serve it — e.g. `["password", "api[_-]?key",
   * "social[_-]?security", "credit[_-]?card"]` keeps secret-handling tasks
   * on local/first-party providers.
   */
  piiPatterns?: string[];
  /**
   * Minimum privacy score (0–1) required for a provider when a PII pattern
   * matches (default: 1.0 = local-only). 0.5+ admits mid-privacy providers;
   * 1.0 restricts to fully-local.
   */
  minPrivacyForPii?: number;
  /**
   * Whether `nuvira models unblock` may override REGISTRY-learned blocks
   * (default: true — the escape hatch works). Set false to make registry
   * blocks admin-hard: unblock refuses and the provider stays skipped.
   * Governance allow/deny lists are ALWAYS admin-hard regardless of this.
   */
  allowUnblock?: boolean;
}

/**
 * Learning-router configuration (Thompson-sampling bandit + hard constraints).
 * Set via `nuvira config set routing.<key> <value>` or directly in .nuviraconfig.json.
 */
export interface RoutingConfig {
  /**
   * Enable Thompson-sampling bandit learning for Auto model routing.
   * Providers are scored by deterministic heuristics × a Beta draw learned
   * from real task outcomes (recorded automatically by the orchestrator).
   * ISSUE-002: enabled by default — set false to opt out. Cold start is
   * deterministic (untouched Beta(1,1) priors sample the mean), so enabling
   * it never randomizes an unlearned ranking; it only starts shifting routing
   * once real outcomes accumulate.
   * Default: true.
   */
  bandit?: boolean;
  /**
   * Opt-in to the interactive rate-limit prompt (wait / switch / skip / abort).
   * Default: false — rate limits are handled FULLY AUTOMATICALLY: transient
   * hits (short reset hints) silently wait + retry, and exhausted providers
   * (long reset hints or repeated hits) silently auto-switch to another
   * healthy provider, so the build continues without interrupting the user.
   * Set true only if you want to be asked on every rate limit.
   */
  askOnRateLimit?: boolean;
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
   * Ask the user what to do when a task can only run on a WEAK model (model
   * escalation is a no-op — every stronger candidate is unavailable/blocked,
   * e.g. only a small local model is configured). Default: false (silent —
   * the pipeline continues on the weak model with lenient parsing, exactly
   * the non-interactive behavior). When true, the user chooses:
   *   continue — proceed on the weak model (its best effort may be
   *              recommendations rather than a reliable deliverable);
   *   wait     — stop and retry when a stronger model is back (shown only
   *              when a stronger candidate is in a short cooldown);
   *   abort    — stop the pipeline so the user can fix provider config.
   */
  promptOnWeakModel?: boolean;
  /**
   * Minimum diverged A/B decisions before the promotion gate (bandit-vs-
   * heuristic) evaluates as meaningful. Surfaced by `nuvira model bandit`.
   * Default: 20.
   */
  promotionMinDecisions?: number;
  /**
   * Enable the ML task-similarity router (ruflo neural-router analog). The
   * bandit learns per provider × complexity bucket; the ML layer learns per
   * TASK FEATURES — "tasks that LOOK like this one succeeded on provider X" —
   * via hashed-feature cosine similarity over real outcomes. Cold start is
   * neutral, min-samples guarded, strength-clamped. Default: false (opt-in).
   * Enable with `nuvira config set routing.mlRouter true`.
   */
  mlRouter?: boolean;
  /** k nearest neighbors for the ML router. Default: 8. */
  mlK?: number;
  /** Min neighbor samples before a provider's ML factor counts. Default: 5. */
  mlMinSamples?: number;
  /** ML blend strength: factor = 1 + strength × (winRate − 0.5). Default: 0.5. */
  mlStrength?: number;
  /**
   * Promotion-gate enforcement (ruflo promotion discipline). When true and the
   * gate has SUFFICIENT diverged A/B data and the bandit is NOT promoted, the
   * bandit is blocked from changing picks — the deterministic heuristic wins
   * until the bandit proves itself. Default: false (bandit always allowed).
   */
  promotionEnforce?: boolean;
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
   * Enable the M2.5 context preflight soft signal in Auto routing scoring: the
   * task's estimated prompt size (caller hint when the real payload is known,
   * else the task text) is scored against each provider's nominal input
   * context window, nudging candidates away from windows that would be
   * heavily utilized (a long conversation or heavy workspace routes toward
   * big-window providers). NEVER a hard block — estimation only, models may
   * exceed nominal windows (the penalty is capped at 35%). Default: true. Set
   * to false to revert to pure dimension-weight scoring (no context-fit field,
   * no preflight section in `models explain`).
   */
  contextFit?: boolean;
  /**
   * P4 M4.4: enable the mid-stream flakiness penalty in Auto routing scoring.
   * Providers whose streams repeatedly START then DIE before completion
   * (registry partialRate EMA) get their reliability dimension scaled down
   * (capped at 40%), nudging the router toward providers that actually finish.
   * Never a hard block — a flaky provider can heal via clean successes, and
   * the penalty only applies when the registry has recorded partials.
   * Default: true. Set to false to revert to pure dimension-weight scoring
   * (no penalty, no ⏸ chip in `models explain`).
   */
  partialFlakiness?: boolean;
  /**
   * Nominal input context window overrides (tokens) for the M2.5 context
   * preflight. Keyed by model id (exact match) or by provider id (provider-
   * level default for every model under that provider). Values replace the
   * built-in table. Example: `nuvira config set routing.contextWindows.local 16384`
   */
  contextWindows?: Record<string, number>;
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
  /**
   * Admin governance policy (Nuvira-Router M2.4): allow/deny provider + model
   * lists, admin max-cost cap, PII-domain privacy block, and control over the
   * `models unblock` escape hatch. Empty/unset = fully permissive (existing
   * behavior unchanged). See GovernanceConfig.
   */
  governance?: GovernanceConfig;
  /**
   * Nuvira sidecar mode (Nuvira-Router P5). The `nuvira` provider is ALWAYS
   * usable as a plain OpenAI-compatible provider (providers.nuvira.baseUrl,
   * default http://127.0.0.1:20128/v1); this flag only gates sidecar-SPECIFIC
   * integration helpers (the `nuvira doctor --nuvira` probe is run explicitly,
   * independent of this switch). Default: false (fully disabled — no new
   * runtime behavior when a gateway isn't in use). Set via
   * `nuvira config set routing.nuviraSidecar.enabled true` or directly in
   * .nuviraconfig.json.
   */
  nuviraSidecar?: {
    /** Master switch for sidecar-specific integration helpers. Default: false. */
    enabled?: boolean;
    /** Pinned gateway image/tag for docker-compose.nuvira.yml. Default: ghcr.io/berriai/litellm:main-stable. */
    image?: string;
  };
  /**
   * M4.4 conservative compression — LOSSLESS FOR CODE. When enabled, long
   * prose context (system prompts / tool-output narration) is elided
   * middle-out while fenced code blocks are preserved byte-identical, so
   * identifiers/strings/symbols always survive (property-tested).
   *
   * ⚠️ OFF BY DEFAULT. Enable only when you understand the tradeoff: the
   * elided prose middle is replaced by a marker, so a model that needed the
   * omitted narration may answer less completely. Code is NEVER compressed.
   */
  compression?: {
    /** Master switch. Default: false (pure pass-through). */
    enabled?: boolean;
    /** Fraction of ORIGINAL PROSE tokens to keep (head+tail). Default: 0.6. */
    keepRatio?: number;
    /** Min PROSE length (chars) before compression kicks in. Default: 800. */
    minProseChars?: number;
  };
  /**
   * M7.4 opt-in gateway telemetry / usage-health flags. OFF BY DEFAULT —
   * privacy-preserving by construction: enabling these NEVER captures prompt
   * content; it only reports aggregate usage/health numbers (request counts,
   * token totals, error rates) already tracked by the quota ledger and cost
   * tracker, and surfaces them via `nuvira doctor --enterprise`.
   *
   * Set via `nuvira config set routing.gatewayTelemetry.enabled true` or
   * directly in .nuviraconfig.json.
   */
  gatewayTelemetry?: {
    /**
     * Master switch for opt-in telemetry/usage health reporting. Default:
     * false (no gateway usage-health reporting — `doctor --enterprise` shows
     * an informative "off by default" note instead of metrics).
     */
    enabled?: boolean;
    /**
     * Include per-provider usage-health flag lines in the report (tokens
     * consumed, requests, parked state, reset countdown per provider).
     * Default: false. When false, the report only shows the aggregate
     * headline (total calls / tokens) — never per-provider detail.
     */
    healthFlags?: boolean;
  };
  /**
   * Engine mode (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 2 — mode
   * routing). 'auto' (default) lets the engine router pick loop-vs-pipeline
   * from the routed provider tier (strong models → the single agentic loop;
   * local/weak tier → the orchestrator pipeline). 'loop'/'pipeline' are
   * absolute overrides (CI pins 'pipeline'). Set via
   * `nuvira config set routing.engineMode loop` or directly in
   * .nuviraconfig.json. Default: 'auto'.
   */
  engineMode?: 'auto' | 'loop' | 'pipeline';
  /**
   * Routing preference mode (HybridRouterOptions.preferenceMode): 'balanced'
   * (default), 'performance-first', 'cost-first', or 'privacy-first'. Read by
   * the chat routing decision cache as part of the STABLE routing-input key —
   * changing the mode changes the key, so a cached decision can never be
   * served across a mode switch.
   */
  preferenceMode?: 'balanced' | 'performance-first' | 'cost-first' | 'privacy-first';
  /**
   * Capability mode — how much the agent spends on REASONING versus how much it
   * saves. 'balanced' (default): the best model for complex/critical work,
   * cheaper models for simple work, escalation on a detected stall. 'max': cost
   * is not a concern — every turn routes to the strongest available model, paid
   * models are always allowed, and cost ceilings are lifted. Set via
   * `nuvira config capability <balanced|max>` or `NUVIRA_CAPABILITY_MODE`. The
   * mode only ever widens MODEL QUALITY and AUTONOMY; every deterministic safety
   * invariant (deny-first commands, workspace boundary, git gates) is unchanged.
   * Resolution: env var, then this config value, then the default ('balanced').
   */
  capabilityMode?: 'balanced' | 'max';
  /**
   * When the loop's within-turn WORK DIGEST is injected on thread compaction.
   * 'all' (default) — always keep a digest of what the turn did; 'max' — only
   * under the `max` capability mode; 'off' — never. Set via
   * `NUVIRA_WORK_DIGEST` or this value. Resolution: env, then config, then
   * 'all'. See `src/config/work-digest.ts`.
   */
  workDigest?: 'all' | 'max' | 'off';
}

/**
 * Full configuration schema for .nuviraconfig.json
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
  /**
   * Toolsets config (capability-gating): per-toolset
   * enable/disable flags. Absent entry = enabled (default). The model's tool
   * schema is built from ENABLED toolsets only (src/tools/toolsets.ts).
   */
  tools?: ToolsConfig;
  /**
   * Skills config (skills-hub parity): per-skill disable flags + the
   * ordered multi-source registry list. The disabled list excludes skills from
   * runtime matching (I7 P0 bridge); registries[] wins over the legacy
   * BUFF_SKILLS_REGISTRY env override when present (I7 P1 multi-source).
   */
  skills?: SkillsConfig;
  /**
   * Modality backend selection (image generation, and future audio/video).
   * Absent = auto-select the first backend whose API key is configured.
   */
  modality?: ModalityConfig;
  /**
   * Dashboard runtime settings. Managed via the Admin page's Workspace field
   * or `nuvira config set dashboard.cwd <dir>`.
   */
  dashboard?: DashboardConfig;
  /**
   * Gateway per-platform inbound policies (who may trigger the agent). Managed
   * via `nuvira config gateway allow/disallow/reply` or the dashboard Permissions
   * page; merged over env in GatewayRegistry (env < config < explicit options).
   */
  gateway?: {
    policies?: Partial<Record<string, { allowedUsers?: string[]; allowedGroups?: string[]; requireMention?: boolean; disabled?: boolean; silentDrop?: boolean; outboundSenders?: string[]; requireApprovedTarget?: boolean }>>;
    /**
     * Channel targets (aliases or platform:channelId) that ALWAYS receive the
     * pipeline completion summary, regardless of who triggered it — e.g.
     * "whatsapp:Alex", "telegram:123", "slack:ops". Managed via
     * `nuvira config gateway notify add/remove` or the dashboard Permissions page.
     */
    statusRecipients?: string[];
    /**
     * Ask-and-WAIT for clarifying questions (`ask_user`) on messaging channels.
     * OFF BY DEFAULT — flagging this on changes live channel behaviour.
     *
     * When OFF (historical behaviour): the question and its choices are sent to
     * the channel and the FIRST choice is used immediately, without waiting.
     * On a surface where the user IS reachable that is misleading — they are
     * asked a question whose answer cannot affect the run, while their real
     * reply arrives afterwards as an unrelated new message.
     *
     * When ON: the turn HOLDS until that contact replies with a choice (number
     * or option text), so a typed answer actually steers the run. If no reply
     * arrives within `askUserTimeoutMs`, the default (first) choice applies and
     * the timeout is logged — a turn can never hang on a silent contact, and a
     * reply that does not match a choice is never swallowed: the waiter is
     * released with the default and the text is handled as a normal message.
     *
     * Set via `nuvira config gateway ask-user-wait on|off` or the dashboard
     * Permissions page.
     */
    askUserWait?: boolean;
    /** Reply window for `askUserWait`, in ms (default 120000; clamped 5s–10min). */
    askUserTimeoutMs?: number;
    /**
     * Inbound attachment handling (documents + voice notes).
     *
     * - `enabled` (default true): when false the gateway still ACCEPTS a
     *   message with an attachment, but never downloads or extracts it — the
     *   model just sees a note that an attachment was dropped by policy. Use
     *   this on a locked-down or metered deployment.
     * - `maxBytes` (default 20 MB): per-attachment cap; anything larger is not
     *   downloaded/extracted.
     */
    inboundAttachments?: { enabled?: boolean; maxBytes?: number };
  };
}

/**
 * Skills configuration — hub-skill runtime gating + multi-source registries.
 *
 * I7 (skills-hub / skills-sync-client parity): installed
 * SKILL.md skills become first-class runtime capabilities, and discovery
 * spans multiple registries. `disabled[]` mirrors the toolsets rule — a
 * disabled skill is excluded at the match gate, never silently injected.
 */
export interface SkillsConfig {
  /** Skill names excluded from runtime matching (absent = all enabled). */
  disabled?: string[];
  /**
   * Ordered registry sources. Each entry is either a URL base
   * (github-raw / browse-sh) or a local dir (auto-detected). Order = priority:
   * the first registry that has a skill wins on install; search merges all
   * with dedupe-by-name. When empty, the legacy BUFF_SKILLS_REGISTRY env
   * override (or the built-in default) is used.
   */
  registries?: string[];
}

/**
 * Modality configuration — backend selection for image generation (and, in
 * future, audio/video). `modality.image.provider` pins a specific backend
 * (gemini | openai | stability | comfyui | pollinations); when unset the first
 * backend whose API key is configured is used. `modality.image.model` overrides
 * the provider's default model, and `modality.image.baseUrl` overrides an
 * endpoint where a provider supports one. Set via
 * `nuvira config set modality.image.provider <id>` or directly in
 * .nuviraconfig.json.
 */
export interface ModalityConfig {
  image?: {
    /** Backend id: gemini | openai | stability | comfyui | pollinations. */
    provider?: string;
    /** Provider-specific model override. */
    model?: string;
    /** Optional endpoint override (e.g. a self-hosted gateway). */
    baseUrl?: string;
  };
}

/**
 * Dashboard runtime settings.
 *
 * The dashboard's chat turns run against a DIRECTORY. When the user has
 * attached a project the turn is scoped to it; when they have not, the turn
 * used to inherit the dashboard server process's own working directory — which
 * for a service started from the home folder meant "assess this project"
 * assessed whatever happened to be in `~`. `dashboard.cwd` makes that fallback
 * explicit and configurable instead of accidental: set it to a project root and
 * an unintended folder can never be scanned again.
 */
export interface DashboardConfig {
  /**
   * Directory dashboard chat turns run in when no project is attached.
   * Absolute path; must exist. Absent = the server process's own cwd (the
   * legacy behaviour, and the reason the ask-to-attach guard exists).
   */
  cwd?: string;
}

/**
 * Toolsets configuration — one enable flag per named tool group.
 *
 * I1 (toolsets + `toolset_validation.py` parity): tools are grouped
 * into named toolsets; disabling a toolset removes its tools from the model's
 * tool-calling schema AND rejects their execution at runtime (a dashboard
 * toggle is never cosmetic — the runtime gate is the single enforcement
 * point, same rule as the skills bridge).
 */
export interface ToolsConfig {
  /** Toolset name → state. Absent entry = enabled (default). */
  toolsets?: Record<string, { enabled?: boolean }>;
  /**
   * WS4 (#26) — tool lifecycle hooks an operator subscribes to: a command per
   * phase (`before` / `after` / `failed`) that receives the call as JSON on
   * stdin, and may VETO a call from a `before` hook. See
   * `src/tools/tool-hooks.ts` for the contract and the fail-open rule.
   */
  hooks?: ToolHookConfig[];
}

/**
 * One declared tool hook, as it is written in `buffconfig.json`.
 *
 * The environment (`NUVIRA_TOOL_HOOK_BEFORE` / `_AFTER` / `_FAILED`) declares the
 * same thing for a single run and WINS over the config for its phase, so a policy
 * can be checked in and an experiment needs no edit to it.
 */
export interface ToolHookConfig {
  /** Which moment of the call this hook sees. */
  phase: 'before' | 'after' | 'failed';
  /**
   * The command to run. It is executed by the platform shell, and the CALL is
   * written to its stdin as JSON — never interpolated into the command line, so
   * a tool argument can never change what runs.
   */
  command: string;
  /** Tool names this hook applies to. Absent or empty = every tool. */
  tools?: string[];
  /** Kill the hook after this many milliseconds (default 5000). */
  timeoutMs?: number;
  /** A name for this hook, used in the report when it vetoes or fails. */
  label?: string;
}

/**
 * How much EXTRA reasoning to ask a model for, in provider-neutral terms.
 *
 * This is INTENT, not a wire value. Each adapter translates it into whatever
 * its provider actually accepts (`reasoning_effort` for the OpenAI-compatible
 * family, an extended-thinking budget for Anthropic, a thinking budget for
 * Gemini). A provider that has no such knob simply ignores it — the value is
 * always optional and never required for a call to succeed.
 *
 * Defined here (the config layer) rather than in the inference layer so both
 * the capability policy and the adapters can name it without an import cycle.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * The family of wire parameter used to request extra reasoning. The shape is a
 * property of the PROVIDER (how it spells the knob), while whether a given
 * MODEL accepts it is a separate, learned fact (see ModelRegistryEntry.
 * reasoningCapability).
 */
export type ReasoningShape = 'openai-reasoning-effort' | 'anthropic-thinking' | 'gemini-thinking';

/**
 * What we have LEARNED about whether one provider × model accepts a
 * reasoning-effort parameter. Absent/`supported:false` means "do not send it"
 * (default-deny): the knob is only ever emitted against positive evidence.
 */
export interface ReasoningCapability {
  supported: boolean;
  /** The exact wire parameter name (e.g. `reasoning_effort`, `thinking`). */
  param: string;
  /** The wire family, so a caller knows how to build the value. */
  shape: ReasoningShape;
  /** Epoch ms the capability was last established. */
  verifiedAt: number;
  /**
   * How we learned it: the provider ADVERTISED it, a PROBE confirmed it, or a
   * rejected request taught us it is NOT supported (`learned-unsupported`).
   */
  source: 'advertised' | 'probed' | 'learned-unsupported';
}

/**
 * Inference options passed to each generation call
 * Note: provider is string to allow plugin-based providers
 */
export interface InferenceOptions {
  /**
   * Request additional reasoning depth from the model, in provider-neutral
   * terms. Set by the routing layer when the capability mode calls for it
   * (`max` → `high`); applied by an adapter ONLY when the registry has verified
   * that the provider × model accepts the corresponding parameter, and retried
   * WITHOUT the parameter if the provider rejects it. Absent → never sent, so
   * the default path is byte-identical to before. See
   * `src/inference/reasoning-effort.ts`.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * INTERNAL — probe mode. When true, the adapter emits its provider's
   * reasoning parameter UNCONDITIONALLY (bypassing the default-deny registry
   * gate) so a probe can establish whether the model accepts it. The registry
   * is updated from the outcome. Never set by routing; only the model probe
   * sets it. See src/inference/model-probe.ts.
   */
  reasoningProbe?: boolean;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  provider?: string;
  stream?: boolean;
  /**
   * M2.3 multi-account rotation: override the adapter's configured key for
   * this single call. Adapters prefer `options.apiKey` over `config.apiKey`,
   * which lets the failover runner retry the SAME provider with the next
   * account key instead of switching providers on a rate-limit/auth failure.
   */
  apiKey?: string;
  /**
   * P4 M4.1 continuation retry: a bounded "continue from here" note (built by
   * src/learning/continuation.ts) appended to the prompt when retrying after a
   * mid-stream failure — the provider continues instead of restarting.
   * Additive: absent → no behavior change. Off by default; the caller opts in.
   */
  continuation?: string;
  /**
   * P4 M4.2 reasoning replay: the previous turn's reasoning_content for this
   * conversation (from src/learning/reasoning-cache.ts), sent as a prior
   * assistant message so strict reasoning providers that 400 on missing prior
   * reasoning accept the retry. Additive: absent → no behavior change.
   */
  reasoningContext?: string;
  /**
   * P4 — external cancellation (the dashboard's Cancel button): when present,
   * the adapter aborts the in-flight request on abort. Absent → the adapter's
   * own timeout applies (unchanged behavior). Additive: never set by the CLI.
   */
  signal?: AbortSignal;
}
