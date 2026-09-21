/**
 * E3b — The tool loop (`src/tools/tool-loop.ts`).
 *
 * The chat
 * loop continues while the model emits tool calls and ends on a no-tools
 * response; think-only responses continue; tool-call errors force another
 * step so the model retries in-context with the error message.
 *
 * The loop is PURE and provider-agnostic: `callModel` and `executeTool` are
 * injected by the caller (chat.ts wires real providers + the ToolExecutor),
 * so tests drive every path with mocks — no network, no TTY.
 *
 * Two transports (C3 acceptance b, H1):
 * - Native: the provider implements `generateTools` (tool_calls protocol).
 * - JSON fallback: the model emits `{"tool":"<name>","arguments":{...}}`
 *   blocks after its response text (contract in TOOL_CONTRACT_JSON).
 */

import { getTool, toolJsonSchemas, type ToolContext, type ToolJsonSchema } from './registry.js';
import { normalizeFollowups, type FollowupSuggestion } from './followup-utils.js';
import { effectiveToolJsonSchemas, coreToolJsonSchemas, isToolEnabled, toolsetForTool } from './toolsets.js';
import { appendToolArtifact } from './artifact-append.js';
import type { ToolMessage } from '../inference/interface.js';
import { logger } from '../utils/logger.js';
import { toUserFacingGenerationError } from '../inference/tool-call-utils.js';

export { type ToolMessage };

// ─── P3c — tool-fallback hints (switch tools when one fails) ────────────────
// The ask: *"if one tool fails you switch to another and explore parallel
// ways"* (round-2 row 25). Today the raw `Error: …` text is fed back and a
// STRONG model retries with another tool — a weak model repeats the same
// failing call. These deterministic per-tool alternatives (no LLM call) make
// the fallback model-independent: on error/denial the hint is appended, on
// success it never fires.

/**
 * Concrete alternative-tool hints per tool. Each names the exact delegate
 * agent_type / syntax so a weak model can act without inventing one.
 */
const TOOL_FALLBACK_HINTS: Record<string, string> = {
  run_terminal:
    'Try delegate with agent_type "tester" for an isolated test/verify run, or retry run_terminal with a longer timeout_ms.',
  read_file:
    'Try code_search (pattern, cwd) to locate the relevant lines, or delegate to agent_type "context-gatherer" to map the file.',
  glob: 'Try list_dir or code_search to explore the workspace instead.',
  list_dir: 'Try glob (pattern) or code_search to find files by content/shape instead.',
  code_search: 'Try glob or read_file — or delegate to agent_type "context-gatherer" for a broader scan.',
  edit_file:
    'Re-read the target with read_file first (the match must be exact), then retry edit_file.',
  write_file: 'Check the parent directory with list_dir, then retry write_file.',
  web_search: 'Try read_page directly on the likely URL, or delegate to agent_type "researcher" for a broader web pass.',
  read_page: 'Try web_search to find the URL, or delegate to agent_type "researcher".',
  plan_todo: 'The plan is best-effort — mark the step blocked and continue with the remaining steps.',
  skill: 'Try listing available skills (skill tool with no name) — or delegate to the sub-agent that owns the capability.',
  clone_repo: 'Verify the URL with web_search, then retry clone_repo — or delegate to agent_type "context-gatherer" to assess the repo.',
  git: 'Try run_terminal with the read-only git command (git status / git diff), or delegate to agent_type "tester" to verify the change.',
  delegate: 'A sub-agent failed — retry with a narrower prompt, or run the subtask yourself with the direct tools.',
  gateway_send: 'Verify the target alias with the gateway directory, then retry gateway_send.',
};

/**
 * The P3c fallback hint for a failed tool call — appended to the error text
 * the model sees. Returns null when the tool has no hint (advisory only; the
 * model still decides). Falls back ONLY on error/denial, never on success.
 */
export function fallbackHintForTool(tool: string, resultText: string): string | null {
  if (!resultText || resultText.startsWith('Error:')) {
    return TOOL_FALLBACK_HINTS[tool] ?? null;
  }
  return null;
}

// ─── P3d — parallel suggestion (explore parallel ways) ─────────────────────
// The ask: *"explore parallel ways"* — independent subtasks should fan out,
// not serialize. The loop is strictly sequential (one tool call per step),
// but `delegate` → `spawnSubagents` (Promise.all, max 4) exists — the model
// just never hears about it. After 2+ SUCCESSFUL independent gather steps in
// a turn, inject an advisory delegate suggestion (exact syntax, bounded to
// delegate's max 4, never on dependent/sequential steps).

/** The gather-type tools whose calls are "independent" (fan-out candidates). */
const INDEPENDENT_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'code_search', 'web_search', 'read_page']);

/**
 * Should a parallel-delegate suggestion fire now? Tracks per-turn successful
 * independent calls; fires once after the 2nd independent success (then stays
 * quiet — one suggestion per turn is enough, the model decides whether to use
 * it). Pure + deterministic (no LLM).
 */
export function makeParallelSuggester(initialCounts: Record<string, number> = {}) {
  const counts: Record<string, number> = { ...initialCounts };
  let fired = false;
  return {
    /** Record a successful independent tool call. Returns the suggestion or null. */
    note(tool: string, ok: boolean): string | null {
      if (!INDEPENDENT_TOOLS.has(tool) || !ok || fired) return null;
      counts[tool] = (counts[tool] ?? 0) + 1;
      if (counts[tool] >= 2) {
        fired = true;
        return (
          `💡 Tip: you have gathered ${counts[tool]} independent items with ${tool} — if these are separate subtasks, ` +
          `consider delegate (agent_type "context-gatherer" or "tester") to run up to 4 of them IN PARALLEL ` +
          `instead of one at a time.`
        );
      }
      return null;
    },
    /** Whether the suggestion already fired this turn. */
    get hasFired(): boolean {
      return fired;
    },
  };
}

/** A step response — either a native tool-call response or parsed fallback. */
export interface StepResponse {
  content: string;
  /** Parsed tool calls (empty = end turn). */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** Provider-owned opaque data echoed back on replay (Gemini thoughtSignature). */
    providerMeta?: Record<string, unknown>;
  }>;
}

