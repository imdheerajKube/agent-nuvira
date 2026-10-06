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
import { hasCredentials, preferredModelsFor, KEYLESS_PROVIDERS } from './model-selection.js';
import { isNonChatModel } from '../inference/model-catalog.js';
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
  // 1. Cost per million tokens — use per-model pricing when available
  //    Fallback to catalog provider-level pricing
  const modelLower = model.toLowerCase();
  let costPerMToken = catalog
    ? ((catalog.pricing.inputPer1K + catalog.pricing.outputPer1K) / 2) * 1000
    : 0.001;

  // Override with known per-model pricing (more accurate than provider averages)
  if (modelLower.includes('gpt-4o-mini') || modelLower.includes('gpt-4o-nano')) costPerMToken = 0.0003;
  else if (modelLower.includes('gpt-4o') && !modelLower.includes('mini')) costPerMToken = 0.005;
  else if (modelLower.includes('claude-3-5-haiku') || modelLower.includes('claude-3-haiku')) costPerMToken = 0.0004;
  else if (modelLower.includes('claude-3-5-sonnet') || modelLower.includes('claude-sonnet')) costPerMToken = 0.003;
  else if (modelLower.includes('claude-opus')) costPerMToken = 0.015;
  else if (modelLower.includes('gemini-flash') || modelLower.includes('gemini-2.0-flash')) costPerMToken = 0.0001;
  else if (modelLower.includes('gemini-pro') && !modelLower.includes('lite')) costPerMToken = 0.00125;
  else if (modelLower.includes('mistral-small')) costPerMToken = 0.0002;
  else if (modelLower.includes('mistral-large') || modelLower.includes('mistral-medium')) costPerMToken = 0.002;
  else if (modelLower.includes('llama-3.3-70b') || modelLower.includes('llama3.3-70b')) costPerMToken = 0.0007;
  else if (modelLower.includes('llama-3.1-8b') || modelLower.includes('llama3.1-8b') || modelLower.includes('llama-3-8b')) costPerMToken = 0.0001;
  else if (modelLower.includes('deepseek-coder')) costPerMToken = 0.0002;
  else if (modelLower.includes('command-r-plus')) costPerMToken = 0.003;
  else if (modelLower.includes('command-r') && !modelLower.includes('plus')) costPerMToken = 0.0005;
  else if (modelLower.includes('o1-') || modelLower.includes('o3-') || modelLower.includes('o4-')) costPerMToken = 0.01;
  else if (modelLower.includes('davinci') || modelLower.includes('codex')) costPerMToken = 0.01;
  // Local models are always free
  else if (provider === 'local' || provider === 'lmstudio' || provider === 'vllm') costPerMToken = 0;

  // Cost score: $0 = 1.0, $0.01 = 0.5, $0.02+ = 0.0
  const costScore = Math.max(0, Math.min(1, 1 - (costPerMToken / 0.02)));

  // Filter out non-chat models (safety, embedding, guard, image, audio, video,
  // research) — the shared classifier is the single source of truth, so this
  // list can never drift from the probe/registry filters.
  if (isNonChatModel(model)) return { costPerMToken: 0, costScore: 0, capabilityFit: 0, health: 0, quotaAvailability: 0, providerSpeed: 0, verification: 0 };

  // 2. Capability fit — score by model SIZE relative to task complexity
  let capabilityFit = 0.5;
  // Detect model size from name (b = billion parameters).
  //
  // P6 (fix_model_routing) — MOE ACTIVE PARAMETERS COUNT, NOT TOTAL ONES. A
  // mixture-of-experts name like `gemma-4-26b-a4b-it` holds 26B parameters but
  // routes each token through ~4B of them, and it is the ACTIVE width that
  // decides whether a model can hold a multi-step agentic task — which is why
  // the tag is in the name at all. The naive parse read `26b` and ranked it as a
  // MEDIUM model with capabilityFit 1.0, measured live as the #1 pick (0.87)
  // above `gemini-3.1-flash-lite`, during the very run that then returned five
  // empty responses in a row. Reading the active width is not a heuristics
  // rewrite: it is reading the number the provider published.
  const sizeMatch = modelLower.match(/(\d+\.?\d*)b/);
  const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 0;
  const activeMatch = modelLower.match(/a(\d+\.?\d*)b/);
  const activeB = activeMatch ? parseFloat(activeMatch[1]) : 0;
  const effectiveB = activeB > 0 && (sizeB === 0 || activeB < sizeB) ? activeB : sizeB;

  // Per-model pricing that depends on size detection
  if (modelLower.includes('qwen') && sizeB >= 70) costPerMToken = 0.0009;
  else if (modelLower.includes('qwen') && sizeB > 0) costPerMToken = 0.0001;

  // Known large models (70B+ params or known high-capability closed models)
  const isLargeModel = effectiveB >= 70
    || modelLower.includes('gpt-4o') && !modelLower.includes('mini')
    || modelLower.includes('claude-3') && !modelLower.includes('haiku')
    || modelLower.includes('sonnet') || modelLower.includes('opus')
    || modelLower.includes('o1') || modelLower.includes('o3') || modelLower.includes('o4')
    || (modelLower.includes('gemini') && (modelLower.includes('pro') && !modelLower.includes('nano')));

  // Known medium models (8B-70B or known mid-tier closed models)
  const isMediumModel = (effectiveB >= 8 && effectiveB < 70)
    || modelLower.includes('gpt-4o-mini') || modelLower.includes('gpt-4o-nano')
    || modelLower.includes('haiku') || modelLower.includes('flash')
    || (modelLower.includes('gemini') && (modelLower.includes('flash') || modelLower.includes('lite')))
    || modelLower.includes('mistral-small') || modelLower.includes('mistral-medium')
    || modelLower.includes('command-r') && !modelLower.includes('plus');

  // Known small models (<8B or known lightweight)
  const isSmallModel = (effectiveB > 0 && effectiveB < 8)
    || modelLower.includes('nano') || modelLower.includes('0.5b') || modelLower.includes('micro')
    || modelLower.includes('turbo') && !modelLower.includes('gpt')
    || modelLower.includes('lite') || modelLower.includes('tiny') || modelLower.includes('mini') && sizeB > 0;

  if (requirements.reasoningNeed === 'high') {
    if (isLargeModel) capabilityFit = 1.0;
    else if (isMediumModel) capabilityFit = 0.6;
    else if (isSmallModel) capabilityFit = 0.2;
  } else if (requirements.reasoningNeed === 'medium') {
    if (isLargeModel) capabilityFit = 0.8;
    else if (isMediumModel) capabilityFit = 1.0;
    else if (isSmallModel) capabilityFit = 0.4;
  } else {
    // low reasoning — prefer small/fast models
    if (isSmallModel) capabilityFit = 1.0;
    else if (isMediumModel) capabilityFit = 0.8;
    else if (isLargeModel) capabilityFit = 0.5; // Overkill
  }

  // P6 — EVIDENCE, not a name. A pair the registry has already judged
  // `unavailable` (repeated real failures — including the empty-response park
  // the routing fixes now record) must not keep presenting itself as a
  // capability match for the task. `isCandidateAvailable` filters such an entry
  // out of the tiered chain, but SCORING still ranked it as if it were healthy,
  // so any caller that reads the ranking (or the report derived from it) saw an
  // unfit model near the top. Capability is the dimension that claims "can do
  // this" — it is exactly the one an availability ruling must limit.
  if (entry?.status === 'unavailable') capabilityFit = Math.min(capabilityFit, 0.2);

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
 * P6 (fix_model_routing) — POOL HYGIENE: could this provider really serve this
 * model id?
 *
 * The registry can hold pairs that are syntactically fine and physically
 * impossible, and a `verified` status on one of them is worse than useless — it
 * spends a fallback slot, a round trip, and (as an "eligible model") credibility
 * on a call that cannot succeed. Observed on disk: `gemini/qwen2.5:0.5b` and
 * `groq/wire-stub-model` marked verified.
 *
 * Deliberately CONSERVATIVE — only two rules, both of which are decidable from
 * the id alone:
 *
 *   1. An Ollama-style TAGGED id (`name:tag`) is a LOCAL runner's naming
 *      scheme. A hosted provider does not serve `qwen2.5:0.5b`; the `:tag` form
 *      belongs to the local-ops providers (see KEYLESS_PROVIDERS).
 *   2. Stub/fixture ids (`wire-stub-model`, `test-…`, `…-stub`) come from test
 *      harnesses and must never be routed to.
 *
 * Anything needing a catalog to adjudicate (a vendor that does not serve a
 * family) is NOT guessed at here: a wrong exclusion silently removes a working
 * model, which is the more expensive mistake.
 */
