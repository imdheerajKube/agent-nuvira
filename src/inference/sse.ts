/**
 * Shared SSE streaming utilities for OpenAI-compatible APIs.
 * Used by Groq, NIM, and any future OpenAI-compatible adapters.
 */

/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns the content delta or null for non-content events (e.g., [DONE], usage info).
 */
export function parseSSELine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed?.choices?.[0]?.delta?.content || null;
  } catch {
    return null;
  }
}

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
export async function streamCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
  onUsage?: (usage: UsageInfo) => void,
): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  const fullContent: string[] = [];
  let buffer = '';

  // M2.2: capture the endpoint-reported usage from any data chunk that carries
  // it (final chunk before [DONE] in the OpenAI include_usage convention).
  const captureUsage = (trimmed: string): void => {
    if (!onUsage || !trimmed.startsWith('data: ')) return;
    const data = trimmed.slice(6).trim();
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (
        parsed?.usage &&
        typeof parsed.usage.prompt_tokens === 'number' &&
        typeof parsed.usage.completion_tokens === 'number'
      ) {
        onUsage({
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
        });
      }
    } catch {
      // Non-JSON data lines are ignored.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines from the buffer
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const token = parseSSELine(trimmed);
        if (token) {
          fullContent.push(token);
          onToken(token);
        }
        captureUsage(trimmed);
      }
    }

    // Process remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      const token = parseSSELine(remaining);
      if (token) {
        fullContent.push(token);
        onToken(token);
      }
      captureUsage(remaining);
    }
  } finally {
    reader.releaseLock();
  }

  return fullContent.join('');
}
