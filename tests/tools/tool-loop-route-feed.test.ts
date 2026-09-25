/**
 * The loop keeps ONE current route frame in the thread.
 *
 * Two properties matter and neither is visible from the feed module's own tests:
 * the frame is refreshed BEFORE the call (so a failover during step N is what the
 * model is told at step N+1), and it is REPLACED rather than appended (so stale
 * route claims cannot be quoted back, and the thread does not grow a frame per
 * step).
 */

import { describe, it, expect } from 'vitest';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import { ROUTE_FEED_MARKER } from '../../src/tools/loop-route-feed.js';
import type { ToolMessage } from '../../src/inference/interface.js';
import type { ServedRoute } from '../../src/inference/route-resolver.js';

/** No tools exposed — this is about the thread, not about tool execution. */
const deps = {
  executeTool: async () => 'unused',
  onEvent: () => {},
};

/** Every thread the loop sent to the model, in order. */
function captureThreads(replies: string[]): { threads: ToolMessage[][]; callModel: (t: ToolMessage[]) => Promise<{ content: string }> } {
  const threads: ToolMessage[][] = [];
  return {
    threads,
    callModel: async (thread: ToolMessage[]) => {
      threads.push(thread.map((m) => ({ ...m })));
      return { content: replies[threads.length - 1] ?? 'done' };
    },
  };
}

const routeFrames = (thread: ToolMessage[]): string[] =>
  thread
    .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(ROUTE_FEED_MARKER))
    .map((m) => String(m.content));

describe('tool loop — the route frame', () => {
  it('is injected next to the system prompt, before the first call', async () => {
    const { threads, callModel } = captureThreads(['answer']);
    const route: ServedRoute = { providerType: 'groq', model: 'openai/gpt-oss-120b' };

    await runToolLoop({
      messages: [
        { role: 'system', content: 'You are Nuvira.' },
        { role: 'user', content: 'which model are you?' },
      ],
      tools: [],
      maxSteps: 1,
      servedRoute: () => route,
      context: { configManager: {} },
      deps: { callModel, ...deps },
    });

    const frames = routeFrames(threads[0]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('openai/gpt-oss-120b');
    // Directly after the system prompt, not buried under tool output.
    expect(threads[0][1].content.startsWith(ROUTE_FEED_MARKER)).toBe(true);
  });

  it('is refreshed when the serving route changes mid-turn', async () => {
    // Step 1 answers with a tool call that runs something, step 2 answers.
    const threads: ToolMessage[][] = [];
    let route: ServedRoute = { providerType: 'groq', model: 'openai/gpt-oss-120b' };

    const callModel = async (thread: ToolMessage[]) => {
      threads.push(thread.map((m) => ({ ...m })));
      if (threads.length === 1) {
        return { content: '', toolCalls: [{ name: 'noop', arguments: '{}' }] } as never;
      }
      // The failover happens between the two model calls, exactly as it does in
      // the executor when a provider fails.
      return { content: 'answered' } as never;
    };

    // A one-shot route change on the SECOND read — the loop reads before each call.
    let reads = 0;
    const servedRoute = (): ServedRoute => {
      reads += 1;
      if (reads > 1) route = { providerType: 'local', model: 'gemma4:e4b' };
      return route;
    };

    await runToolLoop({
      messages: [
        { role: 'system', content: 'You are Nuvira.' },
        { role: 'user', content: 'do the thing' },
      ],
      tools: [],
      maxSteps: 3,
      requireVerification: false,
      servedRoute,
      context: { configManager: {} },
      deps: {
        callModel,
        executeTool: async () => 'ran',
        onEvent: () => {},
      },
    });

    // Every call saw exactly ONE frame — replaced, never accumulated.
    for (const thread of threads) {
      expect(routeFrames(thread)).toHaveLength(1);
    }
    // The first call named the original pair; the later call names the new one.
    const first = routeFrames(threads[0])[0];
    expect(first).toContain('openai/gpt-oss-120b');
    const last = routeFrames(threads[threads.length - 1])[0];
    expect(last).toContain('gemma4:e4b');
    expect(last).toContain('earlier in this turn');
  });

  it('injects nothing when the caller does not know the route', async () => {
    const { threads, callModel } = captureThreads(['answer']);
    await runToolLoop({
      messages: [
        { role: 'system', content: 'You are Nuvira.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
      maxSteps: 1,
      context: { configManager: {} },
      deps: { callModel, ...deps },
    });
    expect(routeFrames(threads[0])).toHaveLength(0);
  });

  it('survives a route reader that throws', async () => {
    const { threads, callModel } = captureThreads(['answer']);
    await runToolLoop({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxSteps: 1,
      servedRoute: () => {
        throw new Error('route read failed');
      },
      context: { configManager: {} },
      deps: { callModel, ...deps },
    });
    // The turn still completed; a broken reader is not a broken turn.
    expect(routeFrames(threads[0])).toHaveLength(0);
  });
});
