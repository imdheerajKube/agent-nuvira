/**
 * ResilientCallLLM — Smart proxy that wraps the auto-router and provides
 * automatic failover for ANY LLM call, anywhere in the codebase.
 *
 * Problem it solves:
 * - Tools, skills, sub-agents, memory all receive a FIXED callLLM bound to
 *   one provider at task start. If that provider fails mid-execution, the
 *   tool just fails.
 * - The 3-candidate cap in chat.ts means only 3 providers are tried.
 * - Session failures aren't persisted across pipelines.
 *
 * Solution:
 * - callLLM becomes a smart proxy that internally re-routes on ANY failure
 * - Tries ALL ranked candidates (no cap)
 * - Tracks failures across the entire session (not just per-task)
 * - Tools/sub-agents use it transparently — they don't know failover happens
 *
 * Usage:
 *   const callLLM = createResilientCallLLM(task, configManager, options);
 *   // Now callLLM automatically re-routes on failure
 *   const result = await callLLM("Implement JWT auth");
 *
 * Integration:
 *   - Orchestrator: replace createAutoRoutedLLM with createResilientCallLLM
 *   - Chat: replace buildToolCallModel's tryGenerate with resilient wrapper
 *   - Tools: ctx.callLLM is already resilient (inherited from orchestrator)
 */

import { getAutoRouter, type AutoRouteResult, type ScoredProvider } from './auto-router.js';
import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';
import { buildAutoResolveOptions } from './resolve-options.js';
import { getModelRegistry } from './model-registry.js';
import { recordActionFailure, type FailureSessionState } from './failure-bookkeeping.js';
import { getProviderFallback, recordRegistrySuccess } from './provider-fallback.js';
import { ProviderFactory } from '../inference/factory.js';
import { recordRoutingDecision } from './routing-history.js';
import { EventNames, getEventBus } from '../observability/event-bus.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';
import type { InferenceOptions } from '../config/types.js';
import type { LLMCallFn } from '../agents/agent.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Failure classification for routing decisions. */
type FailureKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model-not-found' | 'unknown';

/** A candidate provider in the failover chain. */
interface FailoverCandidate {
  provider: string;
  model: string;
  score: number;
}

/** Configuration for the resilient proxy. */
export interface ResilientCallOptions {
  /** Whether to persist failures to disk for cross-pipeline memory (default: true). */
  crossPipelineMemory?: boolean;
  /** Verbose logging (default: false). */
  verbose?: boolean;
  /** Original task info for routing decisions. */
  task: {
    agentType: string;
    description: string;
    complexity?: string;
    taskId?: string;
    contextHintTokens?: number;
  };
}

/** Internal state for a resilient callLLM instance. */
interface ResilientState {
  /** Providers that failed during this resilient callLLM's lifetime. */
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>;
  /** Number of failover attempts in the current call. */
  currentAttempt: number;
  /** The current provider/model (mutated on failover). */
  currentProvider: string;
  currentModel: string;
  /** Whether we've exhausted all candidates. */
  exhausted: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** How long a provider is excluded after an auth failure (whole session). */
const AUTH_FAILURE_EXCLUSION_MS = Number.MAX_SAFE_INTEGER;
/** How long a provider is excluded after rate-limit (short cooldown). */
const RATE_LIMIT_EXCLUSION_MS = 60_000;
/** How long a provider is excluded after timeout/network (medium cooldown). */
const NETWORK_FAILURE_EXCLUSION_MS = 30_000;
/** How long a provider is excluded after model-not-found (long cooldown). */
const MODEL_NOT_FOUND_EXCLUSION_MS = 300_000;
/** Cross-pipeline failure persistence path. */
const FAILURE_PERSIST_PATH = 'nuvira-routing-failures.json';

// ─── Failure Classification ─────────────────────────────────────────────────

function classifyFailure(err: unknown): FailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('authentication')) {
    return 'auth';
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota') || lower.includes('too many requests')) {
    return 'rate-limit';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'timeout';
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network') || lower.includes('fetch failed') || lower.includes('dns')) {
    return 'network';
  }
  if (lower.includes('model not found') || lower.includes('404') || lower.includes('does not exist') || lower.includes('deprecated')) {
    return 'model-not-found';
  }
  return 'unknown';
}

