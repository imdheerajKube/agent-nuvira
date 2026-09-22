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
import { wantsAuthoredArtifact } from './deliverable-class.js';
import type { ComplexityLevel } from './hybrid-router.js';

/** The executable engines (Addendum v4 guiding decision). */
export type EngineMode = 'loop' | 'pipeline';

/** Config values for `routing.engineMode` — 'auto' is the default. */
export type EngineModeConfig = 'auto' | EngineMode;

/** Catalog reasoning baseline below which a provider is "weak tier". */
const WEAK_REASONING_FLOOR = 0.5;

/** Provider ids that are local runners (weak tier by definition). */
const LOCAL_PROVIDER_IDS = new Set([
  'local', 'ollama', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'jan', 'gpt4all',
]);

/** Why an engine was chosen (telemetry / CLI explanation / tests). */
export type EngineReason =
  | 'config-override'
  | 'local-provider'
  | 'weak-reasoning-tier'
  | 'authored-artifact'
  | 'strong-tier-default'
  | 'unknown-provider-default';

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
    /**
     * The goal this decision was made for (G13b) — echoed only when the caller
     * supplied one, so a caller that passes no goal produces the same decision
     * object as before this input existed.
     */
    goal?: string;
  };
}

/** Minimal ConfigManager shape (real instance or a test stub). */
export interface EngineRouterConfigLike {
  getAll?(): { routing?: { engineMode?: string } };
}

/** Read `routing.engineMode` from config ('auto' on absence/failure). */
export function readEngineModeConfig(cm?: EngineRouterConfigLike): EngineModeConfig {
  try {
    const mode = cm?.getAll?.()?.routing?.engineMode;
    return mode === 'loop' || mode === 'pipeline' ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Is this provider the weak/local tier? Order matters: the id check is
 * authoritative for local runners (a catalog entry may be missing entirely
 * for plugin providers), the catalog reasoning baseline covers keyed cloud
 * providers with weak models.
 */
export function isWeakTierProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  if (LOCAL_PROVIDER_IDS.has(provider.toLowerCase())) return true;
  const catalog = getCatalogProvider(provider);
  if (!catalog) return false; // unknown → not provably weak (default strong)
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
export function resolveEngine(opts: {
  provider?: string;
  model?: string;
  complexity?: ComplexityLevel;
  configManager?: EngineRouterConfigLike;
  /**
   * The user's goal (G13b). Optional and purely ADDITIVE: omitted, every rule
   * below behaves exactly as it did before this input existed.
   */
  goal?: string;
}): EngineDecision {
  const inputs = {
    provider: opts.provider,
    model: opts.model,
    complexity: opts.complexity,
    configMode: readEngineModeConfig(opts.configManager),
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
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

  // 2.5 G13b — an AUTHORED ARTIFACT the user asked to be produced goes to the
  //     pipeline, whatever the provider tier.
  //
  //     Why tier is the wrong input for this class of ask: the loop engine is
  //     optimised for a turn that ACTS with tools, and for "write a 12 page
  //     story at /path/Mahagatha.md" it produced a complete, genuinely good
  //     story in chat and wrote NOTHING to disk. The turn was reported as a
  //     success, the ledger never saw a deliverable to continue or assemble,
  //     and the same ask over the pipeline engine — which plans units, keeps
  //     continuity across batches, and ASSEMBLES the document — finished
  //     unattended with the chapters and the book on disk.
  //
  //     The predicate is deliberately narrow (`wantsAuthoredArtifact`): authored
  //     work AND evidence the user asked for it to be produced. "Tell me a
  //     story" and "explain how to write a story to a file" are unaffected, so a
  //     chat answer stays a chat answer. `config-override` above still wins — an
  //     explicit `routing.engineMode='loop'` is obeyed, which is why the loop
  //     engine ALSO carries a deliverable gate of its own.
  if (opts.goal && wantsAuthoredArtifact(opts.goal)) {
    return {
      engine: 'pipeline',
      reason: 'authored-artifact',
      explanation:
        'the request asks for an authored deliverable to be produced — pipeline (plans units, keeps continuity, assembles the document)',
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
export function engineForTask(
  provider: string | undefined,
  model: string | undefined,
  complexity: ComplexityLevel | undefined,
  cm?: EngineRouterConfigLike,
): EngineMode {
  return resolveEngine({ provider, model, complexity, configManager: cm }).engine;
}
