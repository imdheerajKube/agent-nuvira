/**
 * H1 — Shared OpenAI-format tool-calling helper (`src/inference/tools.ts`).
 *
 * Every OpenAI-compatible adapter (openai-compat, groq, openrouter, nim)
 * speaks the same `/chat/completions` `tools`/`tool_calls` protocol — one
 * helper, four adapters (H1 acceptance: "for providers with native
 * tool-calling, pass tools to the request, parse tool_calls"). The same
 * helper rejects unknown tools structurally (the API 400s) and returns
 * parsed tool calls with `arguments` as an object (never a string).
 */
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
/** OpenAI wire form of a tool call (arguments as a JSON string). */
interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
interface WireResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
            tool_calls?: WireToolCall[];
        };
    }>;
}
/**
 * Build the wire `messages` array: assistant messages carry `tool_calls`,
 * tool messages carry `tool_call_id`.
 */
export declare function buildWireMessages(messages: ToolMessage[]): Array<Record<string, unknown>>;
/** Parse the wire response into ToolCallResponse (arguments as objects). */
export declare function parseToolCallResponse(data: WireResponse): ToolCallResponse;
/**
 * POST /chat/completions with `tools` and parse the tool_calls response.
 * Throws the provider-style error (status in the message) so shared
 * failover/classification works unchanged.
 */
export declare function chatCompletionsWithTools(opts: {
    /**
     * Base URL — the helper appends `/chat/completions`. Providers with a
     * non-standard path (Azure deployments) pass `url` instead.
     */
    baseUrl: string;
    /** Explicit full endpoint URL — wins over baseUrl (Azure deployments). */
    url?: string;
    headers: Record<string, string>;
    model: string;
    messages: ToolMessage[];
    tools: ToolSchema[];
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    /**
     * P4 — external cancellation: when present, the request aborts on signal
     * (the dashboard's Cancel button). Absent → AbortSignal.timeout applies.
     */
    signal?: AbortSignal;
    /**
     * Cost-recording hook (quota ledger / cost tracker parity with generate()):
     * invoked with the flattened prompt + response content after a successful
     * call so adapters record wire-metered (or estimated) cost exactly like
     * their non-tool path. Absent → no recording. The third arg carries the
     * endpoint-reported usage when the streaming path captured it (M2.2).
     */
    onCost?: (promptText: string, contentText: string, usage?: {
        promptTokens?: number;
        completionTokens?: number;
    }) => void;
}): Promise<ToolCallResponse>;
/**
 * Streamed twin of chatCompletionsWithTools: POST with `stream: true` and
 * deliver content tokens to onToken as they arrive. Returns the same
 * ToolCallResponse shape as the non-streaming helper (tool_calls accumulated
 * from per-index fragments, arguments JSON-parsed). Best-effort measured
 * usage is captured from the final chunk (stream_options.include_usage).
 */
export declare function chatCompletionsWithToolsStream(opts: Parameters<typeof chatCompletionsWithTools>[0], onToken: (token: string) => void): Promise<ToolCallResponse>;
export {};
//# sourceMappingURL=tools.d.ts.map