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
  let allParsed = true;
  const startsAt = /\(?\s*\{\s*"tool"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = startsAt.exec(cleaned)) !== null) {
    const end = findMatchingBrace(cleaned, m.index);
    if (end === -1) {
      startsAt.lastIndex = m.index + 1;
      continue;
    }
    const block = cleaned.slice(m.index, end + 1);
    try {
      const parsed = JSON.parse(block) as { tool?: string; arguments?: Record<string, unknown> };
      if (parsed.tool && typeof parsed.tool === 'string') {
        calls.push({
          id: `call_${calls.length + 1}`,
          name: parsed.tool,
          arguments: parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
        });
        cleaned = cleaned.slice(0, m.index) + cleaned.slice(end + 1);
        startsAt.lastIndex = m.index;
      } else {
        allParsed = false;
        startsAt.lastIndex = end + 1;
      }
    } catch {
      allParsed = false;
      startsAt.lastIndex = end + 1;
    }
  }
  return { text: allParsed && calls.length > 0 ? cleaned.trim() : content, calls };
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
  let steps = 0;
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

    lastContent = response.content;
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

    for (const call of toolCalls) {
      const tool = getTool(call.name);
      toolCallsRun.push(call.name);
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
        // I2: emit `tool:called` on the observability bus — drives the hooks
        // registry's `post_tool_call` hook (Hermes hooks.py parity). Timing is
        // wall-clock; `ok` mirrors the tool-result convention (Error: prefix).
        const startedAt = Date.now();
        try {
          deps.onEvent?.(`   ⚙ ${call.name}(${summarizeArgs(call.arguments)})`);
          resultText = await deps.executeTool(call.name, call.arguments, ctx);
          // I3: a tool that returns {artifact, result} gets its deliverable
          // recorded on the session (Hermes run.py parity) and only `result`
          // is fed back to the model — the JSON payload is runtime metadata.
          resultText = appendToolArtifact(resultText, ctx.artifacts);
          ctx.emit?.('tool:called', {
            tool: call.name,
            ok: !resultText.startsWith('Error:'),
            result: resultText,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          resultText = `Error: ${message}`;
          ctx.emit?.('tool:called', {
            tool: call.name,
            ok: false,
            error: message,
            durationMs: Date.now() - startedAt,
          });
        }
      }
      thread.push({ role: 'tool', toolCallId: call.id, content: resultText });
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
