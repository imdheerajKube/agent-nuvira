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
import { type ModelRegistryEntry } from './model-registry.js';
import { type CatalogProviderEntry } from '../inference/provider-catalog.js';
import { type ComplexityLevel } from './hybrid-router.js';
import type { ConfigManager } from '../config/manager.js';
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
/**
 * Estimate task requirements from description and complexity.
 */
export declare function estimateTaskRequirements(taskDescription: string, complexity: ComplexityLevel, estimatedInputTokens?: number): TaskRequirements;
/**
 * Build the full model candidate list across all providers.
 * This is the core of model-first routing: instead of scoring providers,
 * we score every model on every provider.
 */
export declare function buildModelCandidates(taskDescription: string, complexity: ComplexityLevel, configManager?: ConfigManager, allowedProviders?: string[]): ModelCandidate[];
/**
 * Pick the best model candidate for a task.
 * Returns the top candidate, or undefined if no models available.
 */
export declare function pickBestModelCandidate(taskDescription: string, complexity: ComplexityLevel, configManager?: ConfigManager, allowedProviders?: string[]): ModelCandidate | undefined;
/**
 * Get the top N model candidates for failover.
 */
export declare function topModelCandidates(taskDescription: string, complexity: ComplexityLevel, n?: number, configManager?: ConfigManager, allowedProviders?: string[]): ModelCandidate[];
/**
 * Build a failover chain: same model on different providers first,
 * then different models.
 */
export declare function buildFailoverChain(bestCandidate: ModelCandidate, allCandidates: ModelCandidate[]): ModelCandidate[];
/**
 * Capability tiers for tiered failover.
 * When a model fails, we escalate through tiers:
 *   suitable -> higher -> cheaper -> local -> neural response
 */
export type CapabilityTier = 'high' | 'medium' | 'low' | 'local';
/**
 * Classify a model into a capability tier.
 */
export declare function classifyTier(candidate: ModelCandidate): CapabilityTier;
/**
 * Check if a model candidate has available quota (not parked, not blocked).
 */
export declare function isCandidateAvailable(candidate: ModelCandidate): boolean;
/**
 * Build a TIERED failover chain with quota pre-check.
 *
 * Strategy (Dheeraj's design):
 *   1. PRIMARY: Best scored model
 *   2. SAME-TIER: Same capability tier, different provider (pre-check quota)
 *   3. ESCALATE: Next higher tier (pre-check quota)
 *   4. DE-ESCALATE: Lower tier, cheaper models (pre-check quota)
 *   5. LOCAL: Local model (always available)
 *   6. NEURAL: Graceful "all exhausted" (no error)
 *
 * Each phase skips quota-parked models to avoid unnecessary API failures.
 */
export declare function buildTieredFailoverChain(bestCandidate: ModelCandidate, allCandidates: ModelCandidate[]): FailoverTier[];
/** A tier in the failover chain. */
export interface FailoverTier {
    phase: 'same-model' | 'same-tier' | 'escalate' | 'de-escalate' | 'local' | 'remaining';
    description: string;
    candidates: ModelCandidate[];
}
//# sourceMappingURL=model-first-router.d.ts.map