/** What the caller injects — chat.ts wires providers/failover, tests use mocks. */
export interface ToolLoopDeps {
  /**
   * Generate one step. `messages` is the FULL conversation so far (system
   * already prepended by the caller). `toolSchemas` are the available tools
   * (empty when the provider lacks native support — the contract text in the
   * system prompt handles the fallback transport).
   *
   * P4 — optional `onToken`: when provided, the caller streams content tokens
   * of this step as they arrive (the dashboard answer typewriter). The loop
   * passes ToolLoopOptions.onToken through; a provider without streaming
   * support simply ignores it and returns the whole step at once.
   * Optional `signal`: forwarded from ToolLoopOptions so an in-flight
   * provider request can abort (the dashboard Cancel button).
   */
  callModel(
    messages: ToolMessage[],
    toolSchemas: ToolJsonSchema[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<StepResponse>;
  /** Execute one tool call. Returns the tool-result text fed back to the model. */
  executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Whether a content-only response is a think-only block (continues, doesn't end). */
  isThinkOnly?(content: string): boolean;
  /** Log a loop event (board note / console line). Defaults to logger.info. */
  onEvent?(line: string): void;
}

export interface ToolLoopOptions {
  /** The full conversation history INCLUDING the current user message. */
  messages: ToolMessage[];
  /** Tool names to expose (default: every registered tool). */
  tools?: string[];
  /**
   * Tiered tool exposure (assessment Addendum v3/v4). When 'tiered' and no
   * explicit `tools` list is given, the model's schema starts at the CORE
   * primitive set; domain toolsets are loaded mid-turn via `tool_search`
   * (action "load"), whose result names the loop unions into the live
   * schema set. Default 'all' preserves the pre-tiering behavior exactly —
   * callers opt in (chat reads `tools.loopExposure` from config).
   */
  toolExposure?: 'all' | 'tiered';
  /**
   * R1 — bound on concurrent read-only calls per step, from the model's harness
   * profile. Omit for the default (4); pass 1 for tiny models.
   */
  maxParallelReads?: number;
  /**
   * Mechanical thread budget in characters (deterministic compaction —
   * see trimThreadBudget). 0 disables (default: DEFAULT_THREAD_BUDGET_CHARS).
   */
  threadBudgetChars?: number;
  /** Bound on steps per turn (default: 8) — never an infinite loop. */
  maxSteps?: number;
  /**
   * Bounded auto-continuation budget (default: 2). A turn that dies MID-WAY —
   * the provider walk exhausted every candidate at step N, or the step bound
   * was reached while the model still had work to do — is RESUMED rather than
   * handed back to the user half-done. Each continuation grants
   * `continuationSteps` more steps and re-attempts the failed step. 0 disables
   * (byte-identical to the previous behavior). Never unbounded: the loop still
   * terminates after `maxSteps + maxContinuations * continuationSteps`. See
   * {@link ToolLoopResult.continuations}.
   */
  maxContinuations?: number;
  /** Extra steps granted per continuation (default: 8). */
  continuationSteps?: number;
  /** Pause before re-attempting a failed step (default: 1500ms; tests set 0). */
  continuationDelayMs?: number;
  /** ToolContext for executions (configManager, followups sink, board, ...). */
  context: ToolContext;
  deps: ToolLoopDeps;
  /**
   * P4 — stream content tokens as the model generates them (typewriter for
   * the dashboard's final answer). Passed to every callModel; providers that
   * stream deliver tokens live, others deliver the whole step at once.
   * The loop never buffers or reorders — the caller's onToken is verbatim.
   */
  onToken?: (token: string) => void;
  /**
   * P4 — external cancellation (the dashboard's Cancel button). The loop
   * checks the signal before every step and after every tool execution and
   * passes it into callModel so an in-flight provider request aborts (the
   * fetch itself stops — quota/tokens are not spent on a cancelled turn).
   * An aborted turn returns a `cancelled: true` result the caller discards.
   */
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  /** The final assistant content (end-turn response). */
  content: string;
  /** Follow-ups collected from suggest_followups calls. */
  followups: FollowupSuggestion[];
  /** Tool names ATTEMPTED this turn (includes refused/unknown/failed calls). */
  toolCalls: string[];
  /**
   * Tool names that ACTUALLY ran successfully this turn — an `Error:` refusal,
   * an unknown tool, or a delivery tool that reported failure is NOT included.
   * This is the honest "what happened" list the trace outcome consumes (the
   * `acted` contract is "at least one tool executed successfully").
   */
  successfulToolCalls?: string[];
  /**
   * True when a delivery tool (`gateway_send`) ran AND reported success
   * (`✅ sent …`). A mere attempt is NOT a delivery — a failed send still lets
   * the model say "I have sent…", so the trace must not read
   * "action performed — message sent".
   */
  deliveryConfirmed?: boolean;
  /** Steps consumed. */
  steps: number;
  /** True when the step bound was hit before an end turn. */
  bounded: boolean;
  /**
   * How many bounded auto-continuations were spent this turn (0 = the turn ran
   * straight through). Telemetry only — a resumed turn reports the SAME content
   * contract as one that never stalled.
   */
  continuations?: number;
  /**
   * True when generation failed entirely (no model answered, no tool ran) —
   * the E3c no-model signal: the caller may fall back to the rule decision
   * (rules act only when the model is unavailable, never as a bypass).
   */
  generationFailed?: boolean;
  /**
   * P4 — true when the turn was cancelled via ToolLoopOptions.signal (the
   * dashboard's Cancel button). The caller DISCARDS the turn: no cache write,
   * no history/memory recording, no followups — a cancelled turn must not
   * leave a half-answer in the session.
   */
  cancelled?: boolean;
  /**
   * HONESTY FLAG — the final answer CLAIMED a delivery/action ("I have sent…",
   * "message delivered…") but NO delivery tool actually ran this turn. A
   * model can write a tool call as prose, or skip it entirely and simply say
   * the action succeeded. When true, the answer is an unverified claim: the
   * caller must NOT present it as a completed action (the gateway appends a
   * correction; the trace records it). Set by the loop; never guessed by
   * callers.
   */
  unverifiedActionClaim?: boolean;
  /**
   * HONESTY FLAG — the answer closes by ANNOUNCING an imminent tool-shaped
   * action ("I will begin by scaffolding the project…", "Let me now create the
   * files") and the turn ends having performed NOTHING. The delivery-claim
   * guard deliberately ignores future tense (a truthful answer may say "I will
   * send it if you confirm"), so a dropped intent passed unreported and read
   * to the user as work in progress. The loop first spends ONE bounded nudge
   * asking the model to actually act; this flag is the residual signal for a
   * promise it still did not keep. The caller must never present such a turn
   * as "in progress".
   */
  unfulfilledPromise?: boolean;
}

/** An orphan reasoning block or bare <think> is a think-only response. */
export function isThinkOnlyResponse(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Only a <think>…</think> block (no visible answer text).
  if (/^<think>[\s\S]*<\/think>\s*$/.test(trimmed)) return true;
  // Only reasoning keywords with no substantive answer (orphan reasoning).
  if (/^(hmm|thinking|let me think|ok,? let'?s|considering)[.:\s]*$/i.test(trimmed.slice(0, 60))) return true;
  return false;
}

/**
 * Extract JSON fallback tool calls from model text:
 * `{"tool":"name","arguments":{...}}` blocks, possibly fenced or multiple.
 * Uses brace-matching (string-aware) so nested argument objects parse
 * correctly. Returns the cleaned content (blocks stripped) + parsed calls.
 */
export function extractFallbackToolCalls(content: string): { text: string; calls: StepResponse['toolCalls'] } {
  const calls: StepResponse['toolCalls'] = [];
  let cleaned = content;
  let strippedAny = false;
  // A real tool block always names the tool as a JSON STRING
  // (`{"tool":"name"`). Requiring the opening quote keeps unrelated prose
  // (`{"tool": broken`) untouched while still catching a truncated real call.
  const startsAt = /\(?\s*\{\s*"tool"\s*:\s*"/g;
  let m: RegExpExecArray | null;
  while ((m = startsAt.exec(cleaned)) !== null) {
    const end = findMatchingBrace(cleaned, m.index);
    if (end === -1) {
      // A QUOTED tool block with no closing brace: the model was cut off
      // mid-call. Everything from the marker on is leaked scaffolding, not
      // answer text — strip it and stop (nothing valid can follow).
      cleaned = cleaned.slice(0, m.index);
      strippedAny = true;
      break;
    }
    const block = cleaned.slice(m.index, end + 1);
    // A matched block is ALWAYS removed from the answer text — a raw
    // `{"tool":...}` block must never leak into the user-facing content,
    // even when it fails to parse (a malformed followups block was the cause
    // of the essay prompt's answer ending in raw JSON).
    cleaned = cleaned.slice(0, m.index) + cleaned.slice(end + 1);
    startsAt.lastIndex = m.index;
    strippedAny = true;
    try {
      const parsed = JSON.parse(block) as { tool?: string; arguments?: Record<string, unknown> };
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          id: `call_${calls.length + 1}`,
          name: parsed.tool,
          arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
        });
      }
    } catch {
      // Unparseable block — dropped from the answer, no tool call.
    }
  }
  if (!strippedAny) return { text: content, calls };
  // Remove empty fenced blocks left behind when a fenced JSON block's BODY was
  // the tool call (e.g. "```json\n\n```").
  const text = cleaned.replace(/\n?```[a-z]*\s*\n?\s*```\s*/gi, '\n').trim();
  return { text, calls };
}

/**
 * Whether content is a BARE acknowledgment — a short lead-in that agrees to
 * help but does NOT yet contain the answer ("Sure, I can help with that!",
 * "Let me write that for you."). The tool contract tells the model to deliver
 * the answer FIRST and call suggest_followups only AFTER it — but a model
 * that misorders them (followups in step 1 + a bare lead-in) must NOT end the
 * turn with only the acknowledgment, otherwise the real answer never arrives
 * (the user sees "Sure!" and no essay). When the loop sees a concluding
 * suggest_followups step whose only content is such a lead-in, it continues
 * so the model can deliver the actual answer.
 */
export function isBareAcknowledgment(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.length >= 80) return false; // a real answer is longer than a lead-in
  if (/^[^.!?]*!$/.test(trimmed)) return true; // short exclamatory lead-in ("Sure!")
  return /^(sure|ok(?:ay)?|alright|absolutely|certainly|of course|no problem|sounds good|happy to|glad to|let me|i['’]d|i['’]ll|i will|i can|i would|i'm on it|on it)/i.test(trimmed) ||
    /(help with that|help you with|write (that|this|it) for|take a look|dive in|give it a shot)/i.test(trimmed);
}

/** Index of the brace matching the one at `start` (string-aware), or -1. */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── Parallel read-only execution (W2) ──────────────────────────────────────
/**
 * Tools that are READ-ONLY and therefore safe to execute concurrently when the
 * model emits several of them in ONE step. Everything else — writes, terminal
 * commands, pipeline dispatch, delegation, `tool_search` (it mutates the
 * tiering state), `plan_todo`, `ask_user` (it blocks on user input) — stays
 * strictly serial and in the model's original order.
 *
 * Why this matters: tool results are fed back one step at a time and the step
 * budget is bounded (16), so N independent reads used to cost N sequential
 * round-trips of wall-clock. Reading several files/searches is the single most
 * common investigation pattern, so it becomes one bounded fan-out.
 *
 * The list is deliberately an ALLOWLIST (never a denylist): a tool added to
 * the registry later is SERIAL by default until it is reviewed as read-only.
 */
export const PARALLEL_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'code_search',
  'web_search',
  'read_page',
]);

/** Whether a tool may run concurrently with sibling calls in the same step. */
export function isParallelSafeTool(name: string): boolean {
  return PARALLEL_SAFE_TOOL_NAMES.has(name);
}

/** Max concurrent read-only calls per step (bounded fan-out) when the model
 *  has no harness opinion — see `ModelHarnessProfile.maxParallelReads`, which
 *  lowers this to 1 for tiny models that cannot use interleaved results. */
const MAX_PARALLEL_READS = 4;

// ─── Bounded auto-continuation (mid-turn model death / step bound) ──────────
// The loop used to give up the MOMENT a step's generation failed (all provider
// candidates exhausted) or the step bound was reached: the user got a partial
// answer (or an error line) and had to re-ask, even though the work was
// half-done and resumable in-context. These defaults resume the SAME turn a
// bounded number of times — the model keeps its thread, completed tool calls
// are never re-run, and the loop can never spin forever.

/** Default continuations granted per turn when the option is omitted. */
export const DEFAULT_MAX_CONTINUATIONS = 2;
/** Default extra steps granted per continuation. */
export const DEFAULT_CONTINUATION_STEPS = 8;
/** Pause before re-attempting a failed step (lets a transient outage clear). */
export const CONTINUATION_DELAY_MS = 1_500;

/**
 * Whether a generation failure looks TRANSIENT — the only case where waiting
 * before the resume attempt helps. A 5xx / network / timeout / rate-limit spike
 * can clear in seconds; a hard failure (no credentialed candidate, dead key,
 * bad model id) cannot, so it resumes IMMEDIATELY. Waiting on a hard failure
 * only delays the user's answer (and made the interactive/gateway paths
 * measurably slower for no benefit).
 */
export function isTransientGenerationFailure(message: string): boolean {
  return /(?:\b429\b|\b5\d\d\b|rate.?limit|quota|too many requests|timeout|timed out|etimedout|econn\w*|enotfound|socket hang up|network|fetch failed|dns|temporarily|overloaded|unavailable|try again)/i.test(
    message,
  );
}

/** Sleep helper for the bounded pre-continuation pause. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mutable turn-level progress shared with the wrapper. Kept OUT of the many
 * `runToolLoopInner` return sites so every exit path (cancel, bounded, terminal
 * dispatch, end-of-response) reports the same honest accounting.
 */
export interface ToolLoopProgress {
  /** Names of tool calls that ran successfully this turn. */
  successfulToolCalls: string[];
  /** True when a delivery tool reported an actual `✅` send. */
  deliveryConfirmed: boolean;
}

/**
 * Run one tool-call turn:
 * generate → execute tools → feed results back → repeat until the model
 * returns a no-tools response (end turn), bounded by maxSteps.
 */
async function runToolLoopInner(opts: ToolLoopOptions, progress: ToolLoopProgress): Promise<ToolLoopResult> {
  const { messages, tools: toolNames, maxSteps = 16, context, deps } = opts;
  // Bounded auto-continuation state (see ToolLoopOptions.maxContinuations).
  const maxContinuations = Math.max(0, opts.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS);
  const continuationSteps = Math.max(1, opts.continuationSteps ?? DEFAULT_CONTINUATION_STEPS);
  let continuations = 0;
  // Bounded dangling-promise nudges spent this turn (see INTENT_PROMISE_RE).
  let intentNudges = 0;
  // The EFFECTIVE bound: starts at maxSteps and is extended (never beyond the
  // continuation budget) so a turn that still has work can finish.
  let stepLimit = maxSteps;
  // R1 — the harness, not a constant, decides how wide a read fan-out this
  // model can consume. Tiny models get 1 (serial): they rarely emit parallel
  // calls and interleaved results cost them more than the latency they save.
  const maxParallelReads = Math.max(1, opts.maxParallelReads ?? MAX_PARALLEL_READS);

  const followups: FollowupSuggestion[] = [];
  const toolCallsRun: string[] = [];
  // Every collected suggestion passes through the shared normalizer, so the
  // loop's output is ALWAYS clean + structured (1–3 items, deduped, no leaked
  // tool JSON, capped prompt/label) regardless of what the model emitted —
  // and every surface (CLI, dashboard chips, gateway list) inherits it.
  const sink = {
    push(f: FollowupSuggestion) {
      const next = normalizeFollowups([...followups, f]);
      followups.length = 0;
      followups.push(...next);
    },
  };
  const ctx: ToolContext = {
    ...context,
    followups: context.followups || sink,
  };

  // Resolve the tool set — stable JSON schemas for every native step
  // (derived from the registry's zod schemas, single source of truth).
  // I1 (toolsets): when the caller did not explicitly pick tools, gate the
  // schema to ENABLED toolsets only — the model never sees a disabled tool
  // (Capability-gating). Explicit toolNames win (caller intent).
  //
  // Tiered exposure (Addendum v3/v4): when opts.toolExposure === 'tiered'
  // and no explicit toolNames were given, the wire schema starts at the CORE
  // primitive set. Domain toolsets load MID-TURN via `tool_search` (action
  // "load"): the tool writes names into ctx.loadedExtraTools and the loop
  // unions their schemas into `schemas` below before the next step. The
  // mutable array + loaded set are the tiering state machine.
  const tiered = opts.toolExposure === 'tiered' && !toolNames;
  // Tiered exposure: guarantee the loader set exists even when the caller
  // forgot — tool_search load writes here; mergeLoadedTools reads it.
  if (tiered && !(ctx.loadedExtraTools instanceof Set)) {
    ctx.loadedExtraTools = new Set<string>();
  }
  const schemas: ToolJsonSchema[] = toolNames
    ? toolJsonSchemas(toolNames)
    : tiered
      ? coreToolJsonSchemas(context.configManager)
      : effectiveToolJsonSchemas(context.configManager);
  // Names already unioned into `schemas` (beyond the initial set). The loop
  // consults ctx.loadedExtraTools after EVERY executed tool call and merges
  // newly-loaded names here.
  const schemaNames = new Set(schemas.map((s) => s.name));
  const mergeLoadedTools = (): number => {
    if (!tiered) return 0;
    const loaded = ctx.loadedExtraTools;
    if (!(loaded instanceof Set) || loaded.size === 0) return 0;
    let added = 0;
    for (const name of loaded) {
      if (schemaNames.has(name)) continue;
      if (!getTool(name)) continue; // never schema a non-registered name
      if (!isToolEnabled(name, context.configManager)) continue; // I1 gate
      const [schema] = toolJsonSchemas([name]);
      if (schema) {
        schemas.push(schema);
        schemaNames.add(name);
        added++;
      }
    }
    if (added > 0) {
      deps.onEvent?.(`   🧰 ${added} tool(s) loaded via tool_search — now callable (${schemas.length} total).`);
    }
    return added;
  };

  const thread: ToolMessage[] = [...messages];
  const budgetChars = opts.threadBudgetChars ?? DEFAULT_THREAD_BUDGET_CHARS;
  // P3d — per-turn parallel suggester: after 2+ successful independent gather
  // steps, one advisory delegate suggestion fires (bounded, deterministic).
  const parallel = makeParallelSuggester();
  let steps = 0;
  // The last SUBSTANTIVE answer text. JSON-only steps (a `{"tool":...}` block
  // with no visible text, common after the model already answered) must NOT
  // clobber it — otherwise the delivered answer is lost and the turn ends
  // with an empty/bounded response (the "where is the essay?" bug).
  let lastContent = '';
  let bounded = false;

  for (;;) {
    // ── Bounded auto-continuation on the STEP BOUND ────────────────────────
    // The model still wanted to act when the budget ran out (a long build, a
    // many-file edit). Extend the budget a bounded number of times and keep
    // the SAME thread — completed tool calls are never re-run — instead of
    // telling the user "I reached my step limit" with the task unfinished.
    if (steps >= stepLimit) {
      if (continuations < maxContinuations) {
        continuations += 1;
        stepLimit += continuationSteps;
        deps.onEvent?.(
          `   🔄 Step bound reached with work remaining — continuing (continuation ${continuations}/${maxContinuations}, budget ${stepLimit} steps).`,
        );
        continue;
      }
      break;
    }
    // P4 — check cancellation BEFORE each step (a pre-aborted signal never
    // spends a model call) and after tool executions (below).
    if (opts.signal?.aborted) {
      return { content: '', followups, toolCalls: toolCallsRun, steps, bounded: false, cancelled: true };
    }
    steps += 1;
    // Mechanical thread budget: trim BEFORE the model call so a provider
    // request never exceeds the window (deterministic — no LLM summarizer,
    // no latency, no drift; see trimThreadBudget).
    if (budgetChars > 0) {
      const trimmedResult = trimThreadBudget(thread, budgetChars);
      if (trimmedResult.trimmed > 0) {
        thread.length = 0;
        thread.push(...trimmedResult.thread);
        deps.onEvent?.(`   ✂️ ${trimmedResult.trimmed} old tool result(s) trimmed to fit the ${Math.round(budgetChars / 1000)}K-char context budget.`);
      }
    }
    let response: StepResponse;
    try {
      response = await deps.callModel(thread, schemas, opts.onToken, opts.signal);
      // A provider/adapter that resolves with nothing usable (undefined, a
      // missing content field) must not crash the turn — treat it as this
      // step's generation failure so the bounded continuation logic below can
      // resume or return gracefully. Malformed steps used to throw a raw
      // TypeError out of the loop and kill an otherwise-recoverable turn.
      if (!response || typeof response.content !== 'string' || !Array.isArray(response.toolCalls)) {
        throw new Error('model returned a malformed step response (no content/toolCalls)');
      }
    } catch (err) {
      // P4 — an abort (the dashboard Cancel button) is a clean stop, NOT a
      // generation failure: the caller discards the turn. No error text, no
      // fallback — the fetch itself aborted on the caller's signal.
      if (opts.signal?.aborted) {
        return { content: '', followups, toolCalls: toolCallsRun, steps, bounded: false, cancelled: true };
      }
      // Generation failure — surface what we have rather than crash the turn.
      // generationFailed is TRUE only when NOTHING happened yet (no content, no
      // tools ran): the caller may then fall back to the rule decision (E3c
      // no-model path). If a step already ran (tool executed / content emitted)
      // the loop made progress — generationFailed stays false so the caller
      // never re-runs work (e.g. the model already called `build`, and a later
      // step's generation died — the pipeline must NOT run twice).
      const message = err instanceof Error ? err.message : String(err);
      // The RAW provider text is for the log/trace ONLY. It used to be
      // interpolated straight into the delivered answer, which is how a
      // WhatsApp/dashboard sender ended up reading a provider JSON dump
      // ("… API error (429): {\"error\":{\"code\":429, …, quotaValue, …}").
      logger.warn(`   ⚠️ Tool-loop generation failed: ${message}`);
      const madeProgress = lastContent.trim() !== '' || toolCallsRun.length > 0;
      // ── Bounded auto-continuation ────────────────────────────────────────
      // The step died mid-turn. Instead of handing the user a partial answer
      // (or an error line) and making them re-ask, resume the SAME turn while
      // the continuation budget lasts: the model keeps its thread, so every
      // completed tool call and gathered fact is still in context and is never
      // repeated. The failure is recorded on the provider walk already (which
      // is what makes the retry land on a fresh candidate), so a short pause
      // then a re-attempt is the honest, bounded recovery. Once the budget is
      // spent the previous behavior applies unchanged.
      // Resume only when the turn had already DONE something (a tool ran, or an
      // answer was written). This is the "model went away MID-WAY" case: the
      // thread holds real work that must not be thrown away, and one more walk
      // (with the failures just recorded) can land on a different candidate.
      //
      // When NOTHING happened, `callModel` has already walked every candidate —
      // re-walking immediately repeats the same exhausted list for no benefit,
      // so the honest thing is to surface the failure (generationFailed) and let
      // the caller's no-model path act. This also keeps the interactive/gateway
      // turns as fast as before on a hard outage.
      if (continuations < maxContinuations && madeProgress) {
        continuations += 1;
        stepLimit += continuationSteps;
        deps.onEvent?.(
          `   🔄 Model call failed mid-turn — resuming this turn (continuation ${continuations}/${maxContinuations}, budget ${stepLimit} steps).`,
        );
        const delayMs = opts.continuationDelayMs ?? (isTransientGenerationFailure(message) ? CONTINUATION_DELAY_MS : 0);
        await sleep(Math.max(0, delayMs));
        continue;
      }
      // `generationFailed` answers ONE question: was an ANSWER delivered? It
      // used to answer "did anything happen yet", which is `madeProgress`, and
      // the two are not the same: a turn that ran `code_search` and then died
      // has made progress but produced no answer, so `content` below is the
      // failure line — and returning it with `generationFailed: false` shipped
      // that line as a SUCCESS. Caught live on the dashboard surface: the bubble
      // read "The model wrote its own working notes instead of an answer…" while
      // the flag was false, so no retry was offered and nothing was queued, the
      // gateway would have reported the turn as fine, and the line was eligible
      // for the answer cache. `madeProgress` keeps its own meaning where it
      // belongs — deciding whether a no-model turn may be re-run through the
      // rules' pipeline fallback (E3c) — and a turn with NO answer at all is a
      // failure either way, because there is nothing to deliver.
      const delivered = lastContent.trim();
      return {
        content: delivered || toUserFacingGenerationError(err),
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
        continuations,
        generationFailed: delivered === '' || !madeProgress,
      };
    }

    // ── Recover tool calls the model wrote as TEXT ─────────────────────────
    // A provider can return a step with NO native tool call whose CONTENT is
    // the raw `{"tool":"suggest_followups",...}` block. Observed live
    // (2026-09-20, auto-routed): the followups printed verbatim as JSON to the
    // user and no menu/chips appeared — the JSON transport parses this shape,
    // the native path did not. Salvage it HERE so every caller (CLI, dashboard
    // console, gateway) recovers the calls, and strip the block from the
    // visible answer either way: a raw `{"tool":…}` block must never be the
    // answer. Idempotent with the JSON transport (which already strips it).
    if (response.toolCalls.length === 0 && response.content.includes('"tool"')) {
      const extracted = extractFallbackToolCalls(response.content);
      if (extracted.text !== response.content) {
        response.content = extracted.text;
        if (extracted.calls.length > 0) {
          response.toolCalls = extracted.calls;
          deps.onEvent?.('   ♻️ recovered tool call(s) the model wrote as text');
        }
      }
    }

    // S1: LONGEST-substantive wins. A trailing wrapper (a short closing
    // paragraph written AFTER the real answer, common when the model repeats
    // suggest_followups) must not clobber the full answer delivered in an
    // earlier step — otherwise the turn ends with the wrapper instead of the
    // essay (the "where is the essay?" bug). Think-only responses are NOT
    // substantive — they are reasoning markers, never candidate answers —
    // so they never enter lastContent (both loop exits prefer the longer
    // of response.content / lastContent; a long <think>…</think> block
    // must not beat the real answer).
    const responseThinkOnly = deps.isThinkOnly
      ? deps.isThinkOnly(response.content)
      : isThinkOnlyResponse(response.content);
    if (response.content.trim() && !responseThinkOnly && response.content.length >= lastContent.length) {
      lastContent = response.content;
    }
    const { toolCalls } = response;

    if (toolCalls.length === 0) {
      // No tools → end turn UNLESS the content is think-only (
      // isThinkOnlyResponse: continue instead of ending).
      if (deps.isThinkOnly ? deps.isThinkOnly(response.content) : isThinkOnlyResponse(response.content)) {
        // Feed an empty assistant step so the model continues in-context.
        thread.push({ role: 'assistant', content: response.content });
        deps.onEvent?.('   🧠 model reasoning… (continuing)');
        continue;
      }
      // ── Dangling-promise nudge (bounded, once) ──────────────────────────
      // The model closed the turn announcing what it is ABOUT to do ("I will
      // begin by scaffolding…", "Let me now create the files") without calling
      // a single tool — nothing ran and, in a chat surface, the turn simply
      // ends. Rather than hand the user a promise as the answer, spend ONE
      // extra step asking for the action. Gated on NOTHING having succeeded
      // this turn (a turn that already did work and narrates a next step is
      // not silently dropped), on tools being available, and on the bounded
      // counter. Any residual promise is reported via `unfulfilledPromise`.
      if (
        intentNudges < 1 &&
        progress.successfulToolCalls.length === 0 &&
        schemas.length > 0 &&
        detectUnfulfilledIntentPromise(
          response.content.length >= lastContent.length ? response.content : lastContent,
        )
      ) {
        intentNudges += 1;
        stepLimit += 1;
        deps.onEvent?.('   🔁 Answer announced an action but performed none — asking the model to carry it out.');
        // The promise is NOT a candidate answer: drop it from the
        // longest-substantive memory so the post-nudge answer (or result) is
        // what the turn delivers. Safe because the gate only fires when no
        // tool succeeded and the closing line is a promise — a real essay
        // would outrank and suppress the nudge entirely.
        lastContent = '';
        thread.push({ role: 'assistant', content: response.content });
        thread.push({
          role: 'user',
          content:
            'You announced an action you were about to take, but no tool was called and nothing was done. ' +
            'Either carry it out now with the tools available, or reply with the actual answer — do not end the turn on a promise.',
        });
        continue;
      }
      // S1 (both exits): the MOST SUBSTANTIVE content seen wins here too —
      // a short closing step ("Sent it to her! ✅") with no tool calls must
      // not clobber the deliverable (poem/essay) the model composed in an
      // earlier step alongside a real tool call. Same rule as the
      // suggest_followups exit below.
      return {
        content: response.content.length >= lastContent.length ? response.content : lastContent,
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
        continuations,
      };
    }

    // ── Execute tool calls (results fed back, next step) ──────────────
    thread.push({
      role: 'assistant',
      content: response.content,
      // `providerMeta` rides along verbatim: it is provider-owned data (Gemini's
      // thoughtSignature) that the adapter must send back on the next turn.
      // Rebuilding the call from id/name/arguments alone silently broke every
      // multi-step provider-tool-calling conversation.
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
        ...(tc.providerMeta ? { providerMeta: tc.providerMeta } : {}),
      })),
    });

