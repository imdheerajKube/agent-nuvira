/**
 * AutoModelRouter — "Use the right model for the right task."
 *
 * A first-class model selection option (`auto`) that lets Agent-Nuvira decide
 * which provider/model to use for each task instead of pinning a single model.
 *
 * Selection dimensions (all scored 0–1 per provider):
 *   1. **Reasoning** — capability for deep/complex tasks
 *   2. **Speed**     — latency score (higher = faster)
 *   3. **Cost**      — cost score (higher = cheaper)
 *   4. **Privacy**   — data locality (1 = fully local/offline)
 *   5. **Reliability** — uptime / error rate
 *
 * Task complexity (from `analyzeComplexity`) shifts the dimension weights:
 *   - trivial/simple  → cost + speed dominate (fast planning with small model)
 *   - moderate        → balanced
 *   - complex/critical → reasoning + reliability dominate (deep reasoning with
 *     larger model; cloud for high-complexity tasks)
 *
 * Privacy preference (preferenceMode === 'privacy-first') routes private tasks
 * to the local provider. Fallback chains and circuit-breaker cooldowns come from
 * the existing `ProviderFallback` engine — providers in cooldown are deprioritized
 * (or excluded) so reliability is honored at runtime.
 *
 * Integration:
 * - `nuvira model switch auto` — select Auto as the active model
 * - Model picker shows "Auto — Agent decides" as the first option
 * - `chat` routes every message when the active model is `auto`
 * - Orchestrator routes each agent task when `--model auto` or `--auto-route` is set
 *
 * Usage:
 * ```ts
 * import { getAutoRouter } from './auto-router.js';
 * const router = getAutoRouter();
 * const decision = router.resolve('writer', 'implement JWT auth with refresh tokens');
 * // → { provider: '<best available>', model: '<resolved model>', explanation: '...' }
 * ```
 */
import { analyzeComplexity } from './hybrid-router.js';
import { getTaskType } from './model-router.js';
import { getBenchmarkRuns } from './benchmark.js';
import { getAgentStats } from './agent-stats.js';
import { getRouterBandit, DEFAULT_MIN_SAMPLES } from './router-bandit.js';
import { getRouterPromotion, DEFAULT_MIN_PROMOTION_DECISIONS } from './router-promotion.js';
import { getMlRouter, DEFAULT_ML_K, DEFAULT_ML_MIN_SAMPLES, DEFAULT_ML_STRENGTH } from './ml-router.js';
import { buildModelCandidates } from './model-first-router.js';
import { pickBestModel, topModelCandidates } from './model-scoring.js';
import { getModelRegistry } from './model-registry.js';
import { estimateTokens } from './cost-tracker.js';
import { preferredModelsFor, PROVIDER_CONTEXT_WINDOWS } from './model-selection.js';
import { isNonChatModel } from '../inference/model-catalog.js';
import { CATALOG_PROVIDER_IDS, getCatalogProvider, getDefaultModel, isCatalogKeyless } from '../inference/provider-catalog.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** The special model value that triggers automatic per-task routing. */
export const AUTO_MODEL = 'auto';
/**
 * How many models ONE provider contributes to the failover chain (DEEP
 * FAILOVER). More than one so a provider's 2nd/3rd-best model is actually
 * reachable — per-model RPD/TPM limits on free tiers mean a 429 on one model
 * says nothing about its siblings.
 */
export const FALLBACK_MODELS_PER_PROVIDER = 3;
/** The special provider value stored in active-model state for Auto mode. */
export const AUTO_PROVIDER = 'auto';
/** Human labels for each dimension (used in explanations). */
export const DIMENSION_LABELS = {
    reasoning: 'reasoning',
    speed: 'speed',
    cost: 'cost',
    privacy: 'privacy',
    reliability: 'reliability',
};
/**
 * Thrown by resolve() when a PII-domain task matches a configured governance
 * PII pattern and EVERY candidate provider fails the privacy bar. The PII
 * policy is a HARD gate — "no PII to low-privacy cloud" holds even when it
 * eliminates every provider, so the router refuses to serve a violator and
 * lets the caller surface the policy block to the user.
 */
export class PIIPolicyError extends Error {
    /** Minimum privacy score the policy required (0–1). */
    requiredPrivacy;
    constructor(requiredPrivacy) {
        super(`PII governance policy: no provider meets the privacy requirement (privacy ≥ ${requiredPrivacy}) for this task — refusing to route PII to a low-privacy provider.`);
        this.name = 'PIIPolicyError';
        this.requiredPrivacy = requiredPrivacy;
    }
}
/**
 * Thrown by resolve() when an ADMIN governance rule (provider allow/deny
 * list, model allow/deny list, or the admin max-cost cap) eliminates EVERY
 * candidate provider. Like PII, these are HARD policy gates: falling back to
 * the full ranking would resurrect a provider the admin policy rules out, so
 * the router refuses to serve a policy-violating provider and lets the caller
 * surface the block (chat/plan render the message, `models explain` renders
 * the full audit trail).
 */
export class GovernancePolicyError extends Error {
    /** Providers eliminated by the policy, with the reason for each (audit). */
    blocked;
    constructor(blocked) {
        super(`Governance policy: every candidate provider was eliminated by an admin rule (${blocked.length} blocked: ${blocked.map((b) => b.provider).join(', ')}) — refusing to serve a policy-violating provider.`);
        this.name = 'GovernancePolicyError';
        this.blocked = blocked;
    }
}
// ─── Provider Capability Profiles ───────────────────────────────────────────
//
// Static baseline profiles for the built-in providers. These encode the
// "right tool for the job" tiers:
//   - local      — private, free, offline; modest reasoning
//   - groq       — fastest, cheap, good general coding
//   - nim        — strong reasoning, reasonable cost
//   - gemini     — strong reasoning + speed, good for complex work
//   - openrouter — frontier reasoning models (GPT/Anthropic tier), slower, pricier
//
// Profiles can be overridden per-call via AutoRouterOptions (see weights).
/**
 * Minimum expected win rate (α/(α+β)) for a provider to qualify as an
 * escalation target. A learned-but-failing provider (win rate near or below
 * 0.5) must never steal routing from a strong cold-start winner.
 */
export const ESCALATION_WIN_RATE_FLOOR = 0.55;
/**
 * S5 — creative/writing tasks need QUALITY, not speed/cost. The static
 * profile floor for `local` is reasoning 0.30 (a 4-bit quant), which is fine
 * for quick edits but must never serve essays/poems/letters. Hard-eliminate
 * sub-floor providers for creative tasks — groq (0.55), gemini (0.85), nim
 * (0.72) and openrouter (0.95) all pass.
 */
export const CREATIVE_MIN_REASONING = 0.4;
// ── DEFAULT_PROFILES: built-in overrides + catalog-sourced defaults ─────────
// The 6 built-in profiles have fine-tuned values. ALL other catalog providers
// get their profiles DYNAMICALLY from the catalog's capability metadata, so
// every provider the user has a key for participates in routing with real
// scores — not a neutral guess.
const BUILTIN_PROFILES = {
    local: { reasoning: 0.30, speed: 0.55, cost: 1.00, privacy: 1.00, reliability: 0.60 },
    groq: { reasoning: 0.55, speed: 1.00, cost: 0.85, privacy: 0.15, reliability: 0.85 },
    nim: { reasoning: 0.72, speed: 0.70, cost: 0.55, privacy: 0.15, reliability: 0.82 },
    gemini: { reasoning: 0.85, speed: 0.80, cost: 0.40, privacy: 0.10, reliability: 0.88 },
    openrouter: { reasoning: 0.95, speed: 0.55, cost: 0.15, privacy: 0.10, reliability: 0.78 },
    // P5 M5.3: the Nuvira sidecar gateway (any OpenAI-compatible endpoint) is a
    // NEUTRAL multi-model host — it can serve any upstream model, so it scores a
    // deliberately neutral profile: never dominates a dimension it can't prove,
    // never excluded from routing (it joins the same registry/bandit learning as
    // built-ins once real usage data exists). Its REAL profile derives from
    // measured usage / runtime stats over time.
    nuvira: { reasoning: 0.50, speed: 0.50, cost: 0.50, privacy: 0.50, reliability: 0.70 },
};
// Generate DEFAULT_PROFILES from catalog: built-in overrides win, extended
// providers get catalog-sourced capability scores. This ensures ALL 22+
// catalog providers participate in auto-routing with real metadata.
const DEFAULT_PROFILES = { ...BUILTIN_PROFILES };
for (const id of CATALOG_PROVIDER_IDS) {
    if (DEFAULT_PROFILES[id])
        continue; // Built-in already has a tuned profile
    try {
        const catalog = getCatalogProvider(id);
        if (catalog) {
            DEFAULT_PROFILES[id] = {
                reasoning: catalog.capabilities.reasoning,
                speed: catalog.capabilities.speed,
                cost: catalog.capabilities.cost,
                privacy: catalog.capabilities.privacy,
                reliability: catalog.capabilities.reliability,
            };
        }
    }
    catch {
        // Best-effort — catalog read must never break routing
    }
}
// ─── Capability-aware scoring (Nuvira-Router P2 M2.1) ───────────────────────
//
// A SOFT signal on top of the five weighted dimensions: which capabilities a
// task ACTUALLY needs (from its task type) vs which capabilities a provider
// offers (from its profile). This is deliberately a small, clamped multiplier
// — it nudges equally-scored providers toward the one whose strengths match
// the task (a code-review wants reasoning, a quick edit wants speed), but it
// can never overturn a large dimension-weight advantage or break the 0–1
// score invariant.
/** Model-catalog-style tags a task type genuinely needs. */
const TASK_CAPABILITY_TAGS = {
    plan: ['reasoning'],
    // Code generation cares about correctness, not latency — every code-capable
    // provider fits equally, so the signal stays neutral for writer tasks and
    // never overturns the dimension-weighted ranking.
    'simple-edit': ['code'],
    'code-review': ['code', 'reasoning'],
    'test-generation': ['code'],
    debug: ['code', 'reasoning'],
    'context-gather': ['fast'],
    default: ['chat'],
};
/** Model-catalog-style tags each built-in provider offers (from its profile). */
const PROVIDER_CAPABILITY_TAGS = {
    local: ['chat', 'code'],
    groq: ['chat', 'code', 'fast'],
    nim: ['chat', 'code', 'reasoning'],
    gemini: ['chat', 'code', 'reasoning', 'fast', 'vision'],
    openrouter: ['chat', 'code', 'reasoning', 'vision', 'agentic'],
};
/**
 * Offered tags for a provider: static catalog tags UNION tags derived from
 * the capability profile (so custom/gateway providers are scored by their
 * REAL profile, not a hardcoded map — a custom strong-reasoning provider gets
 * a 'reasoning' tag even though no static entry lists it).
 *
 * DERIVATION RULES:
 * - reasoning >= 0.65 → 'reasoning'
 * - speed >= 0.85    → 'fast'
 * - Any provider with reasonable reasoning (>= 0.4) and speed (>= 0.4) gets
 *   'chat' and 'code' — these are the UNIVERSAL capabilities: every LLM
 *   provider can chat and generate code. Only truly specialized providers
 *   (pure-embedding, pure-image-gen) lack these.
 * - 'cheap'/'reliable' are DELIBERATELY not derived. No current task type
 *   requires them, so deriving them would only add tags NO task ever matches.
 */
