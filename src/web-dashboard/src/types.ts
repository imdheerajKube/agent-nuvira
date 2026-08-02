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

// ─── Dashboard Data Types ───────────────────────────────────────────────────

export interface CostData {
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  recent: Array<{
    provider: string;
    model: string;
    costUsd: number;
    totalTokens: number;
    timestamp: number;
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
    providers: Array<{ provider: string; score: number; reason: string }>;
  }>;
  /** Which providers/models were actually picked over time */
  usage?: RoutingUsage;
  /** Recent routing decisions (audit trail) — most recent first */
  history?: RoutingHistoryEntry[];
  /** Learning-router bandit state (Thompson-sampling priors + history) */
  bandit?: BanditInsights;
  /** Promotion-gate verdict — is the bandit actually better than the heuristic? */
  promotion?: PromotionInsights;
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

export interface DashboardData {
  cost: CostData;
  history: HistoryData;
  benchmarks: BenchmarkData;
  evals?: EvalData;
  memory: MemoryData;
  health: HealthData;
  routing?: RoutingInsights;
  dag?: DAGData;
  serverTime: number;
}

// ─── Agent Execution Types ──────────────────────────────────────────────────

export interface AgentNode {
  id: string;
  agentType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
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
