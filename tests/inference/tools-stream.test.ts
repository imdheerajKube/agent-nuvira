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

  // ── The measured defect: a payload too large for one output ───────────────
  // Dashboard session `4e2b0e51…-1791349543186` (2026-10-07): 59 `write_file`
  // calls arrived with EMPTY arguments and were parsed to `{}` — so the tool ran
  // with nothing and reported "path is required", which names the wrong problem.
  // The wire now SAYS why, and reports the provider's finish_reason.
  /** One SSE data line from an object — avoids hand-escaped JSON in the cases below. */
  const line = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;
  /** A chunk carrying tool-call argument fragments for index 0. */
  const argChunk = (name: string, argumentsSoFar: string): string =>
    line({
      choices: [
        {
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: argumentsSoFar } }],
          },
        },
      ],
    });

  it('reports a TRUNCATED argument payload instead of silently emptying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          argChunk('write_file', '{"path":"doc.md","content":"# Title\n'),
          // The output cap lands mid-string: the arguments are cut off.
          line({ choices: [{ delta: {}, finish_reason: 'length' }] }),
          'data: [DONE]',
        ),
      ),
    );

    const result = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS },
      () => {},
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].argumentsError).toBe('unparseable');
    expect(result.toolCalls[0].arguments).toEqual({});
    expect(result.finishReason).toBe('length');
  });

  it('reports a call whose arguments never arrived at all as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          argChunk('write_file', ''),
          line({ choices: [{ delta: {}, finish_reason: 'length' }] }),
          'data: [DONE]',
        ),
      ),
    );

    const result = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS },
      () => {},
    );

    expect(result.toolCalls[0].argumentsError).toBe('empty');
    expect(result.finishReason).toBe('length');
  });

  it('marks nothing and reports the finish reason on a healthy call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          argChunk('read_file', '{"path":"src/a.ts"}'),
          line({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]',
        ),
      ),
    );

    const result = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS },
      () => {},
    );

    expect(result.toolCalls[0].argumentsError).toBeUndefined();
    expect(result.toolCalls[0].arguments).toEqual({ path: 'src/a.ts' });
    expect(result.finishReason).toBe('tool_calls');
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

  it('forwards the provider\'s cache-read tokens along with the usage', async () => {
    // DeepSeek reports `prompt_cache_hit_tokens` on its usage object. Dropping
    // it made a 99%-cached audit look like fresh compute in the cost ledger.
    const onCost = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: {"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_cache_hit_tokens":960}}',
          'data: [DONE]',
        ),
      ),
    );

    await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS, onCost },
      () => {},
    );

    const [, , usage] = onCost.mock.calls[0] as [string, string, { cachedPromptTokens?: number }];
    expect(usage.cachedPromptTokens).toBe(960);
  });

  it('accepts the OpenAI nested cached_tokens shape as the same figure', async () => {
    const onCost = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}',
          'data: {"usage":{"prompt_tokens":1000,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":640}}}',
          'data: [DONE]',
        ),
      ),
    );

    await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test/v1', headers: {}, model: 'm', messages: MESSAGES, tools: TOOLS, onCost },
      () => {},
    );

    const [, , usage] = onCost.mock.calls[0] as [string, string, { cachedPromptTokens?: number }];
    expect(usage.cachedPromptTokens).toBe(640);
  });

  it('streams reasoning_content to onReasoning without mixing it into the answer', async () => {
    // DeepSeek thinking models emit `delta.reasoning_content` before (and
    // alongside) the reply. The two channels must stay separate: the CLI shows
    // the former as the model's working notes and only the latter as the answer,
    // and the reasoning is still returned for the wire replay contract.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          'data: {"choices":[{"delta":{"reasoning_content":"The user wants "}}]}',
          'data: {"choices":[{"delta":{"reasoning_content":"a file read."}}]}',
          'data: {"choices":[{"delta":{"content":"Reading it now."}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ),
      ),
    );

    const reasoning: string[] = [];
    const tokens: string[] = [];
    const result = await chatCompletionsWithToolsStream(
      {
        baseUrl: 'https://example.test/v1',
        headers: {},
        model: 'm',
        messages: MESSAGES,
        tools: TOOLS,
        onReasoning: (t) => reasoning.push(t),
      },
      (t) => tokens.push(t),
    );

    expect(reasoning).toEqual(['The user wants ', 'a file read.']);
    expect(tokens).toEqual(['Reading it now.']);
    expect(result.content).toBe('Reading it now.');
    expect(result.reasoningContent).toBe('The user wants a file read.');
  });
});
