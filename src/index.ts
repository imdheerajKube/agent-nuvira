#!/usr/bin/env node

import { createCLI } from './cli/router.js';
import { setLogLevel } from './utils/logger.js';
import { runAutoDiscovery } from './plugins/agent-plugin.js';
import { logger } from './utils/logger.js';

// ─── Agent exports (public API) ─────────────────────────────────────────────
export { Orchestrator } from './agents/orchestrator.js';
export type { OrchestratorOptions, OrchestrationResult } from './agents/orchestrator.js';
export { buildProjectFileTree, truncateTree } from './agents/utils/file-tree.js';
export { ContextVault } from './agents/context-vault.js';
export { Agent } from './agents/agent.js';
export type {
  AgentContext,
  AgentResult,
  TaskStep,
  Artifact,
  AgentMessage,
  FileChange,
  LLMCallFn,
} from './agents/agent.js';
export { PlannerAgent } from './agents/agents/planner.js';
export { ContextGathererAgent } from './agents/agents/context-gatherer.js';
export { WriterAgent } from './agents/agents/writer.js';
export { ReviewerAgent } from './agents/agents/reviewer.js';
export { TesterAgent, cleanupSandbox } from './agents/agents/tester.js';
export type { TestResult } from './agents/agents/tester.js';
export { DebuggerAgent } from './agents/agents/debugger.js';
export { RunnerAgent } from './agents/agents/runner.js';
export type { RunResult } from './agents/agents/runner.js';
export { GitHubReleaseAgent } from './agents/agents/github-release-agent.js';
export { SecurityAgent } from './agents/agents/security-agent.js';
export { runAllScans, scanForPII, scanForInjections, scanForDangerousCode, formatScanReport } from './security/scanner.js';
export type { SecurityFinding, ScanResult } from './security/scanner.js';

// ─── Learning exports ───────────────────────────────────────────────────────
export { SelfImprover, getSelfImprover } from './learning/self-improver.js';
export { AgentStats, getAgentStats } from './learning/agent-stats.js';
export type { AgentPerformance, AgentStatsData } from './learning/agent-stats.js';
export { scoreTrajectory, scoreOrchestrationResult } from './learning/scorer.js';
export type { ScoreComponents, ScoreInput } from './learning/scorer.js';

// ─── Memory exports ────────────────────────────────────────────────────────
export { VectorStore, getVectorStore, cosineSimilarity } from './memory/vector-store.js';
export type { VectorEntry } from './memory/vector-store.js';
export { embed, clearEmbeddingCache, embeddingCacheSize } from './memory/embedder.js';
export { TrajectoryStore, getTrajectoryStore } from './memory/trajectory-store.js';
export type { Trajectory, TrajectoryStep } from './memory/trajectory-store.js';
export {
  retrieveMemoryContext,
  storeExecutionTrajectory,
  getMemoryStats,
  clearMemory,
} from './memory/memory-integration.js';

// ─── Existing exports ───────────────────────────────────────────────────────
export { ConfigManager } from './config/manager.js';
export { ProviderFactory } from './inference/factory.js';
export type { InferenceProvider, ModelDescriptor } from './inference/interface.js';
export type { ProviderType, ProviderConfig, InferenceOptions } from './config/types.js';
export { getPluginRegistry, PluginRegistry } from './plugins/registry.js';
export type { ProviderPlugin, PluginMetadata } from './plugins/registry.js';
export { runAutoDiscovery, discoverProviderPlugins, discoverAgentPlugins, discoverWorkflowPlugins } from './plugins/agent-plugin.js';
export type { AgentPlugin, AgentPluginMetadata } from './plugins/agent-plugin.js';

// ─── Phase 1 new exports ────────────────────────────────────────────────────
export { CostTracker, getCostTracker, estimateTokens, calculateCost } from './learning/cost-tracker.js';
export type { CostEntry, CostSummary } from './learning/cost-tracker.js';
export { ChatHistory, getChatHistory } from './context/history.js';
export type { HistorySession, HistoryMessage } from './context/history.js';

// ─── Phase 2.5 new exports ──────────────────────────────────────────────────
export { DoctorCommand } from './cli/doctor.js';
export type { HealthStatus, CheckResult, ProviderHealth, DoctorReport } from './cli/doctor.js';

