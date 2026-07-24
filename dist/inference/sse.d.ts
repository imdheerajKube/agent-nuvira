/**
 * Shared SSE streaming utilities for OpenAI-compatible APIs.
 * Used by Groq, NIM, and any future OpenAI-compatible adapters.
 */
/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns the content delta or null for non-content events (e.g., [DONE], usage info).
 */
export declare function parseSSELine(line: string): string | null;
/**
 * Perform a streaming chat completion request for an OpenAI-compatible API.
 *
 * @param url - The full URL for the chat completions endpoint
 * @param headers - HTTP headers (including Authorization)
 * @param body - The JSON request body (stream: true will be added automatically)
 * @param onToken - Callback for each content token as it arrives
 * @returns The full concatenated response text
 */
export declare function streamCompletion(url: string, headers: Record<string, string>, body: Record<string, unknown>, onToken: (token: string) => void): Promise<string>;
//# sourceMappingURL=sse.d.ts.map