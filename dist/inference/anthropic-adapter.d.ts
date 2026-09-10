/**
 * AnthropicAdapter — native Anthropic Messages API adapter (Issue 001).
 *
 * Anthropic does NOT speak the OpenAI /v1/chat/completions protocol, so it
 * gets a small native adapter instead of the shared OpenAICompatAdapter:
 *
 *   POST https://api.anthropic.com/v1/messages
 *     headers: x-api-key, anthropic-version: 2023-06-01, content-type
 *     body:    { model, max_tokens, system?, messages: [{role, content}] }
 *
 * Streaming uses Anthropic's event-stream protocol (content_block_delta →
 * text_delta). Wire-token usage comes from the final message_delta event
 * (M2.2 measured cost) and input_tokens/output_tokens on non-stream responses.
 *
 * Error mapping keeps the shared classification contract (the message text is
 * what classifyFallbackError buckets): 401/403→auth, 429→rate-limit,
 * 5xx→server, fetch→network, abort→timeout.
 */
import { InferenceProvider, ModelDescriptor } from './interface.js';
import type { ToolCallResponse, ToolMessage, ToolSchema } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
export declare class AnthropicAdapter implements InferenceProvider {
    readonly name = "Anthropic";
    private config;
    private baseUrl;
    constructor(config: ProviderConfig);
    private headers;
    generate(prompt: string, options?: InferenceOptions): Promise<string>;
    generateStream(prompt: string, options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<string>;
    generateTools(messages: ToolMessage[], tools: ToolSchema[], options?: InferenceOptions): Promise<ToolCallResponse>;
    /**
     * P4/Phase 1.2 — streaming native tool-calling: same protocol with
     * `stream: true`; text deltas stream to onToken, tool_use blocks
     * accumulate from content_block_start + input_json_delta fragments via
     * the shared accumulator and finalize at message_stop.
     */
    generateToolsStream(messages: ToolMessage[], tools: ToolSchema[], options: InferenceOptions | undefined, onToken: (token: string) => void): Promise<ToolCallResponse>;
    isAvailable(): Promise<boolean>;
    getInfo(): string;
    listModels(): Promise<ModelDescriptor[]>;
}
//# sourceMappingURL=anthropic-adapter.d.ts.map