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
import { type AutoRouteResult } from './auto-router.js';
import { type ComplexityLevel } from './hybrid-router.js';
import type { ConfigManager } from '../config/manager.js';
import type { LLMCallFn } from '../agents/agent.js';
/** Failure classification for routing decisions. */
type FailureKind = 'auth' | 'rate-limit' | 'timeout' | 'network' | 'model-not-found' | 'unknown';
/** A candidate provider×model pair in the failover chain. */
export interface FailoverCandidate {
    provider: string;
    model: string;
    score: number;
}
/**
 * Options for {@link buildDeepFailoverPool}. The task text + complexity let the
 * model-first tiered layer contribute candidates; without them the pool is the
 * router chain alone (still deep, just not tier-aware).
 */
export interface DeepFailoverOptions {
    /** Task/goal text — feeds the model-first capability analysis. */
    taskDescription?: string;
    /** Pre-computed complexity (falls back to a plain analysis when omitted). */
    complexity?: ComplexityLevel;
    /** Config manager for the config-declared fallback providers. */
    configManager?: ConfigManager;
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
/**
 * Cross-pipeline failures. Keys are EITHER a bare provider id (provider-wide
 * exclusion — legacy shape, still honored) or `provider|model` (per-model
 * exclusion). Model keys let a failure on one model survive a restart without
 * taking the provider's other models with it.
 */
interface PersistedFailures {
    [key: string]: {
        expiresAt: number;
        kind: FailureKind;
        recordedAt: number;
    };
}
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
export declare function createResilientCallLLM(configManager: ConfigManager, options: ResilientCallOptions): LLMCallFn;
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
export declare function buildDeepFailoverPool(decision: AutoRouteResult | null, opts?: DeepFailoverOptions): FailoverCandidate[];
/** A session-exclusion map in EITHER of the shapes used across the codebase. */
type ExclusionMap = Map<string, number | {
    expiresAt: number;
}>;
/**
 * Options for {@link createFailoverExclusionFilter}.
 */
export interface FailoverExclusionOptions {
    /** PROVIDER-wide session exclusions (dead key, unresolved model). */
    sessionFailed?: ExclusionMap;
    /** MODEL-scoped session exclusions, keyed `provider|model`. */
    sessionFailedModels?: ExclusionMap;
    /**
     * Cross-pipeline failures recorded by ANY path (default: on). Pass `false` to
     * keep the decision purely in-process.
     */
    crossPipelineMemory?: boolean;
    /**
     * Already-loaded persisted failures — avoids a second disk read when the
     * caller has one. Ignored when `crossPipelineMemory` is false.
     */
    persistedFailures?: PersistedFailures;
    /** Consult the registry's per-ENTRY usability (default: on). */
    registryCheck?: boolean;
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
export declare function createFailoverExclusionFilter(opts?: FailoverExclusionOptions): (provider: string, model?: string) => boolean;
export {};
//# sourceMappingURL=resilient-call.d.ts.map