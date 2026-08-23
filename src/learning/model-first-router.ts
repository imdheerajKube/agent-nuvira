/**
 * Model-First Router — scores individual models across ALL providers.
 *
 * Design philosophy (from Dheeraj):
 *   "Auto-route should target MODEL not provider. Models have pricing per
 *   million tokens, not providers. Quota is per-provider but should be tracked
 *   per-model-per-provider. User thinks in models, not providers."
 *
 * Architecture:
 *   1. Build MODEL candidate list (all models from all providers)
 *   2. Score EACH model (cost, quota, capability, health, provider infra)
 *   3. Pick BEST model (across all providers)
 *   4. Failover: same model on different provider → different model
 *
 * This replaces the provider-first approach where we scored providers first,
 * then picked a model within the winning provider.
 */

import { getModelRegistry, type ModelRegistryEntry } from './model-registry.js';
import { getCatalogProvider, type CatalogProviderEntry, CATALOG_PROVIDER_IDS } from '../inference/provider-catalog.js';
import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';
import { getTaskType, type TaskType } from './model-router.js';
import { preferredModelsFor } from './model-selection.js';
import { logger } from '../utils/logger.js';
import type { ConfigManager } from '../config/manager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A model candidate across all providers. */
export interface ModelCandidate {
  /** Model identifier (e.g., 'llama-3.3-70b-versatile'). */
  model: string;
  /** Provider serving this model (e.g., 'groq'). */
  provider: string;
  /** Overall score 0-1 (higher is better). */
  score: number;
  /** Individual dimension scores. */
  dimensions: {
    /** Cost per million tokens (lower = cheaper). */
    costPerMToken: number;
    /** Cost score 0-1 (higher = cheaper). */
    costScore: number;
    /** Capability fit for the task (0-1). */
    capabilityFit: number;
    /** Health score (latency + error rate, 0-1). */
    health: number;
    /** Quota availability (0 = exhausted, 1 = full quota). */
    quotaAvailability: number;
    /** Provider speed bonus (0-1). */
    providerSpeed: number;
    /** Verification status (0-1). */
    verification: number;
  };
  /** Human-readable explanation. */
  reason: string;
  /** Registry entry for additional metadata. */
  entry?: ModelRegistryEntry;
  /** Catalog entry for pricing/context. */
  catalog?: CatalogProviderEntry;
}

/** Task requirements extracted from the task description. */
export interface TaskRequirements {
  minContextWindow: number;
  reasoningNeed: 'low' | 'medium' | 'high';
  speedPriority: boolean;
  costPriority: boolean;
  estimatedInputTokens: number;
}

// ─── Task Analysis ──────────────────────────────────────────────────────────

/**
 * Estimate task requirements from description and complexity.
 */
export function estimateTaskRequirements(
  taskDescription: string,
  complexity: ComplexityLevel,
  estimatedInputTokens?: number,
): TaskRequirements {
  const desc = taskDescription.toLowerCase();

  let minContextWindow = 8192;
  if (complexity === 'complex' || complexity === 'critical') minContextWindow = 32768;
  if (complexity === 'critical') minContextWindow = 65536;

  if (desc.includes('refactor') || desc.includes('migration') || desc.includes('large')) {
    minContextWindow = Math.max(minContextWindow, 65536);
  }
  if (desc.includes('architecture') || desc.includes('design') || desc.includes('review')) {
    minContextWindow = Math.max(minContextWindow, 32768);
  }

  let reasoningNeed: 'low' | 'medium' | 'high' = 'medium';
  if (complexity === 'trivial' || complexity === 'simple') reasoningNeed = 'low';
  if (complexity === 'complex' || complexity === 'critical') reasoningNeed = 'high';
  if (desc.includes('security') || desc.includes('audit') || desc.includes('vulnerability')) {
    reasoningNeed = 'high';
  }
  if (desc.includes('hello') || desc.includes('hi') || desc.includes('greeting')) {
    reasoningNeed = 'low';
  }

  const speedPriority = desc.includes('quick') || desc.includes('fast') || desc.includes('urgent')
    || complexity === 'trivial' || complexity === 'simple';

  const costPriority = desc.includes('cheap') || desc.includes('budget') || desc.includes('free');

  return {
    minContextWindow,
    reasoningNeed,
    speedPriority,
    costPriority,
    estimatedInputTokens: estimatedInputTokens || taskDescription.length * 2,
  };
}

