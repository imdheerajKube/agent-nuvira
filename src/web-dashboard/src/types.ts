// ─── Model Health Types ─────────────────────────────────────────────────────

export type ModelStatus = 'available' | 'limited' | 'unavailable';

export interface TestedModel {
  id: string;
  name: string;
  status: ModelStatus;
  statusReason: string;
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
  /** True when the model is quota-parked (excluded until the window resets). */
  parked?: boolean;
  /** Ms until the current quota window resets (0 = no window tracked). */
  resetsInMs?: number;
  /** The Model Availability Registry's own verdict for this provider × model. */
  registryStatus?: 'verified' | 'unverified' | 'unavailable';
  /**
   * The learned reason behind an `unavailable` verdict, verbatim.
   *
   * Rendered so the cell can say WHICH kind of unusable this is — a dead pair
   * (the id is not served) is a permanent fact, while an auth/entitlement
   * failure is repairable by the key's owner. Collapsing both into
   * "unavailable" is what made "requires purchase" look like a safe guess.
   */
  registryError?: string;
  /** A retired provider × model pair — the id does not exist on that endpoint. */
  registryDead?: boolean;
  /** What a call on this model is expected to cost (labelled, never filtered). */
  entitlement?: { tier: 'free' | 'metered' | 'unknown'; basis: string };
  /**
   * True only when the ROUTER would actually use this model right now.
   *
   * The sibling `status` above answers a different question — "did the provider
   * list it, given the provider's overall credit state" — and is identical for
   * every model of a provider. Without this, a model the router skips read
   * exactly like one it uses constantly.
   */
  routable?: boolean;
}

export interface ProviderHealth {
  provider: string;
  providerLabel: string;
  icon: string;
  apiConfigured: boolean;
  apiAccessible: boolean;
  canGenerate: boolean;
  overallStatus: ModelStatus;
  models: TestedModel[];
  notes: string;
  freeTierInfo?: string;
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
}

export interface ModelsHealthData {
  providers: ProviderHealth[];
  lastChecked: number;
  totalModels: number;
  available: number;
  limited: number;
  unavailable: number;
  /**
   * Of `totalModels` LISTED, how many the router can actually route to right now
   * (registry-verified, un-parked, not stale).
   *
   * The listing count and this number are different questions: a provider can
   * list 400 ids it will never serve us, and OpenRouter alone accounts for
   * hundreds of those. Reported separately so the page cannot present "listed"
   * as "available" and contradict the router on the same screen.
   */
  routable?: number;
  /** Registry-wide totals (all providers, including ones not probed above). */
  registryTotal?: number;
  registryVerified?: number;
}

// ─── Model Availability Registry Types ─────────────────────────────────────

/**
 * One entry in the Model Availability Registry — the UNIFIED enterprise read
 * store the Auto router consults on every pick (sub-ms, FAISS/JSON). Carries
 * availability + quota telemetry mirrored from the ledger (tokens remaining,
 * reset window) so the dashboard shows the exact snapshot routing uses.
 */
export interface RegistryModelEntry {
  model: string;
  status: 'verified' | 'unverified' | 'unavailable';
  latencyMs?: number;
  errorRate: number;
  /** True when the entry is quota-parked (excluded until the window resets). */
  parked: boolean;
  quotaParkedUntil: number;
  /** Tokens remaining in the current window (-1 = no limit configured). */
  remainingTokens: number;
  tokensConsumed: number;
  requests: number;
  /** Ms until the current quota window resets. */
  resetsInMs: number;
  lastVerifiedAt: number;
  lastError?: string;
  source?: string;
  /** M2.2: rolling measured token EMAs from provider-reported usage. */
  measuredInputTokens?: number;
  measuredOutputTokens?: number;
  measuredSamples?: number;
  /**
   * P4 M4.4: mid-stream flakiness EMA (0-1, only present when > 0) — the
   * model started streaming then died before finish. The router scales this
   * model's reliability down (capped 40%) so flaky providers rank below
   * otherwise-identical healthy ones. Optional: an older server won't send it.
   */
  partialRate?: number;
  /**
   * P4 M4.4: flakiness trajectory [{ t, rate }] — the partialRate EMA's recent
   * samples (newest last, capped). Renders the row's mini sparkline: a trend
   * toward 0 = healing via clean successes; climbing = flakiness accumulating.
   */
  partialHistory?: Array<{ t: number; rate: number }>;
  /**
   * v1.60.1/1.60.2: the model's provider-advertised input context window in
   * tokens, recorded LIVE by the model probe (Ollama /api/tags + /api/show,
   * OpenRouter /models, Gemini inputTokenLimit, NIM max_model_len). The
   * router's context preflight prefers this real spec over static estimates.
   * Optional: an older server won't send it.
   */
  contextWindowTokens?: number;
}

export interface RegistryProvider {
  provider: string;
  total: number;
  verified: number;
  unverified: number;
  unavailable: number;
  parked: number;
  /** P4 M4.4: models with a mid-stream flakiness EMA > 0 (router deprioritizes). */
  flaky?: number;
  models: RegistryModelEntry[];
}

export interface ModelRegistryInsights {
  enabled: boolean;
  total: number;
  verified: number;
  unverified: number;
  unavailable: number;
  parked: number;
  /** P4 M4.4: models with a mid-stream flakiness EMA > 0 (router deprioritizes). */
  flaky?: number;
  providers: RegistryProvider[];
  /**
   * Per-action "learned from real usage" telemetry — which provider × model
   * each action killed or verified. Optional: an older server won't send this,
   * so the panel hides the section when absent.
   */
  actionTelemetry?: ActionTelemetryInsights;
  /**
   * ISSUE-004: key-hygiene state — per-provider consecutive 401/403 counters
   * climbing toward the auto-clear threshold (dead keys are cleared from
   * config at 3). Optional: older servers don't send it.
   */
  keyHygiene?: { threshold: number; consecutive: Record<string, number> };
  /** ISSUE-004: verified local models demoted because they were deleted from the machine. */
  deletedLocal?: number;
  updatedAt: number;
}

