#!/usr/bin/env node

import { createCLI } from './cli/router.js';
import { setLogLevel } from './utils/logger.js';
import { runAutoDiscovery } from './plugins/agent-plugin.js';
import { logger } from './utils/logger.js';
import ora from 'ora';

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
export { DebuggerAgent } from './agents/agents/debugger.js';
export { RunnerAgent } from './agents/agents/runner.js';
export type { RunResult } from './agents/agents/runner.js';
export { GitHubReleaseAgent } from './agents/agents/github-release-agent.js';
export { SecurityAgent } from './agents/agents/security-agent.js';
export { runAllScans, scanForPII, scanForInjections, scanForDangerousCode, formatScanReport } from './security/scanner.js';
export type { SecurityFinding, ScanResult } from './security/scanner.js';

// ─── Evaluation Framework exports ───────────────────────────────────────────
export {
  runEvalSuite,
  runEvalTask,
  scaffoldWorkspace,
  runHiddenTest,
  computeEditAccuracy,
  scoreEvalMetrics,
  computeEvalSummary,
  formatEvalReport,
  formatEvalJSON,
  formatEvalMarkdown,
  formatEvalScoreRules,
  getEvalTasks,
  getEvalTask,
  getEvalRuns,
  getLatestEvalRun,
  clearEvals,
  EVAL_SCORE_WEIGHTS,
  IDEAL_TIME_TO_FIX_MS,
} from './learning/eval-framework.js';
export type {
  EvalTask,
  EvalMetrics,
  EvalResult,
  EvalRun,
  EvalSummary,
  EvalCategory,
  RunEvalOptions,
} from './learning/eval-framework.js';
export { EvalCommand } from './cli/eval.js';

// ─── Learning exports ───────────────────────────────────────────────────────
export {
  RouterBandit,
  getRouterBandit,
  resetRouterBandit,
  sampleBeta,
  sampleGamma,
  costAdjustedSuccessReward,
  COMPLEXITY_BUCKETS,
} from './learning/router-bandit.js';
export type {
  BanditOutcome,
  BetaPrior,
  RouterBanditState,
} from './learning/router-bandit.js';
export { SelfImprover, getSelfImprover } from './learning/self-improver.js';
export { AgentStats, getAgentStats } from './learning/agent-stats.js';
export type { AgentPerformance, AgentStatsData } from './learning/agent-stats.js';
export { scoreTrajectory, scoreOrchestrationResult } from './learning/scorer.js';
export type { ScoreComponents, ScoreInput } from './learning/scorer.js';

// ─── Memory exports ────────────────────────────────────────────────────────
export { VectorStore, getVectorStore, cosineSimilarity, JsonBackend, setVectorBackendOverride, resetVectorBackendSelection } from './memory/vector-store.js';
export type { VectorEntry, SearchResult, VectorStoreBackend, VectorBackendType } from './memory/vector-store.js';
export { FaissIvfBackend, NativeFaissBackend, checkNativeFaiss, createFaissBackend } from './memory/faiss-backend.js';
export type { FaissIvfOptions, NativeFaissCheck } from './memory/faiss-backend.js';
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

// ─── Phase 1.4: Init Command exports ────────────────────────────────────────
export { InitCommand } from './cli/init.js';
export type { InitTemplate } from './cli/init.js';

// ─── Skill Compiler exports ─────────────────────────────────────────────────
export { SkillCompiler, getSkillCompiler } from './learning/skill-compiler.js';
export { SkillStore, getSkillStore } from './learning/skill-store.js';

// ─── Context Pruner exports ─────────────────────────────────────────────────
export { ContextPruner } from './learning/context-pruner.js';
export type {
  ContextPrunerOptions,
  ContextTokenBreakdown,
  PruneResult,
  PruneDetail,
} from './learning/context-pruner.js';
export type {
  Skill,
  SkillStep,
  SkillParameter,
  SkillParameterType,
  CompilationResult,
  SkillSummary,
} from './learning/skill-types.js';
export { SkillRunnerAgent } from './agents/agents/skill-runner.js';
export { MCPAgent } from './agents/agents/mcp-agent.js';
export type { McpToolEntry, McpToolResult } from './agents/agents/mcp-agent.js';
export { SkillCommand } from './cli/skill.js';
export { ModelCommand, readActiveModelState, saveActiveModelState, applyActiveModel } from './cli/model.js';
export type { ActiveModelState } from './cli/model.js';

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
export {
  ProviderFallback,
  getProviderFallback,
  resetProviderFallback,
  classifyFallbackError,
  isRetryableError,
} from './learning/provider-fallback.js';
export type {
  ProviderFallbackConfig,
  FallbackResult,
  FallbackErrorType,
} from './learning/provider-fallback.js';