    let endedAfterConcluding = false;

    // ── Phase 1 — decide, in order (deterministic) ─────────────────────────
    // Guards count calls that came BEFORE this one. Pushing the name first made
    // `prior >= 1` true on a tool's FIRST invocation, so plan_todo was refused
    // on EVERY call — the model then retried it and burned the step budget,
    // which is the very loop the guard was written to prevent. Telemetry still
    // records every attempted call, as before.
    type PlannedCall = { call: (typeof toolCalls)[number]; refuse?: string };
    const plans: PlannedCall[] = toolCalls.map((call) => {
      const tool = getTool(call.name);
      const priorSameTool = toolCallsRun.filter((t) => t === call.name).length;
      toolCallsRun.push(call.name);
      // S5 — PLANNER LOOP GUARD: allow the first plan of the turn, refuse
      // repeats (the 6x planner loop observed in
      // trace-1788059239352-k7zl03: 15.6K tokens, 2m25s, FAILED).
      if (call.name === 'plan_todo' && priorSameTool >= 1) {
        return {
          call,
          refuse:
            'Error: plan_todo already called. You have a plan — now execute it. Do NOT call plan_todo again. Use write_file, run_terminal, or other execution tools to complete the work.',
        };
      }
      if (tool?.category === 'pipeline' && priorSameTool >= 1) {
        // The guard this replaces tested the literal name `pipeline`, which is
        // NOT a registered tool — the dispatch tools are build / resume /
        // repair / document / website / analyze / test / publish — so it could
        // never fire and two identical pipeline runs could start in one turn
        // (pipeline-tool.ts has no in-flight guard of its own). Match the real
        // category, and only when the SAME dispatch tool is repeated.
        return {
          call,
          refuse: `Error: ${call.name} was already dispatched this turn — the pipeline is running. Do not call it again.`,
        };
      }
      if (!tool) {
        // Unknown tool — the error is fed back so the model retries with a
        // known tool (hadToolCallError handling).
        return { call, refuse: `Error: unknown tool "${call.name}". Available tools: ${schemas.map((s) => s.name).join(', ')}.` };
      }
      if (tiered && !schemaNames.has(call.name)) {
        // Tiered exposure gate: the tool is REGISTERED but its toolset was
        // never loaded this turn — do NOT execute it silently. Give the model
        // the exact load syntax so it can activate the toolset and retry.
        const ownerToolset = toolsetForTool(call.name);
        return {
          call,
          refuse:
            `Error: tool "${call.name}" exists but its "${ownerToolset?.name ?? 'domain'}" toolset is not loaded this turn. ` +
            `Call tool_search with {"action":"load","toolset":"${ownerToolset?.name ?? ''}"} first — its tools become callable immediately.`,
        };
      }
      if (!isToolEnabled(call.name, context.configManager)) {
        // I1 execution gate: a disabled tool is rejected at runtime even if
        // the model hallucinated its name — the toggle is never cosmetic.
        return { call, refuse: `Error: tool "${call.name}" is disabled — its toolset is turned off. Enable it with \`nuvira tools toolsets\`.` };
      }
      return { call };
    });

