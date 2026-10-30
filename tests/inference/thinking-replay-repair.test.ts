/**
 * The reasoning-replay REPAIR — one retry instead of 3-5 wasted model calls.
 *
 * MEASURED 2026-10-29. Every bench turn against `deepseek-flash` logged 4-5
 * rejections, each with a different request_id (`400 The reasoning_content in the
 * thinking mode must be passed back to the API`), and the turn only continued
 * because a mid-turn continuation retried. Two live requests against
 * `api.deepseek.com` decided why:
 *
 *   · a tool-call assistant turn with NO reasoning_content, in a thread where NO
 *     turn carries reasoning → 400
 *   · the same thread with reasoning on that one turn                → 200
 *
 * So the endpoint's rule is about the REQUEST (a thinking model with tools), not
 * about the thread's own evidence — which is exactly what the old invariant read.
 * A thread that lost its reasoning to trimming or a continuation looked clean to
 * the harness and invalid to the endpoint, forever.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletionsWithTools, chatCompletionsWithToolsStream } from '../../src/inference/tools.js';
import { applyThinkingReplayInvariant, isReasoningReplayRejection, REASONING_NOT_RETAINED } from '../../src/inference/thinking-replay.js';
import type { ToolMessage, ToolSchema } from '../../src/inference/interface.js';

const TOOLS: ToolSchema[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];

/** The measured failing thread: a tool-call turn with no reasoning anywhere. */
const THREAD: ToolMessage[] = [
  { role: 'user', content: 'read notes.txt' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"notes.txt"}' }],
  },
  { role: 'tool', toolCallId: 'c1', content: 'hello' },
];

const OK_BODY = {
  choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
};

/** The provider's own rejection, verbatim from the live request. */
function rejection(status = 400): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () =>
      '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 0506cdda)"}}',
  } as unknown as Response;
}

function okResponse(body: unknown = OK_BODY): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function sse(...lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' } as unknown as Response;
}

/** The `messages` array of the Nth fetch call. */
function sentMessages(fetchMock: ReturnType<typeof vi.fn>, call: number): Array<Record<string, unknown>> {
  const init = fetchMock.mock.calls[call][1] as { body: string };
  return (JSON.parse(init.body) as { messages: Array<Record<string, unknown>> }).messages;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isReasoningReplayRejection', () => {
  it('recognizes the endpoint enforcing the rule, in the endpoint’s words', () => {
    expect(
      isReasoningReplayRejection(
        400,
        '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}',
      ),
    ).toBe(true);
    // Gateways relay the same sentence with their own code for an invalid body.
    expect(isReasoningReplayRejection(422, 'reasoning_content must be passed back')).toBe(true);
  });

  it('stays quiet for every other failure', () => {
    expect(isReasoningReplayRejection(400, '{"error":{"message":"unknown tool: nope"}}')).toBe(false);
    expect(isReasoningReplayRejection(401, 'reasoning_content must be passed back')).toBe(false);
    expect(isReasoningReplayRejection(429, 'rate limited')).toBe(false);
  });
});

describe('applyThinkingReplayInvariant — force', () => {
  it('fills a thread with no reasoning at all only when the endpoint has said so', () => {
    // Without `force` the thread looks like a non-thinking conversation, and the
    // invariant correctly leaves it untouched.
    expect(applyThinkingReplayInvariant(THREAD).filled).toBe(0);
    const forced = applyThinkingReplayInvariant(THREAD, { force: true });
    expect(forced.filled).toBe(1);
    expect(forced.messages[1]).toMatchObject({ reasoningContent: REASONING_NOT_RETAINED });
  });
});

describe('chatCompletionsWithTools — one repair, not a retry storm', () => {
  it('re-sends the same request with the gap filled, and reports that it did', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rejection()).mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatCompletionsWithTools({
      baseUrl: 'https://example.test',
      headers: {},
      model: 'deepseek-flash',
      messages: THREAD,
      tools: TOOLS,
    });

    expect(result.content).toBe('done');
    expect(result.repairedReasoningTurns).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry is the SAME conversation plus the placeholder — nothing else moves,
    // so the prompt cache for the unchanged turns still hits.
    expect(sentMessages(fetchMock, 0)[1]).not.toHaveProperty('reasoning_content');
    expect(sentMessages(fetchMock, 1)[1]).toMatchObject({ reasoning_content: REASONING_NOT_RETAINED });
  });

  it('does not retry a 400 that is not about reasoning replay', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => '{"error":{"message":"unknown tool: nope"}}',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionsWithTools({ baseUrl: 'https://example.test', headers: {}, model: 'm', messages: THREAD, tools: TOOLS }),
    ).rejects.toThrow(/Tool-calling API error \(400\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the failure when the repair does not help', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rejection()).mockResolvedValueOnce(rejection());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      chatCompletionsWithTools({ baseUrl: 'https://example.test', headers: {}, model: 'm', messages: THREAD, tools: TOOLS }),
    ).rejects.toThrow(/reasoning_content/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('chatCompletionsWithToolsStream — the same repair on the streaming path', () => {
  it('repairs and streams instead of failing the turn', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(rejection()).mockResolvedValueOnce(
      sse(
        'data: {"choices":[{"delta":{"content":"done"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens: string[] = [];
    const result = await chatCompletionsWithToolsStream(
      { baseUrl: 'https://example.test', headers: {}, model: 'deepseek-flash', messages: THREAD, tools: TOOLS },
      (t) => tokens.push(t),
    );

    expect(tokens).toEqual(['done']);
    expect(result.repairedReasoningTurns).toBe(1);
    expect(sentMessages(fetchMock, 1)[1]).toMatchObject({ reasoning_content: REASONING_NOT_RETAINED });
  });
});
