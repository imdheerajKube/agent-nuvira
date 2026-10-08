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
import { describeFinding, toWire, type WireFinding, type Finding } from '../findings/verdicts.js';
import type { TurnReport } from './turn-report.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A compact routing snapshot captured at decision time (from AutoRouteResult). */
export interface TraceRoutingSnapshot {
  provider: string;
  model: string;
  score: number;
  complexity: string;
  explanation: string;
  /**
   * A1/A2 — may the FINAL routed model hold an agentic software task? Recorded
   * with the same shared predicate the router used, so the Trace tab can show
   * the capability verdict instead of only the pair. Optional: entries written
   * before this field parse unchanged.
   */
  agenticCapable?: boolean;
  /** A1 — how the model-first override affected the final pick, if known. */
  overrideReason?: 'none' | 'model-first' | 'model-first-blocked' | string;
  /** B — what the consent gate decided for this route (`proceed` | `ask` | …). */
  gateAction?: string;
  /** C3 — the pair this route failed over FROM (the failover chain's head). */
  fallbackFrom?: string;
  /**
   * Bundle 36 — the task INTENT the router bucketed this decision under
   * (`coding` / `creative` / …), recorded so a LATER explicit verdict
   * (`nuvira rate bad`) can correct the exact bandit arm the turn was learned
   * under. The bandit's buckets are `intent:complexity`; without this the
   * correction only has the complexity and has to fall back to every intent
   * bucket at that complexity. Optional: entries written before this field parse
   * unchanged, and `verdict-routing.ts` degrades honestly when it is absent.
   */
  taskIntent?: string;
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
   * `answered`   — a text reply only (no tool ran);
   * `acted`      — at least one tool executed successfully;
   * `failed`     — generation failed (no usable answer);
   * `cancelled`  — the turn was cancelled by the user;
   * `incomplete` — the turn ended WITHOUT concluding the work it claimed: a
   *                 promised/unverified action that no tool performed, a build
   *                 the run observed FAIL (see `unverifiedBuildClaim`), or a
   *                 requested deliverable that was never written. It is not a
   *                 success, and unlike `failed` there IS work to continue from.
   */
  kind: 'answered' | 'acted' | 'failed' | 'cancelled' | 'incomplete';
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
  /**
   * A3 Part 2 — True when a BUILD command the run executed FAILED, no later
   * build succeeded, and the answer nonetheless asserted the artifact came out
   * good (see `detectFailedBuildSuccessClaim`). This is the strongest form of
   * the false-success defect: the run holds its own counter-evidence, so the
   * trace marks the turn `incomplete` rather than `acted`.
   */
  unverifiedBuildClaim?: boolean;
  /**
   * G13b — True when the request asked for an AUTHORED deliverable to be
   * PRODUCED and the turn wrote NOTHING to disk (see
   * `ToolLoopResult.undeliveredArtifact`). The reply may be excellent prose —
   * the 12-page story that was composed into a chat window instead of a file —
   * but the deliverable does not exist, so the Trace tab must not read it as
   * finished work.
   */
  undeliveredArtifact?: boolean;
  /**
   * Bundle 19 — the turn's own file declares its content was omitted, so the
   * artifact is incomplete however complete the prose reads.
   */
  incompleteArtifactClaim?: boolean;
  /**
   * Bundle 20 — the answer ASSERTED a file was written and the turn wrote none.
   * Distinct from `undeliveredArtifact` (a function of the ASK): this is a
   * function of the turn's own CLAIM, so a fabricated "I saved it" is marked
   * `incomplete` even when the ask was never recognised as a deliverable.
   */  unverifiedFileClaim?: boolean;
  /**
   * Bundle 23 (item 13) — the ask named a magnitude and the written artifact is
   * far short of it. The delivered file is not what was asked for, so the turn did
   * not conclude.
   */
  artifactShortfall?: boolean;
}

/**


 * Which gate made a decision, or refused one.
 *
 * `confirmation` is the family the G18 audit could not see at all: a tool that
 * declined to act until a human approved. `permission`/`verification`/
 * `deliverable`/`promise` are the loop's own bounded nudges; `autonomy` is a
 * gate that DECIDED to proceed on the request's own authorization; `budget` is
 * a bound (step/continuation) being reached.
 */