    // ── Phase 2 — execute (read-only runs fan out; everything else serial) ──
    const runOne = async (plan: PlannedCall): Promise<string> => {
      const { call } = plan;
      if (plan.refuse !== undefined) return plan.refuse;
      if (call.name === 'suggest_followups') {
        // The LAST suggest_followups call wins (a model that repeats it after
        // already answering must not accumulate 15 stale suggestions).
        followups.length = 0;
      }
      // I2: emit `tool:started` (before execution) + `tool:called` (after)
      // on the observability bus — drives the hooks registry's
      // the `post_tool_call` hook AND the dashboard's
      // step cards (P0.6: the GUI renders each call as a live card —
      // running → ok/error with duration + collapsible result). Timing is
      // wall-clock; `ok` mirrors the tool-result convention (Error: prefix).
      const startedAt = Date.now();
      ctx.emit?.('tool:started', {
        id: call.id,
        tool: call.name,
        args: call.arguments,
      });
      try {
        deps.onEvent?.(`   ⚙ ${call.name}(${summarizeArgs(call.arguments)})`);
        let resultText = await deps.executeTool(call.name, call.arguments, ctx);
        // I3: a tool that returns {artifact, result} gets its deliverable
        // recorded on the session and only `result`
        // is fed back to the model — the JSON payload is runtime metadata.
        resultText = appendToolArtifact(resultText, ctx.artifacts);
        ctx.emit?.('tool:called', {
          id: call.id,
          tool: call.name,
          ok: !resultText.startsWith('Error:'),
          result: resultText,
          durationMs: Date.now() - startedAt,
        });
        if (call.name === 'suggest_followups') endedAfterConcluding = true;
        return resultText;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.emit?.('tool:called', {
          id: call.id,
          tool: call.name,
          ok: false,
          error: message,
          durationMs: Date.now() - startedAt,
        });
        return `Error: ${message}`;
      }
    };

