/**
 * Loop executor (`src/cli/loop-executor.ts`) — AGENTIC_CAPABILITY_ASSESSMENT
 * Addendum v4 Phase 1.1: "Make `runToolLoop` the executor behind coding-intent
 * dispatch (…extend to `nuvira execute` default path behind
 * `--engine loop|pipeline`, default `pipeline` until Phase 0 numbers land)."
 *
 * `nuvira execute` currently goes straight to the Orchestrator. This module
 * is the LOOP arm: one agentic turn over the same `runToolLoop` the chat
 * engine uses, with the ambient project-context injection + tiered tool
 * exposure the chat path already has. The orchestrator stays the DEFAULT
 * until the Phase 0 eval numbers land; this arm ships complete so
 * `--engine loop` is a real path, not a stub.
 *
 * Engine selection (Phase 2) happens in the CALLER (`execute` dispatch):
 * `resolveEngine()` decides loop vs pipeline from the routed provider tier;
 * this module is deliberately single-responsibility (it IS the loop arm).
 *
 * Telemetry parity with the eval framework: the executor returns wall-clock
 * time, per-tool call counts, errored-tool names (captured from the
 * `tool:called` events, not guessed from content), the bounded flag, and the
 * generation-failed flag so Phase 0 can compare arms on identical metrics.
 *
 * Phase 1.3 guardrail note (v4 risk table): file ops stay deny-first /
 * confirm-gated (registry tools keep their own gates) and the orchestrator
 * remains available for CI/publish — enterprise semantics are not weakened.
 */
import { ConfigManager } from '../config/manager.js';
/** The loop executor's result — every metric the Phase 0 eval needs. */
export interface LoopExecutorResult {
    /** Final assistant content (the loop's end-turn answer). */
    content: string;
    /** True when generation failed entirely (no content, no tools ran). */
    generationFailed: boolean;
    /** True when the loop hit its step bound before an end turn. */
    bounded: boolean;
    /** Tool names executed, in order (repair-count proxy). */
    toolCalls: string[];
    /** Tool names that returned an error result (captured from tool:called). */
    erroredTools: string[];
    /** Wall-clock duration (ms). */
    durationMs: number;
    /** The provider id used (telemetry echo). */
    provider: string;
    /** The model id used (telemetry echo). */
    model: string;
    /** The engine decision explanation (Phase 2 audit trail). */
    engineExplanation: string;
}
/** Options for runLoopExecutor — mirrors the pipeline arm's surface. */
export interface LoopExecutorOptions {
    /** Explicit provider id (auto-routed when omitted or 'auto'). */
    provider?: string;
    /** Explicit model (router-resolved when omitted or 'auto'). */
    model?: string;
    /** Stream content tokens live (CLI prints; eval ignores). */
    onToken?: (token: string) => void;
    /** External cancellation (execute's Ctrl+C). */
    signal?: AbortSignal;
    /** Skip the ambient [Project context] injection (tests). */
    skipProjectContext?: boolean;
    /**
     * Phase 3.2 — skip the loop-side skill match hint (tests / hint-free
     * comparisons). Default false: the hint is part of the loop arm's standard
     * context, mirroring the pipeline arm's skillGuidance injection.
     */
    skipSkillHint?: boolean;
    /** Override the step bound (default 16 — the loop's own default). */
    maxSteps?: number;
    /** Quiet mode: no progress logging (eval arms). */
    quiet?: boolean;
}
/**
 * Run one coding goal through the single agentic loop (the v4 universal
 * engine). Resolves the route the same way chat does (explicit override or
 * AutoModelRouter candidate walk), injects the ambient project context, and
 * runs `runToolLoop` with tiered exposure per config. Never throws — a
 * failure returns a result with generationFailed=true (eval arms count it as
 * a loss; the CLI prints the message).
 */
export declare function runLoopExecutor(goal: string, configManager: ConfigManager, opts?: LoopExecutorOptions): Promise<LoopExecutorResult>;
//# sourceMappingURL=loop-executor.d.ts.map