// ─── Phase 2.6 new exports ──────────────────────────────────────────────────
export { MemoryCommand } from './cli/memory.js';

// ─── Phase 3.3 new exports ──────────────────────────────────────────────────
export { DashboardCommand } from './cli/dashboard.js';

// ─── Phase 3.6 new exports ──────────────────────────────────────────────────
export { AgentCommand } from './cli/agent.js';

// ─── Phase 3.4 new exports ──────────────────────────────────────────────────
export { HybridModelRouter, getHybridRouter, analyzeComplexity, buildFallbackChain, checkBudget, checkConsensus } from './learning/hybrid-router.js';

// ─── Phase 3.2 new exports ──────────────────────────────────────────────────
export { FederationCommand } from './cli/federation.js';
export { FederationClient } from './federation/client.js';
export { createFederationServer, startFederationServer } from './federation/server.js';
export type {
  FederationConfig,
  FederationHealth,
  HandshakeResponse,
  TaskDelegationResponse,
  TaskResult,
  TaskProgressEvent,
} from './federation/protocol.js';
export type { FederationClientEvents, ConnectionStatus } from './federation/client.js';
export type { RoutingDecision, ModelCandidate, ComplexityLevel, ConsensusResult, HybridRouterOptions } from './learning/hybrid-router.js';

// ─── Phase 2.2 new exports ──────────────────────────────────────────────────
export { WorkflowCommand } from './cli/workflow.js';
export {
  getWorkflowTemplates,
  getWorkflowTemplate,
  buildTaskPlanFromTemplate,
  buildWorkflowOptions,
  isValidWorkflowTemplate,
} from './workflow/templates.js';
export type {
  WorkflowTemplate,
  WorkflowStep,
  WorkflowDependency,
} from './workflow/templates.js';
export {
  fetchRegistryIndex,
  searchRegistry,
  installTemplate,
  getInstalledTemplates,
  validateForPublish,
  prepareForPublish,
  getPublishUrl,
  checkForUpgrades,
  resolveDependencies,
  compareVersions,
  versionSatisfies,
} from './workflow/registry.js';
export type {
  RegistryEntry,
  PublishValidation,
} from './workflow/registry.js';

// ─── Phase 3.5 new exports ──────────────────────────────────────────────────
export { TeamCommand } from './cli/team.js';
export {
  findProjectConfig,
  getTeamConfig,
  hasProjectConfig,
  getTeamDataDir,
} from './team/config.js';
export {
  initTeamMemory,
  syncTeamMemory,
  shareTrajectories,
  getTeamMemoryStats,
} from './team/memory.js';
export type { TeamMemoryStats, SyncResult } from './team/memory.js';
export {
  getReview,
  listReviews,
  addReviewComment,
  mergeReview,
  rejectReview,
  createReview,
  createReviewFromResult,
} from './team/review.js';
export type {
  ReviewBundle,
  ReviewFileChange,
  ReviewComment,
  ReviewStatus,
} from './team/review.js';

/**
 * Buff CLI — Flexible AI inference tool
 * Supports local models (Ollama, HuggingFace, GGML) and cloud APIs
 * (NVIDIA NIM, Google Gemini, OpenRouter) plus auto-discovered plugins.
 */
async function main(): Promise<void> {
  const program = createCLI();

  // Parse args and handle debug mode
  const debugIndex = process.argv.indexOf('--debug');
  if (debugIndex > -1 || process.argv.includes('-d')) {
    setLogLevel('debug');
  }

  // Run auto-discovery for plugins before parsing commands
  // This ensures provider plugins are loaded before any command runs.
  try {
    const startTime = Date.now();
    const discovered = await runAutoDiscovery();
    const elapsed = Date.now() - startTime;

    const total = discovered.providerPlugins + discovered.agentPlugins + discovered.workflowPlugins;
    if (total > 0 && process.argv.includes('--debug')) {
      logger.debug(`Auto-discovery: ${discovered.providerPlugins} provider, ${discovered.agentPlugins} agent, ${discovered.workflowPlugins} workflow plugins (${elapsed}ms)`);
    }
  } catch (err) {
    logger.debug(`Plugin auto-discovery failed (non-critical): ${err}`);
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