    const executed: string[] = new Array(plans.length).fill('');
    for (let i = 0; i < plans.length; ) {
      // A run of consecutive read-only calls is ONE bounded fan-out; any
      // refused call breaks the run (its error is cheap and order-sensitive).
      if (plans[i].refuse === undefined && isParallelSafeTool(plans[i].call.name)) {
        let j = i;
        while (j < plans.length && plans[j].refuse === undefined && isParallelSafeTool(plans[j].call.name)) j += 1;
        const run = plans.slice(i, j);
        if (run.length > 1) {
          deps.onEvent?.(`   ⚡ ${run.length} read-only tool calls in parallel`);
          for (let k = 0; k < run.length; k += maxParallelReads) {
            const chunk = run.slice(k, k + maxParallelReads);
            const chunkResults = await Promise.all(chunk.map((p) => runOne(p)));
            chunkResults.forEach((text, n) => {
              executed[i + k + n] = text;
            });
          }
        } else {
          executed[i] = await runOne(run[0]);
        }
        i = j;
      } else {
        executed[i] = await runOne(plans[i]);
        i += 1;
      }
    }

    // ── Phase 3 — post-process, in the model's original call order ─────────
    // Tool results MUST reach the thread in the assistant's tool_calls order:
    // providers pair them by `toolCallId`, and a reordered thread reads as a
    // different (worse) tool use. So the ordered pass below owns the push even
    // though the executions above may have completed out of order.
    // What each call actually delivered (post hint/tip decoration), kept in
    // call order for the endsAgentStep exit below.
    const delivered: string[] = new Array(plans.length).fill('');
    for (let i = 0; i < plans.length; i += 1) {
      const call = plans[i].call;
      const rawResult = executed[i];
      // HONEST ACCOUNTING: record what actually SUCCEEDED (an error/refusal is
      // not a success, and a delivery tool only counts when it reported `✅`).
      // `toolCallsRun` stays the attempted list for telemetry; these two drive
      // the honesty flag and the trace outcome.
      const ranOk =
        !rawResult.startsWith('Error:') &&
        (!DELIVERY_TOOL_NAMES.has(call.name) || deliveryResultSucceeded(rawResult));
      if (ranOk) progress.successfulToolCalls.push(call.name);
      if (call.name === 'gateway_send' && deliveryResultSucceeded(rawResult)) {
        progress.deliveryConfirmed = true;
      }
      let resultText = executed[i];
      // P3c — on error/denial, append the deterministic fallback hint for
      // this tool (advisory — the model still decides; never on success).
      const hint = fallbackHintForTool(call.name, resultText);
      if (hint) resultText = `${resultText}\n\n💡 ${hint}`;
      // P3d — record successful independent gather steps; the suggestion
      // fires once after the 2nd (bounded, deterministic, advisory).
      const parallelTip = parallel.note(call.name, !resultText.startsWith('Error:'));
      if (parallelTip) resultText = `${resultText}\n\n${parallelTip}`;
      delivered[i] = resultText;
      thread.push({ role: 'tool', toolCallId: call.id, content: resultText });
    }