/**
 * Per-action "learned from real usage" telemetry — the feed that keeps the
 * registry's health fresh. Shows exactly which action (chat / execute / plan /
 * edit / skill / learn / ci / doctor / spot-check) verified or killed each
 * provider × model, so the predictive skips routing makes are visible.
 */
export interface ActionTelemetryInsights {
  enabled: boolean;
  /** Events INCLUDED in this view — test-origin records are excluded. */
  total: number;
  /**
   * Events in the log that came from a TEST process and are excluded from every
   * number above.
   *
   * Surfaced, not silently dropped: the log is hash-chained, so the records are
   * still on disk, and a reader can see exactly how much of it is synthetic. A
   * test suite used to write real telemetry here (one fake model reached 2,110
   * of 3,436 lines); the leak is fixed at the source, and this is the second
   * layer — the view stays honest without rewriting a tamper-evident chain.
   */
  synthetic: number;
  updatedAt: number;
  /** Per-action aggregates (sorted by action name). */
  actions: Array<{
    action: string;
    /** Events where the action verified a provider × model. */
    verified: number;
    /** Events where the action marked a provider × model unavailable. */
    killed: number;
    /** Events where a transient failure decayed health (no flip). */
    transient: number;
    /**
     * Events where the action hit a MID-STREAM interruption (P4 M4.4 partial
     * learning) — the provider started streaming then died before completion.
     */
    partial: number;
    /** Provider × model combos this action verified (latest event each). */
    verifiedModels: Array<{ provider: string; model: string; at: number }>;
    /** Provider × model combos this action killed (latest event each). */
    killedModels: Array<{ provider: string; model: string; reason?: string; at: number }>;
    /**
     * Provider × model combos this action interrupted MID-STREAM (latest
     * event each) — P4 M4.4 partial learning: started streaming then died.
     */
    partialModels: Array<{ provider: string; model: string; reason?: string; at: number; streamedChunks?: number }>;
    /**
     * Daily buckets (last 14 days, ascending) — verified vs killed vs
     * transient vs partial per day, so the panel renders a mini time-series
     * chart per action: how the action's learning evolved over time. Each
     * bucket also carries the raw events that day so the chart can be
     * scrubbed day-by-day to show that day's exact chips.
     */
    timeline: Array<{
      day: number;
      verified: number;
      killed: number;
      transient: number;
      /** Mid-stream partial-interruption events that day (P4 M4.4). */
      partial: number;
      /** Raw events that day — the chips the scrubbable chart shows per day. */
      events: Array<{
        provider: string;
        model: string;
        outcome: 'verified' | 'unavailable' | 'error' | 'partial';
        errorType?: string;
        /** Epoch ms of the event. */
        at: number;
        /** P4 M4.4: chunks streamed before a partial died (surfaced in the chip tooltip). */
        streamedChunks?: number;
      }>;
    }>;
  }>;
}

// ─── Dashboard Data Types ───────────────────────────────────────────────────

export interface CostData {
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  /** M2.2: spend per provider from MEASURED (provider-reported) usage only. */
  byProviderMeasured: Record<string, number>;
  /** M2.2: calls + spend with exact wire tokens vs length-based estimates. */
  measuredCalls: number;
  estimatedCalls: number;
  measuredCost: number;
  estimatedCost: number;
  recent: Array<{
    provider: string;
    model: string;
    costUsd: number;
    totalTokens: number;
    timestamp: number;
    measured: boolean;
  }>;
}

export interface HistorySession {
  id: string;
  summary: string;
  provider: string;
  model: string;
  messageCount: number;
  tags: string[];
  startedAt: number;
}

/**
 * One row of the dashboard's skill environment-variable editor.
 *
 * Produced by `skills/skill-env-inventory.ts` — the union of what installed
 * skills declare they need and what is persisted in the credential `.env`.
 * `value` is always MASKED; a real secret never leaves the server.
 */
export interface SkillEnvVarRow {
  /** Variable name. */
  name: string;
  /** Masked value when set ('' when unset). */
  value: string;
  /** Whether a non-empty value is persisted or in the environment. */
  isSet: boolean;
  /** Installed skill that declares this var (absent for a hand-set secret). */
  requiredBy?: string;
  /** Skill description, used as the row's help text. */
  description?: string;
  /**
   * True for provider credentials. Shown 🔒 and not editable here: they are
   * refused by the write path, and skills never receive them.
   */
  isProviderCredential?: boolean;
}

export interface HistoryData {
  total: number;
  recent: HistorySession[];
}

export interface BenchmarkRun {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  summary: {
    totalTasks: number;
    tasksPassed: number;
    tasksFailed: number;
    avgQualityScore: number;
    medianLatencyMs: number;
    totalCostUsd: number;
    totalTokens: number;
  };
}

export interface BenchmarkData {
  totalRuns: number;
  latest: BenchmarkRun | null;
  runs: BenchmarkRun[];
}

// ─── Evaluation Framework Types ────────────────────────────────────────────

export interface EvalRun {
  id: string;
  provider: string;
  model: string;
  startedAt: number;
  summary: {
    totalTasks: number;
    tasksPassed: number;
    completionRate: number;
    testPassRate: number;
    avgTimeToFixMs: number;
    avgEditAccuracy: number;
    avgTokenEfficiency: number;
    totalRollbacks: number;
    dependencyInstallRate: number;
    recoveryRate: number;
    avgCompositeScore: number;
    totalCostUsd: number;
  };
}

export interface EvalData {
  totalRuns: number;
  latest: EvalRun | null;
  runs: EvalRun[];
}

export interface MemoryData {
  total: number;
  avgScore: number;
  byFingerprint: Record<string, number>;
  /** G2: project-scoped facts (B1) — { total, byProject }. */
  facts?: { total: number; byProject: Record<string, number> };
  /** G2: D1 recall-hit telemetry — { total, today, last7d }. */
  recall?: { total: number; today: number; last7d: number; byProject?: Record<string, number> };
  /** G2: active memory backend tier (F1 Mem0 is an optional provider; local = default). */
  backend?: string;
}