function providerOfferedTags(provider, caps) {
    const staticTags = PROVIDER_CAPABILITY_TAGS[provider] || [];
    const derived = [];
    if (caps) {
        // Universal LLM capabilities: every general-purpose provider can chat
        // and code. The threshold is deliberately low (0.4) — even a small local
        // model (reasoning 0.30) can chat and do basic code; the fit signal only
        // needs to distinguish LLMs from non-LLM services.
        if (caps.reasoning >= 0.4 || caps.speed >= 0.4) {
            derived.push('chat', 'code');
        }
        if (caps.reasoning >= 0.65)
            derived.push('reasoning');
        if (caps.speed >= 0.85)
            derived.push('fast');
    }
    return [...new Set([...staticTags, ...derived])];
}
/**
 * 0–1 fit between a task type's required capabilities and a provider's
 * offered tags: matched-required / total-required. 1 = the provider covers
 * every capability the task needs; 0 = none.
 *
 * A provider with NO assessable profile (truly unknown, e.g. a brand-new
 * gateway with a neutral profile) returns 1 — neutral: it can host any model,
 * so it is never unfairly boosted OR penalized until real usage data exists.
 */
export function capabilityFitScore(taskType, provider, caps) {
    const required = TASK_CAPABILITY_TAGS[taskType] || TASK_CAPABILITY_TAGS.default;
    const offered = providerOfferedTags(provider, caps);
    // No assessable tags (unknown provider with no static entry and a neutral
    // profile) → neutral fit: neither boosted nor penalized.
    if (offered.length === 0)
        return 1;
    if (required.length === 0)
        return 1;
    const matched = required.filter((tag) => offered.includes(tag)).length;
    return matched / required.length;
}
/**
 * Apply the soft capability-fit multiplier, clamped so the score never
 * exceeds 1 (the 0–1 invariant the bandit and tests rely on). Range:
 * no-fit ≈ 0.85×, perfect-fit ≈ 1.10× (then clamped).
 */
export function applyCapabilityFit(score, fit) {
    return Math.min(1, score * (0.9 + 0.2 * fit));
}
/**
 * All provider ids considered by default: ALL catalog providers participate
 * in auto-routing. The 6 built-ins have tuned profiles; the other 16+
 * get catalog-sourced profiles. Users who add API keys for openai, anthropic,
 * mistral, etc. automatically get those providers in the routing candidate pool.
 */
export const DEFAULT_AUTO_PROVIDERS = [...CATALOG_PROVIDER_IDS];
// ─── Real Provider Pricing ──────────────────────────────────────────────────
//
// Actual per-1K-token list pricing (USD, input/output) used to derive the cost
// dimension score instead of static profiles. Sources: provider pricing pages
// (approximate; free tiers count as $0). Costs are configurable by overriding
// the pricing table below.
/** Real per-1K-token pricing (USD) — input/output per 1K tokens. */
export const PROVIDER_PRICING_PER_1K = {
    groq: { inputPer1K: 0.00059, outputPer1K: 0.00079 }, // Llama-3.3-70B-class
    nim: { inputPer1K: 0.00010, outputPer1K: 0.00050 }, // varies by model
    gemini: { inputPer1K: 0, outputPer1K: 0 }, // free tier default
    openrouter: { inputPer1K: 0.00250, outputPer1K: 0.01000 }, // GPT-4o-class pass-through
    local: { inputPer1K: 0, outputPer1K: 0 }, // free (local compute)
    // P5 M5.3: a local sidecar gateway is pass-through — its spend depends on
    // the upstream model, which only real usage can know. Default 0 (local-first
    // sidecar convention); M2.2 MEASURED wire-token cost replaces this the moment
    // the gateway reports usage, so the free-first gate judges by truth.
    nuvira: { inputPer1K: 0, outputPer1K: 0 },
};
// Issue 001: seed the pricing table from the provider catalog so the EXTENDED
// providers (openai, anthropic, mistral, cohere, together, deepinfra, ...)
// get real list pricing for cost scoring without per-provider hardcoding. The
// built-in entries above already mirror the catalog; catalog values fill the
// rest, so estimateCallCostUsd / computeCostScore work for every catalog id.
for (const id of CATALOG_PROVIDER_IDS) {
    const catalog = getCatalogProvider(id);
    if (catalog && PROVIDER_PRICING_PER_1K[id] === undefined) {
        PROVIDER_PRICING_PER_1K[id] = { ...catalog.pricing };
    }
}
/** Reference cost per call (USD) used to normalize the 0–1 cost score. */
const COST_REFERENCE_USD = 0.01;
/** Typical call size used for cost scoring (input/output tokens). */
const TYPICAL_INPUT_TOKENS = 2000;
const TYPICAL_OUTPUT_TOKENS = 500;
// ─── M2.5 Context preflight — nominal input context windows ────────────────
// Nominal provider-level context windows (tokens) are imported from
// model-selection (PROVIDER_CONTEXT_WINDOWS) — capability metadata, never a
// per-model name table. Config overrides via `routing.contextWindows[model]`
// (or `[provider]` as a provider-level default) always win, and the live
// model descriptors from a probe win where available.
/** Fallback for unknown providers — large enough to rarely trigger a penalty. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
/**
 * M2.5 context preflight — soft utilization-based fit (0–1, higher = better).
 * NEVER a hard block: even a prompt that exceeds the nominal window only caps
 * the penalty, and unknown/zero windows are neutral (fit 1). Neutral below
 * 50% utilization so normal-size tasks never shift a ranking; ramps linearly
 * to a 35% cap at ≥200% utilization.
 */
export function computeContextFit(promptTokens, windowTokens) {
    if (!windowTokens || windowTokens <= 0)
        return 1;
    const utilization = Math.max(0, promptTokens) / windowTokens;
    const penalty = Math.max(0, Math.min(0.35, (utilization - 0.5) / 1.5));
    return 1 - penalty;
}
/**
 * Estimate the USD cost of a typical call for a provider.
 * An optional pricing override (e.g., from `nuvira config set pricing.*`)
 * takes precedence over the built-in table.
 *
 * M2.2: when `measured` (real wire tokens from provider-reported usage) is
 * available, it replaces the TYPICAL-token estimate — measured cost is the
 * truth when the provider reports it.
 */
export function estimateCallCostUsd(provider, pricing, measured) {
    const p = pricing || PROVIDER_PRICING_PER_1K[provider] || { inputPer1K: 0.00010, outputPer1K: 0.00010 };
    const inputTokens = measured ? measured.inputTokens : TYPICAL_INPUT_TOKENS;
    const outputTokens = measured ? measured.outputTokens : TYPICAL_OUTPUT_TOKENS;
    const inputCost = (inputTokens / 1000) * p.inputPer1K;
    const outputCost = (outputTokens / 1000) * p.outputPer1K;
    return Math.round((inputCost + outputCost) * 100000) / 100000;
}
/**
 * Derive the 0–1 cost score (higher = cheaper) from real provider pricing.
 * Free providers (local, Gemini free tier) score 1.0.
 * M2.2: measured tokens (when present) replace the typical-call estimate.
 */
export function computeCostScore(provider, pricing, measured) {
    const costUsd = estimateCallCostUsd(provider, pricing, measured);
    const score = 1 - costUsd / COST_REFERENCE_USD;
    return Math.max(0, Math.min(1, score));
}
/**
 * Baseline dimension weights per complexity level (balanced mode).
 * These are normalized by the router; the *relative* values matter.
 */
const COMPLEXITY_WEIGHTS = {
    trivial: { reasoning: 0.10, speed: 0.35, cost: 0.30, privacy: 0.10, reliability: 0.15 },
    simple: { reasoning: 0.20, speed: 0.30, cost: 0.25, privacy: 0.10, reliability: 0.15 },
    moderate: { reasoning: 0.30, speed: 0.25, cost: 0.20, privacy: 0.10, reliability: 0.15 },
    complex: { reasoning: 0.40, speed: 0.15, cost: 0.10, privacy: 0.10, reliability: 0.25 },
    critical: { reasoning: 0.45, speed: 0.10, cost: 0.05, privacy: 0.10, reliability: 0.30 },
};
/**
 * Preference-mode weight adjustments (additive, applied on top of complexity weights).
 */
const MODE_ADJUSTMENTS = {
    balanced: {},
    'performance-first': { reasoning: 0.10, speed: 0.15, cost: -0.10, reliability: 0.05 },
    'cost-first': { cost: 0.20, reasoning: -0.10, speed: -0.05 },
    'privacy-first': { privacy: 0.60, cost: 0.05, reasoning: -0.15, reliability: 0.05 },
};
// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * Check whether a model value means "Auto routing".
 */
export function isAutoModel(model) {
    return model === AUTO_MODEL;
}
/**
 * Check whether a provider value means "Auto routing".
 */
export function isAutoProvider(provider) {
    return provider === AUTO_PROVIDER;
}
/**
 * Compute the effective dimension weights for a task.
 * Combines complexity baseline + preference-mode adjustments + user overrides,
 * then normalizes to sum 1 so scores are comparable across calls.
 */
export function computeWeights(complexity, mode = 'balanced', overrides) {
    const base = { ...COMPLEXITY_WEIGHTS[complexity] };
    const adj = MODE_ADJUSTMENTS[mode] || {};
    const merged = { ...base };
    for (const dim of Object.keys(DIMENSION_LABELS)) {
        merged[dim] = (base[dim] || 0) + (adj[dim] || 0);
        if (overrides?.[dim] !== undefined) {
            merged[dim] = overrides[dim];
        }
        if (merged[dim] < 0)
            merged[dim] = 0;
    }
    const total = Object.values(merged).reduce((a, b) => a + b, 0) || 1;
    const normalized = {};
    for (const dim of Object.keys(DIMENSION_LABELS)) {
        normalized[dim] = merged[dim] / total;
    }
    return normalized;
}
/**
 * Score a single provider against the effective weights.
 */
export function analyzeTaskProfile(taskDescription) {
    const text = (taskDescription || '').toLowerCase();
    if (/migrat(e|ion)|upgrade|refactor|pipeline|deployment/.test(text)) {
        return {
            intent: 'migration',
            requiresVerification: true,
            escalationTarget: 'gemini',
            notes: ['migration-related task detected'],
        };
    }
    if (/architect|architecture|design|system|microservice|platform/.test(text) && !/outline|plan|roadmap|strategy/.test(text)) {
        return {
            intent: 'architecture',
            requiresVerification: true,
            escalationTarget: 'gemini',
            notes: ['architecture-focused task detected'],
        };
    }
    if (/verify|verification|validate|rollout|deploy|production|launch|release/.test(text)) {
        return {
            intent: 'verification',
            requiresVerification: true,
            escalationTarget: 'openrouter',
            notes: ['verification-related task detected'],
        };
    }
    if (/security|audit|vulnerab|threat|exploit/.test(text)) {
        return {
            intent: 'security',
            requiresVerification: true,
            escalationTarget: 'openrouter',
            notes: ['security-sensitive task detected'],
        };
    }
    if (/debug|bug|error|fix|trace/.test(text)) {
        return {
            intent: 'debugging',
            requiresVerification: false,
            notes: ['debugging task detected'],
        };
    }
    if (/plan|outline|roadmap|strategy/.test(text)) {
        return {
            intent: 'planning',
            requiresVerification: false,
            notes: ['planning task detected'],
        };
    }
    // S5: creative writing needs quality, not latency — a distinct intent so
    // routing applies a reasoning floor (a 4-bit local model must not serve
    // essays). An NLU taskIntentHint (e.g. 'write an essay' → 'creative')
    // overrides this label; this text rule is the hint-less fallback path.
    if (/\b(?:essay|poem|poetry|story|short story|letter|article|blog(?: post)?|paragraph|composition|novel|dialogue|speech|summary|caption|creative writing)\b/i.test(text) ||
        /\bfor (?:kids|children|students?|class \d)/i.test(text)) {
        return {
            intent: 'creative',
            requiresVerification: false,
            notes: ['creative writing task detected'],
        };
    }
    return {
        intent: 'coding',
        requiresVerification: false,
        notes: ['general coding task detected'],
    };
}
export function scoreProvider(provider, capabilities, weights) {
    const dimensions = {};
    let score = 0;
    let weightTotal = 0;
    for (const dim of Object.keys(DIMENSION_LABELS)) {
        const w = weights[dim] || 0;
        const contribution = w * (capabilities[dim] ?? 0);
        dimensions[dim] = contribution;
        score += contribution;
        weightTotal += w;
    }
    return { score, dimensions, weightTotal };
}
// ─── Auto Model Router ──────────────────────────────────────────────────────
/**
 * AutoModelRouter — scores available providers per task and picks the best.
 */
