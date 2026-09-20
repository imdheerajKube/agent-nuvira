/**
 * Native tool-calling wire mapping (`src/inference/native-tools.ts`) —
 * AGENTIC_CAPABILITY_ASSESSMENT Addendum v4 Phase 1.2 (the BLOCKING item).
 *
 * The loop engine (`runToolLoop`) speaks the OpenAI `ToolMessage`/`ToolSchema`
 * shape. Groq/OpenRouter/OpenAI-compat/NIM ride the shared
 * `chatCompletionsWithTools` helper (tools.ts). Gemini and Anthropic do NOT
 * speak that protocol — the assessment found them at "0 generateTools matches,
 * JSON-fallback only" and marked adapter parity as BLOCKING for loop-default,
 * because prompt-parsed JSON tool calls are flakiest on exactly the models
 * users route to.
 *
 * This module carries the two non-OpenAI wire mappings, so each adapter's
 * `generateTools`/`generateToolsStream` is a thin fetch around tested
 * translation code:
 *
 *   Gemini (v1beta generateContent):
 *     system      → systemInstruction.parts[].text
 *     user        → role "user", parts[{text}]
 *     assistant   → role "model", parts[{text}?, {functionCall:{name,args}}…]
 *     tool result → role "user", parts[{functionResponse:{name,response}}]
 *     tools       → tools[{functionDeclarations:[…]}]  (OpenAPI subset schema)
 *
 *   Anthropic (v1/messages):
 *     system        → top-level `system` string (concatenated)
 *     user          → messages[{role:"user", content}]
 *     assistant+tc  → content blocks: [{type:"text"}?, {type:"tool_use", id, name, input}…]
 *     tool result   → user message with {type:"tool_result", tool_use_id, content}
 *                     (consecutive tool messages merge into ONE user message —
 *                     Anthropic requires tool_result blocks to live in the
 *                     message immediately following the tool_use)
 *     tools         → tools[{name, description, input_schema}]
 *
 * Correctness rules shared by both mappings:
 * - Assistant tool_calls carry `arguments` as a JSON STRING (OpenAI wire
 *   convention); both mappings parse it defensively — a malformed argument
 *   string degrades to `{}` instead of throwing (the model retries in-loop).
 * - Tool results keep their identity: Gemini keys functionResponse by tool
 *   NAME (recovered from the assistant toolCalls entry with the matching id),
 *   Anthropic by tool_use_id directly.
 * - Synthetic tool-call ids (`call_1`…) are generated for Gemini, which has
 *   no id concept — they only need internal consistency within one thread.
 */
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
/** Parse an OpenAI-wire arguments JSON string → object ({} on any failure). */
export declare function parseToolArguments(argumentsJson: string | undefined): Record<string, unknown>;
/** Gemini function declaration (OpenAPI-schema subset, camelCase keys). */
interface GeminiFunctionDeclaration {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
}
interface GeminiPart {
    text?: string;
    functionCall?: {
        name: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        name: string;
        response: Record<string, unknown>;
    };
    /**
     * Returned by Gemini alongside a functionCall part and REQUIRED on the way
     * back when the loop continues the conversation. Opaque to us — we only
     * carry it.
     */
    thoughtSignature?: string;
}
export interface GeminiContent {
    role: 'user' | 'model';
    parts: GeminiPart[];
}
/**
 * Strip JSON-Schema keywords Gemini's function-declaration validation rejects
 * ($schema, additionalProperties, default, examples, exclusiveMinimum/Maximum,
 * oneOf/anyOf/allOf/not — Gemini 1.x 400s on these) and flatten union types
 * (`type: ["string","null"]` → `type: "string", nullable: true`). The OpenAPI
 * subset Gemini accepts: type, description, enum, format, items, properties,
 * required, nullable, minItems/maxItems, minLength/maxLength, minimum/maximum,
 * pattern, title, readOnly, ignore.
 */