export interface AgentPerfStats {
  [agentType: string]: {
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    successRate: number;
    modelPerformance: Record<string, { runs: number; successes: number }>;
    lastRun: number;
  };
}

export interface HealthData {
  patterns: number;
  feedback: number;
  vectors: number;
  agentStats: {
    totalRuns: number;
    overallSuccessRate: number;
    agents: AgentPerfStats;
  } | null;
  memoryDir: string;
}

// ─── Auto Routing Insights Types ────────────────────────────────────────────

/**
 * P6 M6.1 RBAC snapshot — the acting identity, their role, and the full
 * user→role map from ~/.nuvira/rbac.json (mirrors `nuvira admin whoami` / `role
 * list`). `legacy: true` = no roles assigned → fully permissive single-user.
 */
export interface RbacInsights {
  legacy: boolean;
  identity: string;
  /** Acting user's role (null when unassigned / legacy). */
  role: 'admin' | 'operator' | 'viewer' | null;
  users: Array<{
    user: string;
    role: 'admin' | 'operator' | 'viewer';
    via?: 'local' | 'oidc';
  }>;
  updatedAt: number;
}

export interface RoutingInsights {
  providers: Array<{
    provider: string;
    runs: number;
    avgQuality: number;
    passRate: number;
    totalCostUsd: number;
    bestModel?: string;
  }>;
  bestModels: Array<{
    agentType: string;
    model: string;
    successRate: number;
    runs: number;
  }>;
  preference: Array<{
    complexity: string;
    winner: string;
    score: number;
    providers: Array<{
      provider: string;
      score: number;
      reason: string;
      /** v1.58.0 M2.1: task-type capability fit (0-100, undefined = gate OFF) */
      capabilityFit?: number;
      /** v1.58.0 M2.2: measured (real wire tokens) vs estimated cost basis */
      costSource?: 'measured' | 'estimated';
      /** v1.58.0 M2.2: the exact measured token basis when costSource = measured */
      costBasis?: { inputTokens: number; outputTokens: number };
      /** v1.58.0 M2.5: % of nominal input window used by the estimated prompt */
      contextUtilization?: number;
      /** v1.58.0 M2.5: provider's nominal input context window (tokens) */
      contextWindowTokens?: number;
    }>;
  }>;
  /** Which providers/models were actually picked over time */
  usage?: RoutingUsage;
  /** Recent routing decisions (audit trail) — most recent first */
  history?: RoutingHistoryEntry[];
  /** Learning-router bandit state (Thompson-sampling priors + history) */
  bandit?: BanditInsights;
  /** Promotion-gate verdict — is the bandit actually better than the heuristic? */
  promotion?: PromotionInsights;
  /**
   * ML task-similarity router state (v1.71.0, ruflo neural-router analog) —
   * learned per-provider win rates/factors from similar past tasks. Optional:
   * absent when the server predates the feature.
   */
  ml?: MlInsights;
  /** Central quota-ledger status (tokens/requests per provider × model) */
  quota?: QuotaInsights;
  /**
   * Vector-retrieval token savings (retrieval-stats.json) — how many tokens
   * the retrieval layer saved by vectorizing large contexts. Optional: an
   * older server won't send this, so the panel hides the card when absent.
   */
  retrieval?: RetrievalInsights;
  /**
   * Admin governance policy (P6 M6.5) — the allow/deny + cap rules the Auto
   * router enforces as hard constraints (mirrors `nuvira admin policy`).
   * Optional: an older server won't send it, so the panel hides the card.
   */
  governance?: GovernanceInsights;
  /**
   * P6 M6.1 RBAC identity + role assignments (mirrors `nuvira admin whoami` /
   * `nuvira admin role list`). Optional: an older server won't send it, so the
   * panel hides the card when absent.
   */
  rbac?: RbacInsights;
  updatedAt: number;
}

/**
 * Admin governance policy (P6 M6.5) — the exact `routing.governance` the
 * auto-router enforces as hard constraints on every pick (violating providers
 * are ELIMINATED, never just scored lower). Mirrors `nuvira admin policy`.
 */
export interface GovernanceInsights {
  /** True when any rule is active; false = fully permissive. */
  enabled: boolean;
  allowProviders?: string[];
  denyProviders?: string[];
  allowModels?: string[];
  denyModels?: string[];
  /** Admin hard max cost per call (USD) — joins routing.maxCostUsd (stricter wins). */
  maxCostUsd?: number;
  /** Min privacy score (0-1) required when a PII pattern matches (default 1.0). */
  minPrivacyForPii?: number;
  piiPatterns?: string[];
  /** Whether `nuvira models unblock` may override REGISTRY-learned blocks. */
  allowUnblock?: boolean;
  updatedAt: number;
}

/**
 * Vector-retrieval transparency — token-savings stats from the retrieval
 * engine (local bge-small-en-v1.5 embeddings + pure-JS vector store).
 * Complements the quota ledger: retrieval SAVES tokens, the ledger manages
 * quota limits. The card shows cumulative savings + the latest retrieval hits.
 */
export interface RetrievalInsights {
  enabled: boolean;
  /** Total context-assembly calls that went through the retrieval check. */
  totalCalls: number;
  /** Calls where retrieval was actually used (context was large enough). */
  totalRetrievals: number;
  /** Calls where retrieval failed and fell back to full context. */
  totalFailovers: number;
  /** Tokens before retrieval (cumulative). */
  totalOriginalTokens: number;
  /** Tokens after retrieval (cumulative). */
  totalReducedTokens: number;
  /** Cumulative tokens saved. */
  totalSavedTokens: number;
  /** Average reduction percentage (0-100). */
  avgPctReduced: number;
  /** The most recent retrieval call. */
  lastCall?: {
    used: boolean;
    originalTokens: number;
    reducedTokens: number;
    savedTokens: number;
    pctReduced: number;
    chunksRetrieved: number;
    failover: boolean;
    hits: Array<{ filePath: string; similarity: number }>;
  } | null;
  /** Recent retrieval calls (newest first). */
  recent?: Array<Record<string, unknown>>;
  /** Number of chunks in the repo vector index. */
  repoChunks: number;
  /** Embedding dimensionality. */
  dimensions: number;
  updatedAt: number;
}

