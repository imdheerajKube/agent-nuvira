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
import { attachHttpContext } from './http-error.js';
import { parseSSELine } from './sse.js';
/**
 * Build the wire `messages` array: assistant messages carry `tool_calls`,
 * tool messages carry `tool_call_id`.
 */
export function buildWireMessages(messages) {
    return messages.map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
            return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                })),
            };
        }
        if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        }
        return { role: m.role, content: m.content };
    });
}
/** Parse the wire response into ToolCallResponse (arguments as objects). */
export function parseToolCallResponse(data) {
    const message = data.choices?.[0]?.message;
    const content = message?.content || '';
    const toolCalls = [];
    for (const tc of message?.tool_calls || []) {
        let args = {};
        try {
            args = JSON.parse(tc.function.arguments || '{}');
        }
        catch {
            args = {};
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
    }
    return { content, toolCalls };
}
/**
 * POST /chat/completions with `tools` and parse the tool_calls response.
 * Throws the provider-style error (status in the message) so shared
 * failover/classification works unchanged.
 */
export async function chatCompletionsWithTools(opts) {
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 4096;
    const url = opts.url || `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify({
            model: opts.model,
            messages: buildWireMessages(opts.messages),
            temperature,
            max_tokens: maxTokens,
            tools: opts.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
        }),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
        const errorBody = await response.text();
        // Headers attached so extractRetryAfterMs() can read Retry-After /
        // x-ratelimit-reset-* and park for the provider's ACTUAL reset time.
        throw attachHttpContext(new Error(`Tool-calling API error (${response.status}): ${errorBody}`), response.status, response.headers);
    }
    const result = parseToolCallResponse((await response.json()));
    if (opts.onCost) {
        try {
            opts.onCost(opts.messages.map((m) => m.content).filter(Boolean).join('\n'), result.content);
        }
        catch {
            // Cost recording must never break the tool call.
        }
    }
    return result;
}
/**
 * Parse the tool_calls delta from an SSE line, or null when the line carries
 * none (non-data lines, [DONE], content-only chunks).
 */
function parseSSEToolCallDeltas(line) {
    if (!line.startsWith('data: '))
        return null;
    const data = line.slice(6).trim();
    if (data === '[DONE]')
        return null;
    try {
        const parsed = JSON.parse(data);
        return parsed?.choices?.[0]?.delta?.tool_calls ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Streamed twin of chatCompletionsWithTools: POST with `stream: true` and
 * deliver content tokens to onToken as they arrive. Returns the same
 * ToolCallResponse shape as the non-streaming helper (tool_calls accumulated
 * from per-index fragments, arguments JSON-parsed). Best-effort measured
 * usage is captured from the final chunk (stream_options.include_usage).
 */
export async function chatCompletionsWithToolsStream(opts, onToken) {
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 4096;
    const url = opts.url || `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        body: JSON.stringify({
            model: opts.model,
            messages: buildWireMessages(opts.messages),
            temperature,
            max_tokens: maxTokens,
            tools: opts.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            stream: true,
            // OpenAI convention for measured usage in the final chunk (Groq and
            // OpenRouter support it; providers that ignore it just omit usage).
            stream_options: { include_usage: true },
        }),
        // P4 — external cancellation (the dashboard Cancel button). The streaming
        // path historically had no timeout; an explicit signal is the ONLY way to
        // stop it mid-stream.
        signal: opts.signal,
    });
    if (!response.ok) {
        const errorBody = await response.text();
        // Same attachHttpContext treatment as the non-streaming helper so shared
        // failover/classification (Retry-After / x-ratelimit-reset) works.
        throw attachHttpContext(new Error(`Tool-calling streaming API error (${response.status}): ${errorBody}`), response.status, response.headers);
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('Response body is not readable');
    const decoder = new TextDecoder();
    const contentParts = [];
    const toolCalls = [];
    let buffer = '';
    // M2.2: capture the endpoint-reported usage from the final chunk
    // (stream_options.include_usage convention) so onCost records MEASURED cost
    // instead of a length-based estimate — the generateStream parity pattern.
    let streamUsage;
    /** Process one complete SSE line (content delta → onToken; tool_calls → accumulate). */
    const handleLine = (trimmed) => {
        const token = parseSSELine(trimmed);
        if (token) {
            contentParts.push(token);
            onToken(token);
        }
        const deltas = parseSSEToolCallDeltas(trimmed);
        if (deltas) {
            for (const d of deltas) {
                const acc = (toolCalls[d.index] ??= { id: '', name: '', argumentsRaw: '' });
                if (d.id)
                    acc.id = d.id;
                if (d.function?.name)
                    acc.name = d.function.name;
                if (d.function?.arguments)
                    acc.argumentsRaw += d.function.arguments;
            }
        }
        if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6).trim();
            if (data !== '[DONE]') {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed?.usage &&
                        typeof parsed.usage.prompt_tokens === 'number' &&
                        typeof parsed.usage.completion_tokens === 'number') {
                        streamUsage = {
                            promptTokens: parsed.usage.prompt_tokens,
                            completionTokens: parsed.usage.completion_tokens,
                        };
                    }
                }
                catch {
                    // Non-JSON data lines are ignored.
                }
            }
        }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed)
                    handleLine(trimmed);
            }
        }
        const remaining = buffer.trim();
        if (remaining)
            handleLine(remaining);
    }
    finally {
        reader.releaseLock();
    }
    const parsedCalls = [];
    for (const acc of toolCalls) {
        let args = {};
        try {
            args = JSON.parse(acc.argumentsRaw || '{}');
        }
        catch {
            args = {};
        }
        parsedCalls.push({ id: acc.id, name: acc.name, arguments: args });
    }
    const content = contentParts.join('');
    if (opts.onCost) {
        try {
            opts.onCost(opts.messages.map((m) => m.content).filter(Boolean).join('\n'), content, streamUsage);
        }
        catch {
            // Cost recording must never break the stream.
        }
    }
    return { content, toolCalls: parsedCalls };
}
//# sourceMappingURL=tools.js.map