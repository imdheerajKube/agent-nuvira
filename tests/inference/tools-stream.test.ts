/**
 * P4 — streaming tool-calling helper tests (`chatCompletionsWithToolsStream`).
 *
 * Drives the shared OpenAI-protocol streaming helper with a mocked fetch
 * returning SSE chunks (content deltas + per-index tool_calls fragments +
 * final usage chunk — the OpenAI stream_options.include_usage convention).
 * Verifies: tokens delivered to onToken in order, tool_calls accumulated from
 * fragments and JSON-parsed, measured usage forwarded to onCost, and the
 * pure-answer case (no tool calls).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletionsWithToolsStream } from '../../src/inference/tools.js';
import type { ToolCallResponse, ToolMessage, ToolSchema } from '../../src/inference/interface.js';

const MESSAGES: ToolMessage[] = [{ role: 'user', content: 'read src/a.ts' }];
const TOOLS: ToolSchema[] = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

/** Wrap SSE data lines into a Response with a readable body. */
function sseResponse(...lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatCompletionsWithToolsStream', () => {
  it('delivers content tokens live and returns the concatenated answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"role":"assistant","content":"Here "}}]}',
          'data: {"choices":[{"delta":{"content":"is the "}}]}',
          'data: {"choices":[{"delta":{"content":"answer."}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ),
      ),
    );

    const tokens: string[] = [];
    const result = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS },
      (t) => tokens.push(t),
    );

    expect(tokens).toEqual(['Here ', 'is the ', 'answer.']);
    expect(result.content).toBe('Here is the answer.');
    expect(result.toolCalls).toEqual([]);
    // The request carried stream: true + include_usage.
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as { stream?: boolean; stream_options?: { include_usage?: boolean } };
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('accumulates tool_calls from per-index fragments and parses arguments JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"role":"assistant","content":"Reading the file.","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/a.ts\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ),
      ),
    );

    const tokens: string[] = [];
    const result: ToolCallResponse = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS },
      (t) => tokens.push(t),
    );

    expect(result.content).toBe('Reading the file.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'read_file' });
    expect(result.toolCalls[0].arguments).toEqual({ path: 'src/a.ts' });
    expect(tokens).toEqual(['Reading the file.']);
  });

  it('forwards the endpoint-reported usage to onCost (measured cost)', async () => {
    const onCost = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}',
          'data: [DONE]',
        ),
      ),
    );

    await chatCompletionsWithToolsStream(
      {
        baseUrl: 'https://example.test/v1',
        headers: {},
        model: 'm',
        messages: MESSAGES,
        tools: TOOLS,
        onCost,
      },
      () => {},
    );

    expect(onCost).toHaveBeenCalledTimes(1);
    const [promptText, contentText, usage] = onCost.mock.calls[0] as [string, string, { promptTokens?: number; completionTokens?: number }];
    expect(promptText).toContain('read src/a.ts');
    expect(contentText).toBe('ok');
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });
});