// ─── Model Scoring ──────────────────────────────────────────────────────────

/**
 * Score a single model on a specific provider against task requirements.
 */
function scoreModelOnProvider(
  model: string,
  provider: string,
  entry: ModelRegistryEntry | undefined,
  catalog: CatalogProviderEntry | undefined,
  requirements: TaskRequirements,
  providerSpeedBonus: number,
): ModelCandidate['dimensions'] {
  // 1. Cost per million tokens
  const costPerMToken = catalog
    ? ((catalog.pricing.inputPer1K + catalog.pricing.outputPer1K) / 2) * 1000
    : 0.001; // Default cheap

  // Cost score: $0 = 1.0, $0.01 = 0.5, $0.02 = 0.0
  const costScore = Math.max(0, Math.min(1, 1 - (costPerMToken / 0.02)));

  // 2. Capability fit
  let capabilityFit = 0.5;
  const modelLower = model.toLowerCase();
  if (requirements.reasoningNeed === 'high') {
    if (modelLower.includes('70b') || modelLower.includes('gpt-4') || modelLower.includes('claude-3')
      || modelLower.includes('sonnet') || modelLower.includes('opus') || modelLower.includes('pro')) {
      capabilityFit = 1.0;
    } else if (modelLower.includes('8b') || modelLower.includes('small') || modelLower.includes('mini')
      || modelLower.includes('haiku') || modelLower.includes('flash')) {
      capabilityFit = 0.3;
    }
  } else if (requirements.reasoningNeed === 'low') {
    if (modelLower.includes('8b') || modelLower.includes('small') || modelLower.includes('mini')
      || modelLower.includes('haiku') || modelLower.includes('flash') || modelLower.includes('nano')) {
      capabilityFit = 1.0;
    } else if (modelLower.includes('70b') || modelLower.includes('gpt-4') || modelLower.includes('opus')) {
      capabilityFit = 0.4;
    }
  }

  // 3. Health (latency + error rate)
  let health = 0.7; // Default
  if (entry) {
    const latencyScore = entry.latencyMs ? Math.max(0, 1 - (entry.latencyMs / 5000)) : 0.5;
    const errorScore = entry.errorRate !== undefined ? Math.max(0, 1 - entry.errorRate) : 0.7;
    health = (latencyScore * 0.4 + errorScore * 0.6);
  }

  // 4. Quota availability
  let quotaAvailability = 1.0;
  if (entry) {
    if (entry.quotaParkedUntil > Date.now()) {
      quotaAvailability = 0.0; // Exhausted
    } else if (entry.status === 'unavailable') {
      quotaAvailability = 0.1; // Known bad
    } else if (entry.status === 'unverified') {
      quotaAvailability = 0.6; // Not verified yet
    }
  }

  // 5. Provider speed bonus
  const providerSpeed = providerSpeedBonus;

  // 6. Verification status
  let verification = 0.5;
  if (entry?.status === 'verified') verification = 1.0;
  else if (entry?.status === 'unavailable') verification = 0.1;

  return {
    costPerMToken,
    costScore,
    capabilityFit,
    health,
    quotaAvailability,
    providerSpeed,
    verification,
  };
}

/**
 * Build the full model candidate list across all providers.
 * This is the core of model-first routing: instead of scoring providers,
 * we score every model on every provider.
 */