/** Central quota-ledger status surfaced by the dashboard Quota card. */
export interface QuotaInsights {
  enabled: boolean;
  entries: Array<{
    provider: string;
    model: string;
    tokensConsumed: number;
    requests: number;
    windowLengthMs: number;
    resetsInMs: number;
    parked: boolean;
    cooldownRemaining: number;
  }>;
  /**
   * Tokens/requests served by FREE providers (local, gemini free tier — $0).
   * Optional: an older server won't send these, so the panel falls back to
   * totals-derived defaults for forward/backward bundle compatibility.
   */
  freeTokens?: number;
  freeRequests?: number;
  /** Tokens/requests served by PAID providers (actual spend triggered). */
  paidTokens?: number;
  paidRequests?: number;
  /** Estimated USD the free-tier tokens would have cost on a typical paid provider. */
  estimatedSavedUsd?: number;
  /**
   * Failover timeline — parked / re-enabled / released / failover events,
   * newest first (from quota-events.jsonl). Optional: an older server won't
   * send these, so the panel hides the timeline when absent.
   */
  events?: Array<{
    type: 'parked' | 're-enabled' | 'released' | 'failover';
    provider: string;
    reason?: string;
    timestamp: number;
  }>;
  /**
   * M2.3/M2.4: multi-account key rotation — currently-parked ACCOUNTS per
   * provider (fingerprint only — raw keys are never persisted). Lets the
   * dashboard show WHICH account of a provider is skipped by rotation and
   * why, so multi-account state is visible. Optional: an older server won't
   * send these, so the panel hides the list when absent.
   */
  parkedAccounts?: Array<{
    provider: string;
    /** Stable fingerprint (FNV-1a) — never the raw key. */
    accountId: string;
    reason?: string;
    /** Ms until this account is re-admitted. */
    parkedUntil: number;
    /** Remaining ms of the park. */
    remainingMs: number;
  }>;
  updatedAt: number;
}

/**
 * Promotion-gate A/B verdict (ruflo ADR-150 mirror) — evaluated over the
 * router-promotion.jsonl trajectory: quality must improve >2% while cost and
 * latency don't regress, on a sufficient sample of DIVERGED decisions.
 */
export interface PromotionInsights {
  /** Total finalized A/B decisions in the trajectory. */
  decisionCount: number;
  /** Decisions where the bandit pick diverged from the heuristic pick. */
  divergedCount: number;
  /** Minimum diverged decisions required before the gate is meaningful. */
  minDecisions: number;
  /** Relative quality delta: (bandit − heuristic) / heuristic. */
  qualityDelta: number;
  /** Relative cost delta: (bandit − heuristic) / heuristic. */
  costDelta: number;
  /** Relative p95 latency delta: (bandit − heuristic) / heuristic. */
  latencyDelta: number;
  /** True when at least one decision had a measured latency. */
  latencyMeasured: boolean;
  /** Per-criterion pass/fail. */
  criteria: { quality: boolean; cost: boolean; latency: boolean };
  /** True when divergedCount >= minDecisions (enough data to judge). */
  sufficient: boolean;
  /** True when ALL criteria pass (bandit is a genuine improvement). */
  promoted: boolean;
}

export interface BanditPrior {
  alpha: number;
  beta: number;
  expectedWinRate: number;
}

export interface BanditInsights {
  enabled: boolean;
  version: number;
  /** provider → complexity bucket → { alpha, beta, expectedWinRate } */
  priors: Record<string, Record<string, BanditPrior>>;
  learningHistory: Array<{
    provider: string;
    complexity: string;
    outcome: string;
    reward: number;
    timestamp: string;
  }>;
  updatedAt: number;
}

export interface MlProviderInsight {
  provider: string;
  /** Number of similar-task records for this provider. */
  samples: number;
  /** Empirical win rate among those records (0–1); escalated counts half. */
  winRate: number;
  /** Learned multiplier: 1 + strength × (winRate − 0.5); 1.0 = neutral. */
  factor: number;
  /** True when samples >= minSamples — the factor is trustworthy. */
  trusted: boolean;
  model?: string;
}

export interface MlInsights {
  enabled: boolean;
  /** Total learned records in ml-router.jsonl. */
  recordCount: number;
  /** Per-provider learned state, most-sampled first. */
  providers: MlProviderInsight[];
  updatedAt: number;
}

export interface RoutingUsage {
  total: number;
  last24h: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  bySource: Record<string, number>;
  byComplexity: Record<string, number>;
  updatedAt: number;
}

export interface RoutingHistoryEntry {
  id: string;
  timestamp: number;
  source: string;
  agentType: string;
  task: string;
  complexity: string;
  provider: string;
  model: string;
  score: number;
}

// ─── Requests Panel Types (P3-M3.2) ────────────────────────────────────────

/**
 * Per provider × model × action aggregate from the action-telemetry JSONL —
 * the same file the Models panel reads, so both panels always agree. Latency
 * percentiles appear only once >= 3 latency samples exist (the "p95 with <10
 * samples shows —" contract); cost only when the caller recorded it.
 */
