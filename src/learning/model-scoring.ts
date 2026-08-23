/**
 * Model Scoring — task-model matching for intelligent model selection.
 *
 * Problem it solves:
 *   When the auto-router picks a provider (e.g. OpenRouter), it currently
 *   falls back to a hardcoded default model. The registry discovers 300+
 *   models per provider, but they're never used for routing decisions.
 *
 * Solution:
 *   Score each verified model within a provider against task requirements,
 *   picking the BEST model — not just the configured/default one.
 *
 * Scoring dimensions:
 *   1. Context fit — does the model's context window handle the task?
 *   2. Verification status — verified > unverified > unknown
 *   3. Latency — lower is better (measured by spot-checks)
 *   4. Error rate — lower is better (measured by telemetry)
 *   5. Task complexity match — simple tasks → small models, complex → large
 *   6. Cost efficiency — cheaper models preferred when quality is equal
 *
 * Usage:
 *   import { pickBestModel, scoreModels } from './model-scoring.js';
 *   const best = pickBestModel('openrouter', 'implement JWT auth', complexity);
 */

import { getModelRegistry, type ModelRegistryEntry } from './model-registry.js';
import { analyzeComplexity, type ComplexityLevel } from './hybrid-router.js';
import { getCatalogProvider, type CatalogProviderEntry } from '../inference/provider-catalog.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Task requirements extracted from the task description. */
export interface TaskModelRequirements {
  /** Minimum context window needed (tokens). */
  minContextWindow: number;
  /** Desired reasoning level. */
  reasoningNeed: 'low' | 'medium' | 'high';
  /** Whether the task needs fast response. */
  speedPriority: boolean;
  /** Whether cost is a major concern. */
  costPriority: boolean;
  /** Estimated input tokens for this task. */
  estimatedInputTokens: number;
}

/** Score for a single model. */
export interface ModelScore {
  provider: string;
  model: string;
  /** Overall score 0-1 (higher is better). */
  score: number;
  /** Individual dimension scores. */
  dimensions: {
    contextFit: number;
    verification: number;
    latency: number;
    errorRate: number;
    complexityMatch: number;
    costEfficiency: number;
  };
  /** Human-readable explanation. */
  reason: string;
  /** Model registry entry (for additional metadata). */
  entry?: ModelRegistryEntry;
}

// ─── Task Analysis ──────────────────────────────────────────────────────────

/**
 * Estimate task requirements from description and complexity.
 * Maps task text to model selection criteria.
 */
export function estimateTaskRequirements(
  taskDescription: string,
  complexity: ComplexityLevel,
  estimatedInputTokens?: number,
): TaskModelRequirements {
  const desc = taskDescription.toLowerCase();

  // Context window estimation based on task type
  let minContextWindow = 8192; // Default: small model is fine
  if (complexity === 'complex' || complexity === 'critical') {
    minContextWindow = 32768; // Need larger context
  }
  if (complexity === 'critical') {
    minContextWindow = 65536; // Critical tasks need lots of room
  }

  // Task-specific context boosts
  if (desc.includes('refactor') || desc.includes('migration') || desc.includes('large')) {
    minContextWindow = Math.max(minContextWindow, 65536);
  }
  if (desc.includes('architecture') || desc.includes('design') || desc.includes('review')) {
    minContextWindow = Math.max(minContextWindow, 32768);
  }
  if (desc.includes('explain') || desc.includes('summarize') || desc.includes('long')) {
    minContextWindow = Math.max(minContextWindow, 32768);
  }

  // Reasoning need
  let reasoningNeed: 'low' | 'medium' | 'high' = 'medium';
  if (complexity === 'trivial' || complexity === 'simple') {
    reasoningNeed = 'low';
  }
  if (complexity === 'complex' || complexity === 'critical') {
    reasoningNeed = 'high';
  }
  // Task-specific reasoning boosts
  if (desc.includes('security') || desc.includes('audit') || desc.includes('vulnerability')) {
    reasoningNeed = 'high';
  }
  if (desc.includes('creative') || desc.includes('write') || desc.includes('poem')) {
    reasoningNeed = 'high';
  }
  if (desc.includes('hello') || desc.includes('hi') || desc.includes('greeting')) {
    reasoningNeed = 'low';
  }

  // Speed priority
  const speedPriority = desc.includes('quick') || desc.includes('fast') || desc.includes('urgent')
    || complexity === 'trivial' || complexity === 'simple';

  // Cost priority
  const costPriority = desc.includes('cheap') || desc.includes('budget') || desc.includes('free');

  // Estimated input tokens
  const estimatedInputTokensFinal = estimatedInputTokens || taskDescription.length * 2;

  return {
    minContextWindow,
    reasoningNeed,
    speedPriority,
    costPriority,
    estimatedInputTokens: estimatedInputTokensFinal,
  };
}