    // Tiered exposure: after EVERY executed tool call, union any newly
    // loaded toolset schemas into the live set so the NEXT model step can
    // call them natively (tool_search load → loadedExtraTools → here).
    mergeLoadedTools();

    // P4 — cancellation during/after tool execution: do NOT request another
    // model step on a cancelled turn (the user already walked away).
    if (opts.signal?.aborted) {
      return { content: '', followups, toolCalls: toolCallsRun, steps, bounded: false, cancelled: true };
    }

    // ── endsAgentStep — a successful dispenser's RESULT is the answer ────────
    // `build`/`resume`/`repair`/`document`/`website`/`analyze`/`test`/`publish`
    // declare endsAgentStep: the pipeline they dispatch runs the entire task,
    // so their own result text (`✅ build succeeded` + summary + details) IS the
    // deliverable. The flag was declared on the Tool interface and read by
    // NOTHING (audit W4), so the loop always asked for one more model step —
    // a full round trip that re-sent the whole tool schema purely to have the
    // model paraphrase output it had not produced, with a live window for a
    // second dispatch of the same pipeline.
    //
    // Only a SUCCESS ends the step (a refused or failed dispatch must stay in
    // the loop so the model can react), and `ask_user` deliberately does not:
    // its result is the user's ANSWER — input the model must act on. See the
    // `endsAgentStep` docstring in registry.ts for the contract.
    const terminalIdx = delivered.findIndex(
      (text, i) => !text.startsWith('Error:') && getTool(plans[i].call.name)?.endsAgentStep === true,
    );
    if (terminalIdx >= 0) {
      // A real summary written THIS step wins (it is the model's own account
      // of the dispatch); a bare lead-in ("Running the build now…") does not —
      // the pipeline's summary is the answer then, not the wrapper.
      const thisStepIsSubstantive =
        response.content.trim() !== '' && !isBareAcknowledgment(response.content);
      return {
        content: thisStepIsSubstantive ? response.content : delivered[terminalIdx],
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
        continuations,
      };
    }