export { HybridModelRouter, getHybridRouter, analyzeComplexity, buildFallbackChain, checkBudget, checkConsensus } from './learning/hybrid-router.js';
export {
  AutoModelRouter,
  getAutoRouter,
  resetAutoRouter,
  isAutoModel,
  isAutoProvider,
  AUTO_MODEL,
  AUTO_PROVIDER,
  computeWeights,
  scoreProvider,
  DEFAULT_AUTO_PROVIDERS,
  DIMENSION_LABELS,
} from './learning/auto-router.js';
export type {
  AutoRouterOptions,
  AutoRouteResult,
  ProviderCapabilities,
  ScoredProvider,
  RoutingDimension,
} from './learning/auto-router.js';

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
export type { RoutingDecision, ModelCandidate, ComplexityLevel, ConsensusResult, HybridRouterOptions, PreferenceMode } from './learning/hybrid-router.js';

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

// ─── Phase 4.1 — MCP (Model Context Protocol) exports ─────────────────────────
export { MCPClient, createMCPClient } from './mcp/client.js';
export { MCPManager, getMCPManager, resetMCPManager } from './mcp/manager.js';
export { MCPCommand } from './cli/mcp.js';
export { MCP_PROTOCOL_VERSION } from './mcp/types.js';
export type {
  MCPServerConfig,
  MCPConnectionState,
  Tool,
  Resource,
  Prompt,
  CallToolResult,
  TextContent,
  ImageContent,
  Implementation,
} from './mcp/types.js';

// ─── Phase 4.3 — Auto Error-Repair exports ────────────────────────────────────
export { ErrorRepairEngine, RepairBudget } from './learning/error-repair.js';
export { classifyError, isRepairable, selectStrategy, needsApproval, formatRepairSummary } from './learning/error-repair.js';
export type {
  ErrorCategory,
  RepairStrategy,
  RepairMode,
  RepairAttempt,
  ErrorRepairOptions,
} from './learning/error-repair.js';

// ─── Phase 1 — RecoverModule (ARCHITECTURE.md §3.5) ───────────────────────────
export { ErrorRepairRecoverModule } from './learning/recover-module.js';
export type {
  RecoverModule,
  AgentFailure,
  RecoverRepairStrategy,
  RecoverAttempt,
  RecoverAttemptOutcome,
  RecoverResult,
  ErrorClassification,
} from './learning/recover-module.js';

// ─── Phase 2 — ModuleRegistry (ARCHITECTURE.md §4.1) ───────────────────────────
export { ModuleRegistry, ModuleNotFoundError, getModuleRegistry, resetModuleRegistry, setModuleRegistry } from './agents/module-registry.js';
export type { AgentFactory, ModuleMetadata } from './agents/module-registry.js';

// ─── Phase 3 — EventBus (ARCHITECTURE.md §4.2) ────────────────────────────────
export { EventBus, EventNames, LoggerConsumer, DAGConsumer, TelemetryConsumer, DebugConsumer, getEventBus, resetEventBus, getEventBusConsumers } from './observability/event-bus.js';
export type { EventRecord, EventFilter, EventHandler, EventBusConsumer, TelemetrySnapshot } from './observability/event-bus.js';

// ─── ReportModule (Phase 4) ────────────────────────────────────────────
export { DefaultReportModule } from './agents/report-module.js';
export type { ReportModule, ExecutionReport, ReportParams, ReportFormat, AgentResultSummary, ReportFileChange } from './agents/report-module.js';

// ─── InspectModule (Phase 5) ───────────────────────────────────────────
export { DefaultInspectModule } from './agents/inspect-module.js';

