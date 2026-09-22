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
import {envBuff, resolveNuviraHome} from '../config/paths';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LLMCallFn } from '../agents/agent.js';
import type { InferenceOptions } from '../config/types.js';
import { estimateTokens } from './cost-tracker.js';
import { splitPromptLayers, digestPromptLayers, type PromptLayerDigests } from './prompt-layers.js';

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
  /**
   * PER-LAYER prompt digests (stable / context / volatile) + their sizes.
   * The flat `promptDigest` hashes the whole thread, which grows every step —
   * so it can never show whether the STABLE layer (system prompt) was
   * byte-stable across steps. These three digests answer that, which is what
   * makes prompt-caching regressions reviewable at all.
   */
  layers?: PromptLayerDigests;
  /** True when this step is a REPAIR re-prompt escalated to a stronger model
   *  (v1.60.4 per-task/planner escalation — the routing snapshot then carries
   *  the escalated decision at the next complexity level). */
  escalated?: boolean;
}

/**
 * WHAT ACTUALLY HAPPENED — deliberately separate from `success`, which only
 * means "the model produced a reply". Without this, a hallucinated
 * "I have sent the poem…" is indistinguishable from a real delivery in the
 * Trace tab. Populated by the caller that knows the turn's tool activity.
 */
export interface TraceOutcome {
  /**
   * `answered`  — a text reply only (no tool ran);
   * `acted`     — at least one tool executed successfully;
   * `failed`    — generation failed (no usable answer);
   * `cancelled` — the turn was cancelled by the user.
   */
  kind: 'answered' | 'acted' | 'failed' | 'cancelled';
  /** Names of the tools that actually executed this turn (in order). */
  tools?: string[];
  /** True when a delivery tool (`gateway_send`) ran and reported success. */
  delivered?: boolean;
  /**
   * True when the answer CLAIMED a delivery/action that no tool performed
   * (see `detectUnverifiedDeliveryClaim`). This is the honesty flag the Trace
   * tab surfaces as a warning — the reply is unreliable about the action.
   */
  unverifiedClaim?: boolean;
  /**
   * True when the reply CLOSED on a promise to act ("I will begin by…") that
   * the turn never carried out (see `detectUnfulfilledIntentPromise`). The
   * action is not pending — it never started — so the Trace tab flags it
   * instead of letting it read as work in progress.
   */
  unfulfilledPromise?: boolean;
  /**
   * True when this turn MUTATED the workspace (`edit_file`/`write_file`) and
   * ran nothing that could observe the result (`run_terminal`/`test`/`browser`
   * /`run_cli`). The edit is real but "it works" is unproven — the Trace tab
   * surfaces this so an unverified change never reads as a verified one.
   */
  unverifiedEdit?: boolean;
  /**
   * True when the answer ASSERTED a completed code change while the turn was
   * unverified (see `detectUnverifiedEditClaim`). This is the edit analogue of
   * `unverifiedClaim` — the honesty flag for a false "I have fixed it".
   */
  unverifiedEditClaim?: boolean;
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
  /** Final outcome (set by endTrace). NOTE: `success` = "a reply was
   *  generated"; it does NOT mean an action was performed. Use `outcome`.
   *  for that. */
  success?: boolean;
  /** What actually happened (answered vs acted vs failed) — see TraceOutcome. */
  outcome?: TraceOutcome;
  /** LLM calls in execution order. */
  steps: TraceStep[];
  /**
   * The FULL stable layer (system prompt), captured ONCE per trace.
   * Previously every trace exposed only the first 80 characters of it, so the
   * persona / tool contract / response rules were unreviewable. Capped to keep
   * the trace file bounded; `systemPromptChars` records the true size.
   */
  systemPrompt?: string;
  /** True length of the stable layer (before the storage cap). */
  systemPromptChars?: number;
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

const DEFAULT_MEMORY_DIR = join(resolveNuviraHome(), 'memory');
const CURRENT_VERSION = 1;
/** Keep the most recent traces (pipelines are chatty; chat turns now trace too). */
export const MAX_TRACES = 60;
/** Cap steps per trace at 200 (a long pipeline still fits). */
const MAX_STEPS_PER_TRACE = 200;
/** Cap the stored stable layer so 60 traces stay bounded (true size is kept). */
const MAX_SYSTEM_PROMPT_CHARS = 16_000;
/** Preview lengths (keep trace files small). */
const PROMPT_PREVIEW_CHARS = 300;
const RESPONSE_PREVIEW_CHARS = 1000;

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || DEFAULT_MEMORY_DIR;
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
  meta: { goal: string; source?: 'orchestrator' | 'chat' | string; provider?: string; model?: string },
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
export function recordStep(
  traceId: string,
  step: Omit<TraceStep, 'seq' | 'timestamp'> & { promptFull?: string },
): void {
  try {
    const data = readFile();
    const trace = data.traces.find((t) => t.id === traceId);
    if (!trace) return;
    // Layered review (session 3): when the caller passes the FULL prompt we
    // derive per-layer digests and capture the stable layer ONCE per trace.
    // `promptFull` itself is never stored — only the digests + the system layer.
    const { promptFull, ...rest } = step;
    let layers: PromptLayerDigests | undefined;
    if (promptFull) {
      const split = splitPromptLayers(promptFull);
      layers = digestPromptLayers(split);
      if (split.system && trace.systemPrompt === undefined) {
        trace.systemPrompt = split.system.slice(0, MAX_SYSTEM_PROMPT_CHARS);
        trace.systemPromptChars = split.system.length;
      }
    }
    trace.steps.push({
      ...rest,
      ...(layers ? { layers } : {}),
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
export function endTrace(traceId: string, success?: boolean, outcome?: TraceOutcome): void {
  try {
    const data = readFile();
    const trace = data.traces.find((t) => t.id === traceId);
    if (!trace) return;
    if (trace.endedAt !== undefined) return; // already ended
    trace.endedAt = Date.now();
    trace.durationMs = trace.endedAt - trace.startedAt;
    if (success !== undefined) trace.success = success;
    if (outcome) trace.outcome = outcome;
    writeFile(data);
  } catch {
    // Best-effort.
  }
}

/**
 * Build a TraceOutcome from a turn's tool activity. Shared by every caller so
 * the semantics can never drift between the CLI, dashboard and gateway.
 */
export function buildTraceOutcome(input: {
  generationFailed?: boolean;
  cancelled?: boolean;
  tools?: readonly string[];
  unverifiedActionClaim?: boolean;
  unfulfilledPromise?: boolean;
  unverifiedEdit?: boolean;
  unverifiedEditClaim?: boolean;
}): TraceOutcome {
  const tools = [...(input.tools ?? [])];
  if (input.cancelled) return { kind: 'cancelled', tools };
  if (input.generationFailed) return { kind: 'failed', tools };
  const delivered = tools.includes('gateway_send');
  return {
    kind: tools.length > 0 ? 'acted' : 'answered',
    tools,
    ...(delivered ? { delivered: true } : {}),
    ...(input.unverifiedActionClaim ? { unverifiedClaim: true } : {}),
    ...(input.unfulfilledPromise ? { unfulfilledPromise: true } : {}),
    ...(input.unverifiedEdit ? { unverifiedEdit: true } : {}),
    ...(input.unverifiedEditClaim ? { unverifiedEditClaim: true } : {}),
  };
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
      // G10 — an EMPTY response is not a success. Live evidence: the story
      // session's writer step was recorded as `success: true` with
      // `responseLength: 0` / `outputTokens: 0` from `local/gpt-oss:120b-cloud`.
      // A green step for a call that returned nothing made the trace actively
      // misleading — it hid the failure behind a passing checkmark, which is
      // the same "ran ≠ worked" conflation the edit-verification gate exists
      // to kill. Every call site wrapped here is a plain text generation (the
      // orchestrator's planner/reasoner/per-task LLMs), so an empty string can
      // only mean the provider returned no content.
      const empty = output.trim().length === 0;
      success = !empty;
      if (empty) errorMsg = 'empty response — the provider returned no content (0 chars)';
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      recordStep(ctx.traceId, {
        agentType: ctx.agentType,
        taskId: ctx.taskId,
        description: ctx.description,
        // Session 3 — the FULL prompt feeds the layered digests + the one-time
        // stable-layer capture (never stored raw).
        promptFull: prompt,
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