    // End-of-response semantics (the contract: "END EVERY RESPONSE by
    // calling suggest_followups"): when the model delivered its answer and
    // ended with a SUCCESSFUL suggest_followups, the turn is complete — do NOT
    // request another step. That previous behavior forced the model to keep
    // emitting followups (repeating it 4–5×, sometimes malformed), and the
    // repeats clobbered the delivered answer ("where is the essay?" / the
    // answer ending in raw JSON).
    //
    // S1: deliver the MOST SUBSTANTIVE content seen, not necessarily this
    // step's text — the concluding step often carries only a short trailing
    // wrapper while the real answer (the essay) landed in an earlier step
    // whose (invalid) followups call forced the loop to continue. Also covers
    // a JSON-only concluding step (empty text, valid followups): return the
    // substantive answer from earlier.
    // Premature-followups guard: a concluding step whose content is only a
    // bare acknowledgment ("Sure, I can help!") has NOT delivered the answer
    // yet — ending here would hand the user a lead-in instead of the essay.
    // Continue so the model writes the real answer (the S1 longest-substantive
    // logic guarantees an earlier real answer, if any, still wins).
    const hasRealAnswer = lastContent.trim() !== '' && !isBareAcknowledgment(lastContent);
    const thisStepIsReal = response.content.trim() !== '' && !isBareAcknowledgment(response.content);
    if (endedAfterConcluding && (thisStepIsReal || hasRealAnswer)) {
      const content = response.content.length >= lastContent.length ? response.content : lastContent;
      return {
        content,
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
        continuations,
      };
    }
  }

  // Reaching here means the continuation budget is spent (the in-loop check
  // extends the bound otherwise) — the turn is honestly bounded.
  bounded = true;
  deps.onEvent?.(`   ⚠️ Tool loop reached its ${stepLimit}-step budget — returning the last response.`);
  return {
    content: lastContent || 'I reached my step limit for this request.',
    followups,
    toolCalls: toolCallsRun,
    steps,
    bounded: true,
    continuations,
  };
}

// ─── Honest-answer guard ────────────────────────────────────────────────────
// Tools whose successful execution is what actually performs an outbound
// delivery. If one of these ran, a "sent it" sentence is truthful.
const DELIVERY_TOOL_NAMES = new Set(['gateway_send']);

/**
 * True when a delivery-tool RESULT reports an actual delivery.
 *
 * `gateway_send` never throws: a failed send returns a `⚠️`/`🚫`/unknown-target
 * string, and the tool only writes `gateway_send: ✅ sent …` when the transport
 * accepted the message. So "the tool ran" is not the same as "the message was
 * delivered" — observed live: a WhatsApp send that was never received still
 * produced "I have sent…" and a trace reading "✅ action performed — message
 * sent", because delivery was inferred from the attempted tool NAME.
 */
function deliveryResultSucceeded(resultText: string): boolean {
  return /^gateway_send:\s*✅/m.test((resultText || '').trim());
}

/** Past-tense sentences that ASSERT a completed delivery/action. */
const DELIVERY_CLAIM_RE = [
  /\bi(?:'ve| have)\s+(?:just\s+|now\s+|also\s+)*(?:sent|delivered|forwarded|shared|messaged|texted|emailed)\b/i,
  /\bi\s+(?:just\s+|already\s+)*(?:sent|delivered|forwarded|shared|messaged|texted|emailed)\b/i,
  /\b(?:the\s+)?(?:message|poem|note|photo|image|file|it|that|this|result)\s+(?:has been|was|have been|is)\s+(?:sent|delivered|forwarded|shared|emailed|messaged)\b/i,
  /\bsuccessfully\s+(?:sent|delivered|forwarded|shared|emailed|messaged)\b/i,
  /\b(?:it|that|this|the\s+\w+)\s+(?:has been|was)\s+(?:delivered|sent)\s+to\b/i,
];

/** A sentence that is future/interrogative/negated is NOT a completed claim. */
const NON_CLAIM_CONTEXT_RE =
  /\b(?:not|n't|never|unable|cannot|can't|couldn't|didn't|won't|will|would|should|could|can|may|might|going to|about to|try(?:ing)? to|attempt|if you|let me|shall i|should i|do you want|i'?ll)\b/i;

/**
 * True when the answer asserts a delivery that no delivery tool performed.
 * Sentence-scoped so a negation or a future promise elsewhere in the answer
 * never turns a truthful statement into a flag (and vice-versa).
 *
 * This is the "unverified claim" detector — the model may write a tool call as
 * plain prose, or skip tools entirely and simply SAY the action succeeded.
 * A JSON-as-text call is recovered by the loop's salvage step (so the tool
 * really runs and the flag stays false); this catches the residual case where
 * there is no tool call at all.
 */
export function detectUnverifiedDeliveryClaim(content: string, toolsRun: readonly string[]): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (toolsRun.some((n) => DELIVERY_TOOL_NAMES.has(n))) return false;
  // Split on sentence boundaries; test each independently.
  const sentences = text.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/);
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || NON_CLAIM_CONTEXT_RE.test(s)) continue;
    if (DELIVERY_CLAIM_RE.some((re) => re.test(s))) return true;
  }
  return false;
}

/**
 * Tool-shaped actions a first-person imminent promise can drop. Matched by
 * STEM (`\w*` suffix) so "scaffold" covers "scaffolding", "write" covers
 * "writing", etc. — the promise is usually phrased as a gerund ("start by
 * scaffolding").
 */
const INTENT_ACTION_STEM =
  '(?:creat|writ|build|scaffold|implement|generat|add|edit|updat|modif|refactor|run|execut|install|configur|read|inspect|send|post|upload|deploy|publish|fetch|search|apply|fix|delet|remov|mov|renam|copi|compil|set\\s+up)';

/**
 * A first-person IMMINENT promise to act. Immediacy is required, because that
 * is what separates "I am doing this next, in this turn" (a dropped intent)
 * from "I will create a routine for her" (a description of the deliverable).
 * Four shapes cover the real phrasings:
 *   - "Let me now create the files."          (let me …)
 *   - "I will now scaffold the project."      (immediacy adverb)
 *   - "I'll start by reading the config."     (start/begin by …)
 *   - "I will go ahead and implement it."     (go ahead and …)
 */