// ─── TaskExecutionPipeline (Phase 7) ───────────────────────────────────────
export { TaskExecutionPipeline } from './agents/task-execution-pipeline.js';
export { PipelineAudit } from './agents/pipeline-audit.js';
export type {
  PipelineConfig,
  PipelineResult,
  StepResult,
  TestOutput,
} from './agents/task-execution-pipeline.js';
export type {
  AuditTrail,
  AuditEntry,
  PipelineSnapshot,
} from './agents/pipeline-audit.js';

// ─── PlanModule (Phase 7) ──────────────────────────────────────────────
export { DefaultPlanModule } from './agents/plan-module.js';
export type { PlanModule, PlanParams, PlanOutput } from './agents/plan-module.js';

// ─── EditModule (Phase 7) ──────────────────────────────────────────────
export { DefaultEditModule } from './agents/edit-module.js';
export type { EditModule, EditParams, EditOutput } from './agents/edit-module.js';

// ─── ExecuteModule (Phase 8) ───────────────────────────────────────────
export { DefaultExecuteModule } from './agents/execute-module.js';
export type { ExecuteModule, ExecuteParams, ExecuteResult } from './agents/execute-module.js';

// ─── TestModule (Phase 8) ──────────────────────────────────────────────
export { DefaultTestModule } from './agents/test-module.js';
export type { TestModule, TestParams, TestResult } from './agents/test-module.js';

// ─── SafeExecutionLayer (Phase 9) ───────────────────────────────────────
export { DefaultSafeExecutionLayer } from './agents/safe-execution-layer.js';
export type {
  SafeExecutionLayer,
  SafetyCheck,
  SafetyResult,
  FileSafetyParams,
  SandboxExecutionParams,
  SandboxExecutionResult,
  LLMCallParams,
  SafetySeverity,
} from './agents/safe-execution-layer.js';

// ─── VerifyModule (Phase 6) ────────────────────────────────────────────
export { DefaultVerifyModule } from './agents/verify-module.js';
export type {
  VerifyModule,
  VerificationResult,
  VerificationCheck,
  VerifyParams,
  CheckType,
  CheckSeverity,
} from './agents/verify-module.js';
export type {
  InspectModule,
  InspectionResult,
  InspectParams,
  InspectionStats,
  InspectArtifact,
  PlanStepRef,
} from './agents/inspect-module.js';

// ─── Phase 4.4 — A2A Protocol exports ────────────────────────────────────────
export { createA2AServer, startA2AServer } from './federation/a2a-server.js';
export type { A2AServerOptions } from './federation/a2a-server.js';
export {
  createDefaultAgentCard,
  A2A_PROTOCOL_VERSION,
  A2A_DEFAULT_PORT,
  A2A_DEFAULT_HOST,
} from './federation/a2a-types.js';
export type {
  AgentCard,
  AgentCapability,
  AgentSkill,
  A2ATask,
  A2ATaskResult,
  A2ATaskRequest,
  A2ATaskResponse,
  A2ATaskStatus,
  A2AHealth,
  A2ADiscoveryResult,
  A2ADirectoryEntry,
} from './federation/a2a-types.js';
export {
  fetchAgentCard,
  discoverAgent,
  delegateTask,
  pollTaskStatus,
  delegateAndWait,
  checkA2AHealth,
} from './federation/a2a-client.js';

// ─── Phase 4.5 — CI/CD Headless Mode exports ──────────────────────────────────
export { CICommand } from './cli/ci.js';

// ─── Publish & Phase commands (Autonomous publish + phase-wise execution) ──────
export { PublishCommand } from './cli/publish.js';
export { PhaseCommand } from './cli/phase.js';
export { PhaseExecutionEngine } from './agents/phase-engine.js';
export type {
  PhaseDefinition,
  PhaseScopeState,
  PhaseState,
  PhaseStatus,
  PhaseScopeDefinition,
  PhaseScopeOptions,
  PhaseResult,
} from './agents/phase-engine.js';
export { CredentialStore } from './agents/credential-store.js';
export type {
  GitCredentials,
  NpmCredentials,
  PublishCredentials,
} from './agents/credential-store.js';
export { parseReviewOutput } from './cli/ci.js';
export type {
  CIExecuteResult,
  CIReviewResult,
  CIReviewFinding,
  CICheckResult,
} from './cli/ci.js';

