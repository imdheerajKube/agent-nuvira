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
import { type ModelRegistryEntry } from './model-registry.js';
import { type ComplexityLevel } from './hybrid-router.js';
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
/**
 * Estimate task requirements from description and complexity.
 * Maps task text to model selection criteria.
 */
export declare function estimateTaskRequirements(taskDescription: string, complexity: ComplexityLevel, estimatedInputTokens?: number): TaskModelRequirements;
/**
 * Score all verified models within a provider for a given task.
 * Returns models ranked by score (best first).
 */
export declare function scoreModels(provider: string, taskDescription: string, complexity?: ComplexityLevel, estimatedInputTokens?: number): ModelScore[];
/**
 * Pick the best model for a provider given a task.
 * Returns the best model string, or undefined if no models available.
 */
export declare function pickBestModel(provider: string, taskDescription: string, complexity?: ComplexityLevel, estimatedInputTokens?: number): string | undefined;
/**
 * Get the top N model candidates for a provider.
 * Used for fallback chain and learning.
 */
export declare function topModelCandidates(provider: string, taskDescription: string, n?: number, complexity?: ComplexityLevel, estimatedInputTokens?: number): ModelScore[];
//# sourceMappingURL=model-scoring.d.ts.map