function exclusionDuration(kind: FailureKind): number {
  switch (kind) {
    case 'auth': return AUTH_FAILURE_EXCLUSION_MS;
    case 'rate-limit': return RATE_LIMIT_EXCLUSION_MS;
    case 'timeout': return NETWORK_FAILURE_EXCLUSION_MS;
    case 'network': return NETWORK_FAILURE_EXCLUSION_MS;
    case 'model-not-found': return MODEL_NOT_FOUND_EXCLUSION_MS;
    case 'unknown': return NETWORK_FAILURE_EXCLUSION_MS;
  }
}

// ─── Cross-Pipeline Failure Persistence ─────────────────────────────────────

interface PersistedFailures {
  [provider: string]: { expiresAt: number; kind: FailureKind; recordedAt: number };
}

function loadPersistedFailures(): PersistedFailures {
  try {
    const { existsSync, readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const path = join(homedir(), '.nuvira', FAILURE_PERSIST_PATH);
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw) as PersistedFailures;
    const now = Date.now();
    // Clean expired entries
    for (const key of Object.keys(data)) {
      if (data[key].expiresAt <= now) delete data[key];
    }
    return data;
  } catch {
    return {};
  }
}

function persistFailure(provider: string, kind: FailureKind): void {
  try {
    const { existsSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { homedir } = require('node:os');
    const dir = join(homedir(), '.nuvira');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, FAILURE_PERSIST_PATH);
    const existing = loadPersistedFailures();
    existing[provider] = {
      expiresAt: Date.now() + exclusionDuration(kind),
      kind,
      recordedAt: Date.now(),
    };
    writeFileSync(path, JSON.stringify(existing, null, 2));
  } catch {
    // Best-effort — persistence must never break routing.
  }
}

// ─── Provider Resolution ────────────────────────────────────────────────────

function resolveProviderAdapter(configManager: ConfigManager, providerType: string) {
  try {
    const { type, config } = configManager.getProviderConfig(providerType);
    return ProviderFactory.createProvider(type, config);
  } catch {
    return null;
  }
}

function resolveDesiredModel(
  autoRouter: ReturnType<typeof getAutoRouter>,
  providerType: string,
  agentType: string,
  configManager: ConfigManager,
  taskDescription?: string,
): string {
  return autoRouter.resolveModel(providerType, agentType, configManager, taskDescription);
}

// ─── Main Factory ───────────────────────────────────────────────────────────

/**
 * Create a resilient callLLM that auto-routes on ANY failure.
 *
 * Unlike the orchestrator's fixed-bound callLLM, this proxy:
 * 1. Routes to the auto-router's best candidate initially
 * 2. On ANY failure (not just rate-limit), re-routes to the next candidate
 * 3. Tries ALL ranked candidates (no 3-candidate cap)
 * 4. Tracks failures across the session AND persists to disk
 * 5. Tools/sub-agents use it transparently
 */