// ─── Model Scoring ──────────────────────────────────────────────────────────

/**
 * Score a single model against task requirements.
 * Returns 0-1 score (higher is better).
 */
function scoreModel(
  provider: string,
  model: string,
  entry: ModelRegistryEntry | undefined,
  requirements: TaskModelRequirements,
  catalogEntry: CatalogProviderEntry | undefined,
): ModelScore {
  const dimensions = {
    contextFit: 0,
    verification: 0,
    latency: 0,
    errorRate: 0,
    complexityMatch: 0,
    costEfficiency: 0,
  };

  // 1. Context fit (0-1): does the model's context window handle the task?
  if (entry?.contextWindowTokens && entry.contextWindowTokens > 0) {
    const ratio = entry.contextWindowTokens / requirements.minContextWindow;
    dimensions.contextFit = Math.min(1, ratio); // 1.0 = perfect fit, >1.0 = more than enough
  } else {
    // Unknown context window — assume it fits (benefit of doubt for unprobed models)
    dimensions.contextFit = 0.5;
  }

  // 2. Verification status (0-1)
  if (entry?.status === 'verified') {
    dimensions.verification = 1.0;
  } else if (entry?.status === 'unverified') {
    dimensions.verification = 0.6; // Probed but not spot-checked
  } else {
    dimensions.verification = 0.3; // Not in registry at all
  }

  // 3. Latency (0-1): lower is better
  if (entry?.latencyMs !== undefined && entry.latencyMs > 0) {
    // Map latency to score: 0ms = 1.0, 5000ms = 0.0
    dimensions.latency = Math.max(0, 1 - (entry.latencyMs / 5000));
  } else {
    dimensions.latency = 0.5; // Unknown latency — middle ground
  }

  // 4. Error rate (0-1): lower is better
  if (entry?.errorRate !== undefined) {
    dimensions.errorRate = Math.max(0, 1 - entry.errorRate);
  } else {
    dimensions.errorRate = 0.7; // Unknown error rate — slightly optimistic
  }

  // 5. Complexity match (0-1): does the model fit the task complexity?
  // Heuristic: model size/name suggests capability
  const modelLower = model.toLowerCase();
  let complexityScore = 0.5; // Default: moderate

  // Large/complex models for high reasoning
  if (requirements.reasoningNeed === 'high') {
    if (modelLower.includes('70b') || modelLower.includes('gpt-4') || modelLower.includes('claude-3')
      || modelLower.includes('sonnet') || modelLower.includes('opus') || modelLower.includes('pro')) {
      complexityScore = 1.0;
    } else if (modelLower.includes('8b') || modelLower.includes('small') || modelLower.includes('mini')
      || modelLower.includes('haiku') || modelLower.includes('flash')) {
      complexityScore = 0.3;
    }
  } else if (requirements.reasoningNeed === 'low') {
    // Small/fast models for simple tasks
    if (modelLower.includes('8b') || modelLower.includes('small') || modelLower.includes('mini')
      || modelLower.includes('haiku') || modelLower.includes('flash') || modelLower.includes('nano')) {
      complexityScore = 1.0;
    } else if (modelLower.includes('70b') || modelLower.includes('gpt-4') || modelLower.includes('opus')) {
      complexityScore = 0.4; // Overkill for simple tasks
    }
  }
  dimensions.complexityMatch = complexityScore;

  // 6. Cost efficiency (0-1): cheaper is better when quality is equal
  const catalogPricing = catalogEntry?.pricing;
  if (catalogPricing) {
    // Map cost to score: $0 = 1.0, $0.01/1K = 0.0
    const avgCost = (catalogPricing.inputPer1K + catalogPricing.outputPer1K) / 2;
    dimensions.costEfficiency = Math.max(0, 1 - (avgCost / 0.01));
  } else {
    dimensions.costEfficiency = 0.5; // Unknown cost
  }

  // Weighted score based on task requirements
  const weights = {
    contextFit: requirements.minContextWindow > 32768 ? 0.25 : 0.15,
    verification: 0.20,
    latency: requirements.speedPriority ? 0.20 : 0.10,
    errorRate: 0.15,
    complexityMatch: 0.15,
    costEfficiency: requirements.costPriority ? 0.15 : 0.05,
  };

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const score = Object.entries(dimensions).reduce((sum, [key, val]) => {
    return sum + (val * (weights[key as keyof typeof weights] || 0));
  }, 0) / totalWeight;

  // Build explanation
  const reasons: string[] = [];
  if (dimensions.contextFit >= 0.8) reasons.push('context fits');
  if (dimensions.verification === 1.0) reasons.push('verified');
  if (dimensions.latency > 0.7) reasons.push('fast');
  if (dimensions.errorRate > 0.9) reasons.push('reliable');
  if (dimensions.complexityMatch > 0.8) reasons.push('complexity-matched');
  if (dimensions.costEfficiency > 0.7) reasons.push('cost-effective');

  return {
    provider,
    model,
    score,
    dimensions,
    reason: reasons.length > 0 ? reasons.join(', ') : 'default',
    entry,
  };
}

