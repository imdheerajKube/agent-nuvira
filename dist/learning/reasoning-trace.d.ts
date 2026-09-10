/**
 * Reasoning Trace — step-by-step capture of every LLM call in a multi-agent
 * pipeline (assessment P0).
 *
 * Each trace = one orchestration run (goal → plan → tasks → result). Each step
 * = one LLM call, recording:
 *   - agentType (writer, tester, planner, …)
 *   - provider × model actually used
 *   - prompt digest (sha256 prefix) + preview (never the full payload)
 *   - response preview + full length
 *   - input/output token estimates + latency
 *   - the Auto-router routing snapshot at decision time (when auto-routed)
 *
 * Persisted to ~/.nuvira/memory/reasoning-traces.json (respects NUVIRA_MEMORY_DIR
 * for tests). Writes are best-effort — a trace write must NEVER break an LLM
 * call or the pipeline.
 *
 * Consumers:
 *   - `nuvira trace list|show|replay|clear` (CLI)
 *   - Dashboard /api/traces endpoints (TracePanel)
 */
import type { LLMCallFn } from '../agents/agent.js';
/** A compact routing snapshot captured at decision time (from AutoRouteResult). */
export interface TraceRoutingSnapshot {
    provider: string;
    model: string;
    score: number;
    complexity: string;
    explanation: string;
}
/** One LLM call within a trace. */
export interface TraceStep {
    /** 1-based position within the trace. */
    seq: number;
    /** Epoch ms when the call started. */
    timestamp: number;
    /** Agent that made the call (planner, writer, tester, memory, …). */
    agentType: string;
    /** Task step id when the call belongs to a task (undefined for planner/memory). */
    taskId?: string;
    /** Human-readable task/goal description. */
    description?: string;
    /** Provider the call was routed to. */
    provider: string;
    /** Model used for the call. */
    model: string;
    /** sha256 hex prefix of the prompt (never the full prompt). */
    promptDigest: string;
    /** First ~300 chars of the prompt (for replay readability). */
    promptPreview: string;
    /** First ~1000 chars of the response (for replay readability). */
    responsePreview: string;
    /** Full response length in chars (accurate even when preview is truncated). */
    responseLength: number;
    /** Estimated input tokens. */
    inputTokens: number;
    /** Estimated output tokens. */
    outputTokens: number;
    /** Call duration in ms. */
    latencyMs: number;
    /** True when the call returned normally (errors are still recorded). */
    success: boolean;
    /** Error message when the call threw. */
    error?: string;
    /** Auto-router decision snapshot when the call was auto-routed. */
    routing?: TraceRoutingSnapshot;
    /** True when this step is a REPAIR re-prompt escalated to a stronger model
     *  (v1.60.4 per-task/planner escalation — the routing snapshot then carries
     *  the escalated decision at the next complexity level). */
    escalated?: boolean;
}
/** A full reasoning trace — one pipeline execution. */
export interface ReasoningTrace {
    id: string;
    /** The original user goal. */
    goal: string;
    /** Where the trace came from (orchestrator pipelines / chat turns / a gateway channel). */
    source: 'orchestrator' | 'chat' | string;
    /** Epoch ms when the trace began. */
    startedAt: number;
    /** Epoch ms when the trace ended (undefined = still running). */
    endedAt?: number;
    /** Total duration in ms (set by endTrace). */
    durationMs?: number;
    /** Pipeline-level provider override when known. */
    provider?: string;
    /** Pipeline-level model override when known. */
    model?: string;
    /** Final outcome (set by endTrace). */
    success?: boolean;
    /** LLM calls in execution order. */
    steps: TraceStep[];
}
/** Aggregated stats over all stored traces. */
export interface TraceStats {
    total: number;
    totalSteps: number;
    /** Average per-step latency (ms) across all steps. */
    avgLatencyMs: number;
    /** Total estimated tokens across all steps. */
    totalTokens: number;
    /** Steps by agentType. */
    byAgentType: Record<string, number>;
    /** Steps by model. */
    byModel: Record<string, number>;
    updatedAt: number;
}
/** Context for withTraceCapture — everything a step needs except the call result. */
export interface TraceCaptureContext {
    traceId: string;
    agentType: string;
    taskId?: string;
    description?: string;
    /** Provider override when the router snapshot doesn't carry one. */
    provider?: string;
    /** Model override (used when inferenceOptions don't specify one). */
    model?: string;
    /** Auto-router decision snapshot (captured at decision time). */
    routing?: TraceRoutingSnapshot;
    /** True for escalated repair re-prompts (v1.60.4 model escalation). */
    escalated?: boolean;
}
/** Keep the most recent traces (pipelines are chatty; chat turns now trace too). */
export declare const MAX_TRACES = 60;
/**
 * Create a new trace and persist it (empty, open). Returns the trace id.
 * Callers pass the id to withTraceCapture and endTrace.
 */
export declare function beginTrace(meta: {
    goal: string;
    source?: 'orchestrator' | 'chat' | string;
    provider?: string;
    model?: string;
}): string;
/**
 * Record one LLM call as a step in the trace. Best-effort: never throws.
 * seq is assigned automatically from the current step count.
 */
export declare function recordStep(traceId: string, step: Omit<TraceStep, 'seq' | 'timestamp'>): void;
/**
 * Mark a trace finished (sets endedAt, durationMs, success). Idempotent: a
 * second endTrace (e.g. from a finally block after an early close) is a no-op.
 */
export declare function endTrace(traceId: string, success?: boolean): void;
/** Get one trace by id (null when missing). */
export declare function getTrace(id: string): ReasoningTrace | null;
/** List traces, most recent first (optionally limited). */
export declare function listTraces(limit?: number): ReasoningTrace[];
/** Delete a single trace (used by the dashboard/CLI). */
export declare function deleteTrace(id: string): boolean;
/** Clear ALL stored traces. */
export declare function clearTraces(): void;
/** Aggregate stats over all stored traces. */
export declare function getTraceStats(): TraceStats;
/**
 * Wrap an LLMCallFn so every call is recorded as a trace step.
 *
 * The wrapper times the call, digests the prompt, truncates the response, and
 * records the step (success or error) through the best-effort store. The
 * original function's behavior is unchanged — including re-throwing errors so
 * callers' failure handling (fallback, repair, routing telemetry) still works.
 *
 * NOTE: apply EXACTLY ONCE per call chain. Wrapping an already-wrapped
 * function would double-record every call. The orchestrator wraps each LLM at
 * its creation site (planner/memory default + per-task LLM) and never re-wraps.
 */
export declare function withTraceCapture(callLLM: LLMCallFn, ctx: TraceCaptureContext): LLMCallFn;
//# sourceMappingURL=reasoning-trace.d.ts.map