export declare function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined;
/** ToolSchema[] → Gemini `tools` request entry. */
export declare function toGeminiFunctionDeclarations(tools: ToolSchema[]): Array<{
    functionDeclarations: GeminiFunctionDeclaration[];
}>;
/**
 * ToolMessage[] → Gemini `contents` + `systemInstruction`.
 * Consecutive tool-result messages become one "user" content with one
 * functionResponse part each (the loop pushes them individually, but a
 * parallel-capable caller may batch them).
 */
export declare function toGeminiContents(messages: ToolMessage[]): {
    systemInstruction?: {
        parts: Array<{
            text: string;
        }>;
    };
    contents: GeminiContent[];
};
/** Non-stream Gemini generateContent response shape (tool-call aware). */
export interface GeminiToolResponse {
    candidates?: Array<{
        content?: {
            parts?: Array<{
                text?: string;
                functionCall?: {
                    name: string;
                    args?: Record<string, unknown>;
                };
                thoughtSignature?: string;
            }>;
        };
        finishReason?: string;
    }>;
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
    };
}
/** Parse a Gemini response body → the loop's ToolCallResponse. */
export declare function parseGeminiToolResponse(data: GeminiToolResponse): ToolCallResponse;
/**
 * Extract the text deltas from ONE Gemini SSE chunk (streamGenerateContent
 * alt=sse): text parts stream to the caller immediately, functionCall parts
 * accumulate. Returns null for non-data/[DONE]/unparseable lines.
 */
export declare function parseGeminiToolSSEChunk(line: string): {
    text: string | null;
    functionCalls: Array<{
        name: string;
        args?: Record<string, unknown>;
        thoughtSignature?: string;
    }>;
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
    };
} | null;
/** Anthropic content blocks used by tool calling. */
export type AnthropicBlock = {
    type: 'text';
    text: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, unknown>;
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: string;
};
export interface AnthropicRequestMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicBlock[];
}
/**
 * ToolMessage[] → Anthropic `system` + `messages`.
 * Consecutive tool results merge into ONE user message (tool_result blocks
 * must immediately follow the tool_use they answer). Empty text is skipped;
 * an assistant message with only toolCalls sends tool_use blocks with no
 * text block (Anthropic accepts content arrays with tool_use only).
 */
export declare function toAnthropicMessages(messages: ToolMessage[]): {
    system: string | undefined;
    messages: AnthropicRequestMessage[];
};
/** ToolSchema[] → Anthropic `tools` request entry. */
export declare function toAnthropicToolDefs(tools: ToolSchema[]): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}>;
/** Non-stream Anthropic Messages response shape (tool-call aware). */
export interface AnthropicToolResponse {
    content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
    }>;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}
/** Parse an Anthropic Messages response body → the loop's ToolCallResponse. */
export declare function parseAnthropicToolResponse(data: AnthropicToolResponse): ToolCallResponse;
/**
 * Streaming state machine for Anthropic's event stream with tools.
 * Feed every `data: {…}` SSE line; text deltas arrive via the returned
 * `text` (deliver to onToken), tool_use blocks accumulate from
 * content_block_start (id/name) + input_json_delta fragments and are
 * finalized at message_stop via `finalize()`.
 */
export declare class AnthropicToolStreamAccumulator {
    private blocks;
    private usage?;
    private stopped;
    /** Consume one parsed SSE event object. Returns text deltas to stream (or null). */
    consume(event: {
        type?: string;
        index?: number;
        content_block?: {
            type?: string;
            text?: string;
            id?: string;
            name?: string;
        };
        delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
        };
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
        };
    }): string | null;
    /** Whether message_stop arrived (the stream is complete). */
    get isStopped(): boolean;
    /** Wire-usage captured from message_delta (undefined when the stream carried none). */
    get streamUsage(): {
        promptTokens?: number;
        completionTokens?: number;
    } | undefined;
    /** Finalize → the loop's ToolCallResponse (text joined, tool_use inputs parsed). */
    finalize(): ToolCallResponse;
}
export {};
//# sourceMappingURL=native-tools.d.ts.map