// ─── Phase 4.2 — AST Editing Engine exports ──────────────────────────────────
export {
  analyzeStructure,
  findNodeByName,
  findNodeAtPosition,
  validateSyntax,
  formatStructureSummary,
  getStructureIcon,
} from './editing/ast.js';
export {
  detectLanguage,
  offsetToPosition,
  positionToOffset,
  getLanguageConfig,
} from './editing/types.js';
export {
  applyEdit,
  applyEdits,
  formatEditSummary,
} from './editing/diff.js';
export {
  performEdit,
  replaceFunctionBody,
  addMethodToClass,
  addImport,
  insertBefore,
  insertAfter,
  deleteNode,
  buildStructuralContext,
} from './editing/edit.js';
export type {
  SupportedLanguage,
  LanguageConfig,
  SourcePosition,
  SourceRange,
  StructuralNode,
  StructureType,
  ASTEdit,
  EditType,
  EditResult,
  EditConflict,
} from './editing/types.js';

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

  // ── Startup progress feedback ────────────────────────────────────────────
  // First-run / cold start can take a while (plugin discovery + history init +,
  // when enabled, semantic reindex). Give the user a live status line instead
  // of a silent hang. Ora auto-suppresses when stdout is not a TTY, so piped
  // output stays clean.
  const startupSpinner = ora({
    text: '⚙️  Agent-Nuvira starting…',
    spinner: 'dots',
  }).start();

  // Run auto-discovery for plugins before parsing commands
  // This ensures provider plugins are loaded before any command runs.
  try {
    const startTime = Date.now();
    startupSpinner.text = '⚙️  Loading plugins…';
    const discovered = await runAutoDiscovery();
    const elapsed = Date.now() - startTime;

    const total = discovered.providerPlugins + discovered.agentPlugins + discovered.workflowPlugins;
    if (total > 0 && process.argv.includes('--debug')) {
      logger.debug(`Auto-discovery: ${discovered.providerPlugins} provider, ${discovered.agentPlugins} agent, ${discovered.workflowPlugins} workflow plugins (${elapsed}ms)`);
    }
  } catch (err) {
    logger.debug(`Plugin auto-discovery failed (non-critical): ${err}`);
  }

  // Auto-prune old chat history on startup using configured retentionDays,
  // apply history.semanticSearch config to ChatHistory singleton,
  // and auto-trigger semantic reindex if enabled but vector store is empty.
  try {
    startupSpinner.text = '⚙️  Initializing history & search…';
    const { ConfigManager } = await import('./config/manager.js');
    const { getChatHistory, ChatHistory } = await import('./context/history.js');
    const { getVectorStore } = await import('./memory/vector-store.js');
    const configManager = new ConfigManager();
    const historyConfig = configManager.getAll().history || {};

    // Apply semantic search toggle from config
    const semanticSearch = historyConfig.semanticSearch !== false;
    ChatHistory.setSemanticSearchEnabled(semanticSearch);

    // Auto-prune old sessions
    const retentionDays = historyConfig.retentionDays ?? 30;
    const removed = getChatHistory().prune(retentionDays);
    if (removed > 0) {
      logger.debug(`Auto-pruned ${removed} old chat session(s) (retention: ${retentionDays}d)`);
    }

    // Auto-trigger semantic reindex if enabled but vector store has no chat entries
    if (semanticSearch) {
      const sessionCount = getChatHistory().count();
      if (sessionCount > 0) {
        const vs = getVectorStore();
        const allEntries = await vs.getAll();
        const hasChatEntries = allEntries.some((e) => e.id.startsWith('session-'));
        if (!hasChatEntries) {
          startupSpinner.text = '📦 Building semantic search index…';
          logger.debug('📦 Building semantic search index for past conversations...');
          const indexed = await getChatHistory().reindexSemantic();
          if (indexed > 0) {
            logger.debug(`Auto-indexed ${indexed} session(s) for semantic search`);
          }
        }
      }
    }
  } catch (err) {
    // Non-critical — startup shouldn't fail due to history initialization
    logger.debug(`History initialization failed (non-critical): ${err}`);
  }

  startupSpinner.stop();

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
