// ─── Model Health Types ─────────────────────────────────────────────────────

export type ModelStatus = 'available' | 'limited' | 'unavailable';

export interface TestedModel {
  id: string;
  name: string;
  status: ModelStatus;
  statusReason: string;
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
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
  /** Total logged events (capped by the registry at MAX_ACTION_LOG_ENTRIES). */
  total: number;
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
  /** Central quota-ledger status (tokens/requests per provider × model) */
  quota?: QuotaInsights;
  /**
   * Vector-retrieval token savings (retrieval-stats.json) — how many tokens
   * the retrieval layer saved by vectorizing large contexts. Optional: an
   * older server won't send this, so the panel hides the card when absent.
   */
  retrieval?: RetrievalInsights;
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
  serverTime: number;
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
}
