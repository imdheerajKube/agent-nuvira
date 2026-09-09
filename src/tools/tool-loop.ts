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

import { getTool, toolJsonSchemas, type FollowupSuggestion, type ToolContext, type ToolJsonSchema } from './registry.js';
import { effectiveToolJsonSchemas, coreToolJsonSchemas, isToolEnabled, toolsetForTool } from './toolsets.js';
import { appendToolArtifact } from './artifact-append.js';
import type { ToolMessage } from '../inference/interface.js';
import { logger } from '../utils/logger.js';

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
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
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
   * Mechanical thread budget in characters (deterministic compaction —
   * see trimThreadBudget). 0 disables (default: DEFAULT_THREAD_BUDGET_CHARS).
   */
  threadBudgetChars?: number;
  /** Bound on steps per turn (default: 8) — never an infinite loop. */
  maxSteps?: number;
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
  /** Tool names executed this turn (telemetry / tests). */
  toolCalls: string[];
  /** Steps consumed. */
  steps: number;
  /** True when the step bound was hit before an end turn. */
  bounded: boolean;
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
  const startsAt = /\(?\s*\{\s*"tool"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = startsAt.exec(cleaned)) !== null) {
    const end = findMatchingBrace(cleaned, m.index);
    if (end === -1) {
      startsAt.lastIndex = m.index + 1;
      continue;
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
  return { text: strippedAny ? cleaned.trim() : content, calls };
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

/**
 * Run one tool-call turn:
 * generate → execute tools → feed results back → repeat until the model
 * returns a no-tools response (end turn), bounded by maxSteps.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { messages, tools: toolNames, maxSteps = 16, context, deps } = opts;

  const followups: FollowupSuggestion[] = [];
  const toolCallsRun: string[] = [];
  const sink = { push(f: FollowupSuggestion) { followups.push(f); } };
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

  while (steps < maxSteps) {
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
      logger.warn(`   ⚠️ Tool-loop generation failed: ${message}`);
      const madeProgress = lastContent.trim() !== '' || toolCallsRun.length > 0;
      return {
        content: lastContent || `I couldn't complete that request (${message}).`,
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
        generationFailed: !madeProgress,
      };
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
      };
    }

    // ── Execute tool calls (results fed back, next step) ──────────────
    thread.push({
      role: 'assistant',
      content: response.content,
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) })),
    });

    let endedAfterConcluding = false;
    for (const call of toolCalls) {
      const tool = getTool(call.name);
      toolCallsRun.push(call.name);
      if (call.name === 'suggest_followups') {
        // The LAST suggest_followups call wins (a model that repeats it after
        // already answering must not accumulate 15 stale suggestions).
        followups.length = 0;
      }
      let resultText: string;

      // S5 — PLANNER LOOP GUARD: if plan_todo has been called more than
      // once, force-break the loop and return whatever content we have.
      // This prevents the 6x planner loop observed in trace-1788059239352-k7zl03
      // where the model called plan_todo 6 times for a song-writing request
      // (15.6K tokens, 2m25s, FAILED).
      const planTodoCount = toolCallsRun.filter((t) => t === 'plan_todo').length;
      if (call.name === 'plan_todo' && planTodoCount >= 1) {
        resultText = 'Error: plan_todo already called. You have a plan — now execute it. Do NOT call plan_todo again. Use write_file, run_terminal, or other execution tools to complete the work.';
      } else if (call.name === 'pipeline' && toolCallsRun.filter((t) => t === 'pipeline').length >= 1) {
        resultText = 'Error: pipeline already called. The pipeline is running — do not call it again.';
      } else if (!tool) {
        // Unknown tool — the error is fed back so the model retries with a
        // known tool (hadToolCallError handling).
        resultText = `Error: unknown tool "${call.name}". Available tools: ${schemas.map((s) => s.name).join(', ')}.`;
      } else if (tiered && !schemaNames.has(call.name)) {
        // Tiered exposure gate: the tool is REGISTERED but its toolset was
        // never loaded this turn — do NOT execute it silently. Give the model
        // the exact load syntax so it can activate the toolset and retry.
        const ownerToolset = toolsetForTool(call.name);
        resultText =
          `Error: tool "${call.name}" exists but its "${ownerToolset?.name ?? 'domain'}" toolset is not loaded this turn. ` +
          `Call tool_search with {"action":"load","toolset":"${ownerToolset?.name ?? ''}"} first — its tools become callable immediately.`;
      } else if (!isToolEnabled(call.name, context.configManager)) {
        // I1 execution gate: a disabled tool is rejected at runtime even if
        // the model hallucinated its name — the toggle is never cosmetic.
        resultText = `Error: tool "${call.name}" is disabled — its toolset is turned off. Enable it with \`nuvira tools toolsets\`.`;
      } else {
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
          resultText = await deps.executeTool(call.name, call.arguments, ctx);
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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resultText = `Error: ${message}`;
          ctx.emit?.('tool:called', {
            id: call.id,
            tool: call.name,
            ok: false,
            error: message,
            durationMs: Date.now() - startedAt,
          });
        }
      }
      // P3c — on error/denial, append the deterministic fallback hint for
      // this tool (advisory — the model still decides; never on success).
      const hint = fallbackHintForTool(call.name, resultText);
      if (hint) resultText = `${resultText}\n\n💡 ${hint}`;
      // P3d — record successful independent gather steps; the suggestion
      // fires once after the 2nd (bounded, deterministic, advisory).
      const parallelTip = parallel.note(call.name, !resultText.startsWith('Error:'));
      if (parallelTip) resultText = `${resultText}\n\n${parallelTip}`;
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
      };
    }
  }

  bounded = true;
  deps.onEvent?.(`   ⚠️ Tool loop reached its ${maxSteps}-step bound — returning the last response.`);
  return {
    content: lastContent || 'I reached my step limit for this request.',
    followups,
    toolCalls: toolCallsRun,
    steps,
    bounded: true,
  };
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
// latency, no summarization drift (the Freebuff compact-history pattern):
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