export function isPairPlausible(provider: string, model: string): boolean {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return false;
  // 2. Fixture/stub ids.
  if (/^(wire-|test-|fixture-|stub-)/.test(id) || /-stub(-|$)|\.stub\./.test(id)) return false;
  // 1. Ollama-style tags only on a local runner.
  if (id.includes(':')) {
    const localRunner = KEYLESS_PROVIDERS.includes(provider) || provider === 'ollama';
    if (!localRunner) return false;
  }
  return true;
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
    // ── P5 (fix_model_routing) — A CREDENTIAL GATE, so the pool is CALLABLE ──
    // Without this the candidate list (and every count derived from it) included
    // providers the user has NO credential for. Measured on this machine: the
    // pool claimed 538 models across 23 "providers" — openai, anthropic, xai,
    // perplexity, bedrock, omniroute… all keyless here — while only 17 pairs had
    // ever been verified. A report that can say "538 models are available"
    // cannot be trusted when it says "no model can do this", and the ranking it
    // produces is dominated by providers that would 401. Gated only when a
    // ConfigManager is supplied (every real routing path passes one); callers
    // that deliberately want the raw catalog — a probe sweep, a test — still get
    // the unfiltered list, and `countEligibleModels` keeps its old behaviour
    // rather than silently changing the meaning of an existing number.
    if (configManager && !hasCredentials(configManager, providerId)) continue;
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
      // A DEAD PAIR — the provider itself answered "model not found" for this
      // exact model (see ModelRegistryEntry.deadPair) — is never offered again.
      // It cannot serve a request, so including it spends a fallback slot and a
      // 404 round trip that a servable sibling should have had. Observed live:
      // the pool offered `local/gemini-3.1-flash-lite` (an Ollama runner cannot
      // serve a Google model) on every walk until this filter existed.
      if (registry.isDeadPair(providerId, modelEntry.model)) continue;
      // P6 — a pair that CANNOT exist is not a candidate: an Ollama-tagged id on
      // a hosted provider, or a test fixture. Same class as the dead-pair filter
      // above, decided from the id instead of from a past 404 (see
      // `isPairPlausible`).
      if (!isPairPlausible(providerId, modelEntry.model)) continue;
      // Skip speech/audio/video/image/research models early
      const modelLower = modelEntry.model.toLowerCase();
      if (modelLower.includes('whisper') || modelLower.includes('tts') || modelLower.includes('speech')
        || modelLower.includes('-image') || modelLower.includes('banana') || modelLower.includes('lyria')
        || modelLower.includes('imagen') || modelLower.includes('veo') || modelLower.includes('video')
        || modelLower.includes('deep-research') || modelLower.includes('grounding')
        || modelLower.includes('audio') || modelLower.includes('caption')) {
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

      // Weighted score — weights shift by complexity:
      // Critical/complex tasks: capabilityFit dominates (0.40), cost shrinks (0.10)
      // Simple/trivial tasks: cost dominates (0.30), capabilityFit relaxes (0.15)
      const isHighStakes = requirements.reasoningNeed === 'high';
      const isLowStakes = requirements.reasoningNeed === 'low';
      const weights = {
        cost: isHighStakes ? 0.10 : isLowStakes ? 0.30 : requirements.costPriority ? 0.25 : 0.15,
        capabilityFit: isHighStakes ? 0.40 : isLowStakes ? 0.15 : 0.25,
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
 * Count what the pool ACTUALLY offers right now.
 *
 * WHY THIS EXISTS (G9): the failure report used to decide its closing sentence
 * from the PARK list alone — and a dead pair (a provider that answered "model
 * not found") has no expiry, so a report whose only exclusions were dead pairs
 * printed "No suitable model is available right now". Live, that sentence was
 * shown while 507 models were eligible and the provider served a request 52
 * seconds later. A report that cannot count the pool cannot claim it is empty,
 * so the count is computed through the SAME filtering the router uses (dead
 * pairs + non-chat models excluded) — the report can never disagree with what
 * routing would actually consider.
 */
export function countEligibleModels(
  allowedProviders?: string[],
  configManager?: ConfigManager,
): { models: number; providers: number } {
  try {
    // A neutral, class-agnostic description: we want the SIZE of the pool, not
    // a ranking. Complexity only shifts score weights, never eligibility.
    //
    // P5: when a ConfigManager is supplied the count is CREDENTIALED — it is the
    // set routing would actually try, not the catalog. Without it the count is
    // the legacy filter-only number, which must never be used to justify a
    // shortage claim ("no model is available") — it counts models this machine
    // has no key for.
    const candidates = buildModelCandidates('general task', 'moderate' as ComplexityLevel, configManager, allowedProviders);
    const providers = new Set<string>();
    for (const c of candidates) providers.add(c.provider);
    return { models: candidates.length, providers: providers.size };
  } catch {
    return { models: 0, providers: 0 };
  }
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

/**
 * Capability tiers for tiered failover.
 * When a model fails, we escalate through tiers:
 *   suitable -> higher -> cheaper -> local -> neural response
 */
export type CapabilityTier = 'high' | 'medium' | 'low' | 'local';

/**
 * Classify a model into a capability tier.
 */
export function classifyTier(candidate: ModelCandidate): CapabilityTier {
  if (candidate.provider === 'local' || candidate.provider === 'lmstudio' || candidate.provider === 'vllm') {
    return 'local';
  }
  if (candidate.dimensions.capabilityFit >= 0.8) return 'high';
  if (candidate.dimensions.capabilityFit >= 0.5) return 'medium';
  return 'low';
}

/**
 * Check if a model candidate has available quota (not parked, not blocked).
 */
export function isCandidateAvailable(candidate: ModelCandidate): boolean {
  // Check quota parking from registry entry
  if (candidate.entry) {
    if (candidate.entry.quotaParkedUntil > Date.now()) return false;
    if (candidate.entry.status === 'unavailable') return false;
  }
  // Check if model is a non-chat model (filtered in scoring but double-check)
  if (candidate.dimensions.capabilityFit === 0 && candidate.dimensions.health === 0) return false;
  return true;
}

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
export function buildTieredFailoverChain(
  bestCandidate: ModelCandidate,
  allCandidates: ModelCandidate[],
): FailoverTier[] {
  const bestTier = classifyTier(bestCandidate);
  const tried = new Set<string>();
  tried.add(`${bestCandidate.provider}:${bestCandidate.model}`);

  const tiers: FailoverTier[] = [];

  // Phase 1: Same model on different providers (fastest transition)
  const sameModelDifferentProvider = allCandidates.filter(
    c => c.model === bestCandidate.model
      && c.provider !== bestCandidate.provider
      && !tried.has(`${c.provider}:${c.model}`)
      && isCandidateAvailable(c)
  );
  if (sameModelDifferentProvider.length > 0) {
    tiers.push({
      phase: 'same-model',
      description: `Same model (${bestCandidate.model}) on different provider`,
      candidates: sameModelDifferentProvider,
    });
    sameModelDifferentProvider.forEach(c => tried.add(`${c.provider}:${c.model}`));
  }

  // Phase 2: Same capability tier, different models (pre-check quota)
  const sameTier = allCandidates.filter(
    c => classifyTier(c) === bestTier
      && c.model !== bestCandidate.model
      && !tried.has(`${c.provider}:${c.model}`)
      && isCandidateAvailable(c)
  );
  if (sameTier.length > 0) {
    tiers.push({
      phase: 'same-tier',
      description: `Same capability tier (${bestTier}), different models`,
      candidates: sameTier,
    });
    sameTier.forEach(c => tried.add(`${c.provider}:${c.model}`));
  }

  // Phase 3: Escalate to higher tier (pre-check quota)
  const higherTiers: CapabilityTier[] = bestTier === 'low' ? ['medium', 'high']
    : bestTier === 'medium' ? ['high']
    : [];
  for (const tier of higherTiers) {
    const escalation = allCandidates.filter(
      c => classifyTier(c) === tier
        && !tried.has(`${c.provider}:${c.model}`)
        && isCandidateAvailable(c)
    );
    if (escalation.length > 0) {
      tiers.push({
        phase: 'escalate',
        description: `Escalate to ${tier} tier`,
        candidates: escalation,
      });
      escalation.forEach(c => tried.add(`${c.provider}:${c.model}`));
    }
  }

  // Phase 4: De-escalate to lower tier, cheaper models (pre-check quota)
  const lowerTiers: CapabilityTier[] = bestTier === 'high' ? ['medium', 'low']
    : bestTier === 'medium' ? ['low']
    : [];
  for (const tier of lowerTiers) {
    const deescalation = allCandidates.filter(
      c => classifyTier(c) === tier
        && !tried.has(`${c.provider}:${c.model}`)
        && isCandidateAvailable(c)
    );
    if (deescalation.length > 0) {
      tiers.push({
        phase: 'de-escalate',
        description: `De-escalate to ${tier} tier (cheaper)`,
        candidates: deescalation,
      });
      deescalation.forEach(c => tried.add(`${c.provider}:${c.model}`));
    }
  }

  // Phase 5: Local models (always available, last resort before neural)
  const localModels = allCandidates.filter(
    c => classifyTier(c) === 'local'
      && !tried.has(`${c.provider}:${c.model}`)
  );
  if (localModels.length > 0) {
    tiers.push({
      phase: 'local',
      description: 'Local model (always available)',
      candidates: localModels,
    });
    localModels.forEach(c => tried.add(`${c.provider}:${c.model}`));
  }

  // Phase 6: Any remaining available models (last resort)
  const remaining = allCandidates.filter(
    c => !tried.has(`${c.provider}:${c.model}`)
      && isCandidateAvailable(c)
  );
  if (remaining.length > 0) {
    tiers.push({
      phase: 'remaining',
      description: 'Any remaining available models',
      candidates: remaining,
    });
  }

  return tiers;
}

/** A tier in the failover chain. */
export interface FailoverTier {
  phase: 'same-model' | 'same-tier' | 'escalate' | 'de-escalate' | 'local' | 'remaining';
  description: string;
  candidates: ModelCandidate[];
}