export function createResilientCallLLM(
  configManager: ConfigManager,
  options: ResilientCallOptions,
): LLMCallFn {
  const autoRouter = getAutoRouter();
  const state: ResilientState = {
    sessionFailed: new Map(),
    currentAttempt: 0,
    currentProvider: '',
    currentModel: '',
    exhausted: false,
  };

  // Load cross-pipeline failures
  const persistedFailures = options.crossPipelineMemory !== false ? loadPersistedFailures() : {};

  // Initial routing decision
  const initialDecision = resolveWithExclusions(
    autoRouter,
    configManager,
    options.task,
    state.sessionFailed,
    persistedFailures,
    options.verbose,
  );

  if (initialDecision) {
    state.currentProvider = initialDecision.provider;
    state.currentModel = initialDecision.model;
  }

  // Build the ranked candidate list (all candidates, no cap)
  // Pass task description + complexity for model-first failover
  const allCandidates = buildCandidateList(
    initialDecision,
    state.sessionFailed,
    persistedFailures,
    options.task.description,
    options.task.complexity ? analyzeComplexity(options.task.description) : undefined,
    configManager,
  );

  // The resilient callLLM
  const callLLM: LLMCallFn = async (prompt: string, inferenceOptions?: InferenceOptions): Promise<string> => {
    if (state.exhausted) {
      throw new Error(`All LLM providers exhausted. No more candidates available for: ${options.task.description}`);
    }

    // Try current provider first, then walk all candidates
    const candidatesToTry: FailoverCandidate[] = [
      { provider: state.currentProvider, model: state.currentModel, score: 1.0 },
      ...allCandidates.filter(c =>
        c.provider !== state.currentProvider ||
        c.model !== state.currentModel
      ),
    ];

    let lastError: unknown = null;

    for (const candidate of candidatesToTry) {
      // Skip excluded providers
      if (isExcluded(candidate.provider, state.sessionFailed, persistedFailures)) {
        if (options.verbose) {
          logger.debug(`   ⏭️  ${candidate.provider} excluded — skipping`);
        }
        continue;
      }

      // Skip registry-blocked providers
      try {
        const registry = getModelRegistry();
        if (registry.getBlockedProviders().includes(candidate.provider)) {
          if (options.verbose) {
            logger.debug(`   ⏭️  ${candidate.provider} registry-blocked — skipping`);
          }
          continue;
        }
      } catch {
        // Best-effort — registry must never break routing.
      }

      // Resolve the provider adapter
      const adapter = resolveProviderAdapter(configManager, candidate.provider);
      if (!adapter) {
        if (options.verbose) {
          logger.debug(`   ⏭️  ${candidate.provider} unresolvable — skipping`);
        }
        continue;
      }

      // Check availability
      try {
        if (!(await adapter.isAvailable())) {
          if (options.verbose) {
            logger.debug(`   ⏭️  ${candidate.provider} unavailable — skipping`);
          }
          continue;
        }
      } catch {
        continue;
      }

      // Try the call
      try {
        // Resolve the model at call time (ScoredProvider doesn't carry model)
        const resolvedModel = candidate.model === 'default'
          ? resolveDesiredModel(autoRouter, candidate.provider, options.task.agentType, configManager, options.task.description)
          : candidate.model;
        const mergedOptions: InferenceOptions = {
          ...inferenceOptions,
          model: resolvedModel,
        };

        // Update current provider for next call
        state.currentProvider = candidate.provider;
        state.currentModel = candidate.model;

        const result = await adapter.generate(prompt, mergedOptions);

        // Success — reset failover counter for this candidate
        state.currentAttempt = 0;

        // Record success in registry
        try {
          recordRegistrySuccess(candidate.provider, resolvedModel, 'execute');
        } catch {
          // Best-effort.
        }

        // Record routing decision for audit
        recordRoutingDecision({
          source: 'orchestrator',
          agentType: options.task.agentType,
          task: options.task.description,
          complexity: options.task.complexity || 'moderate',
          provider: candidate.provider,
          model: resolvedModel,
          score: candidate.score,
        });

        if (state.currentAttempt > 0 && options.verbose) {
          logger.success(`✅ Resilient failover: answered from ${candidate.provider}/${candidate.model} after ${state.currentAttempt} attempts`);
        }

        return result;
      } catch (err) {
        lastError = err;
        state.currentAttempt++;

        // Classify and record the failure
        const kind = classifyFailure(err);
        const duration = exclusionDuration(kind);

        state.sessionFailed.set(candidate.provider, {
          expiresAt: Date.now() + duration,
          kind,
        });

        // Persist for cross-pipeline memory
        if (options.crossPipelineMemory !== false) {
          persistFailure(candidate.provider, kind);
        }

        // Record failure in shared bookkeeping
        try {
          const session: FailureSessionState = {
            sessionFailedProviders: new Map([[candidate.provider, Date.now() + duration]]),
            sessionTransientFailedProviders: new Set(),
          };
          recordActionFailure(
            session,
            candidate.provider,
            err,
            configManager,
            { model: candidate.model, action: options.task.agentType },
          );
        } catch {
          // Best-effort.
        }

        // Emit failover event
        try {
          getEventBus().emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
            agentType: options.task.agentType,
            stage: 'routing',
            message: `⚠️ ${candidate.provider} failed (${kind}) — trying next candidate`,
          }, 'orchestrator');
        } catch {
          // Best-effort.
        }

        if (options.verbose) {
          logger.warn(`   ⚠️ ${candidate.provider} failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
        }

        // Continue to next candidate
        continue;
      }
    }

    // All candidates exhausted
    state.exhausted = true;
    throw new Error(
      `All LLM providers exhausted for: ${options.task.description}. ` +
      `Tried ${candidatesToTry.length} candidates. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  };

  // Expose metadata for debugging
  (callLLM as any).__resilient = {
    getState: () => ({ ...state }),
    getCandidates: () => [...allCandidates],
    getCurrentProvider: () => state.currentProvider,
    getCurrentModel: () => state.currentModel,
    isExhausted: () => state.exhausted,
  };

  return callLLM;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveWithExclusions(
  autoRouter: ReturnType<typeof getAutoRouter>,
  configManager: ConfigManager,
  task: { agentType: string; description: string; complexity?: string; contextHintTokens?: number },
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>,
  persistedFailures: PersistedFailures,
  verbose?: boolean,
): AutoRouteResult | null {
  try {
    const decision = autoRouter.resolve(
      task.agentType,
      task.description,
      {
        ...buildAutoResolveOptions(configManager, {
          verbose,
          contextHintTokens: task.contextHintTokens,
        }),
        complexityHint: task.complexity as any,
      },
      configManager,
    );

    // Filter out excluded providers
    const now = Date.now();
    const isExcludedLocal = (p: string): boolean => {
      const sessionExcl = sessionFailed.get(p);
      if (sessionExcl && sessionExcl.expiresAt > now) return true;
      const persisted = persistedFailures[p];
      if (persisted && persisted.expiresAt > now) return true;
      return false;
    };

    // Find first non-excluded ranked provider
    const allRanked = [decision.provider, ...decision.ranked.map(r => r.provider)];
    const firstAvailable = allRanked.find(p => !isExcludedLocal(p));

    if (firstAvailable && firstAvailable !== decision.provider) {
      // Sink to the first available
      const rankedEntry = decision.ranked.find(r => r.provider === firstAvailable);
      const model = resolveDesiredModel(autoRouter, firstAvailable, task.agentType, configManager, task.description);
      return {
        ...decision,
        provider: firstAvailable,
        model,
        score: rankedEntry?.score ?? decision.score,
        explanation: `${decision.explanation} — sank to ${firstAvailable} (original excluded)`,
      };
    }

    return decision;
  } catch {
    return null;
  }
}

function buildCandidateList(
  decision: AutoRouteResult | null,
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>,
  persistedFailures: PersistedFailures,
  taskDescription?: string,
  complexity?: ComplexityLevel,
  configManager?: ConfigManager,
): FailoverCandidate[] {
  if (!decision) return [];

  const now = Date.now();
  const candidates: FailoverCandidate[] = [];

  // Primary candidate
  candidates.push({
    provider: decision.provider,
    model: decision.model,
    score: decision.score,
  });

  // ── MODEL-FIRST FAILOVER: same model on different providers first ──────
  // When a model fails on one provider, try the SAME model on a different
  // provider before switching to a different model. This ensures the user
  // gets the model they expect (e.g., Llama 3.3) even if one provider is down.
  try {
    const { buildModelCandidates, buildFailoverChain } = require('./model-first-router.js');
    if (taskDescription && complexity) {
      const modelCandidates = buildModelCandidates(taskDescription, complexity, configManager);
      const failoverChain = buildFailoverChain(
        { model: decision.model, provider: decision.provider } as any,
        modelCandidates,
      );
      for (const fc of failoverChain) {
        if (fc.provider === decision.provider && fc.model === decision.model) continue;
        const key = `${fc.provider}:${fc.model}`;
        if (candidates.some(c => `${c.provider}:${c.model}` === key)) continue;
        candidates.push({
          provider: fc.provider,
          model: fc.model,
          score: fc.score,
        });
      }
    }
  } catch {
    // Best-effort — model-first must never break routing
  }

  // All ranked candidates (NO cap) — supplement model-first with provider-ranked
  for (const ranked of decision.ranked) {
    if (ranked.provider === decision.provider) continue;
    const key = `${ranked.provider}:default`;
    if (candidates.some(c => c.provider === ranked.provider)) continue;
    candidates.push({
      provider: ranked.provider,
      model: 'default', // Will be resolved at call time
      score: ranked.score,
    });
  }

  // Add fallback chain candidates (from the config's fallback.providers)
  try {
    const fallbackChain = getProviderFallback({} as any).getFallbackChain(decision.provider);
    for (const fb of fallbackChain) {
      if (candidates.some(c => c.provider === fb)) continue;
      candidates.push({
        provider: fb,
        model: 'default',
        score: 0.1, // Low score — these are last-resort
      });
    }
  } catch {
    // Best-effort — fallback chain must never break routing.
  }

  // Sort by score descending (best first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

function isExcluded(
  provider: string,
  sessionFailed: Map<string, { expiresAt: number; kind: FailureKind }>,
  persistedFailures: PersistedFailures,
): boolean {
  const now = Date.now();
  const sessionExcl = sessionFailed.get(provider);
  if (sessionExcl && sessionExcl.expiresAt > now) return true;
  const persisted = persistedFailures[provider];
  if (persisted && persisted.expiresAt > now) return true;
  return false;
}