export function buildModelCandidates(
  taskDescription: string,
  complexity: ComplexityLevel,
  configManager?: ConfigManager,
  allowedProviders?: string[],
): ModelCandidate[] {
  const registry = getModelRegistry();
  const requirements = estimateTaskRequirements(taskDescription, complexity);
  const candidates: ModelCandidate[] = [];

  // Determine which providers to consider
  const providers = allowedProviders || CATALOG_PROVIDER_IDS;

  for (const providerId of providers) {
    const catalog = getCatalogProvider(providerId);
    const providerSpeed = catalog?.capabilities.speed || 0.5;

    // Get ALL models for this provider from the registry
    const allModels = registry.getAllModelsForProvider(providerId);

    // If no models in registry, use the catalog's default model
    if (allModels.length === 0 && catalog?.defaultModel) {
      allModels.push({
        provider: providerId,
        model: catalog.defaultModel,
        status: 'unverified' as const,
        lastVerifiedAt: 0,
        lastProbedAt: 0,
        lastUsedAt: 0,
        errorRate: 0,
        quotaParkedUntil: 0,
        source: 'probe' as const,
      });
    }

    for (const modelEntry of allModels) {
      // Skip speech/audio models
      const modelLower = modelEntry.model.toLowerCase();
      if (modelLower.includes('whisper') || modelLower.includes('tts') || modelLower.includes('speech')) {
        continue;
      }

      const dims = scoreModelOnProvider(
        modelEntry.model,
        providerId,
        modelEntry,
        catalog,
        requirements,
        providerSpeed,
      );

      // Weighted score
      const weights = {
        cost: requirements.costPriority ? 0.25 : 0.15,
        capabilityFit: 0.25,
        health: 0.20,
        quotaAvailability: 0.15,
        providerSpeed: requirements.speedPriority ? 0.10 : 0.05,
        verification: 0.10,
      };

      const score = (
        dims.costScore * weights.cost +
        dims.capabilityFit * weights.capabilityFit +
        dims.health * weights.health +
        dims.quotaAvailability * weights.quotaAvailability +
        dims.providerSpeed * weights.providerSpeed +
        dims.verification * weights.verification
      );

      // Build explanation
      const reasons: string[] = [];
      if (dims.costScore > 0.7) reasons.push('cheap');
      if (dims.capabilityFit > 0.8) reasons.push('capability-match');
      if (dims.health > 0.8) reasons.push('healthy');
      if (dims.quotaAvailability >= 1.0) reasons.push('quota-ok');
      if (dims.providerSpeed > 0.8) reasons.push('fast-provider');
      if (dims.verification === 1.0) reasons.push('verified');

      candidates.push({
        model: modelEntry.model,
        provider: providerId,
        score,
        dimensions: dims,
        reason: reasons.length > 0 ? reasons.join(', ') : 'default',
        entry: modelEntry,
        catalog: catalog || undefined,
      });
    }
  }

  // Sort by score (best first)
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Pick the best model candidate for a task.
 * Returns the top candidate, or undefined if no models available.
 */
export function pickBestModelCandidate(
  taskDescription: string,
  complexity: ComplexityLevel,
  configManager?: ConfigManager,
  allowedProviders?: string[],
): ModelCandidate | undefined {
  const candidates = buildModelCandidates(taskDescription, complexity, configManager, allowedProviders);
  return candidates[0];
}

/**
 * Get the top N model candidates for failover.
 */
export function topModelCandidates(
  taskDescription: string,
  complexity: ComplexityLevel,
  n: number = 10,
  configManager?: ConfigManager,
  allowedProviders?: string[],
): ModelCandidate[] {
  const candidates = buildModelCandidates(taskDescription, complexity, configManager, allowedProviders);
  return candidates.slice(0, n);
}

/**
 * Build a failover chain: same model on different providers first,
 * then different models.
 */
export function buildFailoverChain(
  bestCandidate: ModelCandidate,
  allCandidates: ModelCandidate[],
): ModelCandidate[] {
  const chain: ModelCandidate[] = [];

  // Phase 1: Same model on different providers
  const sameModel = allCandidates.filter(
    c => c.model === bestCandidate.model && c.provider !== bestCandidate.provider
  );
  chain.push(...sameModel);

  // Phase 2: Different models (best first)
  const differentModels = allCandidates.filter(
    c => c.model !== bestCandidate.model
  );
  chain.push(...differentModels);

  return chain;
}