export interface RequestsInsights {
  enabled: boolean;
  /** Total action-telemetry events in the log. */
  total: number;
  rows: Array<{
    provider: string;
    model: string;
    action: string;
    /** Total requests for this provider × model × action. */
    requests: number;
    /**
     * P4 M4.4: mid-stream partial-interruption events in this group — the
     * provider started streaming then died before finishing. NOT counted as
     * request failures; surfaced so the panel can flag flaky providers.
     * Optional: an older server won't send it, so the panel defaults to 0.
     */
    partials?: number;
    /** Failures ÷ requests (0–1). */
    errorRate: number;
    /** Latency summary — present only when latency samples were recorded. */
    latency?: {
      avg: number;
      samples: number;
      p50?: number;
      p95?: number;
      p99?: number;
    };
    /** Sum of recorded call costs (USD) — present only when callers logged it. */
    costUsd?: number;
    costCalls: number;
    /** Recent correlation ids for traceability (max 5). */
    callIds: string[];
    /** Epoch ms of the most recent event in this group. */
    lastAt: number;
  }>;
  updatedAt: number;
}

// ─── Findings (WS1 #23) ─────────────────────────────────────────────────────

/** The only two amounts a finding is worth — see `src/findings/verdicts.ts`. */
export type FindingVerdict = 'CONFIRMED' | 'PLAUSIBLE';

/**
 * One check that was actually performed. `ref` IS the evidence — the line, the
 * command, the path — never a summary of it, and a blank one is not a check.
 */
export interface FindingEvidence {
  kind: 'quote' | 'command' | 'file' | 'observation';
  ref: string;
  detail?: string;
}

/**
 * One finding a turn recorded, in the shared wire form every surface reports.
 *
 * MIRRORED, not imported, from `src/findings/verdicts.ts`'s `WireFinding` —
 * exactly like `TraceStep`/`TraceOutcome` below, and for the same reason: the
 * dashboard bundle is built from `src/web-dashboard/src` alone (see
 * `vite.config.ts`), so a frontend type cannot depend on a server module
 * without pulling it into the bundle. The shape is asserted on the wire by the
 * server side of the trace/chat payloads, so drift is a type error there.
 *
 * `verdict` is computed by the GATE (`confirmFinding`), never by this UI: the
 * GUI only ever renders what the gate decided.
 */
export interface TraceFinding {
  claim: string;
  verdict: FindingVerdict;
  outcome: string;
  evidence: FindingEvidence[];
  source: string;
}

/**
 * WS5 (#27) — the isolation a chat turn had, as the dashboard reads it.
 *
 * Mirrors `IsolationOutcome` in `src/tools/worktree.ts`. NOTE the diff's two
 * halves, because they are NOT the same list and reading the wrong one renders an
 * empty card: `files` is the changed PATHS (a plain string per file, what a reader
 * scans) and `payload` is the unified-diff BODY the existing diff card renders.
 *
 * `payload` is deliberately the same `{files, summary}` shape the `git:diff` event
 * carries, so an isolated turn's changes render with the card that is already
 * there rather than a second renderer that could drift from it.
 */
export interface WorktreeOutcome {
  /** The worktree the turn ran in (reported even after it is removed). */
  dir: string;
  /** The commit the diff is measured against. */
  base: string;
  diff: {
    /** Changed paths, one entry per file. */
    files: string[];
    summary: string;
    /** True when the run changed nothing — a fact, not a failure. */
    unchanged: boolean;
    /** The unified diff, in the shared diff-card shape. */
    payload: { files: Array<{ path: string; body: string }>; summary: string };
  };
  /** False when the directory was KEPT (`keepWorktree`). */
  removed: boolean;
}

/** WS5 (#27) — what a resumed turn replayed instead of paying for. */
export interface ResumeOutcome {
  id: string;
  replayed: number;
  modelCalls: number;
  /** False when the record could not be written (the turn still happened). */
  saved: boolean;
  /** The operator-facing line the surface composed (see `closeResume`). */
  notice: string;
}

// ─── Reasoning Trace Types (P0) ────────────────────────────────────────────

/** One LLM call recorded in a reasoning trace. */
export interface TraceStep {
  seq: number;
  timestamp: number;
  agentType: string;
  taskId?: string;
  description?: string;
  provider: string;
  model: string;
  promptDigest: string;
  promptPreview: string;
  responsePreview: string;
  responseLength: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  error?: string;
  routing?: {
    provider: string;
    model: string;
    score: number;
    complexity: string;
    explanation: string;
  };
  /** True when this step is a REPAIR re-prompt escalated to a stronger model
   *  (v1.60.4 per-task/planner escalation). */
  escalated?: boolean;
  /**
   * Per-layer prompt digests + sizes (session 3). The stable-layer digest
   * staying constant across steps is what proves the system prompt is
   * prompt-cacheable — the flat `promptDigest` cannot show that.
   */
  layers?: {
    systemDigest: string;
    contextDigest: string;
    volatileDigest: string;
    systemChars: number;
    contextChars: number;
    volatileChars: number;
  };
}

/** A reasoning trace (list view omits steps/previews). */
export interface TraceEntry {
  id: string;
  goal: string;
  source: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /**
   * The FULL stable layer (system prompt), captured once per trace
   * (session 3). Present in the detail view only — the list endpoint strips it.
   */
  systemPrompt?: string;
  /** True length of the stable layer before the storage cap. */
  systemPromptChars?: number;
  provider?: string;
  model?: string;
  success?: boolean;
  /**
   * What actually happened — `answered` (text reply only) vs `acted` (a tool
   * ran), plus `delivered`/`unverifiedClaim`/`unfulfilledPromise` and the edit
   * analogues `unverifiedEdit`/`unverifiedEditClaim`. This is how the Trace tab
   * distinguishes a real send from a hallucinated "I sent it", an
   * announced-but-never-performed action from work in progress, and a code
   * change that was never verified from one that was.
   */
  outcome?: {
    kind: 'answered' | 'acted' | 'failed' | 'cancelled';
    tools?: string[];
    delivered?: boolean;
    unverifiedClaim?: boolean;
    unfulfilledPromise?: boolean;
    /** Files changed but nothing verified the result (tests/typecheck/browser). */
    unverifiedEdit?: boolean;
    /** The answer asserted a code change that no verification backed. */
    unverifiedEditClaim?: boolean;
  };
  /**
   * WS1 — the findings this run recorded, in call order, with the verdicts the
   * GATE computed and the evidence behind them. Present on both the list and
   * the detail payload (they are small, and a count on the row is how a reader
   * sees that an audit is available at all). Absent means the run recorded
   * none — never "this surface cannot say".
   */
  findings?: TraceFinding[];
  /** Present in the detail endpoint only. */
  steps?: TraceStep[];
  /** List-view aggregates. */
  stepCount?: number;
  failedSteps?: number;
  totalTokens?: number;
}

