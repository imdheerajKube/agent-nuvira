/**
 * A stream that goes silent must fail, not hang the turn.
 *
 * WHY (measured 2026-10-25). A benchmark turn streamed 41 tool calls and then
 * stopped: no output, no socket, no child process, until the 25-minute harness cap
 * killed it. `fetch` carried no signal and `reader.read()` had no timeout, so a
 * connection dropped mid-response parked the agent forever — and nothing in the
 * logs said so until the process was killed.
 *
 * The fix is an IDLE budget, re-armed on every chunk (a slow model may legitimately
 * stream for minutes; a total-duration cap would abort a healthy answer). These
 * tests pin the two halves that matter: the stall is reported as a `timeout` (the
 * class the failover retries) and a healthy stream is untouched.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, streamCompletion, streamIdleTimeoutMs } from '../../src/inference/sse.js';

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.NUVIRA_STREAM_IDLE_TIMEOUT_MS = '60';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NUVIRA_STREAM_IDLE_TIMEOUT_MS;
  globalThis.fetch = realFetch;
});

/** An SSE body that sends `chunks` and then NEVER closes — the dropped connection. */
function stallingFetch(chunks: string[]): void {
  vi.stubGlobal('fetch', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // Deliberately no controller.close(): the connection died mid-response.
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const sse = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

describe('streamCompletion idle guard', () => {
  it('fails a stalled stream as a timeout instead of waiting forever', async () => {
    stallingFetch([sse('partial')]);
    const tokens: string[] = [];
    await expect(
      streamCompletion('http://x/chat', {}, { model: 'm' }, (t) => tokens.push(t)),
    ).rejects.toThrow(/stream timeout: no data for 60 ms/);
    // What did arrive was delivered — the guard does not discard a partial answer.
    expect(tokens).toEqual(['partial']);
  });

  it('leaves a healthy stream alone, however many chunks it sends', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse('hello ')));
          setTimeout(() => {
            // Two more chunks a few ms apart, then a clean close.
            controller.enqueue(encoder.encode(sse('world')));
            controller.close();
          }, 5);
        },
      });
      return new Response(body, { status: 200 });
    });

    const tokens: string[] = [];
    const text = await streamCompletion('http://x/chat', {}, { model: 'm' }, (t) => tokens.push(t));
    expect(text).toBe('hello world');
    expect(tokens).toEqual(['hello ', 'world']);
  });

  it('reports a non-stall failure unchanged', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(streamCompletion('http://x/chat', {}, { model: 'm' }, () => {})).rejects.toThrow(/API error \(500\)/);
  });
});

describe('streamIdleTimeoutMs', () => {
  it('reads the dial, and defaults to two minutes', () => {
    expect(streamIdleTimeoutMs()).toBe(60);
    delete process.env.NUVIRA_STREAM_IDLE_TIMEOUT_MS;
    expect(streamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
    process.env.NUVIRA_STREAM_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(streamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  });
});
