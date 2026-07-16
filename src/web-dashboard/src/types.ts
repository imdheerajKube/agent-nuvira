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

export interface DashboardData {
  cost: CostData;
  history: HistoryData;
  benchmarks: BenchmarkData;
  memory: MemoryData;
  health: HealthData;
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
