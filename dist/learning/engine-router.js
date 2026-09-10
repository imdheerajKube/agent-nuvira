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
import { getCatalogProvider } from '../inference/provider-catalog.js';
/** Catalog reasoning baseline below which a provider is "weak tier". */
const WEAK_REASONING_FLOOR = 0.5;
/** Provider ids that are local runners (weak tier by definition). */
const LOCAL_PROVIDER_IDS = new Set([
    'local', 'ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'jan', 'gpt4all',
]);
/** Read `routing.engineMode` from config ('auto' on absence/failure). */
export function readEngineModeConfig(cm) {
    try {
        const mode = cm?.getAll?.()?.routing?.engineMode;
        return mode === 'loop' || mode === 'pipeline' ? mode : 'auto';
    }
    catch {
        return 'auto';
    }
}
/**
 * Is this provider the weak/local tier? Order matters: the id check is
 * authoritative for local runners (a catalog entry may be missing entirely
 * for plugin providers), the catalog reasoning baseline covers keyed cloud
 * providers with weak models.
 */
export function isWeakTierProvider(provider) {
    if (!provider)
        return false;
    if (LOCAL_PROVIDER_IDS.has(provider.toLowerCase()))
        return true;
    const catalog = getCatalogProvider(provider);
    if (!catalog)
        return false; // unknown → not provably weak (default strong)
    return catalog.capabilities.reasoning < WEAK_REASONING_FLOOR;
}
/**
 * Resolve which engine should execute a task. Pure + deterministic: the same
 * inputs always yield the same decision (eval arms rely on this).
 *
 * @param opts.provider    routed provider id (undefined = no routing happened)
 * @param opts.model       routed model id (echoed in the decision only)
 * @param opts.complexity  task complexity (echoed; tier decides in v4)
 * @param opts.configManager  config source for `routing.engineMode`
 */
export function resolveEngine(opts) {
    const inputs = {
        provider: opts.provider,
        model: opts.model,
        complexity: opts.complexity,
        configMode: readEngineModeConfig(opts.configManager),
    };
    // 1. Explicit override — absolute (CI pins 'pipeline', enthusiasts pin 'loop').
    if (inputs.configMode !== 'auto') {
        return {
            engine: inputs.configMode,
            reason: 'config-override',
            explanation: `routing.engineMode='${inputs.configMode}' — explicit override`,
            inputs,
        };
    }
    // 2. auto: weak/local tier → pipeline (the guided pipeline genuinely helps
    //    a model that would flounder in a free loop — the assessment's v1 §3
    //    win #4, kept honestly).
    if (LOCAL_PROVIDER_IDS.has((opts.provider ?? '').toLowerCase())) {
        return {
            engine: 'pipeline',
            reason: 'local-provider',
            explanation: `provider '${opts.provider}' is a local runner — guided pipeline (weak-model advantage)`,
            inputs,
        };
    }
    const catalog = opts.provider ? getCatalogProvider(opts.provider) : undefined;
    if (catalog && catalog.capabilities.reasoning < WEAK_REASONING_FLOOR) {
        return {
            engine: 'pipeline',
            reason: 'weak-reasoning-tier',
            explanation: `provider '${opts.provider}' reasoning baseline ${catalog.capabilities.reasoning} < ${WEAK_REASONING_FLOOR} — guided pipeline`,
            inputs,
        };
    }
    // 3. Strong tier / unknown → loop (the universal engine; the pipeline is
    //    the demoted path, so weakness must be proven, not assumed).
    return {
        engine: 'loop',
        reason: catalog ? 'strong-tier-default' : 'unknown-provider-default',
        explanation: catalog
            ? `provider '${opts.provider}' is strong tier — single agentic loop (v4 universal engine)`
            : `provider '${opts.provider ?? 'unrouted'}' has no catalog entry — loop (default engine)`,
        inputs,
    };
}
/**
 * Convenience predicate for callers that only need the mode (the dashboard
 * badge, the eval framework's arm selection). Same inputs, same determinism.
 */
export function engineForTask(provider, model, complexity, cm) {
    return resolveEngine({ provider, model, complexity, configManager: cm }).engine;
}
//# sourceMappingURL=engine-router.js.map