export type TraceGateName =
  | 'permission'
  | 'verification'
  | 'deliverable'
  | 'promise'
  | 'confirmation'
  | 'workspace'
  | 'autonomy'
  | 'repeat'
  | 'budget'
  // The loop's SELF-DIAGNOSIS nudge: the same action failed more than once and
  // the model was told to diagnose the cause instead of retrying it (see
  // RunTrace.repeatedFailure). A gate name rather than a new kind — it IS a
  // bounded decision the loop made about the run's own behaviour.
  | 'diagnosis'
  // The loop's SELF-REVIEW nudge: a substantial, already-verified turn is ending
  // and the model was asked to check the result against the ORIGINAL ask before
  // it can finish. The verification gate owns "did you check"; this owns "did you
  // answer the whole question" — a distinct, bounded decision about the run.
  | 'self-review'
  // The loop's ZERO-ACTION nudge: the request directed work on the workspace and
  // the turn was ending having run no tool at all, so it was told to do the work
  // (see `requireAction` in tool-loop.ts). A bounded decision about the run's own
  // behaviour, distinct from 'deliverable' (an authored file) and 'promise' (an
  // announced action the answer dropped).
  | 'action'
  // WS4 (#26) — an operator's tool hook decided (or failed to decide) about a
  // call. A gate name rather than a new event kind: a hook veto IS a decision
  // about a call, which is what this vocabulary is for.
  | 'tool-hook'
  // Missing-prerequisite TAKEOVER: a `run_terminal` failed because a KNOWN,
  // installable system tool was missing (command not found / exit 127), and the
  // model was told, deterministically, to install it itself rather than declare
  // itself unable and hand the user a manual step.
  | 'tool-takeover'
  // ROUTING self-instrumentation (A2): the router chose a provider×model for a
  // turn and the harness recorded the CONTEXT of that choice — the pair, its
  // complexity/score, whether the model is agentic-capable, and (for a weak
  // agentic route) the consent-gate outcome. This is the record whose absence
  // let the failed Tauri turn route to `local/gemma4:e4b` invisibly.
  | 'routing'
  // PROMPT/CONTEXT BUDGET (D1): the assembled outbound context crossed a budget
  // threshold and the harness recorded which contributor is responsible. A gate
  // name because it IS a decision the harness made about its own context.
  | 'context-budget'
  // PREREQUISITE verification (D2): a build/run was about to fail (or already
  // did) on a MISSING PROJECT PREREQUISITE (a required file/feature that is not
  // a missing binary) and the harness took over with the exact fix.
  | 'prerequisite'
  // PLAN gate (E2): a workspace-directing turn was about to MUTATE without
  // having declared a plan, so the loop spent one bounded nudge to plan first —
  // the "plan → track → verify" contract made structural instead of optional.
  | 'plan'
  // MID-TURN MODEL HANDOFF (fix_model_routing P2): the model serving the turn
  // resolved with NOTHING usable (no answer text, no tool call) twice in a row,
  // so the loop handed the work to a DIFFERENT model instead of re-asking the
  // same one. A gate name because it is a bounded decision the loop made about
  // its own run — and the record that makes "why did this turn move models?"
  // answerable from the trace instead of inferred from a missing line.
  | 'handoff'
  // MALFORMED TOOL CALL (2026-10-07): a tool call arrived with NO usable
  // arguments — the payload did not fit in one model output and was cut off — so
  // the call was REFUSED rather than executed as `{}`, and after the third one
  // the loop spent a bounded nudge telling the model to deliver in sections. A
  // gate name because it is a bounded decision about the run's own behaviour; the
  // measured reason it exists is a turn that burned 81 steps and 59 identical
  // retries without ever naming the real cause.
  | 'malformed-call';

/**
 * A NON-LLM fact about a turn: a tool call, a gate decision, or a refusal.
 *
 * WHY THIS IS NOT A `TraceStep`. `steps` are LLM calls — they carry a prompt
 * digest, a model, tokens, and they feed `getTraceStats`. A tool call has none
 * of those, and folding it in would corrupt every aggregate the Trace tab and
 * the stats command already report. This is the separate, equally honest
 * record: WHAT THE TURN DID, alongside what the model was asked.
 *
 * The gap it closes was recorded as G18: the loop engine wrote no trace at all,
 * and the audit of the confirmation gates had to be done by reading code and
 * driving the real tools, because "the trace store showed 0 refusals" meant
 * "it cannot see refusals" — not "there were none".
 */
