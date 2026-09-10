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
import { type FollowupSuggestion, type ToolContext, type ToolJsonSchema } from './registry.js';
import type { ToolMessage } from '../inference/interface.js';
export { type ToolMessage };
/**
 * The P3c fallback hint for a failed tool call — appended to the error text
 * the model sees. Returns null when the tool has no hint (advisory only; the
 * model still decides). Falls back ONLY on error/denial, never on success.
 */
export declare function fallbackHintForTool(tool: string, resultText: string): string | null;
/**
 * Should a parallel-delegate suggestion fire now? Tracks per-turn successful
 * independent calls; fires once after the 2nd independent success (then stays
 * quiet — one suggestion per turn is enough, the model decides whether to use
 * it). Pure + deterministic (no LLM).
 */
export declare function makeParallelSuggester(initialCounts?: Record<string, number>): {
    /** Record a successful independent tool call. Returns the suggestion or null. */
    note(tool: string, ok: boolean): string | null;
    /** Whether the suggestion already fired this turn. */
    readonly hasFired: boolean;
};
/** A step response — either a native tool-call response or parsed fallback. */
export interface StepResponse {
    content: string;
    /** Parsed tool calls (empty = end turn). */
    toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
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
    callModel(messages: ToolMessage[], toolSchemas: ToolJsonSchema[], onToken?: (token: string) => void, signal?: AbortSignal): Promise<StepResponse>;
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
export declare function isThinkOnlyResponse(content: string): boolean;
/**
 * Extract JSON fallback tool calls from model text:
 * `{"tool":"name","arguments":{...}}` blocks, possibly fenced or multiple.
 * Uses brace-matching (string-aware) so nested argument objects parse
 * correctly. Returns the cleaned content (blocks stripped) + parsed calls.
 */
export declare function extractFallbackToolCalls(content: string): {
    text: string;
    calls: StepResponse['toolCalls'];
};
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
export declare function isBareAcknowledgment(content: string): boolean;
/**
 * Run one tool-call turn:
 * generate → execute tools → feed results back → repeat until the model
 * returns a no-tools response (end turn), bounded by maxSteps.
 */
export declare function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult>;
/** Default thread budget in characters (~50K tokens at 4 chars/token). */
export declare const DEFAULT_THREAD_BUDGET_CHARS = 200000;
/**
 * Deterministically trim a thread to `maxChars`:
 * 1. Never touch the system prompt or the FIRST user message (the ask).
 * 2. Never touch the last `RECENT_KEEP` messages (recent context).
 * 3. Oldest-first: tool results longer than 500 chars collapse to the stub;
 *    if still over budget, remaining old tool results collapse entirely.
 * Returns a NEW array (input untouched) + how many messages were trimmed.
 */
export declare function trimThreadBudget(thread: ToolMessage[], maxChars?: number): {
    thread: ToolMessage[];
    trimmed: number;
};
//# sourceMappingURL=tool-loop.d.ts.map