export interface TracesData {
  total: number;
  traces: TraceEntry[];
}

// ─── Admin Command-Runner Types (E3c follow-up — dashboard executes the
// state commands so the user never types them; keys ALWAYS masked) ──────────

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface AdminCheck {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
  fix?: string;
}

export interface AdminProviderSummary {
  type: string;
  configured: boolean;
  keySource: 'env' | 'config' | 'vault' | 'none' | 'local';
  keyMasked: string | null;
  model?: string;
  baseUrl?: string;
}

export interface AdminChecksData {
  system: AdminCheck[];
  enterprise: AdminCheck[];
  providers: AdminProviderSummary[];
  serverTime: number;
}

// ─── Admin write surface (Session 18 — user-id + password control layer) ───

/** Whether the admin write surface is configured and this session is authed. */
export interface AdminAuthStatus {
  configured: boolean;
  authenticated: boolean;
  user?: string | null;
  /** The acting RBAC role ('admin' | 'operator' | 'viewer') — gates the write surface. */
  role?: string | null;
  /**
   * The signed-in account is still on the published first-run default
   * (admin/admin) and must change it before any mutating route will work — the
   * server refuses those with 403 `password_change_required`.
   */
  mustChangePassword?: boolean;
}

/** One dashboard admin user (never carries salt/hash). */
export interface AdminUser {
  user: string;
  role: 'admin' | 'operator' | 'viewer';
  createdAt: number;
}

/** User-management response (role.manage = admin). */
export interface AdminUsersResult {
  ok: boolean;
  users?: AdminUser[];
  error?: string;
  /** True when a DELETE actually removed a user. */
  removed?: boolean;
  /** 403 — authenticated but the role may not manage users. */
  forbidden?: boolean;
  unauthorized?: boolean;
}

/** Login/setup response: ok + the Bearer token to persist, or a server error. */
export interface AdminLoginResult {
  ok: boolean;
  user?: string;
  /** The acting RBAC role — gates what this session may write. */
  role?: string;
  token?: string;
  error?: string;
  /** 401 — session missing/expired; the UI must show the login form again. */
  unauthorized?: boolean;
}

/** Provider save/remove response: the refreshed (masked) row on success. */
export interface AdminWriteResult {
  ok: boolean;
  error?: string;
  cleared?: boolean;
  /** True when the key lives in the environment and cannot be removed from config. */
  envSourced?: boolean;
  /** The env var the key comes from (only meaningful when envSourced). */
  envVar?: string;
  provider?: AdminProviderSummary;
  /** 403 — the session is valid but this role may not perform the action. */
  forbidden?: boolean;
  unauthorized?: boolean;
  /** Validation errors for contacts that were rejected (e.g. phone number for Telegram). */
  contactErrors?: string[];
}

/** Provider test-connection response (model list on success). */
export interface AdminTestResult {
  ok: boolean;
  models?: string[];
  error?: string;
  unauthorized?: boolean;
}

/** One entry of the provider catalog (drives the Add-provider selector). */
export interface AdminCatalogProvider {
  id: string;
  label: string;
  icon?: string;
  envVar?: string | null;
  keyless?: boolean;
}

export interface AdminCatalog {
  providers: AdminCatalogProvider[];
}

/** Session 36 — user-declared daily budget (routing.quota + cost cap). */
export interface AdminQuotaLimit {
  tokensPerWindow?: number;
  requestsPerWindow?: number;
  windowMs?: number;
}

/** GET /api/admin/quota — the current budget config + editable provider set. */
export interface AdminQuotaConfig {
  ok: boolean;
  quota: Record<string, AdminQuotaLimit>;
  costUsd: number | null;
  providers: string[];
  error?: string;
}

/** PUT /api/admin/quota body — null clears a field; clearProvider removes a row. */
export interface AdminQuotaPayload {
  quota?: Record<string, AdminQuotaLimit | null>;
  costUsd?: number | null;
  clearProvider?: string;
}

export interface DashboardData {
  cost: CostData;
  history: HistoryData;
  benchmarks: BenchmarkData;
  evals?: EvalData;
  memory: MemoryData;
  health: HealthData;
  routing?: RoutingInsights;
  /** Model Availability Registry — the unified sub-ms read store routing uses. */
  modelRegistry?: ModelRegistryInsights;
  /**
   * Requests panel aggregate (P3-M3.2) — per provider × model × action
   * requests, latency percentiles, error rate, measured cost. Optional: an
   * older server won't send these, so the panel hides when absent.
   */
  requests?: RequestsInsights;
  dag?: DAGData;
  /**
   * Persisted pipeline runs (from pipeline-runs.json) — powers the scrubbable
   * Run Timeline. Optional: an older server won't send these, so the panel
   * falls back to live-DAG-only runs.
   */
  pipelineRuns?: { total: number; runs: PipelineRun[] };
  /**
   * P0 reasoning traces — every LLM call in past pipelines (agent × model ×
   * prompt digest × response × tokens × latency × routing snapshot). Optional:
   * an older server won't send these, so the panel hides when absent.
   */
  traces?: TracesData;
  /**
   * Unattended runs and their per-batch economy (G27) — the dashboard half of
   * `nuvira execute`'s per-batch cost/latency table. Optional: an older server
   * won't send these, so the Run Timeline renders without it.
   */
  unattendedJobs?: { total: number; jobs: UnattendedJobView[] };
  /**
   * Gateway conversations, merged in from the conversation SSE event so the
   * Conversations tab updates live. Optional: the field exists only once such an
   * event has arrived, and an older server never sends one.
   */
  conversations?: { total: number; recent: HubConversationSummary[] };
  serverTime: number;
}

