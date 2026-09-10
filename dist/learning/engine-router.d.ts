/**
 * Engine router (`src/learning/engine-router.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 2: "Route MODE as well as model."
 *
 * The plan of record: `runToolLoop` is the universal engine; the orchestrator
 * pipeline survives as the direct path for CI/publish AND for the weak/local
 * tier — "this is how the weak-model advantage is kept honestly." The router
 * already knows the model tier; this module turns that knowledge into an
 * ENGINE decision, deterministically (no LLM call, sub-microsecond):
 *
 *   1. Explicit config (`routing.engineMode`: 'loop' | 'pipeline') wins —
 *      the user's override is absolute (CI scripts pin `pipeline`).
 *   2. `auto` (default): provider tier decides —
 *        weak/local tier  → pipeline (the guided pipeline genuinely helps a
 *                           4-bit local model that would flounder in a free
 *                           loop — assessment v1 §3 win #4);
 *        strong tier      → loop (the assessment's core thesis).
 *   3. Unknown providers default to loop (the plan demotes the pipeline to an
 *      opt-in path, so the burden of proof is on weakness, not strength).
 *
 * Tier evidence, in order: provider id (local runners are weak by
 * definition), then the catalog's static reasoning baseline
 * (capabilities.reasoning < WEAK_REASONING_FLOOR). The registry's live
 * benchmark data is deliberately NOT consulted here — engine selection must
 * be stable within a session (a task flipping engines mid-run would break
 * resume/checkpoint semantics), and the catalog baseline is the same signal
 * the cold-start router already relies on.
 *
 * Consumers: `nuvira execute --engine auto|loop|pipeline` (Phase 1.1) and
 * the eval framework's engine arms (Phase 0).
 */
import type { ComplexityLevel } from './hybrid-router.js';
/** The executable engines (Addendum v4 guiding decision). */
export type EngineMode = 'loop' | 'pipeline';
/** Config values for `routing.engineMode` — 'auto' is the default. */
export type EngineModeConfig = 'auto' | EngineMode;
/** Why an engine was chosen (telemetry / CLI explanation / tests). */
export type EngineReason = 'config-override' | 'local-provider' | 'weak-reasoning-tier' | 'strong-tier-default' | 'unknown-provider-default';
/** The engine decision + the evidence behind it (auditable, never opaque). */
export interface EngineDecision {
    engine: EngineMode;
    reason: EngineReason;
    /** Human-readable one-liner for CLI/telemetry surfaces. */
    explanation: string;
    /** Inputs the decision was computed from (echoed for the audit trail). */
    inputs: {
        provider: string | undefined;
        model: string | undefined;
        complexity: ComplexityLevel | undefined;
        configMode: EngineModeConfig;
    };
}
/** Minimal ConfigManager shape (real instance or a test stub). */
export interface EngineRouterConfigLike {
    getAll?(): {
        routing?: {
            engineMode?: string;
        };
    };
}
/** Read `routing.engineMode` from config ('auto' on absence/failure). */
export declare function readEngineModeConfig(cm?: EngineRouterConfigLike): EngineModeConfig;
/**
 * Is this provider the weak/local tier? Order matters: the id check is
 * authoritative for local runners (a catalog entry may be missing entirely
 * for plugin providers), the catalog reasoning baseline covers keyed cloud
 * providers with weak models.
 */
export declare function isWeakTierProvider(provider: string | undefined): boolean;
/**
 * Resolve which engine should execute a task. Pure + deterministic: the same
 * inputs always yield the same decision (eval arms rely on this).
 *
 * @param opts.provider    routed provider id (undefined = no routing happened)
 * @param opts.model       routed model id (echoed in the decision only)
 * @param opts.complexity  task complexity (echoed; tier decides in v4)
 * @param opts.configManager  config source for `routing.engineMode`
 */
export declare function resolveEngine(opts: {
    provider?: string;
    model?: string;
    complexity?: ComplexityLevel;
    configManager?: EngineRouterConfigLike;
}): EngineDecision;
/**
 * Convenience predicate for callers that only need the mode (the dashboard
 * badge, the eval framework's arm selection). Same inputs, same determinism.
 */
export declare function engineForTask(provider: string | undefined, model: string | undefined, complexity: ComplexityLevel | undefined, cm?: EngineRouterConfigLike): EngineMode;
//# sourceMappingURL=engine-router.d.ts.map