/**
 * Score all verified models within a provider for a given task.
 * Returns models ranked by score (best first).
 */
export function scoreModels(
  provider: string,
  taskDescription: string,
  complexity?: ComplexityLevel,
  estimatedInputTokens?: number,
): ModelScore[] {
  const registry = getModelRegistry();
  const catalogEntry = getCatalogProvider(provider);
  const resolvedComplexity = complexity || analyzeComplexity(taskDescription);
  const requirements = estimateTaskRequirements(taskDescription, resolvedComplexity, estimatedInputTokens);

  // Get ALL tracked models for this provider (verified + unverified + unavailable)
  const allModels = registry.getAllModelsForProvider(provider);

  // If no models in registry, return empty (caller falls back to configured model)
  if (allModels.length === 0) {
    return [];
  }

  // Score each model
  const scores: ModelScore[] = [];
  for (const modelEntry of allModels) {
    scores.push(scoreModel(provider, modelEntry.model, modelEntry, requirements, catalogEntry));
  }

  // Sort by score (best first)
  scores.sort((a, b) => b.score - a.score);

  return scores;
}

/**
 * Pick the best model for a provider given a task.
 * Returns the best model string, or undefined if no models available.
 */
export function pickBestModel(
  provider: string,
  taskDescription: string,
  complexity?: ComplexityLevel,
  estimatedInputTokens?: number,
): string | undefined {
  const scores = scoreModels(provider, taskDescription, complexity, estimatedInputTokens);
  if (scores.length === 0) return undefined;
  return scores[0].model;
}

/**
 * Get the top N model candidates for a provider.
 * Used for fallback chain and learning.
 */
export function topModelCandidates(
  provider: string,
  taskDescription: string,
  n: number = 5,
  complexity?: ComplexityLevel,
  estimatedInputTokens?: number,
): ModelScore[] {
  const scores = scoreModels(provider, taskDescription, complexity, estimatedInputTokens);
  return scores.slice(0, n);
}