// ─── Unattended Run Batch Economy (G27) ─────────────────────────────────────

/** One batch's measured economy and duration within an unattended run. */
export interface UnattendedBatchView {
  index: number;
  progress: number;
  progressLine?: string;
  /** Measured spend for this batch's window (USD). Undefined = not metered. */
  costUsd?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
}

/** An unattended run (long-form book, phased build) and its batch rows. */
export interface UnattendedJobView {
  id: string;
  kind: 'long-form' | 'phased';
  status: string;
  goal: string;
  progress: number;
  progressLine?: string;
  batches: number;
  costUsd?: number;
  tokens?: number;
  stopReason?: string;
  updatedAt: number;
  batchStats: UnattendedBatchView[];
}

// ─── Pipeline Run Timeline Types ────────────────────────────────────────────

/** One phase (agent step) within a pipeline run timeline. */
export interface PipelinePhase {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
  complexity?: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
  /** Computed duration (ms) when both timestamps are known. */
  durationMs?: number;
}

/** One persisted pipeline execution — the unit the Run Timeline scrubs. */
export interface PipelineRun {
  id: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  totalDurationMs: number;
  phases: PipelinePhase[];
  /**
   * Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — which engine
   * executed ('pipeline' | 'loop'). Loop turns persist their per-turn tool
   * telemetry in turnTelemetry; run chips and the meta row badge it.
   */
  engine?: 'pipeline' | 'loop';
  /** Loop-engine turns: per-turn tool-call telemetry. */
  turnTelemetry?: {
    toolCallCount: number;
    erroredToolCount: number;
    bounded?: boolean;
    generationFailed?: boolean;
    provider?: string;
    model?: string;
  };
}

// ─── Agent Execution Types ──────────────────────────────────────────────────

export interface AgentNode {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  /** Per-subtask complexity label (trivial/simple/moderate/complex/critical). */
  complexity?: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface AgentEdge {
  from: string;
  to: string;
}

export interface DAGData {
  pipeline: string | null;
  nodes: AgentNode[];
  edges: AgentEdge[];
  timestamp: number;
  active: boolean;
  /**
   * Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — which engine
   * executed the current/latest run ('loop' | 'pipeline'). The DAG view
   * badges it next to the LIVE dot.
   */
  engine?: 'loop' | 'pipeline';
  /** The engine router's explanation (audit trail, shown in the badge tooltip). */
  engineExplanation?: string;
  /** Loop-engine turns: per-turn tool-call telemetry (the turn card). */
  loopTurn?: {
    turnId: string;
    title: string;
    startedAt: number;
    endedAt?: number;
    active: boolean;
    toolCallCount: number;
    erroredToolCount: number;
    bounded?: boolean;
    generationFailed?: boolean;
    cancelled?: boolean;
    provider?: string;
    model?: string;
    toolCalls: Array<{ tool: string; ok?: boolean; durationMs?: number; error?: string }>;
  };
}

// ─── Agent Hub Types (I4 — Skills / Tools / Channels / Artifacts) ───────────

/** One toolset (I1 capability group) with its enabled state. */
export interface HubToolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  tools: string[];
  toolCount: number;
}

export interface HubChannelAlias {
  alias: string;
  platform: string;
  channelId: string;
  addedAt?: number;
}

/** One platform transport's config status (I6 — Email/Signal included). */
export interface HubPlatformStatus {
  platform: string;
  label: string;
  configured: boolean;
  envVars: string[];
}

/** One env var of a platform transport (config surface — prompt/secret metadata). */
export interface HubPlatformEnvVar {
  varName: string;
  set: boolean;
  value: string;
  /** Field label; additive transport modes end with "(optional)". */
  prompt: string;
  secret: boolean;
}

/** A platform transport as exposed by GET /api/config/platforms. */
export interface PlatformConfigEntry {
  platform: string;
  label: string;
  configured: boolean;
  envVars: HubPlatformEnvVar[];
  /** Link to the platform's setup documentation (BotFather, developer console, etc.). */
  setupUrl?: string;
  /** One-line setup hint (e.g. 'Create a bot via @BotFather, then paste the token here.'). */
  setupHint?: string;
}

/** Per-platform inbound policy (who may trigger the agent) — Permissions page. */
export interface HubChannelPolicy {
  allowedUsers?: string[];
  allowedGroups?: string[];
  requireMention?: boolean;
  disabled?: boolean;
  silentDrop?: boolean;
  /**
   * Who may command the agent to send to a THIRD PARTY via gateway_send.
   * Distinct from allowedUsers (who may trigger). ABSENT = inherit
   * allowedUsers (open to anyone who can trigger); [] = nobody; "Allow-All" =
   * anyone.
   */
  outboundSenders?: string[];
  /** Require gateway_send targets to be APPROVED contacts. */
  requireApprovedTarget?: boolean;
}

/**
 * A saved verified contact (name + contact no) — the Permissions page
 * validated list. `id` is the same sender id stored in
 * `policies.<platform>.allowedUsers`; `name` is the optional display label
 * (CLI parity: `nuvira whatsapp contact add <Name> <number>`).
 */
export interface HubContact {
  name: string;
  platform: string;
  id: string;
  phone?: string;
  status?: 'approved' | 'pending' | 'rejected';
  registeredAt?: number;
  addedAt?: number;
}

/** One entry in the gateway delivery ledger (I2). */
export interface HubInboxEntry {
  id: string;
  platform: string;
  channelId: string;
  text: string;
  from?: string;
  senderId?: string;
  isGroup: boolean;
  /**
   * `clarified` = the message answered a question the agent was WAITING on.
   * `attachment_failed` = a document arrived but could not be extracted; the
   * sender was answered with the reason instead of routing it to a model.
   */
  handled: 'pipeline' | 'chat' | 'help' | 'refused' | 'error' | 'duplicate' | 'clarified' | 'attachment_failed';
  reply?: string;
  at: number;
  /** Present on a `duplicate` entry — the id/fingerprint it collided with. */
  dedupKey?: string;
  /** For a `duplicate`: how many times this identity has now been seen. */
  dedupCount?: number;
}

