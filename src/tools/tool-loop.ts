/**
 * E3b — The tool loop (`src/tools/tool-loop.ts`).
 *
 * Freebuff `run-agent-step.ts` parity, verified against the clone: the chat
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
import { effectiveToolJsonSchemas, isToolEnabled } from './toolsets.js';
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
   */
  callModel(messages: ToolMessage[], toolSchemas: ToolJsonSchema[]): Promise<StepResponse>;
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
  /** Bound on steps per turn (default: 8) — never an infinite loop. */
  maxSteps?: number;
  /** ToolContext for executions (configManager, followups sink, board, ...). */
  context: ToolContext;
  deps: ToolLoopDeps;
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
}

/** Freebuff `isThinkOnlyResponse` parity: an orphan reasoning block or bare <think>. */
export function isThinkOnlyResponse(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Only a <think>…</think> block (no visible answer text).
  if (/^<think>[\s\S]*<\/think>\s*$/.test(trimmed)) return true;
  // Only reasoning keywords with no substantive answer (Freebuff orphan reasoning).
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
 * Run one tool-call turn (Freebuff run-agent-step semantics):
 * generate → execute tools → feed results back → repeat until the model
 * returns a no-tools response (end turn), bounded by maxSteps.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { messages, tools: toolNames, maxSteps = 8, context, deps } = opts;

  const followups: FollowupSuggestion[] = [];
  const toolCallsRun: string[] = [];
  const sink = { push(f: FollowupSuggestion) { followups.push(f); } };
  const ctx: ToolContext = {
    ...context,
    followups: context.followups || sink,
  };

  // Resolve the tool set once — stable JSON schemas for every native step
  // (derived from the registry's zod schemas, single source of truth).
  // I1 (toolsets): when the caller did not explicitly pick tools, gate the
  // schema to ENABLED toolsets only — the model never sees a disabled tool
  // (Hermes capability-gating parity). Explicit toolNames win (caller intent).
  const schemas: ToolJsonSchema[] = toolNames ? toolJsonSchemas(toolNames) : effectiveToolJsonSchemas(context.configManager);

  const thread: ToolMessage[] = [...messages];
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
    steps += 1;
    let response: StepResponse;
    try {
      response = await deps.callModel(thread, schemas);
    } catch (err) {
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
    // essay (the "where is the essay?" bug).
    if (response.content.trim() && response.content.length >= lastContent.length) {
      lastContent = response.content;
    }
    const { toolCalls } = response;

    if (toolCalls.length === 0) {
      // No tools → end turn UNLESS the content is think-only (Freebuff
      // isThinkOnlyResponse: continue instead of ending).
      if (deps.isThinkOnly ? deps.isThinkOnly(response.content) : isThinkOnlyResponse(response.content)) {
        // Feed an empty assistant step so the model continues in-context.
        thread.push({ role: 'assistant', content: response.content });
        deps.onEvent?.('   🧠 model reasoning… (continuing)');
        continue;
      }
      return {
        content: response.content,
        followups,
        toolCalls: toolCallsRun,
        steps,
        bounded: false,
      };
    }

    // ── Execute tool calls (Freebuff: results fed back, next step) ──────
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
      if (!tool) {
        // Unknown tool — the error is fed back so the model retries with a
        // known tool (Freebuff hadToolCallError parity).
        resultText = `Error: unknown tool "${call.name}". Available tools: ${schemas.map((s) => s.name).join(', ')}.`;
      } else if (!isToolEnabled(call.name, context.configManager)) {
        // I1 execution gate: a disabled tool is rejected at runtime even if
        // the model hallucinated its name — the toggle is never cosmetic.
        resultText = `Error: tool "${call.name}" is disabled — its toolset is turned off. Enable it with \`buff tools toolsets\`.`;
      } else {
        // I2: emit `tool:started` (before execution) + `tool:called` (after)
        // on the observability bus — drives the hooks registry's
        // `post_tool_call` hook (Hermes hooks.py parity) AND the dashboard's
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
          // recorded on the session (Hermes run.py parity) and only `result`
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

    // End-of-response semantics (Freebuff contract: "END EVERY RESPONSE by
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