export interface TraceEvent {
  /** 1-based position within the trace's event list. */
  seq: number;
  /** Epoch ms when the event was recorded. */
  timestamp: number;
  /**
   * `tool`     — a tool call that actually ran (ok/error, duration, args);
   * `gate`     — a gate made a DECISION (nudge spent, or autonomy proceeded);
   * `refusal`  — a call was DECLINED (`Error:` result, confirmation gate,
   *              unknown/disabled tool, repeat dispatch);
   * `decision` — a non-tool decision worth auditing (e.g. the provider walk
   *              abandoning a candidate, a loop bound being reached).
   */
  kind: 'tool' | 'gate' | 'refusal' | 'decision' | 'failover';
  /** Tool name for `tool`/`refusal` events. */
  tool?: string;
  /** Which gate/nudge/bound this is about (see {@link TraceGateName}). */
  gate?: TraceGateName;
  /** One line, human-readable — the same wording the console prints. */
  summary: string;
  /** Bounded args preview for a tool call (what the gate actually saw). */
  args?: string;
  /** Bounded result/error preview (the evidence the verdict was read from). */
  result?: string;
  /** True when the call succeeded; false for an error or a refusal. */
  ok?: boolean;
  durationMs?: number;
  /**
   * A2 — the routing snapshot for a `'routing'` gate event (provider, model,
   * complexity, score, agenticCapable, override reason, consent-gate action).
   * Present only on routing decision events, so a turn can be audited for the
   * pair it chose and whether that pair could hold the task.
   */
  routing?: TraceRoutingSnapshot;
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
   * Non-LLM facts about the run, in order: tool calls, gate decisions, and
   * refusals (G18). Absent on traces written before this existed — readers must
   * treat `undefined` as "no events were recorded", never as "none happened".
   */
  events?: TraceEvent[];
  /**
   * WS1 (#23) — the findings the run recorded, in call order, in the shared wire
   * form (`findings/verdicts.ts`): the claim, the outcome, the evidence and the
   * verdict the GATE computed.
   *
   * Persisted on the trace for the same reason the outcome flags are: a verdict
   * that only ever existed in the turn's return value cannot be audited after the
   * turn — a reader opening the Trace tab would see the tool calls and the
   * hallucinations flags but not that the run ASSERTED something and whether
   * anything backed it. Absent on traces written before this existed; readers
   * must treat `undefined` as "this trace predates findings", never as "none".
   */
  findings?: WireFinding[];
  /**
   * E-trace — the derived plan → track → verify → report artifact for the run
   * (see `learning/turn-report.ts`).
   *
   * Persisted for the same reason `findings` is: the report is the turn's TRUST
   * VERDICT (how many plan steps closed, what changed, whether anything verified
   * it, and which honesty flag fired). A verdict that only ever lived in the
   * turn's return value cannot be reviewed after the fact — a reader opening the
   * Trace tab would see the tool calls and the events but not the assembled
   * report they sum to. It is DERIVED from recorded evidence, never narrated, so
   * storing it cannot add a claim the run did not back.
   */
  turnReport?: TurnReport;
  /**
   * The USER's verdict on this turn — the ONE label the harness cannot derive.
   *
   * Every other signal on this record is derived from evidence the run produced
   * (a tool ran, a plan step closed, a flag fired). Acceptance is not: only the
   * user knows whether the work was what they wanted. So it is recorded
   * EXPLICITLY, never inferred from silence (silence is not consent — the same
   * rule the bandit follows), and it carries its SOURCE so a fitted quality
   * signal can tell a human judgement from a derived one. Written by
   * `recordTraceVerdict` (CLI `nuvira rate` and the dashboard Trace tab).
   */
  userVerdict?: {
    verdict: 'accepted' | 'rejected';
    at: number;
    /** `cli`/`dashboard` = the user said so; `derived` = the harness inferred it. */
    source: 'cli' | 'dashboard' | 'derived';
  };
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
  /**
   * G18 — non-LLM facts recorded across all traces (tool calls, gate decisions,
   * refusals). Counted separately from `totalSteps` on purpose: an event is not
   * an LLM call, and adding it to the token/latency averages would make both
   * wrong. `refusals` is the number the confirmation-gate audit could not obtain
   * before this existed.
   */
  totalEvents: number;
  /** How many of those events are refusals (declined calls). */
  refusals: number;
  /** How many are gate DECISIONS (a nudge spent, or autonomy proceeding). */
  gateDecisions: number;
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

/**
 * The run currently being traced in THIS process, so `recordTraceEvent` can be
 * called without an id (see its docstring). Set by {@link beginTrace}, cleared
 * by {@link endTrace}. One run per process is the actual invariant everywhere a
 * trace is opened (a pipeline, a chat turn, a dashboard session), so a single
 * slot is honest rather than a shortcut.
 */
let currentTraceId: string | null = null;
/** Cap steps per trace at 200 (a long pipeline still fits). */
const MAX_STEPS_PER_TRACE = 200;
/**
 * Cap NON-LLM events per trace at 400 — deliberately higher than the step cap:
 * a busy agentic turn runs many tools per step, and the tail (the last actions
 * before the turn ended) is what an audit reads. Like the step cap, this keeps
 * 60 traces bounded instead of letting one long run dominate the file.
 */
const MAX_EVENTS_PER_TRACE = 400;
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
  // The run in progress, for recorders that hold no id (see recordTraceEvent).
  currentTraceId = id;
  const data = readFile();
  data.traces.push({
    id,
    goal: meta.goal,
    source: meta.source || 'orchestrator',
    startedAt: Date.now(),
    provider: meta.provider,
    model: meta.model,
    steps: [],
    events: [],
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
 * Record one NON-LLM event (a tool call, a gate decision, a refusal) — G18.
 *
 * Same contract as {@link recordStep}: best-effort, never throws, and the tail
 * is kept when the cap is hit (the most recent actions are the ones an audit
 * reads). The caller passes WHAT HAPPENED; `seq`/`timestamp` are assigned here
 * so two recorders can never disagree about ordering.
 */
export function recordTraceEvent(
  traceId: string | undefined,
  event: Omit<TraceEvent, 'seq' | 'timestamp'>,
): void {
  try {
    // No id → the run IN PROGRESS. A recorder deep in the stack (a routing
    // substitution inside a provider call) has nothing to pass and the call it
    // is reporting on belongs to the trace that is open right now, so the event
    // attaches there instead of being dropped. Without this, "record it in the
    // trace" was only possible at the few call sites that happened to hold an
    // id, which is the same call-site-locality that let the provider×model pair
    // bug survive two earlier fixes.
    const id = traceId || currentTraceId;
    if (!id) return;
    const data = readFile();
    const trace = data.traces.find((t) => t.id === id);
    if (!trace) return;
    const events = trace.events ?? (trace.events = []);
    events.push({ ...event, seq: events.length + 1, timestamp: Date.now() });
    if (events.length > MAX_EVENTS_PER_TRACE) {
      trace.events = events.slice(-MAX_EVENTS_PER_TRACE);
      // Re-number so seq stays 1-based contiguous, exactly like the step cap.
      trace.events.forEach((e, i) => { e.seq = i + 1; });
    }
    writeFile(data);
  } catch {
    // Best-effort — an instrument must never break the run it observes.
  }
}

/**
 * Attach the findings a run recorded to its trace — WS1 (#23).
 *
 * The findings are already GATED when they arrive (`confirmFinding` refused any
 * promotion without usable evidence), so this stores them verbatim rather than
 * re-deciding: the trace must show what the run actually reported, and a reader
 * comparing the Trace tab against the turn's own output must not find two
 * different verdicts. `toWire` is applied anyway, so a `Finding` passed by
 * mistake is normalised into the comparable form instead of leaking `at` (which
 * would differ on every run).
 *
 * Best-effort on purpose: the trace store is an instrument, and an instrument
 * must never break the run it observes — `recordStep` and `recordTraceEvent`
 * follow the same rule. An id-less call attaches to the run in progress, exactly
 * like `recordTraceEvent`, so a recorder that never held the id still lands on
 * the right trace.
 *
 * Each finding ALSO lands as a `decision` event, so the run's timeline reads in
 * order (the tool call that checked something, then the verdict it earned)
 * instead of the verdicts appearing only in a section of their own.
 */
export function recordTraceFindings(
  traceId: string | undefined,
  findings: readonly (WireFinding | Finding)[],
): void {
  if (findings.length === 0) return;
  try {
    const id = traceId || currentTraceId;
    if (!id) return;
    const data = readFile();
    const trace = data.traces.find((t) => t.id === id);
    if (!trace) return;
    const wire = findings.map((finding) => (isWireFinding(finding) ? finding : toWire(finding)));
    const stored = trace.findings ?? (trace.findings = []);
    for (const finding of wire) stored.push(finding);
    const events = trace.events ?? (trace.events = []);
    for (const finding of wire) {
      events.push({
        seq: events.length + 1,
        timestamp: Date.now(),
        kind: 'decision',
        summary: describeFinding(finding),
      });
    }
    // Same cap and re-numbering rule as `recordTraceEvent`, so the timeline's
    // `seq` stays 1-based contiguous however the events arrived.
    if (events.length > MAX_EVENTS_PER_TRACE) {
      trace.events = events.slice(-MAX_EVENTS_PER_TRACE);
      trace.events.forEach((e, i) => { e.seq = i + 1; });
    }
    writeFile(data);
  } catch {
    // Best-effort — an instrument must never break the run it observes.
  }
}

/**
 * Attach the derived TurnReport a turn ended with to its trace — E-trace.
 *
 * Stores the report VERBATIM rather than re-deriving it: the report is already
 * built from recorded evidence (`buildTurnReport`), and a reader comparing the
 * Trace tab against the turn's own close-out must not find two different
 * verdicts. A `null`/absent report is a no-op — a plain answer that produced no
 * non-trivial report leaves the field unset, which reads as "this trace
 * predates the report or the turn had nothing to report", never as "verified".
 *
 * Best-effort and id-less-capable on exactly the same contract as
 * `recordTraceEvent` / `recordTraceFindings`: an id-less call attaches to the
 * run in progress, and an instrument must never break the run it observes.
 *
 * It ALSO lands as a `decision` event in the timeline (like findings do), so the
 * report reads in order at the end of the run rather than appearing only in a
 * section of its own.
 */
export function recordTurnReport(
  traceId: string | undefined,
  report: TurnReport | null | undefined,
): void {
  if (!report) return;
  try {
    const id = traceId || currentTraceId;
    if (!id) return;
    const data = readFile();
    const trace = data.traces.find((t) => t.id === id);
    if (!trace) return;
    trace.turnReport = report;
    const events = trace.events ?? (trace.events = []);
    events.push({
      seq: events.length + 1,
      timestamp: Date.now(),
      kind: 'decision',
      summary: `turn report — ${report.summary ?? report.verification}`,
    });
    // Same cap and re-numbering rule as `recordTraceEvent`.
    if (events.length > MAX_EVENTS_PER_TRACE) {
      trace.events = events.slice(-MAX_EVENTS_PER_TRACE);
      trace.events.forEach((e, i) => { e.seq = i + 1; });
    }
    writeFile(data);
  } catch {
    // Best-effort — an instrument must never break the run it observes.
  }
}

/**
 * Record the USER's verdict on a finished turn — the ground truth a quality
 * signal is fit to.
 *
 * WHY ON THE TRACE. The trace is already the per-turn record: the goal, the
 * steps, the outcome, the turn report. A verdict that lived anywhere else would
 * have to be joined back to a turn by heuristic, and a label that cannot be
 * traced to the run it judges is a number nobody can audit. It also lands as a
 * `decision` event, so the reviewable timeline reads in order.
 *
 * Idempotent in the useful direction: re-rating a turn REPLACES the verdict
 * (people change their mind, and the newer judgement is the better one) rather
 * than accumulating contradicting rows.
 */
export function recordTraceVerdict(
  traceId: string,
  verdict: 'accepted' | 'rejected',
  source: 'cli' | 'dashboard' | 'derived',
  now: number = Date.now(),
): boolean {
  try {
    const data = readFile();
    const trace = data.traces.find((t) => t.id === traceId);
    if (!trace) return false;
    trace.userVerdict = { verdict, at: now, source };
    const events = trace.events ?? (trace.events = []);
    events.push({
      seq: events.length + 1,
      timestamp: now,
      kind: 'decision',
      summary: `user verdict — ${verdict} (${source})`,
    });
    // Same cap and re-numbering rule as `recordTraceEvent`.
    if (events.length > MAX_EVENTS_PER_TRACE) {
      trace.events = events.slice(-MAX_EVENTS_PER_TRACE);
      trace.events.forEach((e, i) => { e.seq = i + 1; });
    }
    writeFile(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this already the wire form? `WireFinding` and `Finding` differ only in
 * `at`, which `Finding` may carry — checked structurally rather than by a flag
 * so either shape can be passed.
 */
function isWireFinding(finding: WireFinding | Finding): finding is WireFinding {
  return !('at' in finding && finding.at !== undefined);
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
    // ── D3 / A5: THE SUMMARY NAMES THE PAIR THAT SERVED, NOT THE ONE REQUESTED ──
    // `beginTrace` stores the pair the caller had CONFIGURED when the run
    // started. That is a REQUEST, not a fact: it is read before routing, so a
    // failover, a handoff or a substitution leaves it describing a pair that may
    // have served nothing at all. Measured on a real 12-minute turn: the summary
    // said `groq` while all 81 recorded steps said `deepseek/deepseek-flash`,
    // and `model explain` had predicted a THIRD pair — three accounts of one
    // turn, so "which model ran?" was unanswerable from the very artefact meant
    // to answer it. The provider half was derived from the steps but the MODEL
    // was left as REQUESTED, so `nuvira trace` could print a served provider
    // beside a model that never ran. Both halves are now one vote: the
    // provider×model PAIR that served the most steps.
    //
    // No steps → the requested pair is left ALONE rather than overwritten with a
    // guess: nothing tried is not evidence.
    try {
      const servedPairs = new Map<string, { provider: string; model: string; count: number }>();
      for (const step of trace.steps ?? []) {
        if (!step?.provider) continue;
        const key = `${step.provider}\u0000${step.model}`;
        const entry = servedPairs.get(key);
        if (entry) entry.count += 1;
        else servedPairs.set(key, { provider: step.provider, model: step.model, count: 1 });
      }
      let winner: { provider: string; model: string; count: number } | undefined;
      for (const entry of servedPairs.values()) {
        if (!winner || entry.count > winner.count) winner = entry;
      }
      if (winner) {
        // `const` so the narrowing survives into the callbacks below.
        const served = winner;
        trace.provider = served.provider;
        // The MODEL is the other half of the pair: a served provider beside a
        // requested model is a pair the run never ran.
        if (served.model) trace.model = served.model;
        // ── D2: A MID-TURN DETOUR IS A RECORDED FACT, NOT AN INVISIBLE ONE ──
        // A step served by a pair other than the run's own is how an unrelated
        // model (measured: a local `deepseek-coder:latest` on seq 14 of an
        // 82-step run) answers part of a run while the summary, the header and
        // the report all name something else. The fact is not a failure by
        // itself — a failover is legitimate — but it must be AUDITABLE, so one
        // bounded `decision` event lists every other pair and the step count it
        // served. Without it, "why does step 14 read like that?" had no answer.
        const detours = [...servedPairs.values()]
          .filter((p) => p.provider !== served.provider || p.model !== served.model)
          .sort((a, b) => b.count - a.count);
        if (detours.length > 0) {
          const events = trace.events ?? (trace.events = []);
          const total = (trace.steps ?? []).length;
          const described = detours
            .slice(0, 5)
            .map((p) => `${p.provider}/${p.model || 'unknown'} ×${p.count}`)
            .join(', ');
          events.push({
            kind: 'decision',
            summary:
              `model detour — ${detours.reduce((n, p) => n + p.count, 0)} of ${total} step(s) ran on a pair ` +
              `other than the run's own (${served.provider}/${served.model || 'unknown'}): ${described}` +
              (detours.length > 5 ? `, +${detours.length - 5} more` : ''),
            seq: events.length + 1,
            timestamp: Date.now(),
          });
          if (events.length > MAX_EVENTS_PER_TRACE) {
            trace.events = events.slice(-MAX_EVENTS_PER_TRACE);
            trace.events.forEach((e, i) => { e.seq = i + 1; });
          }
        }
      }
    } catch {
      // Best-effort — the summary must never break the end of a run.
    }
    writeFile(data);
    // Close the window for id-less recorders — an event after this belongs to
    // the NEXT run, not to the one that just finished.
    if (currentTraceId === traceId) currentTraceId = null;
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
  unverifiedBuildClaim?: boolean;
  undeliveredArtifact?: boolean;
  incompleteArtifactClaim?: boolean;
  unverifiedFileClaim?: boolean;
  artifactShortfall?: boolean;
}): TraceOutcome {
  const tools = [...(input.tools ?? [])];
  if (input.cancelled) return { kind: 'cancelled', tools };
  if (input.generationFailed) return { kind: 'failed', tools };
  const delivered = tools.includes('gateway_send');
  // A turn that CLAIMED work it did not do — or that was asked for a deliverable
  // and produced none — did not conclude. It is `incomplete`, and it must NOT be
  // a success: the live Aukat_check runs reported `success: true` for turns whose
  // outcome was `cancelled`, so nothing downstream offered to continue them.
  const incomplete = Boolean(
    input.undeliveredArtifact ||
      input.unfulfilledPromise ||
      input.unverifiedActionClaim ||
      input.unverifiedBuildClaim ||
      input.incompleteArtifactClaim ||
      input.unverifiedFileClaim ||
      input.artifactShortfall,
  );
  return {
    kind: incomplete ? 'incomplete' : tools.length > 0 ? 'acted' : 'answered',
    tools,
    ...(delivered ? { delivered: true } : {}),
    ...(input.unverifiedActionClaim ? { unverifiedClaim: true } : {}),
    ...(input.unfulfilledPromise ? { unfulfilledPromise: true } : {}),
    ...(input.unverifiedEdit ? { unverifiedEdit: true } : {}),
    ...(input.unverifiedEditClaim ? { unverifiedEditClaim: true } : {}),
    ...(input.unverifiedBuildClaim ? { unverifiedBuildClaim: true } : {}),
    ...(input.undeliveredArtifact ? { undeliveredArtifact: true } : {}),
    ...(input.incompleteArtifactClaim ? { incompleteArtifactClaim: true } : {}),
    ...(input.unverifiedFileClaim ? { unverifiedFileClaim: true } : {}),
    ...(input.artifactShortfall ? { artifactShortfall: true } : {}),
  };
}

/**
 * Did this turn actually succeed? `cancelled`, `failed` and `incomplete` are NOT
 * successes. Callers used to pass `!generationFailed`, which let a cancelled turn
 * record `success: true` while its outcome read `cancelled`; every surface then
 * treated an unfinished run as finished.
 */
export function traceOutcomeSucceeded(outcome: TraceOutcome | undefined): boolean {
  if (!outcome) return true;
  return outcome.kind !== 'failed' && outcome.kind !== 'cancelled' && outcome.kind !== 'incomplete';
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
  let totalEvents = 0;
  let refusals = 0;
  let gateDecisions = 0;
  for (const trace of data.traces) {
    for (const step of trace.steps) {
      totalSteps++;
      latencySum += step.latencyMs;
      tokenSum += step.inputTokens + step.outputTokens;
      byAgentType[step.agentType] = (byAgentType[step.agentType] || 0) + 1;
      byModel[step.model] = (byModel[step.model] || 0) + 1;
    }
    for (const event of trace.events ?? []) {
      totalEvents++;
      if (event.kind === 'refusal') refusals++;
      if (event.kind === 'gate') gateDecisions++;
    }
  }
  return {
    total: data.traces.length,
    totalSteps,
    avgLatencyMs: totalSteps > 0 ? Math.round(latencySum / totalSteps) : 0,
    totalTokens: tokenSum,
    byAgentType,
    byModel,
    totalEvents,
    refusals,
    gateDecisions,
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
