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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAutoRouter } from './auto-router.js';
import { analyzeComplexity } from './hybrid-router.js';
import { buildAutoResolveOptions } from './resolve-options.js';
import { buildModelCandidates, buildTieredFailoverChain } from './model-first-router.js';
import { recordModelUsage } from './model-warmup.js';
import { resolveWorkingModel } from '../inference/model-validator.js';
import { getDefaultModel } from '../inference/provider-catalog.js';
import { getModelRegistry } from './model-registry.js';
import { recordActionFailure } from './failure-bookkeeping.js';
import { getProviderFallback, recordRegistrySuccess } from './provider-fallback.js';
import { ProviderFactory } from '../inference/factory.js';
import { recordRoutingDecision } from './routing-history.js';
import { EventNames, getEventBus } from '../observability/event-bus.js';
import { logger } from '../utils/logger.js';
/** Key for a model-scoped exclusion / persisted failure. */
function modelKey(provider, model) {
    return `${provider}|${model}`;
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
function classifyFailure(err) {
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
function exclusionDuration(kind) {
    switch (kind) {
        case 'auth': return AUTH_FAILURE_EXCLUSION_MS;
        case 'rate-limit': return RATE_LIMIT_EXCLUSION_MS;
        case 'timeout': return NETWORK_FAILURE_EXCLUSION_MS;
        case 'network': return NETWORK_FAILURE_EXCLUSION_MS;
        case 'model-not-found': return MODEL_NOT_FOUND_EXCLUSION_MS;
        case 'unknown': return NETWORK_FAILURE_EXCLUSION_MS;
    }
}
function loadPersistedFailures() {
    try {
        const path = join(homedir(), '.nuvira', FAILURE_PERSIST_PATH);
        if (!existsSync(path))
            return {};
        const raw = readFileSync(path, 'utf-8');
        const data = JSON.parse(raw);
        const now = Date.now();
        // Clean expired entries
        for (const key of Object.keys(data)) {
            if (data[key].expiresAt <= now)
                delete data[key];
        }
        return data;
    }
    catch {
        return {};
    }
}
/**
 * Persist a failure for cross-pipeline memory. When the failing MODEL is known
 * the entry is keyed `provider|model` so a sibling model on the same provider
 * is still routable in the next process; without a model it stays
 * provider-wide (the legacy, honest answer).
 */
function persistFailure(provider, kind, model) {
    try {
        const dir = join(homedir(), '.nuvira');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const path = join(dir, FAILURE_PERSIST_PATH);
        const existing = loadPersistedFailures();
        const key = model && model !== 'default' ? modelKey(provider, model) : provider;
        existing[key] = {
            expiresAt: Date.now() + exclusionDuration(kind),
            kind,
            recordedAt: Date.now(),
        };
        writeFileSync(path, JSON.stringify(existing, null, 2));
    }
    catch {
        // Best-effort — persistence must never break routing.
    }
}
// ─── Provider Resolution ────────────────────────────────────────────────────
function resolveProviderAdapter(configManager, providerType) {
    try {
        const { type, config } = configManager.getProviderConfig(providerType);
        return ProviderFactory.createProvider(type, config);
    }
    catch {
        return null;
    }
}
function resolveDesiredModel(autoRouter, providerType, agentType, configManager, taskDescription) {
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
export function createResilientCallLLM(configManager, options) {
    const autoRouter = getAutoRouter();
    const state = {
        sessionFailed: new Map(),
        sessionFailedModels: new Map(),
        currentAttempt: 0,
        currentProvider: '',
        currentModel: '',
        exhausted: false,
    };
    // Load cross-pipeline failures
    const persistedFailures = options.crossPipelineMemory !== false ? loadPersistedFailures() : {};
    // Initial routing decision
    const initialDecision = resolveWithExclusions(autoRouter, configManager, options.task, state.sessionFailed, persistedFailures, options.verbose);
    if (initialDecision) {
        state.currentProvider = initialDecision.provider;
        state.currentModel = initialDecision.model;
    }
    // Build the ranked candidate list (all candidates, no cap)
    // Pass task description + complexity for model-first failover
    const allCandidates = buildDeepFailoverPool(initialDecision, {
        taskDescription: options.task.description,
        complexity: options.task.complexity ? analyzeComplexity(options.task.description) : undefined,
        configManager,
    });
    // ONE shared exclusion predicate (session provider-wide + session per-model +
    // cross-pipeline persisted + registry per-entry). The session maps are read
    // LIVE, so a failure recorded mid-walk takes effect on the next candidate.
    const failoverFilter = createFailoverExclusionFilter({
        sessionFailed: state.sessionFailed,
        sessionFailedModels: state.sessionFailedModels,
        crossPipelineMemory: options.crossPipelineMemory !== false,
        persistedFailures,
    });
    // The resilient callLLM
    const callLLM = async (prompt, inferenceOptions) => {
        if (state.exhausted) {
            throw new Error(`All LLM providers exhausted. No more candidates available for: ${options.task.description}`);
        }
        // Try current provider first, then walk all candidates
        const candidatesToTry = [
            { provider: state.currentProvider, model: state.currentModel, score: 1.0 },
            ...allCandidates.filter(c => c.provider !== state.currentProvider ||
                c.model !== state.currentModel),
        ];
        let lastError = null;
        for (const candidate of candidatesToTry) {
            // MODEL-scoped exclusions are honored before provider-wide ones, and the
            // registry is checked per ENTRY: a failed or parked model rules out only
            // itself, so the provider's other candidates in this list stay reachable
            // (deep failover). Shared with chat/execute via the same factory.
            if (failoverFilter(candidate.provider, candidate.model)) {
                if (options.verbose) {
                    logger.debug(`   ⏭️  ${candidate.provider}/${candidate.model} excluded (failure or registry) — skipping`);
                }
                continue;
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
            }
            catch {
                continue;
            }
            // Try the call
            try {
                // Resolve the model at call time (ScoredProvider doesn't carry model)
                let resolvedModel = candidate.model === 'default'
                    ? resolveDesiredModel(autoRouter, candidate.provider, options.task.agentType, configManager, options.task.description)
                    : candidate.model;
                // CRITICAL: 'default' is a sentinel that must NEVER reach a provider API.
                // resolveDesiredModel may return 'default' when the registry is cold and
                // the config has model:'default'. Resolve through the live model list so
                // the API call always uses a real model name (e.g. 'llama-3.3-70b-versatile').
                if (!resolvedModel || resolvedModel === 'default') {
                    try {
                        const adapter = resolveProviderAdapter(configManager, candidate.provider);
                        if (adapter) {
                            resolvedModel = await resolveWorkingModel(adapter, candidate.provider, resolvedModel);
                        }
                    }
                    catch {
                        // Best-effort — fall through to the catalog's curated default
                        try {
                            resolvedModel = getDefaultModel(candidate.provider);
                        }
                        catch {
                            // Last resort — never send 'default' to an API
                            resolvedModel = 'unknown';
                        }
                    }
                }
                const mergedOptions = {
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
                }
                catch {
                    // Best-effort.
                }
                // Record usage for warmup daemon
                try {
                    recordModelUsage(candidate.provider, resolvedModel);
                }
                catch {
                    // Best-effort — warmup must never break routing
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
            }
            catch (err) {
                lastError = err;
                state.currentAttempt++;
                // Classify and record the failure
                const kind = classifyFailure(err);
                const duration = exclusionDuration(kind);
                // PER-MODEL EXCLUSION when the failing model is known. Excluding the
                // whole provider here is what stopped a provider's 2nd-best model from
                // ever being tried: one 429 on model A took models B and C with it.
                // Only a failure that indicts the whole provider (auth: the key is
                // dead) still records a provider-wide exclusion.
                const failedModel = candidate.model;
                const modelScoped = kind !== 'auth' && !!failedModel && failedModel !== 'default';
                if (modelScoped) {
                    state.sessionFailedModels.set(modelKey(candidate.provider, failedModel), {
                        expiresAt: Date.now() + duration,
                        kind,
                    });
                }
                else {
                    state.sessionFailed.set(candidate.provider, {
                        expiresAt: Date.now() + duration,
                        kind,
                    });
                }
                // Persist for cross-pipeline memory
                if (options.crossPipelineMemory !== false) {
                    persistFailure(candidate.provider, kind, modelScoped ? failedModel : undefined);
                }
                // Record failure in shared bookkeeping
                try {
                    const session = {
                        sessionFailedProviders: new Map([[candidate.provider, Date.now() + duration]]),
                        sessionTransientFailedProviders: new Set(),
                    };
                    recordActionFailure(session, candidate.provider, err, configManager, { model: candidate.model, action: options.task.agentType });
                }
                catch {
                    // Best-effort.
                }
                // Emit failover event
                try {
                    getEventBus().emit(EventNames.ORCHESTRATOR_AGENT_UPDATE, {
                        agentType: options.task.agentType,
                        stage: 'routing',
                        message: `⚠️ ${candidate.provider} failed (${kind}) — trying next candidate`,
                    }, 'orchestrator');
                }
                catch {
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
        throw new Error(`All LLM providers exhausted for: ${options.task.description}. ` +
            `Tried ${candidatesToTry.length} candidates. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    };
    // Expose metadata for debugging
    callLLM.__resilient = {
        getState: () => ({ ...state }),
        getCandidates: () => [...allCandidates],
        getCurrentProvider: () => state.currentProvider,
        getCurrentModel: () => state.currentModel,
        isExhausted: () => state.exhausted,
    };
    return callLLM;
}
// ─── Helpers ────────────────────────────────────────────────────────────────
function resolveWithExclusions(autoRouter, configManager, task, sessionFailed, persistedFailures, verbose) {
    try {
        const decision = autoRouter.resolve(task.agentType, task.description, {
            ...buildAutoResolveOptions(configManager, {
                verbose,
                contextHintTokens: task.contextHintTokens,
            }),
            complexityHint: task.complexity,
        }, configManager);
        // Filter out excluded providers
        const now = Date.now();
        const isExcludedLocal = (p) => {
            const sessionExcl = sessionFailed.get(p);
            if (sessionExcl && sessionExcl.expiresAt > now)
                return true;
            const persisted = persistedFailures[p];
            if (persisted && persisted.expiresAt > now)
                return true;
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
    }
    catch {
        return null;
    }
}
/**
 * Build the DEEP failover pool — the ONE candidate list every entry path walks.
 *
 * This used to live only here, which is why the orchestrator/tool/sub-agent path
 * was the deepest walker and chat/execute reached strictly fewer models. It is
 * now exported so chat, execute, the dashboard console and the gateway all walk
 * the SAME pool:
 *
 *   1. the router's primary win
 *   2. the model-first TIERED pool (same model on other providers → same tier →
 *      escalate → de-escalate → local; quota pre-checked, so every provider's
 *      siblings are reachable, not just its one pin)
 *   3. the router's own chain — ranked alternates PLUS the reserve pool
 *   4. any ranked provider the chain never resolved a model for
 *   5. the config-declared fallback providers
 *
 * Sorted best-first. Callers layer their OWN exclusions on top (session/model
 * cooldowns, registry blocks) — the pool itself is never filtered, so a caller
 * that deliberately wants to reach a parked model (to let `resolveWorkingModel`
 * repair it) still can.
 */
export function buildDeepFailoverPool(decision, opts = {}) {
    if (!decision)
        return [];
    const { taskDescription, complexity, configManager } = opts;
    const candidates = [];
    // Primary candidate
    candidates.push({
        provider: decision.provider,
        model: decision.model,
        score: decision.score,
    });
    // ── TIERED FAILOVER: capability-based with quota pre-check ────────────
    // Strategy (Dheeraj's design):
    //   1. Same model, different provider (fastest transition)
    //   2. Same capability tier, different models (pre-check quota)
    //   3. Escalate to higher tier (pre-check quota)
    //   4. De-escalate to lower tier, cheaper models (pre-check quota)
    //   5. Local model (always available, last resort)
    //   6. Any remaining (last resort before neural response)
    // Only the providers the ROUTER actually considered (winner + ranked) may
    // contribute tiered candidates. `ranked` is the post-governance, credentialed
    // set, so this keeps the pool to really-callable providers — without it the
    // tiered layer returns the whole CATALOG and every walk pointlessly probes
    // providers the user has no key for (measured: 23 pairs, 16 of them
    // un-credentialed, before this restriction).
    const allowedProviders = [...new Set([decision.provider, ...decision.ranked.map((r) => r.provider)])];
    try {
        if (taskDescription && complexity) {
            const modelCandidates = buildModelCandidates(taskDescription, complexity, configManager, allowedProviders);
            const tieredChain = buildTieredFailoverChain({ model: decision.model, provider: decision.provider, dimensions: { capabilityFit: 0.5 } }, modelCandidates);
            // Flatten tiers into candidate list, maintaining tier order
            for (const tier of tieredChain) {
                for (const fc of tier.candidates) {
                    if (fc.provider === decision.provider && fc.model === decision.model)
                        continue;
                    const key = `${fc.provider}:${fc.model}`;
                    if (candidates.some(c => `${c.provider}:${c.model}` === key))
                        continue;
                    candidates.push({
                        provider: fc.provider,
                        model: fc.model,
                        score: fc.score,
                    });
                }
            }
        }
    }
    catch {
        // Best-effort — tiered failover must never break routing
    }
    // The router's OWN fallback chain — ranked alternates PLUS the RESERVE pool
    // (credentialed providers the registry hasn't verified yet). Each entry now
    // carries a REAL model, and there are several per provider (DEEP FAILOVER),
    // so dedupe must be by provider × model — dedupe by provider alone is what
    // silently dropped every alternate model and made the chain one-model-per-
    // provider. The reserve is strictly last-resort: scored below every ranked
    // candidate so it is only reached once the verified pool is exhausted.
    for (const fb of decision.fallbackChain) {
        const model = fb.model && fb.model !== 'default' ? fb.model : 'default';
        // The primary candidate is already candidates[0].
        if (fb.provider === decision.provider && model === decision.model)
            continue;
        const key = `${fb.provider}|${model}`;
        if (candidates.some((c) => `${c.provider}|${c.model}` === key))
            continue;
        candidates.push({
            provider: fb.provider,
            model,
            // Keep the chain's own order meaningful: the router already ranked these
            // (primary picks before alternates, reserve last). A real model from the
            // chain outranks a bare provider placeholder.
            score: model === 'default' ? 0.05 : 0.5,
        });
    }
    // Any ranked provider still missing entirely (no chain entry resolved a
    // model) — added LAST with the placeholder; resolveModel fills it in at call
    // time via the per-model path.
    for (const ranked of decision.ranked) {
        if (ranked.provider === decision.provider)
            continue;
        if (candidates.some(c => c.provider === ranked.provider))
            continue;
        candidates.push({
            provider: ranked.provider,
            model: 'default', // Will be resolved at call time
            score: ranked.score,
        });
    }
    // Add fallback chain candidates (from the config's fallback.providers)
    try {
        const fallbackChain = getProviderFallback({}).getFallbackChain(decision.provider);
        for (const fb of fallbackChain) {
            if (candidates.some(c => c.provider === fb))
                continue;
            candidates.push({
                provider: fb,
                model: 'default',
                score: 0.1, // Low score — these are last-resort
            });
        }
    }
    catch {
        // Best-effort — fallback chain must never break routing.
    }
    // Sort by score descending (best first)
    candidates.sort((a, b) => b.score - a.score);
    // The router's own win MUST stay first. The score-sort above compares the
    // router's COMPOSITE score against the tiered layer's raw capability scores,
    // and a tiered candidate can outscore the winner — which would silently
    // override the router for every caller that walks the pool in order (chat and
    // execute do exactly that). The router's decision is authoritative; the pool
    // only extends failover BEYOND it.
    const primaryIdx = candidates.findIndex((c) => c.provider === decision.provider && c.model === decision.model);
    if (primaryIdx > 0) {
        const [primary] = candidates.splice(primaryIdx, 1);
        candidates.unshift(primary);
    }
    return candidates;
}
/**
 * Expiry read from either a bare timestamp (`Map<string, number>`, the shape
 * chat keeps) or a record with `expiresAt` (resilient-call's internal maps and
 * the persisted-failure store). Duck-typing both shapes is what lets ONE
 * predicate serve every entry path without an adapter allocation per call.
 */
function expiryAt(value) {
    if (value === undefined)
        return 0;
    return typeof value === 'number' ? value : value.expiresAt;
}
/**
 * Build the ONE failover-exclusion predicate every entry path shares, so the
 * deep walk can never drift between chat, execute, the gateway and the
 * orchestrator.
 *
 * It answers exactly the question the orchestrator's walk used to answer alone:
 * "should this provider×model be skipped?". Provider-wide AND model-scoped
 * exclusions are honored separately — a 429 on one model rules out that model
 * only, never its healthy siblings. Session maps are read LIVE at call time, so
 * a failure recorded mid-walk takes effect on the very next candidate.
 *
 * Best-effort by construction: a registry failure never rules a candidate out.
 */
export function createFailoverExclusionFilter(opts = {}) {
    const persisted = opts.crossPipelineMemory === false
        ? {}
        : opts.persistedFailures ?? loadPersistedFailures();
    const registryCheck = opts.registryCheck !== false;
    return (provider, model) => {
        if (isExcluded(provider, model, opts.sessionFailed, opts.sessionFailedModels, persisted)) {
            return true;
        }
        return registryCheck ? isRegistryRuledOut(provider, model) : false;
    };
}
function isExcluded(provider, model, sessionFailed, sessionFailedModels, persistedFailures) {
    const now = Date.now();
    // Provider-wide (auth / unresolved model).
    if (expiryAt(sessionFailed?.get(provider)) > now)
        return true;
    if (expiryAt(persistedFailures[provider]) > now)
        return true;
    // Model-scoped — only this exact provider × model is ruled out.
    if (model && model !== 'default') {
        const key = modelKey(provider, model);
        const modelExcl = sessionFailedModels?.get(key);
        if (expiryAt(modelExcl) > now)
            return true;
        const persistedModel = persistedFailures[key];
        if (expiryAt(persistedModel) > now)
            return true;
    }
    return false;
}
/**
 * Has the Model Availability Registry already ruled this candidate out?
 *
 * Model-aware on purpose: with a concrete model the check is per-ENTRY
 * (parked/unavailable/stale → skip just that candidate), so a parked model no
 * longer blocks its healthy siblings on the same provider. Only an unresolved
 * ('default') model falls back to the provider-wide blocked check.
 * Best-effort — a registry failure never rules a candidate out.
 */
function isRegistryRuledOut(provider, model) {
    try {
        const registry = getModelRegistry();
        if (model && model !== 'default') {
            // Untracked model → unproven, not ruled out: the failover chain exists
            // precisely to reach models the registry has no data on yet.
            if (!registry.getEntry(provider, model))
                return false;
            return !registry.isUsable(provider, model);
        }
        return registry.getBlockedProviders().includes(provider);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=resilient-call.js.map