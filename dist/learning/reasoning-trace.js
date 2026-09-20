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
import { createHash } from 'node:crypto';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from './cost-tracker.js';
// ─── Storage ────────────────────────────────────────────────────────────────
const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent traces (pipelines are chatty; chat turns now trace too). */
export const MAX_TRACES = 60;
/** Cap steps per trace at 200 (a long pipeline still fits). */
const MAX_STEPS_PER_TRACE = 200;
/** Preview lengths (keep trace files small). */
const PROMPT_PREVIEW_CHARS = 300;
const RESPONSE_PREVIEW_CHARS = 1000;
function memoryDir() {
    return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
}
function tracesPath() {
    return join(memoryDir(), 'reasoning-traces.json');
}
function ensureDir() {
    if (!existsSync(memoryDir())) {
        mkdirSync(memoryDir(), { recursive: true });
    }
}
function readFile() {
    try {
        ensureDir();
        if (!existsSync(tracesPath()))
            return { version: CURRENT_VERSION, traces: [] };
        const raw = readFileSync(tracesPath(), 'utf-8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data.traces))
            return { version: CURRENT_VERSION, traces: [] };
        return data;
    }
    catch {
        return { version: CURRENT_VERSION, traces: [] };
    }
}
function writeFile(data) {
    try {
        ensureDir();
        writeFileSync(tracesPath(), JSON.stringify(data, null, 2), 'utf-8');
    }
    catch {
        // Best-effort — a failed trace write must never break the pipeline.
    }
}
function sha256Prefix(input, length = 16) {
    try {
        return createHash('sha256').update(input).digest('hex').slice(0, length);
    }
    catch {
        return String(input.length);
    }
}
// ─── API ────────────────────────────────────────────────────────────────────
/**
 * Create a new trace and persist it (empty, open). Returns the trace id.
 * Callers pass the id to withTraceCapture and endTrace.
 */
export function beginTrace(meta) {
    const id = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = readFile();
    data.traces.push({
        id,
        goal: meta.goal,
        source: meta.source || 'orchestrator',
        startedAt: Date.now(),
        provider: meta.provider,
        model: meta.model,
        steps: [],
    });
    // Cap: keep the most recent MAX_TRACES.
    if (data.traces.length > MAX_TRACES) {
        data.traces = data.traces.slice(-MAX_TRACES);
    }
    writeFile(data);
    return id;
}
/**
 * Record one LLM call as a step in the trace. Best-effort: never throws.
 * seq is assigned automatically from the current step count.
 */
export function recordStep(traceId, step) {
    try {
        const data = readFile();
        const trace = data.traces.find((t) => t.id === traceId);
        if (!trace)
            return;
        trace.steps.push({
            ...step,
            seq: trace.steps.length + 1,
            timestamp: Date.now(),
        });
        if (trace.steps.length > MAX_STEPS_PER_TRACE) {
            // Drop the OLDEST steps first (keeps the tail — the most recent work).
            trace.steps = trace.steps.slice(-MAX_STEPS_PER_TRACE);
            // Re-number so seq stays 1-based contiguous.
            trace.steps.forEach((s, i) => { s.seq = i + 1; });
        }
        writeFile(data);
    }
    catch {
        // Best-effort.
    }
}
/**
 * Mark a trace finished (sets endedAt, durationMs, success). Idempotent: a
 * second endTrace (e.g. from a finally block after an early close) is a no-op.
 */
export function endTrace(traceId, success, outcome) {
    try {
        const data = readFile();
        const trace = data.traces.find((t) => t.id === traceId);
        if (!trace)
            return;
        if (trace.endedAt !== undefined)
            return; // already ended
        trace.endedAt = Date.now();
        trace.durationMs = trace.endedAt - trace.startedAt;
        if (success !== undefined)
            trace.success = success;
        if (outcome)
            trace.outcome = outcome;
        writeFile(data);
    }
    catch {
        // Best-effort.
    }
}
/**
 * Build a TraceOutcome from a turn's tool activity. Shared by every caller so
 * the semantics can never drift between the CLI, dashboard and gateway.
 */
export function buildTraceOutcome(input) {
    const tools = [...(input.tools ?? [])];
    if (input.cancelled)
        return { kind: 'cancelled', tools };
    if (input.generationFailed)
        return { kind: 'failed', tools };
    const delivered = tools.includes('gateway_send');
    return {
        kind: tools.length > 0 ? 'acted' : 'answered',
        tools,
        ...(delivered ? { delivered: true } : {}),
        ...(input.unverifiedActionClaim ? { unverifiedClaim: true } : {}),
    };
}
/** Get one trace by id (null when missing). */
export function getTrace(id) {
    const data = readFile();
    return data.traces.find((t) => t.id === id) || null;
}
/** List traces, most recent first (optionally limited). */
export function listTraces(limit = 20) {
    const data = readFile();
    return [...data.traces].reverse().slice(0, limit);
}
/** Delete a single trace (used by the dashboard/CLI). */
export function deleteTrace(id) {
    const data = readFile();
    const before = data.traces.length;
    data.traces = data.traces.filter((t) => t.id !== id);
    const deleted = data.traces.length !== before;
    if (deleted)
        writeFile(data);
    return deleted;
}
/** Clear ALL stored traces. */
export function clearTraces() {
    writeFile({ version: CURRENT_VERSION, traces: [] });
}
/** Aggregate stats over all stored traces. */
export function getTraceStats() {
    const data = readFile();
    const byAgentType = {};
    const byModel = {};
    let totalSteps = 0;
    let latencySum = 0;
    let tokenSum = 0;
    for (const trace of data.traces) {
        for (const step of trace.steps) {
            totalSteps++;
            latencySum += step.latencyMs;
            tokenSum += step.inputTokens + step.outputTokens;
            byAgentType[step.agentType] = (byAgentType[step.agentType] || 0) + 1;
            byModel[step.model] = (byModel[step.model] || 0) + 1;
        }
    }
    return {
        total: data.traces.length,
        totalSteps,
        avgLatencyMs: totalSteps > 0 ? Math.round(latencySum / totalSteps) : 0,
        totalTokens: tokenSum,
        byAgentType,
        byModel,
        updatedAt: Date.now(),
    };
}
// ─── LLM wrapper ────────────────────────────────────────────────────────────
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
export function withTraceCapture(callLLM, ctx) {
    return async (prompt, inferenceOptions) => {
        const start = Date.now();
        let success = false;
        let errorMsg;
        let output = '';
        try {
            output = await callLLM(prompt, inferenceOptions);
            success = true;
        }
        catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
            throw err;
        }
        finally {
            recordStep(ctx.traceId, {
                agentType: ctx.agentType,
                taskId: ctx.taskId,
                description: ctx.description,
                provider: ctx.routing?.provider || ctx.provider || 'unknown',
                model: inferenceOptions?.model || ctx.model || ctx.routing?.model || 'unknown',
                promptDigest: sha256Prefix(prompt),
                promptPreview: prompt.slice(0, PROMPT_PREVIEW_CHARS),
                responsePreview: output.slice(0, RESPONSE_PREVIEW_CHARS),
                responseLength: output.length,
                inputTokens: estimateTokens(prompt),
                outputTokens: estimateTokens(output),
                latencyMs: Date.now() - start,
                success,
                error: errorMsg,
                routing: ctx.routing,
                escalated: ctx.escalated,
            });
        }
        return output;
    };
}
//# sourceMappingURL=reasoning-trace.js.map