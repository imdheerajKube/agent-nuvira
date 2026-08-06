/**
 * Shared SSE streaming utilities for OpenAI-compatible APIs.
 * Used by Groq, NIM, and any future OpenAI-compatible adapters.
 */
/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns the content delta or null for non-content events (e.g., [DONE], usage info).
 */
export declare function parseSSELine(line: string): string | null;
/** Measured token usage reported by an OpenAI-compatible endpoint. */
export interface UsageInfo {
    promptTokens: number;
    completionTokens: number;
}
/**
 * Perform a streaming chat completion request for an OpenAI-compatible API.
 *
 * @param url - The full URL for the chat completions endpoint
 * @param headers - HTTP headers (including Authorization)
 * @param body - The JSON request body (stream: true will be added automatically)
 * @param onToken - Callback for each content token as it arrives
 * @param onUsage - Optional callback for the endpoint-reported token usage
 *   (M2.2 wire-token metering): some endpoints emit a final data chunk carrying
 *   a `usage` object (OpenAI stream_options.include_usage convention) — when
 *   present it is forwarded so adapters can record MEASURED cost instead of
 *   length-based estimates.
 * @returns The full concatenated response text
 */
export declare function streamCompletion(url: string, headers: Record<string, string>, body: Record<string, unknown>, onToken: (token: string) => void, onUsage?: (usage: UsageInfo) => void): Promise<string>;
//# sourceMappingURL=sse.d.ts.map