export class AutoModelRouter {
    profiles;
    constructor(profiles) {
        this.profiles = profiles ? { ...DEFAULT_PROFILES, ...profiles } : { ...DEFAULT_PROFILES };
    }
    /**
     * Get the capability profile for a provider: an explicit profile (constructor
     * / updateProfiles / user config) wins, then the provider catalog's baseline
     * (Issue 001 — every catalog provider scores with real metadata, not a
     * neutral guess), then a neutral fallback for truly unknown providers.
     */
    getCapabilities(provider) {
        if (this.profiles[provider])
            return this.profiles[provider];
        const catalog = getCatalogProvider(provider);
        if (catalog) {
            return {
                reasoning: catalog.capabilities.reasoning,
                speed: catalog.capabilities.speed,
                cost: catalog.capabilities.cost,
                privacy: catalog.capabilities.privacy,
                reliability: catalog.capabilities.reliability,
            };
        }
        return { reasoning: 0.5, speed: 0.5, cost: 0.5, privacy: 0.2, reliability: 0.7 };
    }
    /** Update/override capability profiles (e.g., from config). */
    updateProfiles(profiles) {
        this.profiles = { ...this.profiles, ...profiles };
    }
    /**
     * MODEL-LEVEL capability refinement (model-first-router parity): the
     * provider's capability profile is a BASELINE — the model actually served
     * may be much stronger or weaker. Refines the provider caps with evidence
     * from the model id the router will serve for THIS task (resolveModel:
     * the configured pin, or the task-resolved best model via pickBestModel).
     *
     * Evidence signals (all derived from the model id + registry measurements,
     * no network):
     *   - parameter-size hints: larger parameter counts (70b > 13b > 8b > 3b/1b)
     *     raise reasoning; tiny param counts lower it;
     *   - tier words: 'large'/'max'/'opus'/'70b'/… raise; 'mini'/'tiny'/'small'/
     *     'instant'/'flash'/'nano'/'lite' lower reasoning (flash/instant also
     *     RAISE speed — they are speed-optimized models);
     *   - frontier-keyword families (gpt-4/5-class, claude-3/4-class,
     *     gemini-2-class, deepseek-r1, llama-70b) raise reasoning;
     *   - registry latency: a model measured much slower than its provider
     *     baseline suggests a heavyweight (raises reasoning, lowers speed) and
     *     vice versa.
     *
     * Deliberately CONSERVATIVE: adjustments clamp to ±0.35 and never cross the
     * 0..1 bounds; an unknown model id returns the provider baseline unchanged
     * (the gate then behaves exactly as before — no behavior change for
     * unresolvable evidence). Deterministic: same inputs → same caps.
     */
    getModelCapabilities(provider, model) {
        const base = { ...this.getCapabilities(provider) };
        if (!model || model === 'default')
            return base;
        const m = model.toLowerCase();
        let reasoningAdj = 0;
        let speedAdj = 0;
        // Parameter-size evidence.
        const params = /(\d+(?:\.\d+)?)b(?:\b|-|$)/.exec(m);
        if (params) {
            const b = parseFloat(params[1]);
            if (b >= 60)
                reasoningAdj += 0.25;
            else if (b >= 30)
                reasoningAdj += 0.15;
            else if (b >= 12)
                reasoningAdj += 0.05;
            else if (b <= 4) {
                reasoningAdj -= 0.2;
                speedAdj += 0.15; // tiny models are fast
            }
        }
        // Tier-word evidence.
        const SLOW_TIER = /\b(large|max|opus|pro|ultra|frontier)\b/;
        const FAST_TIER = /\b(mini|tiny|small|nano|lite|instant|flash|turbo|haiku)\b/;
        if (SLOW_TIER.test(m))
            reasoningAdj += 0.15;
        if (FAST_TIER.test(m)) {
            reasoningAdj -= 0.1;
            speedAdj += 0.15;
        }
        // Frontier-family evidence (keyword match on the id).
        if (/\b(gpt-[45]|o[134](?:-|$)|claude-[34]|gemini-2|deepseek-r1|qwen3|qwen-3)\b/.test(m) ||
            /gpt-4|gpt-5|claude-3|claude-4|gemini-2/.test(m)) {
            reasoningAdj += 0.2;
        }
        // Registry latency evidence: measured latency far from the provider
        // baseline's implied speed. 0.5s ≈ fast tier, 10s+ ≈ heavyweight.
        try {
            const entry = getModelRegistry().getEntry(provider, model);
            if (entry?.latencyMs) {
                if (entry.latencyMs >= 10_000) {
                    reasoningAdj += 0.1;
                    speedAdj -= 0.1;
                }
                else if (entry.latencyMs <= 800) {
                    speedAdj += 0.1;
                }
            }
        }
        catch {
            // Registry unavailable — id evidence only.
        }
        return {
            ...base,
            reasoning: Math.min(1, Math.max(0, base.reasoning + reasoningAdj)),
            speed: Math.min(1, Math.max(0, base.speed + speedAdj)),
        };
    }
    /**
     * Default candidate providers — DYNAMIC (Issue 001): every provider the user
     * has credentials for participates, not just the 6 built-ins. The candidate
     * pool is derived at runtime from the provider catalog + the config manager:
     * keyless catalog providers (local, nuvira, lmstudio, vllm) are always
     * candidates (reachability is probed), and any catalog provider whose env
     * var / config carries a REAL key joins — so a user who sets OPENAI_API_KEY,
     * ANTHROPIC_API_KEY, MISTRAL_API_KEY, ... sees those providers routed to.
     * Explicitly configured non-catalog providers (plugins/custom) join too.
     *
     * Falls back to the full built-in list when nothing has credentials (or when
     * no config manager is provided), so the router still produces a decision
     * and the caller surfaces availability. Explicit `allowedProviders` always
     * win over this filtering.
     */
    getDefaultAllowedProviders(configManager) {
        if (!configManager || typeof configManager.hasRequiredCredentials !== 'function') {
            return { allowed: DEFAULT_AUTO_PROVIDERS, excluded: [], reserve: [] };
        }
        // ── Registry-aware filtering: prefer providers with VERIFIED, usable
        // models over bare credential checks. A key existing ≠ the models on that
        // provider actually serving (OpenRouter lists 300+ models your credits
        // can't buy; Gemini paid models 403 without billing). When the registry
        // has real data, restrict Auto routing to providers we've verified — this
        // is the "no more routing into 404s" guarantee.
        const registry = getModelRegistry();
        // Hard skip: providers whose every tracked model the registry marks
        // unavailable/quota-parked (learned from real usage telemetry) are never
        // even scored — dead providers can't win a task they'd fail.
        const blocked = new Set(registry.getBlockedProviders());
        // ISSUE-002 registry pre-filter STRENGTH: a provider with ZERO verified
        // models AND ≥3 unavailable entries is DEGRADED — excluded even when some
        // entries are merely unverified (the lenient all-models-blocked check
        // alone would still score it, so the registry's own data would be
        // ignored until every last model failed). 0 verified + 3+ dead = the
        // registry already knows this provider won't serve.
        const degraded = new Set(registry.getDegradedProviders());
        const excluded = [];
        // DYNAMIC base: catalog ids + explicitly-configured provider ids, filtered
        // to providers with credentials. Keyless catalog providers pass through
        // hasRequiredCredentials (they need no key); keyed ones need a real key.
        let configuredIds = [];
        try {
            configuredIds = Object.keys(configManager.getAll?.()?.providers ?? {});
        }
        catch {
            // Best-effort — a config read must never break routing.
        }
        const registered = registry.getUsableProviders();
        const base = [...new Set([...CATALOG_PROVIDER_IDS, ...configuredIds])].filter((p) => {
            if (blocked.has(p) || degraded.has(p)) {
                // Cite the registry's own counts so the explanation proves the data
                // is working ("openrouter excluded — 0 verified, 6 unavailable"). The
                // DEGRADED reason (with exact counts) is the more informative one — a
                // provider that meets the degraded bar also meets the blocked bar, but
                // "0 verified, 6 unavailable" tells the user far more than "all models
                // unavailable".
                const stats = registry.getProviderStats(p);
                const reason = degraded.has(p)
                    ? `${stats.verified} verified (${stats.parked} parked), ${stats.unavailable} unavailable`
                    : `all tracked models unavailable`;
                excluded.push({ provider: p, reason });
                return false;
            }
            // Keyless runners BEYOND `local` (nuvira, lmstudio, vllm) only join when
            // the registry has VERIFIED them or the user explicitly configured them
            // — a not-running localhost endpoint must never out-rank running local
            // on a cold start (Issue 001 review feedback).
            if (isCatalogKeyless(p) && p !== 'local') {
                const explicit = configuredIds.includes(p);
                const verified = registered.includes(p);
                if (!explicit && !verified)
                    return false;
            }
            try {
                return configManager.hasRequiredCredentials(p);
            }
            catch {
                return false;
            }
        });
        if (registered.length > 0) {
            const intersection = base.filter((p) => registered.includes(p));
            if (intersection.length > 0) {
                // Verified providers win the primary ranking, but the credentialed-yet-
                // unverified rest is NOT thrown away — it becomes the reserve fallback
                // pool, so a task still reaches those models when every verified
                // candidate fails ("only reject when nothing is left").
                const reserve = base.filter((p) => !registered.includes(p));
                return { allowed: intersection, excluded, reserve };
            }
        }
        // Never return an empty list: if EVERY configured provider is
        // registry-blocked (pathological), fall back to the full built-in list so
        // the caller still gets a decision and surfaces availability instead of
        // crashing on an empty ranking.
        return { allowed: base.length > 0 ? base : DEFAULT_AUTO_PROVIDERS, excluded, reserve: [] };
    }
    /**
     * Resolve the optimal provider/model for a task.
     *
     * @param agentType — Agent type (e.g., 'writer', 'planner', 'chat')
     * @param taskDescription — The task text used for complexity analysis
     * @param options — Routing options (mode, allowed providers, circuit-breaker status)
     * @param configManager — Optional; used to resolve provider model defaults
     * @returns An AutoRouteResult with ranked providers, fallback chain, and explanation
     */
    resolve(agentType, taskDescription, options = {}, configManager) {
        // Subtask-local routing: a complexityHint from the plan (TaskStep.complexity)
        // wins over re-analyzing the description, so a planner that labels each
        // step simple/moderate/complex routes that step accordingly — not the whole
        // goal's complexity. Bandit bucketing uses the SAME value on recordOutcome
        // (the orchestrator threads task.complexity through), keeping select-time
        // and record-time buckets consistent.
        const complexity = options.complexityHint ?? analyzeComplexity(taskDescription);
        const taskType = getTaskType(agentType);
        // C3: an NLU intent hint overrides the intent LABEL while keeping the
        // text-derived safety flags (verification/escalation) intact — see the
        // taskIntentHint doc on AutoRouterOptions.
        const analyzedProfile = analyzeTaskProfile(taskDescription);
        const taskProfile = options.taskIntentHint
            ? { ...analyzedProfile, intent: options.taskIntentHint }
            : analyzedProfile;
        // S5: creative/writing tasks need QUALITY — enforce a reasoning floor so a
        // 4-bit local model (reasoning 0.30) can never serve an essay/poem/letter.
        // The floor is a hard elimination (like the per-call minReasoning option),
        // but derived from the task intent rather than a manual config.
        const effectiveMinReasoning = taskProfile.intent === 'creative'
            ? Math.max(options.minReasoning ?? 0, CREATIVE_MIN_REASONING)
            : options.minReasoning;
        const mode = options.preferenceMode || 'balanced';
        let weights = computeWeights(complexity, mode, options.weights);
        if (taskProfile.requiresVerification) {
            const boosted = {
                ...weights,
                reasoning: Math.min(1, weights.reasoning + 0.12),
                reliability: Math.min(1, weights.reliability + 0.10),
                cost: Math.max(0, weights.cost - 0.08),
                speed: Math.max(0, weights.speed - 0.04),
            };
            const total = Object.values(boosted).reduce((a, b) => a + b, 0) || 1;
            weights = {
                reasoning: boosted.reasoning / total,
                speed: boosted.speed / total,
                cost: boosted.cost / total,
                privacy: boosted.privacy / total,
                reliability: boosted.reliability / total,
            };
        }
        // ── Rule overrides: an explicit intent always wins over scoring ─────────
        // Mirrors ruflo's `multi-model-router` rule mode — a regex/string pattern
        // that matches the task forces a specific provider (and optionally model),
        // short-circuiting scoring entirely.
        if (options.rules?.length) {
            for (const rule of options.rules) {
                const re = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'i') : rule.pattern;
                if (re.test(taskDescription)) {
                    const provider = rule.provider;
                    const model = rule.model || this.resolveModel(provider, agentType, configManager);
                    // Note the forced decision so bandit outcome recording attributes
                    // successes/failures to the rule's provider — not a stale one from a
                    // previous task of the same agent type. Harmless when bandit is off
                    // (the orchestrator gates recording on routing.bandit !== false).
                    getRouterBandit().noteDecision(agentType, provider);
                    if (options.verbose) {
                        logger.info(`  🛑 Routing rule '${rule.name}' matched → ${provider}/${model}`);
                    }
                    return {
                        agentType,
                        complexity,
                        taskProfile,
                        escalationApplied: false,
                        taskType,
                        provider,
                        model,
                        score: 1,
                        weights,
                        ranked: [{
                                provider,
                                score: 1,
                                dimensions: { reasoning: 1, speed: 1, cost: 1, privacy: 1, reliability: 1 },
                                weightTotal: 1,
                                inCooldown: false,
                                reason: `forced by routing rule '${rule.name}'`,
                            }],
                        fallbackChain: [],
                        explanation: `Routing rule '${rule.name}' matched task → ${provider}/${model}`,
                        routedBy: 'rule',
                    };
                }
            }
        }
        // ISSUE-002: the default candidate pool is now registry-filtered — capture
        // WHY providers were excluded (registry-cited counts) so the explanation
        // proves the gathered data is driving decisions. Explicit allowedProviders
        // opt out of the registry filter entirely (caller knows best).
        let registryExcluded = [];
        let reserveProviders = [];
        let allowed;
        if (options.allowedProviders?.length) {
            allowed = options.allowedProviders;
        }
        else {
            const defaultPool = this.getDefaultAllowedProviders(configManager);
            allowed = defaultPool.allowed;
            registryExcluded = defaultPool.excluded;
            reserveProviders = defaultPool.reserve;
        }
        let escalationApplied = false;
        let allowedProviders = allowed;
        if (taskProfile.requiresVerification && taskProfile.escalationTarget) {
            const escalationTarget = taskProfile.escalationTarget;
            if (allowedProviders.includes(escalationTarget)) {
                allowedProviders = [escalationTarget, ...allowedProviders.filter((p) => p !== escalationTarget)];
                escalationApplied = true;
            }
        }
        const cooldown = new Map();
        for (const cb of options.circuitBreakerStatus || []) {
            if (cb.cooldownRemaining > 0)
                cooldown.set(cb.provider, cb.cooldownRemaining);
        }
        // ── Quota ledger (quotaStatus): exhausted providers sink exactly like
        // circuit-breaker cooldown providers. Quota parking is SEPARATE from
        // cooldown so a provider can be quota-parked without circuit-breaker
        // state (and vice versa) — both exclude it from the healthy pick.
        const quotaParked = new Map();
        for (const qs of options.quotaStatus || []) {
            if (qs.cooldownRemaining > 0)
                quotaParked.set(qs.provider, qs.cooldownRemaining);
        }
        // Load runtime stats once (benchmark quality + best-model per agent type)
        const runtime = options.useRuntimeStats ? this.loadRuntimeAdjustments(agentType) : null;
        if (runtime && options.verbose) {
            logger.info(`  📊 Runtime stats: ${runtime.summary}`);
        }
        // M2.1 gate: `routing.capabilityFit` (default ON) makes the soft
        // capability-fit signal reversible — set false to revert to pure
        // dimension-weight scoring. Best-effort config read (mocks / plugin
        // configs may lack getAll): never let the gate break routing.
        let capabilityFitEnabled = true;
        try {
            capabilityFitEnabled = (configManager?.getAll?.()?.routing?.capabilityFit ?? true) !== false;
        }
        catch {
            // Best-effort
        }
        // M2.4 governance: admin policy from `routing.governance`. Best-effort
        // config read — an unset/empty policy is fully permissive (existing
        // behavior unchanged). All violations are hard-eliminations inside the
        // constraint slot below (never scored lower).
        let governance;
        try {
            governance = configManager?.getAll?.()?.routing?.governance;
        }
        catch {
            // Best-effort — policy must never break routing.
        }
        // M2.5 context preflight: `routing.contextFit` (default ON) gates the soft
        // utilization signal exactly like capability-fit — set false to revert to
        // pure dimension-weight scoring. The estimated prompt size is the caller's
        // context hint when provided (the REAL payload — conversation history,
        // gathered context), else the task text itself. Estimation only, never a
        // hard block. Best-effort config read — never let it break routing.
        let contextFitEnabled = true;
        try {
            contextFitEnabled = (configManager?.getAll?.()?.routing?.contextFit ?? true) !== false;
        }
        catch {
            // Best-effort
        }
        // P4 M4.4 mid-stream flakiness: `routing.partialFlakiness` (default ON)
        // gates the reliability penalty the registry's partialRate EMA applies to
        // providers that keep starting streams that die mid-way. When OFF the
        // signal is fully inert (no penalty, no ⏸ chip in `models explain`).
        // Best-effort config read — never let it break routing.
        let partialFlakinessEnabled = true;
        try {
            partialFlakinessEnabled = (configManager?.getAll?.()?.routing?.partialFlakiness ?? true) !== false;
        }
        catch {
            // Best-effort
        }
        const promptTokens = options.contextHintTokens ?? estimateTokens(taskDescription);
        // Score every allowed provider
        let scored = allowedProviders.map((provider) => {
            let caps = this.getCapabilities(provider);
            // Real pricing replaces the static cost capability; M2.2 measured wire
            // tokens (when the provider/gateway reports usage) replace the
            // TYPICAL-token estimate — measured cost is the truth when available.
            let measuredCost;
            if (options.useRealPricing !== false) {
                const pricing = this.getProviderPricing(provider, configManager);
                measuredCost = this.getMeasuredCost(provider);
                caps = { ...caps, cost: computeCostScore(provider, pricing, measuredCost) };
            }
            // Runtime data adjusts reasoning/reliability from real performance
            if (runtime) {
                caps = this.adjustCapabilitiesForRuntime(caps, provider, runtime);
            }
            // P4 M4.4 mid-stream flakiness penalty: a provider that keeps starting
            // streams that die before completion is a WORSE reliability bet than one
            // that errors cleanly (its model is real — it just can't finish). The
            // registry's partialRate EMA (0–1, healed by clean successes) scales the
            // reliability dimension down; gated by `routing.partialFlakiness`.
            let flakiness;
            if (partialFlakinessEnabled) {
                const registryFlakiness = getModelRegistry().getProviderFlakiness(provider);
                if (registryFlakiness > 0) {
                    flakiness = registryFlakiness;
                    // Cap the penalty at 40% of the reliability dimension — a flaky
                    // provider loses ground but is never hard-blocked (it may heal).
                    caps = {
                        ...caps,
                        reliability: Math.max(0, (caps.reliability ?? 0) * (1 - Math.min(0.4, registryFlakiness * 0.5))),
                    };
                }
            }
            const { score, dimensions, weightTotal } = scoreProvider(provider, caps, weights);
            const inCooldown = cooldown.has(provider);
            const qp = quotaParked.get(provider);
            // Capability fit (M2.1): the soft task-type → capability signal, gated
            // by `routing.capabilityFit` (default ON). When disabled the signal is
            // fully inert — raw dimension-weighted scores, no fit field, no suffix.
            // Only HEALTHY candidates get a fit: a parked provider's reason is
            // already definitive, so it carries no fit field (and the explain view
            // shows no chip for it). `caps` is passed through so custom/gateway
            // providers are scored by their REAL capability profile (a strong-
            // reasoning custom provider gets a derived 'reasoning' tag even though
            // no static entry lists it).
            const capabilityFit = qp === undefined && capabilityFitEnabled
                ? capabilityFitScore(taskType, provider, caps)
                : undefined;
            const fitScore = capabilityFit !== undefined ? applyCapabilityFit(score, capabilityFit) : score;
            // M2.5 context preflight (soft, estimation-only): how well the provider's
            // nominal input window fits the estimated prompt size. Gated by
            // `routing.contextFit` (default ON) like capability-fit. NEVER a hard
            // block — even a prompt exceeding the window only caps the penalty
            // (computeContextFit), and unknown windows are neutral. Healthy
            // candidates only: a quota-parked reason is already definitive. NOTE: the
            // window is judged on the CONFIGURED pin (resolveModel); bandit per-model
            // learning may serve a different concrete model whose window differs —
            // an acceptable soft-estimate divergence (bandit is on by default, but
            // cold start stays deterministic until outcomes accumulate).
            const resolvedWindow = qp === undefined && contextFitEnabled
                ? this.resolveContextWindow(provider, this.resolveModel(provider, agentType, configManager, taskDescription), configManager)
                : undefined;
            const contextWindowTokens = resolvedWindow?.window;
            const contextWindowSource = resolvedWindow?.source;
            const contextUtilization = contextWindowTokens !== undefined && promptTokens > 0
                ? promptTokens / contextWindowTokens
                : undefined;
            const contextFit = contextWindowTokens !== undefined
                ? computeContextFit(promptTokens, contextWindowTokens)
                : undefined;
            const finalScore = fitScore * (contextFit ?? 1);
            const reason = qp !== undefined
                ? `${provider} (quota exhausted — auto re-enables in ${Math.ceil(qp / 1000)}s)`
                : this.buildReason(provider, caps, complexity, mode, inCooldown, runtime?.adjusted.has(provider));
            let finalReason = qp !== undefined || capabilityFit === undefined
                ? reason
                : `${reason} · capability-fit ${Math.round(capabilityFit * 100)}%`;
            // Context chip only when the window actually matters (penalty regime) —
            // a normal-size task keeps a clean reason; a squeezed window shows the
            // estimate and the nominal window it was judged against.
            if (contextFit !== undefined && contextFit < 1 && contextWindowTokens !== undefined) {
                finalReason = `${finalReason} · context-fit ${Math.round(contextFit * 100)}% (${promptTokens} tok of ${contextWindowTokens})`;
            }
            // ISSUE-002 context-window transparency: a provider with NO advertised
            // spec anywhere (no live descriptor, no provider-level estimate — the
            // DEFAULT fallback) is flagged so an unadvertised window is never
            // silently treated like a real one. Live/override/provider-estimate
            // windows are known quantities and keep the reason clean for normal-size
            // tasks (the preflight snapshot still carries `contextWindowSource` for
            // every candidate — the explain view shows the full provenance).
            if (contextWindowSource === 'default') {
                finalReason = `${finalReason} · window: no advertised spec (default)`;
            }
            // P4 M4.4 flakiness chip — the reliability penalty is transparent.
            if (flakiness !== undefined && flakiness > 0) {
                finalReason = `${finalReason} · ⏸ flaky mid-stream (${Math.round(flakiness * 100)}%)`;
            }
            return {
                provider,
                score: finalScore,
                dimensions,
                weightTotal,
                inCooldown,
                quotaParked: qp !== undefined,
                capabilityFit,
                contextFit,
                contextUtilization,
                contextWindowTokens,
                contextWindowSource,
                flakiness,
                costSource: measuredCost ? 'measured' : 'estimated',
                costBasis: measuredCost
                    ? { inputTokens: measuredCost.inputTokens, outputTokens: measuredCost.outputTokens }
                    : undefined,
                reason: finalReason,
            };
        });
        // ── Hard constraints: ELIMINATE candidates that can't meet the ask ──────
        // Mirrors ruflo's per-request maxCost/maxLatency/minQuality hard filters —
        // violating providers are dropped (not just scored lower). If constraints
        // eliminate everything, fall back to the full list rather than erroring.
        // minSpeed/minReasoning are judged on the SERVED MODEL (model-level
        // gating); maxCostUsd stays provider-typical (pricing is per provider).
        // ── Free/local-first gate (allowPaid: false) ───────────────────────────
        // Mirrors the assessment's "prefer free/local unless complexity demands":
        // when the user disallows paid providers, ELIMINATE paid ones (typical
        // call cost > $0) for trivial/simple/moderate tasks so free/local models
        // win unless the task demands otherwise. Complex/critical tasks may still
        // use paid/high-capacity models. Falls back to the full list when the gate
        // would eliminate everyone (e.g. only paid providers have credentials).
        if (options.allowPaid === false &&
            (complexity === 'trivial' || complexity === 'simple' || complexity === 'moderate')) {
            const freeOnly = scored.filter((s) => {
                // M2.2: judge by MEASURED cost when the provider reports usage — a
                // gateway with real (tiny) token counts may be free-in-practice even
                // if its list price is non-zero.
                const costUsd = estimateCallCostUsd(s.provider, this.getProviderPricing(s.provider, configManager), s.costBasis);
                return costUsd === 0;
            });
            if (freeOnly.length > 0) {
                scored = freeOnly;
            }
            else if (options.verbose) {
                logger.warn('  ⚠️ allowPaid: false eliminated every provider — falling back to full ranking');
            }
        }
        // M2.4: eliminated-provider audit trail — populated only when the
        // governance/hard-constraint slot actually removes a provider for POLICY
        // reasons (admin lists, admin cost cap, PII block). minSpeed/minReasoning
        // kills stay in the per-provider reason, not this list.
        let governanceBlocked = [];
        if (options.maxCostUsd !== undefined ||
            options.minSpeed !== undefined ||
            effectiveMinReasoning !== undefined ||
            this.governanceActive(governance)) {
            // ── Pass 1: NON-PII constraints (two-pass so the PII hard-gate always
            // sees exactly the survivors of the other rules). ────────────────────
            // M2.4: admin max-cost cap joins the per-call option — the effective
            // cap is the stricter of the two. A governance allow/deny list or admin
            // cap is a HARD elimination. Eliminated providers are recorded in
            // `governanceBlocked` (only policy-related kills; minSpeed/minReasoning
            // stay in the per-provider reason) so the audit trail + explain view
            // show exactly what policy removed.
            const effectiveMaxCostUsd = this.effectiveMaxCost(options.maxCostUsd, governance?.maxCostUsd);
            const blockedHere = [];
            // PII patterns are compiled ONCE per resolve (not per provider) — and a
            // task that matches is computed once, not re-lowered per candidate.
            const taskLower = (taskDescription || '').toLowerCase();
            const compiledPii = (governance?.piiPatterns || [])
                .map((p) => {
                try {
                    return new RegExp(p, 'i');
                }
                catch {
                    return null; // malformed pattern — ignored, never breaks routing
                }
            })
                .filter((r) => r !== null);
            const piiMatched = compiledPii.length > 0 && compiledPii.some((re) => re.test(taskLower));
            const minPrivacy = governance?.minPrivacyForPii ?? 1.0;
            const constrained = scored.filter((s) => {
                if (effectiveMaxCostUsd !== undefined) {
                    const costUsd = estimateCallCostUsd(s.provider, this.getProviderPricing(s.provider, configManager), s.costBasis);
                    if (costUsd > effectiveMaxCostUsd) {
                        if (governance?.maxCostUsd !== undefined) {
                            blockedHere.push({ provider: s.provider, reason: `admin max-cost cap $${effectiveMaxCostUsd} (cost $${costUsd})` });
                        }
                        return false;
                    }
                }
                // minSpeed/minReasoning are judged on the MODEL the router will
                // actually serve (resolveModel: configured pin or task-resolved best
                // model), not the provider baseline — a provider hosting both an
                // 8b-instant and a 70b model must NOT be eliminated for its baseline
                // when the task resolves to the 70b (model-level gating, model-first-
                // router parity). resolveModel never throws; wrapped anyway so a gate
                // can never break routing.
                let servedModel;
                try {
                    servedModel = this.resolveModel(s.provider, agentType, configManager, taskDescription);
                }
                catch {
                    servedModel = undefined;
                }
                const servedCaps = this.getModelCapabilities(s.provider, servedModel);
                if (options.minSpeed !== undefined) {
                    if (servedCaps.speed < options.minSpeed)
                        return false;
                }
                if (effectiveMinReasoning !== undefined) {
                    if (servedCaps.reasoning < effectiveMinReasoning)
                        return false;
                }
                // ── M2.4 governance (non-PII rules) ─────────────────────────────
                // Provider allow/deny lists (admin policy beats credential filtering).
                if (governance?.allowProviders?.length && !governance.allowProviders.includes(s.provider)) {
                    blockedHere.push({ provider: s.provider, reason: 'not on admin allowProviders list' });
                    return false;
                }
                if (governance?.denyProviders?.length && governance.denyProviders.includes(s.provider)) {
                    blockedHere.push({ provider: s.provider, reason: 'on admin denyProviders list' });
                    return false;
                }
                // Model allow/deny lists enforced against the model the router will
                // ACTUALLY serve (the configured pin, or the curated default when no
                // pin is set) — never against an unrelated candidate that happens to
                // be allowed. denyModels wins over allowModels.
                const modelReason = this.governanceModelReason(s.provider, agentType, configManager, governance);
                if (modelReason) {
                    blockedHere.push({ provider: s.provider, reason: modelReason });
                    return false;
                }
                return true;
            });
            // ── Pass 2: PII hard-gate on the NON-PII survivors. ────────────────
            // PII is a PRIVACY policy, not a cost/speed tradeoff: "no PII to
            // low-privacy cloud" holds even when it eliminates every candidate. If
            // any compliant provider survives the other rules, keep ONLY the
            // compliant subset. If NOTHING meets the privacy bar (or the non-PII
            // pass already eliminated everyone), NEVER fall back to a violator —
            // throw PIIPolicyError so the caller surfaces the block instead of
            // silently leaking PII to the cloud.
            if (piiMatched) {
                const piiCompliant = constrained.filter((s) => this.getCapabilities(s.provider).privacy >= minPrivacy);
                for (const s of constrained) {
                    if (this.getCapabilities(s.provider).privacy < minPrivacy) {
                        blockedHere.push({ provider: s.provider, reason: `PII-domain task — privacy ${this.getCapabilities(s.provider).privacy} < required ${minPrivacy}` });
                    }
                }
                if (piiCompliant.length > 0) {
                    scored = piiCompliant;
                    governanceBlocked = blockedHere;
                }
                else {
                    governanceBlocked = blockedHere;
                    throw new PIIPolicyError(minPrivacy);
                }
            }
            else if (constrained.length > 0) {
                scored = constrained;
                governanceBlocked = blockedHere;
            }
            else if (blockedHere.length > 0) {
                // HARD governance gate: an ADMIN rule (provider allow/deny list, model
                // allow/deny list, or the admin max-cost cap) eliminated every
                // candidate. The benign fallback below would resurrect those
                // violators — NEVER serve a provider the admin policy rules out, even
                // when that leaves nothing to serve. Throw so the caller surfaces the
                // policy block honestly (chat/plan render the message, `models
                // explain` renders the full audit trail) instead of silently
                // violating the policy. NOTE: blockedHere holds ONLY governance kills
                // (per-call maxCostUsd/minSpeed/minReasoning never push to it), so
                // this branch is unreachable when only per-call SOFT options were set.
                governanceBlocked = blockedHere;
                throw new GovernancePolicyError(blockedHere);
            }
            else {
                // Benign fallback — only PER-CALL soft options (maxCostUsd/minSpeed/
                // minReasoning) eliminated everyone (an impossible per-request ask),
                // not an admin policy. Keep the full ranking so the caller still gets
                // a decision instead of erroring.
                governanceBlocked = blockedHere;
                if (options.verbose) {
                    logger.warn('  ⚠️ Governance/hard constraints eliminated every provider — falling back to full ranking');
                }
            }
        }
        // Rank: circuit-breaker-cooldown providers sink first, then quota-parked
        // ones, then healthy ones; ties broken by score. A quota-parked provider
        // is only selected when every candidate is parked (matching cooldown).
        scored.sort((a, b) => {
            if (a.inCooldown !== b.inCooldown)
                return a.inCooldown ? 1 : -1;
            if (!!a.quotaParked !== !!b.quotaParked)
                return a.quotaParked ? 1 : -1;
            return b.score - a.score;
        });
        // ── Thompson-sampling bandit: multiply each score by a Beta draw ────────
        // Mirrors ruflo's model-router: final score = deterministicScore × θ where
        // θ ~ Beta(α, β) per complexity bucket. Cold start Beta(1,1) ≈ deterministic.
        // Also: the DETERMINISTIC ranking is captured BEFORE bandit sampling so the
        // promotion gate can A/B the two strategies on the same task (feature 3).
        const deterministicRanking = [...scored];
        const heuristicWinner = deterministicRanking.find((s) => !s.inCooldown) || deterministicRanking[0];
        let routedBy = 'heuristic';
        let banditEscalation = false;
        let escalatedProvider;
        if (options.useBandit) {
            const bandit = getRouterBandit();
            // v3 — the learning bucket is task-INTENT-aware. Derive the intent from
            // the TEXT (analyzedProfile, NOT the hint-overridden taskProfile) so
            // select-time and record-time buckets always match — and so a provider's
            // coding-session wins can never boost it for creative writing.
            const learnIntent = analyzedProfile.intent;
            scored = scored.map((s) => ({
                ...s,
                score: bandit.sampleScore(s.provider, complexity, s.score, learnIntent),
            }));
            scored.sort((a, b) => {
                if (a.inCooldown !== b.inCooldown)
                    return a.inCooldown ? 1 : -1;
                return b.score - a.score;
            });
            routedBy = 'bandit';
            // ── Uncertainty-driven escalation (ruflo model-router mirror) ─────────
            // If the bandit's winner has almost no accumulated data (α+β < threshold),
            // its sampled score is a cold-start guess — committing to it is a coin
            // flip. Escalate to the next-ranked provider that HAS learned data so a
            // strictly better cold-start policy: prefer learned providers over
            // unlearned ones when data exists, behave deterministically otherwise.
            // SANITY BOUND: only escalate to a provider the bandit actually believes
            // in — expected win rate (α/(α+β)) must be meaningfully above 0.5, so a
            // learned-but-failing provider can never steal routing from a strong
            // cold-start winner.
            const minSamples = options.escalationMinSamples ?? DEFAULT_MIN_SAMPLES;
            const winner = scored.find((s) => !s.inCooldown) || scored[0];
            const winnerPrior = bandit.getPrior(winner.provider, complexity, analyzedProfile.intent);
            if (winnerPrior.alpha + winnerPrior.beta < minSamples) {
                // S5: never escalate DOWNWARD in capability. The bandit's learned
                // priors come from past sessions (often coding-heavy local usage), so
                // "learned" ≠ "better for THIS task" — escalating from a strong
                // cold-start winner (e.g. a frontier cloud model with no samples yet)
                // to a weaker learned provider (e.g. a 4-bit local model) was exactly
                // how an essay got routed to the weakest model. Only escalate to a
                // learned provider that is AT LEAST as capable as the winner.
                const winnerCaps = this.getCapabilities(winner.provider);
                const learnedAlternative = scored.find((s) => s.provider !== winner.provider &&
                    !s.inCooldown &&
                    (() => {
                        const p = bandit.getPrior(s.provider, complexity, analyzedProfile.intent);
                        return (p.alpha + p.beta >= minSamples &&
                            p.alpha / (p.alpha + p.beta) >= ESCALATION_WIN_RATE_FLOOR &&
                            this.getCapabilities(s.provider).reasoning >= winnerCaps.reasoning);
                    })());
                if (learnedAlternative) {
                    banditEscalation = true;
                    escalatedProvider = learnedAlternative.provider;
                    if (options.verbose) {
                        logger.info(`  🎲 Bandit uncertainty: ${winner.provider} has no learning data (α+β=${winnerPrior.alpha + winnerPrior.beta}) — escalating to learned ${learnedAlternative.provider} (win-rate ≥ ${ESCALATION_WIN_RATE_FLOOR})`);
                    }
                }
            }
            // ── Promotion-gate enforcement (ruflo promotion discipline) ──────────
            // The bandit may LEARN and RECORD always, but when enforcement is on and
            // the gate has enough diverged A/B data to judge, the bandit is only
            // ALLOWED to change picks if it has PROVEN itself (promoted). A failing
            // bandit falls back to the deterministic heuristic ranking — a learned
            // layer must beat the incumbent before it can steer decisions. The
            // trajectory keeps recording so a future promotion re-enables it.
            if (options.enforcePromotion) {
                const minDecisions = options.promotionMinDecisions ?? DEFAULT_MIN_PROMOTION_DECISIONS;
                const gate = getRouterPromotion().evaluate(minDecisions);
                if (gate.sufficient && !gate.promoted) {
                    scored = [...deterministicRanking];
                    routedBy = 'bandit-gated';
                    banditEscalation = false;
                    escalatedProvider = undefined;
                    if (options.verbose) {
                        logger.warn(`  🚦 Promotion gate: bandit NOT promoted (quality Δ ${(gate.qualityDelta * 100).toFixed(1)}%, cost Δ ${(gate.costDelta * 100).toFixed(1)}%) — using the deterministic heuristic pick.`);
                    }
                }
            }
        }
        // ── ML task-similarity blend (ruflo neural-router analog) ──────────────
        // The bandit learns per provider × complexity bucket; the ML router learns
        // per TASK FEATURES — "tasks that LOOK like this one succeeded on provider
        // X". The learned factor multiplies each candidate's (post-bandit) score;
        // cold start (no similar tasks) is neutral 1.0, min-samples guarded, and
        // strength-clamped so it can never overturn a large deterministic edge.
        if (options.useMlRouter) {
            const ml = getMlRouter();
            const learned = ml.learnedScores(taskDescription, scored.map((s) => s.provider), {
                k: options.mlK ?? DEFAULT_ML_K,
                minSamples: options.mlMinSamples ?? DEFAULT_ML_MIN_SAMPLES,
                strength: options.mlStrength ?? DEFAULT_ML_STRENGTH,
                complexity,
                intent: analyzedProfile.intent,
            });
            let mlAdjusted = false;
            scored = scored.map((s) => {
                const l = learned.get(s.provider);
                if (l?.trusted && l.factor !== 1) {
                    mlAdjusted = true;
                    return { ...s, score: s.score * l.factor, reason: `${s.reason} | ml: ${(l.winRate * 100).toFixed(0)}% win (${l.samples} similar)` };
                }
                return s;
            });
            scored.sort((a, b) => {
                if (a.inCooldown !== b.inCooldown)
                    return a.inCooldown ? 1 : -1;
                return b.score - a.score;
            });
            if (mlAdjusted && options.verbose) {
                logger.info(`  🧠 ML router: adjusted scores from ${ml.size()} learned task(s)`);
            }
        }
        // Pick the best candidate that is not in cooldown and not quota-parked
        // (unless ALL are). When uncertainty escalation fired, select the learned
        // alternative instead.
        const selected = escalatedProvider
            ? scored.find((s) => s.provider === escalatedProvider)
            : scored.find((s) => !s.inCooldown && !s.quotaParked) || scored[0];
        let provider = selected.provider;
        let model = this.resolveModel(provider, agentType, configManager, taskDescription);
        // ── MODEL-FIRST ROUTING: override provider pick with model-level scoring ──
        // Instead of picking a provider then a model, score ALL models across ALL
        // providers and pick the BEST model. This ensures cost-per-million-token,
        // quota availability, and capability fit are evaluated at the MODEL level,
        // not the provider level. The provider is derived FROM the model pick.
        //
        // MODEL-FIRST ROUTING: score individual models across ALL providers.
        // Only activates when:
        //   1. Registry has real model data (verified models from probes)
        //   2. No explicit model pin (user hasn't configured a specific model)
        //   3. useModelFirst option is not explicitly false
        // When a user has pinned a specific model, we respect that choice.
        try {
            const registry = getModelRegistry();
            const hasRealData = registry.getUsableProviders().length > 0;
            const userHasPinnedModel = !!(configManager && (() => {
                try {
                    const { config } = configManager.getProviderConfig(provider);
                    return config?.model && config.model !== 'default';
                }
                catch {
                    return false;
                }
            })());
            // Don't override when bandit escalation has fired — the bandit has
            // learned data and should be respected.
            const modelFirstEnabled = options.useModelFirst ?? (hasRealData && !userHasPinnedModel && !escalatedProvider);
            if (modelFirstEnabled && taskDescription) {
                const modelCandidates = buildModelCandidates(taskDescription, complexity, configManager, allowed);
                if (modelCandidates.length > 0) {
                    const bestModel = modelCandidates[0];
                    // Only override if the model-first pick is significantly better
                    // (at least 10% higher score) to avoid thrashing on marginal gains
                    if (bestModel.score > selected.score * 1.1 || selected.score < 0.3) {
                        provider = bestModel.provider;
                        model = bestModel.model;
                        if (options.verbose) {
                            logger.info(`  🎯 Model-first override: ${provider}/${model} (score ${bestModel.score.toFixed(3)} vs provider ${selected.score.toFixed(3)})`);
                        }
                    }
                }
            }
        }
        catch {
            // Best-effort — model-first must never break routing
        }
        // Note the decision so outcome recording (recordOutcome) can reward the
        // provider that actually served the task.
        if (options.useBandit) {
            const bandit = getRouterBandit();
            bandit.noteDecision(agentType, provider);
            // ── Per-modelId learning (ruflo ADR-149 mirror) ───────────────────────
            // The provider-level prior learns "which PROVIDER won"; the per-model
            // prior learns "which concrete MODEL won" within that provider
            // (llama-3.3-70b-versatile ≠ openai/gpt-oss-20b on the SAME provider).
            // When any candidate model has learned data, prefer the best Thompson-
            // sampled one; cold start keeps the configured model (deterministic).
            model = this.resolveModelWithLearning(provider, model, complexity, options.escalationMinSamples ?? DEFAULT_MIN_SAMPLES, analyzedProfile.intent, taskDescription);
            bandit.noteModelDecision(agentType, model);
            // ── Promotion gate A/B (ruflo router-parallel mirror) ─────────────────
            // Record both the deterministic pick and the bandit pick for this task.
            // The orchestrator's recordOutcome() finalizes it with the real outcome,
            // and `nuvira model bandit` evaluates the three promotion criteria.
            getRouterPromotion().noteParallelDecision(agentType, taskDescription, this.toParallelPick(heuristicWinner, agentType, configManager), this.toParallelPick(selected, agentType, configManager, model));
        }
        // Build fallback chain (skip in-cooldown providers when alternatives exist)
        //
        // DEEP FAILOVER: every provider contributes MULTIPLE models, not one. Before
        // this the chain carried a single resolveModel() pick per provider, so a
        // provider's 2nd-best model was effectively unreachable — a 429 on the one
        // listed model skipped the provider entirely even though its other models
        // were healthy (free tiers meter per-model RPD/TPM, so siblings usually ARE
        // healthy). Ordering: the PRIMARY provider's alternate models first (stay on
        // the provider whose latency/health is already known, no provider switch
        // cost), then the other providers' primary picks, then their alternates, so
        // the chain both uses every model AND still leaves the provider before
        // burning through all of its fallbacks.
        const fallbackChain = [];
        const seenFallback = new Set();
        const pushFallback = (s, model, alternate) => {
            const key = `${s.provider}|${model}`;
            if (seenFallback.has(key))
                return;
            seenFallback.add(key);
            fallbackChain.push({
                provider: s.provider,
                model,
                estimatedCost: 0,
                qualityScore: s.score,
                contextWindowTokens: s.contextWindowTokens,
                reason: alternate
                    ? `Fallback (alternate model on ${s.provider})`
                    : s.inCooldown
                        ? `Fallback (in cooldown): ${s.provider}`
                        : `Fallback: ${s.provider}`,
            });
        };
        const modelsFor = (s) => this.fallbackModelsFor(s.provider, agentType, configManager, taskDescription, complexity);
        // Pass 1: the primary provider's OTHER models (deep failover within the
        // provider that just failed a call).
        for (const s of scored) {
            if (s.provider !== provider)
                continue;
            const models = modelsFor(s).slice(1); // [0] is the primary pick already in use
            for (const m of models)
                pushFallback(s, m, true);
        }
        // Pass 2: every other provider's best model (historical chain order).
        for (const s of scored) {
            if (s.provider === provider)
                continue;
            const models = modelsFor(s);
            if (models.length === 0)
                continue;
            pushFallback(s, models[0], false);
        }
        // Pass 3: those providers' remaining models.
        for (const s of scored) {
            if (s.provider === provider)
                continue;
            const models = modelsFor(s);
            for (const m of models.slice(1))
                pushFallback(s, m, true);
        }
        // Last-resort reserve: credentialed providers the registry has not verified
        // (no data yet). They never enter `ranked`/the primary pick — they are tried
        // only after every ranked fallback is exhausted, so "use every model we can
        // actually call, reject only when nothing is left" holds without routing
        // into unproven models by default.
        for (const p of reserveProviders) {
            if (p === provider)
                continue;
            if (fallbackChain.some((c) => c.provider === p))
                continue;
            fallbackChain.push({
                provider: p,
                model: this.resolveModel(p, agentType, configManager, taskDescription),
                estimatedCost: 0,
                qualityScore: 0,
                reason: `Fallback (unverified — last resort): ${p}`,
            });
        }
        // Pass 4 (reserve, deep): the reserve providers' alternate models too, so a
        // last-resort credential pool is not limited to one model per provider.
        for (const p of reserveProviders) {
            if (p === provider)
                continue;
            for (const m of this.fallbackModelsFor(p, agentType, configManager, taskDescription, complexity).slice(1)) {
                const key = `${p}|${m}`;
                if (seenFallback.has(key))
                    continue;
                seenFallback.add(key);
                fallbackChain.push({
                    provider: p,
                    model: m,
                    estimatedCost: 0,
                    qualityScore: 0,
                    reason: `Fallback (unverified, alternate model — last resort): ${p}`,
                });
            }
        }
        const explanation = this.buildExplanation(agentType, complexity, taskType, selected, mode, model, weights, taskProfile) + (routedBy === 'bandit' ? ' | bandit-learned' : '') +
            (banditEscalation ? ' | escalated: winner unlearned' : '') +
            // ISSUE-002 explanation transparency: cite the registry data that
            // excluded providers from the candidate pool, so auto routing proves
            // its gathered telemetry is driving decisions ("excluded: openrouter
            // (0 verified models, 6 unavailable)").
            (registryExcluded.length > 0
                ? ` | excluded: ${registryExcluded.map((e) => `${e.provider} (${e.reason})`).join(', ')}`
                : '');
        if (options.verbose) {
            logger.info(`  🤖 Auto routing: ${explanation}`);
        }
        // M2.5: context preflight snapshot over the FINAL ranked set (post
        // governance/constraints), so the explain view shows exactly what the
        // surviving candidates were judged against.
        const contextPreflight = contextFitEnabled
            ? {
                estimatedPromptTokens: promptTokens,
                basis: options.contextHintTokens !== undefined ? 'hint' : 'task',
                // Resolve the window even for quota-parked candidates (their scored
                // entry deliberately omits the context fields — the park reason is
                // definitive — but the preflight snapshot must still show a window;
                // the human explain renderer calls toLocaleString() on it).
                providers: scored.map((s) => {
                    const w = s.contextWindowTokens !== undefined
                        ? { window: s.contextWindowTokens, source: s.contextWindowSource }
                        : this.resolveContextWindow(s.provider, this.resolveModel(s.provider, agentType, configManager, taskDescription), configManager);
                    return {
                        provider: s.provider,
                        contextWindowTokens: w.window,
                        contextWindowSource: w.source,
                        utilization: s.contextUtilization,
                        fit: s.contextFit,
                    };
                }),
            }
            : undefined;
        return {
            agentType,
            complexity,
            taskProfile,
            escalationApplied,
            taskType,
            provider,
            model,
            score: selected.score,
            weights,
            ranked: scored,
            fallbackChain,
            explanation,
            routedBy,
            banditEscalation,
            governanceBlocked,
            registryExcluded,
            contextPreflight,
        };
    }
    /**
     * M2.5: nominal input context window (tokens) for a provider×model. Model
     * table → provider fallback → generous default. `routing.contextWindows`
     * overrides (keyed by model, or by provider as a provider-level default)
     * always win. Estimation-only input — never a hard block.
     *
     * ISSUE-002: also returns WHERE the window came from so the explanation can
     * flag estimate/default windows — "no advertised spec" is never silently
     * treated like a real one.
     */
    resolveContextWindow(provider, model, configManager) {
        try {
            const overrides = configManager?.getAll?.()?.routing?.contextWindows;
            if (overrides) {
                // Coerce string values (e.g. `nuvira config set routing.contextWindows.local
                // 16384` stores "16384") to numbers so utilization math never relies on
                // JS coercion; invalid/non-positive values fall through.
                const fromOverride = (key) => {
                    const v = overrides[key];
                    if (v === undefined)
                        return undefined;
                    const n = Number(v);
                    return Number.isFinite(n) && n > 0 ? n : undefined;
                };
                const modelWin = fromOverride(model);
                if (modelWin !== undefined)
                    return { window: modelWin, source: 'override' };
                const providerWin = fromOverride(provider);
                if (providerWin !== undefined)
                    return { window: providerWin, source: 'override' };
            }
        }
        catch {
            // Best-effort — config read must never break routing.
        }
        // LIVE provider-advertised window first: recorded by the listModels probe
        // when the endpoint exposes it (Ollama context_length, OpenRouter
        // context_length). The router's preflight prefers the model's real spec
        // over a static provider-level default.
        const live = getModelRegistry().getEntry(provider, model)?.contextWindowTokens;
        if (live !== undefined && live > 0)
            return { window: live, source: 'live' };
        // Provider-level nominal window — a static estimate, never a per-model
        // hardcoded table. Flagged as 'provider' so the explanation can say the
        // window is an estimate, not the provider's advertised spec.
        const providerWindow = PROVIDER_CONTEXT_WINDOWS[provider];
        if (providerWindow !== undefined && providerWindow > 0) {
            return { window: providerWindow, source: 'provider' };
        }
        return { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
    }
    /**
     * Record a real task outcome so the bandit can learn from actual results.
     * A `complexityHint` (the plan's TaskStep.complexity) keeps the bandit
     * bucket consistent with the hint used at resolve() time.
     * Only meaningful when `useBandit` is enabled during resolve(); the reward
     * is cost-adjusted — the provider's real pricing drives the α bump so a
     * cheap provider's success is worth the most (mirrors ruflo's cost-adjusted
     * reward table).
     *
     * @param agentType  The agent type the routed task belonged to
     * @param taskDescription The task text (complexity bucket is re-derived)
     * @param outcome    success | failure | escalated
     * @param configManager Optional — used to resolve per-provider pricing
     *                       overrides when computing the cost-adjusted reward
     */
    recordOutcome(agentType, taskDescription, outcome, configManager, outcomeData, complexityHint) {
        const bandit = getRouterBandit();
        const provider = bandit.getLastProvider(agentType);
        if (!provider)
            return;
        const costScore = computeCostScore(provider, this.getProviderPricing(provider, configManager));
        // v3 — bucket the outcome under the SAME text-derived task intent the
        // resolve() sampling used (analyzeTaskProfile, hint-independent), so a
        // model's coding wins can't leak into its creative-win prior and vice
        // versa. Mirrors the select-time derivation exactly.
        const learnIntent = analyzeTaskProfile(taskDescription).intent;
        if (complexityHint) {
            bandit.recordOutcomeWithComplexity(provider, complexityHint, outcome, costScore, undefined, learnIntent);
        }
        else {
            bandit.recordOutcome(provider, taskDescription, outcome, costScore, undefined, learnIntent);
        }
        // Per-modelId learning: attribute the same outcome to the concrete model
        // that served the task (ruflo ADR-149 mirror) so the model choice learns.
        const model = bandit.getLastModel(agentType);
        if (model) {
            if (complexityHint) {
                bandit.recordModelOutcomeWithComplexity(model, complexityHint, outcome, costScore, undefined, learnIntent);
            }
            else {
                bandit.recordModelOutcome(model, taskDescription, outcome, costScore, undefined, learnIntent);
            }
        }
        // Promotion gate: finalize the parallel A/B decision with the real outcome
        // so `nuvira model bandit` can judge bandit-vs-heuristic on real trajectories.
        // Keyed by agentType+task so parallel tasks never misattribute outcomes.
        try {
            getRouterPromotion().recordOutcome(agentType, taskDescription, outcome, outcomeData);
        }
        catch {
            // Best-effort — never break outcome recording on a promotion error.
        }
        // ML task-similarity router: record the same outcome as a feature vector
        // so the kNN layer learns "tasks like THIS succeed on provider X". Same
        // text-derived intent/complexity bucketing as the bandit for consistency.
        try {
            const intent = analyzeTaskProfile(taskDescription).intent;
            const learnComplexity = complexityHint ?? analyzeComplexity(taskDescription);
            getMlRouter().record(taskDescription, provider, model ?? 'default', outcome, costScore, agentType, learnComplexity, intent);
        }
        catch {
            // Best-effort — ML recording must never break outcome handling.
        }
    }
    /**
     * Choose the concrete model within the selected provider using per-model
     * bandit priors (ruflo ADR-149 mirror).
     *
     * Candidate models = the provider's configured pin (if real) + the curated
     * known-good defaults for the provider. Cold start (no per-model data yet)
     * keeps the configured model — deterministic. Once outcomes accumulate,
     * the best Thompson-sampled LEARNED model wins, so the model choice learns.
     */
    resolveModelWithLearning(provider, configuredModel, complexity, minSamples = DEFAULT_MIN_SAMPLES, taskIntent, taskDescription) {
        const bandit = getRouterBandit();
        const candidates = [];
        if (configuredModel && configuredModel !== 'default')
            candidates.push(configuredModel);
        // MODEL-LEVEL ROUTING: use model scoring to rank candidates by task fitness.
        // This ensures the bandit learns from the BEST models, not just verified ones.
        if (taskDescription) {
            try {
                const scored = topModelCandidates(provider, taskDescription, 10, complexity);
                for (const s of scored) {
                    if (!candidates.includes(s.model))
                        candidates.push(s.model);
                }
            }
            catch {
                // Fall through to preferred models
            }
        }
        // Supplement with preferred models (health-ranked verified models)
        for (const m of preferredModelsFor(provider)) {
            if (!candidates.includes(m))
                candidates.push(m);
        }
        if (candidates.length === 0)
            return configuredModel || 'default';
        // v3 — per-model learning is intent-bucketed like provider learning: the
        // SAME taskIntent the outcome was recorded under (recordModelOutcome)
        // must be the bucket sampled here, or per-model data never surfaces.
        const learned = candidates.filter((m) => {
            const p = bandit.getModelPrior(m, complexity, taskIntent);
            return p.alpha + p.beta >= minSamples;
        });
        // Cold start: no per-model data → keep the best-scored candidate (deterministic).
        if (learned.length === 0)
            return candidates[0];
        // Learned: pick the candidate with the best Thompson-sampled per-model draw.
        const sampled = learned
            .map((m) => ({ model: m, score: bandit.sampleModelScore(m, complexity, 1, taskIntent) }))
            .sort((a, b) => b.score - a.score);
        return sampled[0].model;
    }
    /**
     * Build a ParallelPick (promotion-gate A/B record) for a scored provider.
     * Used to log the deterministic pick vs the bandit pick for the same task.
     *
     * @param modelOverride  The ACTUAL model chosen for the bandit side (e.g. a
     *                       per-model-learned pick). Defaults to the provider's
     *                       configured pin so the A/B records the real served
     *                       model — otherwise per-model divergence would be
     *                       invisible to the promotion gate.
     */
    toParallelPick(scored, agentType, configManager, modelOverride) {
        const caps = this.getCapabilities(scored.provider);
        return {
            provider: scored.provider,
            model: modelOverride ?? this.resolveModel(scored.provider, agentType, configManager),
            predictedQuality: scored.score,
            predictedCostUsd: estimateCallCostUsd(scored.provider, this.getProviderPricing(scored.provider, configManager)),
            // Rough latency estimate from the speed capability (higher = faster).
            estimatedLatencyMs: Math.round(3000 + (1 - caps.speed) * 6000),
        };
    }
    /**
     * Resolve the effective per-1K-token pricing for a provider.
     * Config overrides (`nuvira config set pricing.<provider>...`) win over the
     * built-in pricing table; unknown providers fall back to a cheap default.
     */
    getProviderPricing(provider, configManager) {
        const override = configManager?.getAll().pricing?.[provider];
        // Issue 001: fall back through the pricing table, then the provider
        // catalog's list pricing, then a cheap default — extended catalog
        // providers cost-score with real numbers, never a neutral guess.
        const catalog = getCatalogProvider(provider);
        const builtin = PROVIDER_PRICING_PER_1K[provider] ||
            (catalog ? catalog.pricing : undefined) ||
            { inputPer1K: 0.00010, outputPer1K: 0.00010 };
        return {
            inputPer1K: override?.inputPer1K ?? builtin.inputPer1K,
            outputPer1K: override?.outputPer1K ?? builtin.outputPer1K,
        };
    }
    /**
     * M2.2: measured wire-token profile for a provider from the Model
     * Availability Registry (sample-weighted EMA). Best-effort — registry
     * bookkeeping must never break routing; undefined ⇒ estimated cost.
     */
    getMeasuredCost(provider) {
        try {
            return getModelRegistry().getMeasuredUsage(provider);
        }
        catch {
            return undefined;
        }
    }
    // ── M2.4 governance helpers ───────────────────────────────────────────────
    /**
     * Whether any governance policy is configured (so the constraint slot only
     * runs when there is something to enforce).
     */
    governanceActive(g) {
        if (!g)
            return false;
        return Boolean((g.allowProviders?.length ?? 0) > 0 ||
            (g.denyProviders?.length ?? 0) > 0 ||
            (g.allowModels?.length ?? 0) > 0 ||
            (g.denyModels?.length ?? 0) > 0 ||
            (g.piiPatterns?.length ?? 0) > 0 ||
            g.maxCostUsd !== undefined);
    }
    /**
     * Effective per-call max-cost cap: the stricter of the per-call option and
     * the admin governance cap. undefined when neither is set.
     */
    effectiveMaxCost(perCallUsd, adminUsd) {
        if (perCallUsd === undefined)
            return adminUsd;
        if (adminUsd === undefined)
            return perCallUsd;
        return Math.min(perCallUsd, adminUsd);
    }
    /**
     * Why a provider fails the governance MODEL allow/deny lists, or undefined
     * when it passes. Enforced against the model the router will ACTUALLY serve:
     *   - the CONFIGURED pin when one is set (resolveModel returns it) — a pin
     *     on the deny-list, or NOT on the allow-list, kills the provider. This
     *     closes the "any candidate passes but the served pin violates" hole.
     *   - the curated defaults when NO pin is set (the adapter's default model
     *     is what a no-pin resolve serves) — deny wins, allow must include one.
     * denyModels always wins over allowModels.
     */
    governanceModelReason(provider, agentType, configManager, governance) {
        if (!governance)
            return undefined;
        const configured = this.resolveModel(provider, agentType, configManager);
        const served = configured && configured !== 'default' ? [configured] : preferredModelsFor(provider);
        const candidates = served.length > 0 ? served : ['default'];
        if (governance.denyModels?.length && candidates.some((m) => governance.denyModels.includes(m))) {
            const denied = candidates.find((m) => governance.denyModels.includes(m));
            return `model '${denied}' on admin denyModels list`;
        }
        if (governance.allowModels?.length && !candidates.some((m) => governance.allowModels.includes(m))) {
            return `model '${candidates.join(', ')}' not on admin allowModels list`;
        }
        return undefined;
    }
    /**
     * The ranked model list a provider can serve this task with, best first.
     *
     * Always starts with the model the router would actually pick, then the
     * provider's other task-scored candidates, then its remaining health-ranked
     * verified models. This is what makes the failover chain DEEP (several models
     * per provider) instead of one: a provider with five working models must be
     * able to serve from all five, not give up after its first rate limit.
     *
     * Never returns the `'default'` SENTINEL or a non-chat model (a probe can
     * verify a classifier/embedding/vision model, which can never answer a turn).
     * Best-effort — scoring failures degrade to the pick + verified list.
     */
    fallbackModelsFor(provider, agentType, configManager, taskDescription, complexity) {
        const out = [];
        const push = (model) => {
            if (!model || model === 'default')
                return;
            if (out.includes(model))
                return;
            if (isNonChatModel(model))
                return;
            out.push(model);
        };
        push(this.resolveModel(provider, agentType, configManager, taskDescription));
        if (taskDescription) {
            try {
                for (const c of topModelCandidates(provider, taskDescription, FALLBACK_MODELS_PER_PROVIDER, complexity)) {
                    push(c.model);
                }
            }
            catch {
                // Best-effort — model scoring must never break the chain.
            }
        }
        for (const m of preferredModelsFor(provider))
            push(m);
        // HEALTHY-FIRST, but never dropped: a model the registry currently deems
        // unusable (parked on its own quota / marked unavailable) must not outrank
        // a healthy sibling, yet it stays in the list as the LAST resort — parks
        // are short and the model may well have recovered by the time the walk
        // gets to it ("use every model available; reject only when nothing is
        // left"). Stable partition preserves the scoring order within each group.
        const usable = [];
        const unusable = [];
        try {
            const registry = getModelRegistry();
            for (const m of out) {
                if (registry.getEntry(provider, m) && !registry.isUsable(provider, m))
                    unusable.push(m);
                else
                    usable.push(m);
            }
        }
        catch {
            // Best-effort — a registry failure must not empty the chain.
            return out.slice(0, FALLBACK_MODELS_PER_PROVIDER);
        }
        return [...usable, ...unusable].slice(0, FALLBACK_MODELS_PER_PROVIDER);
    }
    /**
     * Resolve the model name to use within a chosen provider.
     * Prefers the provider's configured model; falls back to 'default'.
     *
     * Registry-aware pin preference (the "no more recursion" guarantee): when
     * the Model Availability Registry has DEFINITIVELY ruled out the configured
     * pin (unavailable / quota-parked from real telemetry or a probe), the
     * router must NOT keep re-selecting it — the validator would re-repair it
     * with a "model not available" warning on every message. Instead, prefer a
     * registry-VERIFIED working model for the provider so auto routing lands on
     * a model that is known to work from the start.
     *
     * A pin the registry has no data on (cold start) is returned unchanged —
     * the live-list validator repairs it (once) and telemetry then verifies the
     * replacement, so the registry learns before the next message.
     */
    resolveModel(provider, agentType, configManager, taskDescription) {
        if (configManager) {
            try {
                const { config } = configManager.getProviderConfig(provider);
                if (config?.model && config.model !== 'default') {
                    // Best-effort registry consult — never let it break model resolution.
                    try {
                        const registry = getModelRegistry();
                        const entry = registry.getEntry(provider, config.model);
                        const pinDead = !!entry && (entry.status === 'unavailable' || entry.quotaParkedUntil > Date.now());
                        if (pinDead) {
                            const verified = registry.resolveVerifiedModel(provider, preferredModelsFor(provider));
                            if (verified)
                                return verified;
                        }
                    }
                    catch {
                        // Fall through to the configured pin
                    }
                    return config.model;
                }
            }
            catch {
                // Fall through to default
            }
        }
        // MODEL-LEVEL ROUTING: when no specific model is configured, use the
        // model scoring module to pick the BEST model from the provider's
        // available models based on task requirements. This is the key fix that
        // makes the auto-router leverage ALL discovered models (300+ on OpenRouter,
        // multiple on Groq/Gemini/NIM, etc.) instead of falling back to a single
        // hardcoded default.
        if (taskDescription) {
            try {
                const bestModel = pickBestModel(provider, taskDescription);
                if (bestModel) {
                    // USABILITY GATE: a task-scored model can still be one the registry
                    // has parked (its own quota window) or marked unavailable. It must
                    // never win the PRIMARY pick while a servable sibling exists —
                    // scoring alone ranks the parked model low, not out. The registry
                    // re-admits it automatically once its window lapses, so this is the
                    // per-model quota contract end to end: skip the resting model, serve
                    // from a sibling, and pick the resting one again when it recovers.
                    const registry = getModelRegistry();
                    const entry = registry.getEntry(provider, bestModel);
                    if (!entry || registry.isUsable(provider, bestModel))
                        return bestModel;
                    const usable = preferredModelsFor(provider)[0];
                    if (usable)
                        return usable;
                    // Nothing usable — fall through to the parked pick (the park may have
                    // lapsed, and a rejected pick is better than no model at all).
                    return bestModel;
                }
            }
            catch {
                // Fall through to preferred models
            }
        }
        // Fallback: use preferred models from registry (health-ranked)
        const preferred = preferredModelsFor(provider);
        if (preferred.length > 0)
            return preferred[0];
        // LAST RESORT: use the catalog's curated default model for this provider.
        // This ensures resolveModel() NEVER returns 'default' — every provider
        // always resolves to a real, known-working model name.
        return getDefaultModel(provider);
    }
    /**
     * Pick the best model within the selected provider, given a list of model
     * descriptors (e.g., from provider.listModels()). Keeps the configured model
     * if present, otherwise the first non-speech model, otherwise 'default'.
     */
    pickModelFromCatalog(provider, models, configManager) {
        const configured = this.resolveModel(provider, 'default', configManager);
        if (configured !== 'default')
            return configured;
        const usable = models.find((m) => !(m.tags || []).includes('speech'));
        return usable?.id || getDefaultModel(provider);
    }
    /**
     * Load runtime performance data: per-provider benchmark quality and the
     * best-performing model for the given agent type (from agent stats).
     */
    loadRuntimeAdjustments(agentType) {
        const benchmarkQuality = {};
        const counts = {};
        try {
            for (const run of getBenchmarkRuns()) {
                benchmarkQuality[run.provider] = (benchmarkQuality[run.provider] || 0) + run.summary.avgQualityScore;
                counts[run.provider] = (counts[run.provider] || 0) + 1;
            }
            for (const provider of Object.keys(benchmarkQuality)) {
                benchmarkQuality[provider] /= counts[provider] || 1;
            }
        }
        catch {
            // Benchmark data unavailable — proceed without it
        }
        let bestModelForAgent;
        try {
            bestModelForAgent = getAgentStats().getBestModel(agentType);
        }
        catch {
            // Stats unavailable
        }
        const parts = [];
        if (Object.keys(benchmarkQuality).length > 0) {
            parts.push(`${Object.keys(benchmarkQuality).length} provider(s) benchmarked`);
        }
        if (bestModelForAgent) {
            parts.push(`best model for '${agentType}' is ${bestModelForAgent}`);
        }
        return {
            benchmarkQuality,
            bestModelForAgent,
            adjusted: new Set(),
            summary: parts.join('; ') || 'no data yet',
        };
    }
    /**
     * Adjust a provider's capability scores from runtime data:
     * - Benchmark quality blends into `reasoning` (30% measured / 70% static)
     * - A proven best model for this agent type boosts reliability + reasoning
     */
    adjustCapabilitiesForRuntime(caps, provider, runtime) {
        const adjusted = { ...caps };
        let touched = false;
        const bq = runtime.benchmarkQuality[provider];
        if (bq !== undefined) {
            adjusted.reasoning = Math.min(1, caps.reasoning * 0.7 + bq * 0.3);
            touched = true;
        }
        if (runtime.bestModelForAgent && runtime.bestModelForAgent.startsWith(provider + '/')) {
            adjusted.reliability = Math.min(1, caps.reliability + 0.08);
            adjusted.reasoning = Math.min(1, adjusted.reasoning + 0.05);
            touched = true;
        }
        if (touched)
            runtime.adjusted.add(provider);
        return adjusted;
    }
    /** Build a short reason for a provider's rank. */
    buildReason(provider, caps, complexity, mode, inCooldown, runtimeAdjusted = false) {
        if (inCooldown)
            return `${provider} (circuit-breaker cooldown active)`;
        const parts = [];
        if (caps.privacy >= 0.9)
            parts.push('fully private/local');
        if (caps.speed >= 0.9)
            parts.push('fastest');
        if (caps.reasoning >= 0.9)
            parts.push('strongest reasoning');
        if (caps.cost >= 0.85)
            parts.push('cheapest');
        if (mode === 'privacy-first')
            parts.push('privacy-weighted');
        if (runtimeAdjusted)
            parts.push('📊 stats-adjusted');
        return parts.length ? `${provider}: ${parts.join(', ')}` : `${provider}: adequate for ${complexity} complexity`;
    }
    /** Build the human-readable decision explanation. */
    buildExplanation(agentType, complexity, taskType, selected, mode, model, weights, taskProfile) {
        const complexityLabels = {
            trivial: '🟢 trivial',
            simple: '🔵 simple',
            moderate: '🟡 moderate',
            complex: '🟠 complex',
            critical: '🔴 critical',
        };
        const dominant = Object.keys(DIMENSION_LABELS)
            .reduce((a, b) => (weights[b] > weights[a] ? b : a), 'reasoning');
        const modeStr = mode !== 'balanced' ? ` | ${mode}` : '';
        const profileSuffix = taskProfile.requiresVerification ? ' | verification' : '';
        return `${agentType} (${complexityLabels[complexity]}, ${taskType}) → ${selected.provider}/${model} ` +
            `score ${selected.score.toFixed(2)} | dominant: ${DIMENSION_LABELS[dominant]}${modeStr}${profileSuffix}`;
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let autoRouterInstance = null;
/**
 * Get or create the AutoModelRouter singleton.
 */
export function getAutoRouter() {
    if (!autoRouterInstance) {
        autoRouterInstance = new AutoModelRouter();
    }
    return autoRouterInstance;
}
/**
 * Reset the singleton (useful for testing).
 */
export function resetAutoRouter() {
    autoRouterInstance = null;
}
//# sourceMappingURL=auto-router.js.map