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
 * Persisted to ~/.buff/memory/reasoning-traces.json (respects BUFF_MEMORY_DIR
 * for tests). Writes are best-effort — a trace write must NEVER break an LLM
 * call or the pipeline.
 *
 * Consumers:
 *   - `buff trace list|show|replay|clear` (CLI)
 *   - Dashboard /api/traces endpoints (TracePanel)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LLMCallFn } from '../agents/agent.js';
import type { InferenceOptions } from '../config/types.js';
import { estimateTokens } from './cost-tracker.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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
  /** Where the trace came from (orchestrator pipelines today). */
  source: 'orchestrator' | 'chat';
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

interface TraceFile {
  version: number;
  traces: ReasoningTrace[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = join(homedir(), '.buff', 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent 20 traces. */
const MAX_TRACES = 20;
/** Cap steps per trace at 200 (a long pipeline still fits). */
const MAX_STEPS_PER_TRACE = 200;
/** Preview lengths (keep trace files small). */
const PROMPT_PREVIEW_CHARS = 300;
const RESPONSE_PREVIEW_CHARS = 1000;

function memoryDir(): string {
  return process.env.BUFF_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

function tracesPath(): string {
  return join(memoryDir(), 'reasoning-traces.json');
}

function ensureDir(): void {
  if (!existsSync(memoryDir())) {
    mkdirSync(memoryDir(), { recursive: true });
  }
}

function readFile(): TraceFile {
  try {
    ensureDir();
    if (!existsSync(tracesPath())) return { version: CURRENT_VERSION, traces: [] };
    const raw = readFileSync(tracesPath(), 'utf-8');
    const data = JSON.parse(raw) as TraceFile;
    if (!Array.isArray(data.traces)) return { version: CURRENT_VERSION, traces: [] };
    return data;
  } catch {
    return { version: CURRENT_VERSION, traces: [] };
  }
}

function writeFile(data: TraceFile): void {
  try {
    ensureDir();
    writeFileSync(tracesPath(), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Best-effort — a failed trace write must never break the pipeline.
  }
}

function sha256Prefix(input: string, length = 16): string {
  try {
    return createHash('sha256').update(input).digest('hex').slice(0, length);
  } catch {
    return String(input.length);
  }
}

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * Create a new trace and persist it (empty, open). Returns the trace id.
 * Callers pass the id to withTraceCapture and endTrace.
 */
export function beginTrace(
  meta: { goal: string; source?: 'orchestrator' | 'chat'; provider?: string; model?: string },
): string {
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
export function recordStep(traceId: string, step: Omit<TraceStep, 'seq' | 'timestamp'>): void {
  try {
    const data = readFile();
    const trace = data.traces.find((t) => t.id === traceId);
    if (!trace) return;
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
  } catch {
    // Best-effort.
  }
}

/**
 * Mark a trace finished (sets endedAt, durationMs, success). Idempotent: a
 * second endTrace (e.g. from a finally block after an early close) is a no-op.
 */
export function endTrace(traceId: string, success?: boolean): void {
  try {
    const data = readFile();
    const trace = data.traces.find((t) => t.id === traceId);
    if (!trace) return;
    if (trace.endedAt !== undefined) return; // already ended
    trace.endedAt = Date.now();
    trace.durationMs = trace.endedAt - trace.startedAt;
    if (success !== undefined) trace.success = success;
    writeFile(data);
  } catch {
    // Best-effort.
  }
}

/** Get one trace by id (null when missing). */
export function getTrace(id: string): ReasoningTrace | null {
  const data = readFile();
  return data.traces.find((t) => t.id === id) || null;
}

/** List traces, most recent first (optionally limited). */
export function listTraces(limit = 20): ReasoningTrace[] {
  const data = readFile();
  return [...data.traces].reverse().slice(0, limit);
}

/** Delete a single trace (used by the dashboard/CLI). */
export function deleteTrace(id: string): boolean {
  const data = readFile();
  const before = data.traces.length;
  data.traces = data.traces.filter((t) => t.id !== id);
  const deleted = data.traces.length !== before;
  if (deleted) writeFile(data);
  return deleted;
}

/** Clear ALL stored traces. */
export function clearTraces(): void {
  writeFile({ version: CURRENT_VERSION, traces: [] });
}

/** Aggregate stats over all stored traces. */
export function getTraceStats(): TraceStats {
  const data = readFile();
  const byAgentType: Record<string, number> = {};
  const byModel: Record<string, number> = {};
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
export function withTraceCapture(
  callLLM: LLMCallFn,
  ctx: TraceCaptureContext,
): LLMCallFn {
  return async (prompt: string, inferenceOptions?: InferenceOptions): Promise<string> => {
    const start = Date.now();
    let success = false;
    let errorMsg: string | undefined;
    let output = '';
    try {
      output = await callLLM(prompt, inferenceOptions);
      success = true;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
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