export interface HubDeliveryEntry {
  id: string;
  target: string;
  platform: string;
  channelId: string;
  text: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
}

export interface HubArtifactSummary {
  sessionId: string;
  count: number;
  latestAt: number;
  recent: Array<{ kind: string; title?: string; preview?: string }>;
}

export interface HubSkill {
  id: string;
  name: string;
  description: string;
  version?: string;
  origin: 'compiled' | 'hub';
  usageCount?: number;
  /** P3 — derived from buffconfig `skills.disabled[]` (false when disabled). */
  enabled: boolean;
  /** P6e — provenance: true for first-party bundled skills (🧠 badge). */
  bundled?: boolean;
}

/**
 * One subagent child-process run as the dashboard shows it. Provider, model and
 * transport explain a run after the fact; `refusalCode` says why one refused
 * (the run reported a typed code instead of an exit status).
 */
export interface HubSubagentRun {
  id: string;
  goal: string;
  /** spawning | running | completed | failed | timeout | killed */
  status: string;
  provider?: string;
  model?: string;
  /** native | json | none — how tool calls travelled. */
  transport?: string;
  refusalCode?: string;
  error?: string;
  llmCalls: number;
  toolCalls: number;
  startedAt: number;
  durationMs?: number;
  resultPreview?: string;
}

/** Bedrock credential shape (mirrors the `/api/bedrock/status` answer). */
export type BedrockAuthMethod = 'bearer' | 'iam' | 'none';

/** Bedrock credential state for this machine (the onboarding panel reads it). */
export interface BedrockStatus {
  configured: boolean;
  region: string;
  authMethod: BedrockAuthMethod;
  apiKeySet: boolean;
  iamKeySet: boolean;
}

/** One gateway conversation row (per-contact history). */
export interface HubConversationSummary {
  key: string;
  platform: string;
  channelId: string;
  contactName?: string;
  messageCount: number;
  lastActiveAt: number;
  lastUserMessage: string;
  lastAssistantMessage: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string; ts: number }>;
  tags?: string[];
}

/**
 * Conversation aggregates behind the Conversations tab charts. Required on the hub
 * payload; the streamed merge carries only totals and rows.
 */
export interface HubConversationAnalytics {
  totalMessages: number;
  totalConversations: number;
  avgMessagesPerConversation: number;
  topContacts: Array<{ name: string; platform: string; messageCount: number; lastActiveAt: number }>;
  hourlyDistribution: Array<{ hour: number; count: number }>;
  dailyDistribution: Array<{ day: number; count: number }>;
  platformBreakdown: Array<{ platform: string; conversations: number; messages: number }>;
  dailyVolume: Array<{ date: string; count: number }>;
  avgUserMessageLength: number;
  avgAssistantMessageLength: number;
}

export interface HubData {
  toolsets: {
    toolsets: HubToolset[];
    enabled: number;
    disabled: number;
    totalTools: number;
  };
  channels: {
    delivery: {
      total: number;
      pending: number;
      sent: number;
      failed: number;
      recent: HubDeliveryEntry[];
    };
    aliases: HubChannelAlias[];
    reachable: Array<{ platform: string; channelId: string; aliases: string[]; reachable: boolean }>;
    platforms: HubPlatformStatus[];
    policies: Record<string, HubChannelPolicy>;
    /** Saved verified contacts (name + contact no) — the validated list. */
    contacts: HubContact[];
    /** Status recipients — always get pipeline completion summaries. */
    statusRecipients: string[];
    /** Friendly display labels for status recipients (resolved name → number). */
    statusRecipientDisplay: Record<string, string>;
    inbox: {
      total: number;
      pipeline: number;
      chat: number;
      help: number;
      refused: number;
      /** Re-deliveries recognised and deliberately not re-run (dedup). */
      duplicate: number;
      /** Documents/voice notes that arrived but could not be read (see reply). */
      attachmentFailed: number;
      recent: HubInboxEntry[];
    };
  };
  artifacts: {
    totalSessions: number;
    totalArtifacts: number;
    sessions: HubArtifactSummary[];
  };
  skills: {
    compiled: HubSkill[];
    hub: HubSkill[];
    total: number;
    /** P3 — enabled/disabled counts (mirror the toolsets summary cards). */
    enabled: number;
    disabled: number;
  };
  /** Subagent child-process runs (most recent first) — inspectable after the fact. */
  subagents: {
    total: number;
    running: number;
    failed: number;
    recent: HubSubagentRun[];
  };
  /** Gateway chat conversations (per-contact history). */
  conversations: {
    total: number;
    recent: HubConversationSummary[];
    analytics: HubConversationAnalytics;
  };
  adminConfigured: boolean;
  serverTime: number;
}

// ─── P1 task runner (dashboard command console) ─────────────────────────────

export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'error';

export interface TaskLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: number;
}

export interface TaskRecord {
  id: string;
  /** Human display line: the args joined with spaces. */
  command: string;
  args: string[];
  cwd: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  timeoutMs: number;
  logs: TaskLogLine[];
  error?: string;
}

// ─── P2 in-page WhatsApp pairing (GUI parity with `nuvira whatsapp pair`) ─────

export type WhatsAppPairState = 'idle' | 'pairing' | 'paired' | 'failed' | 'cancelled' | 'error';

export interface WhatsAppPairStatus {
  state: WhatsAppPairState;
  paired: boolean;
  sessionDir: string;
  /** Browser-scannable QR (PNG data URL) — null until the first QR arrives. */
  qr: string | null;
  /** Raw Baileys QR payload (for external tools / debugging). */
  qrRaw: string | null;
  /** 8-char "link with phone number instead" code (phone mode only). */
  pairingCode: string | null;
  phone: string | null;
  error: string | null;
  startedAt: number | null;
}