const INTENT_PROMISE_RES: readonly RegExp[] = [
  new RegExp(
    `\\blet me\\s+(?:now\\s+|then\\s+|first\\s+|just\\s+)*` +
      `(?:start\\s+by\\s+|begin\\s+by\\s+|start\\s+|begin\\s+|go\\s+ahead\\s+and\\s+)?(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+` +
      `(?:now|next|first|immediately|right\\s+away)\\s+` +
      `(?:start\\s+by\\s+|begin\\s+by\\s+|start\\s+|begin\\s+|go\\s+ahead\\s+and\\s+)?(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+(?:start|begin)\\s+by\\s+(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
  new RegExp(
    `\\bi(?:'ll| will| am going to| am about to|'m going to)\\s+` +
      `(?:go\\s+ahead\\s+and|proceed\\s+to|get\\s+right\\s+to)\\s+(?:${INTENT_ACTION_STEM}\\w*)`,
    'i',
  ),
];

/** A list means a deliverable was produced (a plan enumerates phases). */
const LIST_STRUCTURE_RE = /^[ \t]*(?:[-*•·]|\d+[.)])\s+\S/m;

/**
 * A CONDITIONAL or interrogative promise is not dropped intent — "I will send
 * it once you confirm" is an offer, and "shall I proceed?" is a question. Only
 * an unconditional, declarative promise is a dangling one.
 */
const PROMISE_CONDITION_RE =
  /\b(?:if|once|when|after|unless)\s+(?:you|your|i\s+(?:get|receive|hear)|approved|confirmed|permission)\b|\b(?:shall|should)\s+i\b|\bdo you want\b|\blet me know\b|\bwould you\b|\byour\s+(?:approval|go-?ahead|confirmation|permission|ok)\b|\?/i;

/**
 * True when the answer CLOSES on an unconditional first-person promise to take
 * a tool-shaped action — the "I will begin by scaffolding…" shape that ends a
 * turn with nothing done.
 *
 * Deliberately narrow, because crying wolf is worse than staying silent:
 * - Only the closing sentences are judged; a promise mid-answer followed by
 *   real work is narration, not a dropped intent.
 * - An answer containing a list is never a dangling promise — a plan
 *   enumerates, and a prose answer that stops is what this catches.
 * - Immediacy is required ("I will NOW …", "Let me …", "I'll start by …"), so
 *   a descriptive future ("I will create a routine for her") is not a promise.
 * - Conditional/interrogative promises and pure chat verbs (explain, describe,
 *   summarise) are excluded.
 */
export function detectUnfulfilledIntentPromise(content: string): boolean {
  const text = (content || '').trim();
  if (!text) return false;
  if (LIST_STRUCTURE_RE.test(text)) return false;
  const sentences = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Judge only the closing few sentences (the promise that ends the turn).
  for (const sentence of sentences.slice(-3).reverse()) {
    if (!INTENT_PROMISE_RES.some((re) => re.test(sentence))) continue;
    if (PROMISE_CONDITION_RE.test(sentence)) return false;
    return true;
  }
  return false;
}

/**
 * Public entry point. Runs the loop, then annotates the result with the
 * honest-answer flags so every surface (CLI, dashboard, gateway, trace) can
 * distinguish "generated a reply" from "actually performed the action".
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const progress: ToolLoopProgress = { successfulToolCalls: [], deliveryConfirmed: false };
  const result = await runToolLoopInner(opts, progress);
  if (!result.cancelled && !result.generationFailed) {
    result.successfulToolCalls = [...progress.successfulToolCalls];
    result.deliveryConfirmed = progress.deliveryConfirmed;
    // Judge the "I have sent it" claim against what actually DELIVERED, not
    // against the attempted tool list — a failed gateway_send must not silence
    // the honesty correction.
    if (detectUnverifiedDeliveryClaim(result.content, result.successfulToolCalls)) {
      result.unverifiedActionClaim = true;
    }
    // Residual dangling promise: the bounded nudge either got the action
    // carried out (then a tool succeeded and this cannot fire) or it did not.
    // Gated on NOTHING having succeeded, so a turn that partially completed
    // and narrates remaining work is never reported as a dropped intent.
    if (result.successfulToolCalls.length === 0 && detectUnfulfilledIntentPromise(result.content)) {
      result.unfulfilledPromise = true;
    }
  }
  return result;
}

/** Compact argument preview for the event line. */
function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.entries(args).slice(0, 1)[0];
  if (!first) return '{}';
  const [key, value] = first;
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  return `{${key}: ${v.length > 40 ? v.slice(0, 40) + '…' : v}}`;
}

// ─── Mechanical thread budget (assessment Addendum v4 Phase 3.3) ────────────
// The loop had NO thread-size management: a read_file of a large file (or a
// long tool result chain) accumulated verbatim until the provider rejected
// the request. This is DETERMINISTIC compaction — no LLM call, no summary
// latency, no summarization drift (the compact-history pattern):
// the oldest tool results collapse to a stub first, the newest stay verbatim,
// and the system prompt + first user message are never touched.

/** Default thread budget in characters (~50K tokens at 4 chars/token). */
export const DEFAULT_THREAD_BUDGET_CHARS = 200_000;

/** Messages at the END of the thread that are never trimmed (recent context). */
const RECENT_KEEP = 6;

/** Stub left in place of a trimmed tool result. */
const TRIM_STUB = '[earlier tool result trimmed to fit the context budget]';

/** Estimated character size of one thread message (chars/4 ≈ tokens). */
function messageChars(m: ToolMessage): number {
  return (m.content?.length ?? 0) + (m.toolCalls?.length ? JSON.stringify(m.toolCalls).length : 0);
}

/**
 * Deterministically trim a thread to `maxChars`:
 * 1. Never touch the system prompt or the FIRST user message (the ask).
 * 2. Never touch the last `RECENT_KEEP` messages (recent context).
 * 3. Oldest-first: tool results longer than 500 chars collapse to the stub;
 *    if still over budget, remaining old tool results collapse entirely.
 * Returns a NEW array (input untouched) + how many messages were trimmed.
 */
export function trimThreadBudget(
  thread: ToolMessage[],
  maxChars: number = DEFAULT_THREAD_BUDGET_CHARS,
): { thread: ToolMessage[]; trimmed: number } {
  const total = thread.reduce((a, m) => a + messageChars(m), 0);
  if (total <= maxChars) return { thread, trimmed: 0 };

  const out = [...thread];
  // Indices eligible for trimming: skip the system prompt, the first user
  // message, and the RECENT_KEEP tail.
  const firstUserIdx = thread.findIndex((m) => m.role === 'user');
  const eligible: number[] = [];
  for (let i = 0; i < out.length - RECENT_KEEP; i++) {
    if (out[i].role === 'system') continue;
    if (i === firstUserIdx) continue;
    eligible.push(i);
  }

  let over = total - maxChars;
  let trimmed = 0;
  // Pass 1: collapse long OLD tool results to the stub (keep the first 500
  // chars so the model retains the gist of what it did).
  for (const i of eligible) {
    if (over <= 0) break;
    const m = out[i];
    if (m.role !== 'tool' || m.content.length <= 500) continue;
    const delta = m.content.length - 500 - TRIM_STUB.length;
    if (delta <= 0) continue;
    out[i] = { ...m, content: m.content.slice(0, 500) + TRIM_STUB };
    over -= delta;
    trimmed++;
  }
  // Pass 2: still over — collapse remaining OLD tool results entirely.
  if (over > 0) {
    for (const i of eligible) {
      if (over <= 0) break;
      const m = out[i];
      if (m.role !== 'tool' || m.content === TRIM_STUB) continue;
      over -= m.content.length - TRIM_STUB.length;
      out[i] = { ...m, content: TRIM_STUB };
      trimmed++;
    }
  }
  // Pass 3: STILL over (pathological — huge old user turns) — trim old USER
  // messages to a short stub. User messages carry no tool_call pairing, so
  // this is wire-safe (an assistant toolCalls block + its tool stub stay
  // paired; never fabricate tool messages — providers validate ids).
  if (over > 0) {
    for (const i of eligible) {
      if (over <= 0) break;
      const m = out[i];
      if (m.role !== 'user' || m.content.length <= 200) continue;
      const delta = m.content.length - 200 - TRIM_STUB.length;
      if (delta <= 0) continue;
      out[i] = { ...m, content: m.content.slice(0, 200) + TRIM_STUB };
      over -= delta;
      trimmed++;
    }
  }
  return { thread: out, trimmed };
}
