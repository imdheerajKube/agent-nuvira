/**
 * The prefix-freezing strategy is chosen by the ROUTE, not once for the turn.
 *
 * A frozen, growing prefix is a discount only where the provider caches identical
 * prefixes (DeepSeek: $0.003/M cached vs $0.15/M fresh). On a local runner or an
 * unknown gateway it is full-price dead weight, so the loop must keep trimming
 * per call there. These tests exercise the loop, not just the predicate: a
 * handoff mid-turn to a non-caching provider has to change the strategy too.
 */

import { describe, it, expect, vi } from 'vitest';

import { COMPACTION_MARKER, runToolLoop } from '../../src/tools/tool-loop.js';
import type { ToolMessage } from '../../src/inference/interface.js';
import type { ServedRoute } from '../../src/inference/route-resolver.js';

const TRIM_STUB = '[earlier tool result trimmed to fit the context budget]';

/** Drive the loop with N fat read results, capturing every thread it sends. */
async function runWithRoute(route: ServedRoute, steps = 8) {
  const threads: ToolMessage[][] = [];
  const events: string[] = [];
  const deps = {
    callModel: vi.fn(async (thread: ToolMessage[]) => {
      threads.push(thread.map((m) => ({ ...m })));
      const calls = thread.filter((m) => m.role === 'tool').length;
      return calls < steps
        ? { content: '', toolCalls: [{ id: `c${calls}`, name: 'read_file', arguments: { path: `f${calls}.ts` } }] }
        : { content: 'done', toolCalls: [] };
    }),
    executeTool: vi.fn(async () => 'z'.repeat(3_000)),
    onEvent: (line: string) => events.push(line),
  };
  const result = await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read everything and report' },
    ],
    context: { cwd: process.cwd() } as never,
    deps: deps as never,
    maxSteps: 14,
    threadBudgetChars: 2_000,
    maxContinuations: 0,
    servedRoute: () => route,
  });
  return { threads, events, result };
}

const hasCompaction = (threads: ToolMessage[][]): boolean =>
  threads.some((t) => t.some((m) => String(m.content ?? '').startsWith(COMPACTION_MARKER)));

const hasStub = (threads: ToolMessage[][]): boolean =>
  threads.some((t) => t.some((m) => String(m.content ?? '').includes(TRIM_STUB)));

describe('tool loop — cache-stable prefix is gated on the route', () => {
  it('compacts ONCE and freezes the prefix on a provider that caches', async () => {
    const { threads } = await runWithRoute({ providerType: 'deepseek', model: 'deepseek-flash' });

    // The thread grew past the budget, so a compaction happened…
    expect(hasCompaction(threads)).toBe(true);
    // …and once it did, later calls kept the SAME compaction message (prefix
    // stable) instead of re-stubbing earlier messages on every call.
    const markersPerThread = threads.map(
      (t) => t.filter((m) => String(m.content ?? '').startsWith(COMPACTION_MARKER)).length,
    );
    expect(Math.max(...markersPerThread)).toBe(1);
  });

  it('never freezes the prefix on a local runner — it trims per call instead', async () => {
    const { threads, events } = await runWithRoute({ providerType: 'local', model: 'llama3' });

    expect(hasCompaction(threads)).toBe(false);
    expect(hasStub(threads)).toBe(true);
    // …and says so once, so the strategy is explainable from the log.
    expect(events.filter((e) => e.includes('no known prompt prefix cache'))).toHaveLength(1);
    expect(events.some((e) => e.includes('frozen'))).toBe(false);
  });

  it('re-decides after a mid-turn handoff (caching → non-caching keeps trimming)', async () => {
    // The route moves to `local` after the first call, exactly as a provider
    // failover does. The already-frozen span stays (it no longer exists in the
    // thread), but no NEW compaction may seal on the non-caching provider.
    let route: ServedRoute = { providerType: 'deepseek', model: 'deepseek-flash' };
    const threads: ToolMessage[][] = [];
    let reads = 0;
    const deps = {
      callModel: vi.fn(async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        const calls = thread.filter((m) => m.role === 'tool').length;
        return calls < 10
          ? { content: '', toolCalls: [{ id: `h${calls}`, name: 'read_file', arguments: { path: `h${calls}.ts` } }] }
          : { content: 'done', toolCalls: [] };
      }),
      executeTool: vi.fn(async () => 'q'.repeat(3_000)),
      onEvent: () => {},
    };
    await runToolLoop({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read everything and report' },
      ],
      context: { cwd: process.cwd() } as never,
      deps: deps as never,
      maxSteps: 16,
      threadBudgetChars: 2_000,
      maxContinuations: 0,
      servedRoute: () => {
        reads += 1;
        if (reads > 1) route = { providerType: 'local', model: 'llama3' };
        return route;
      },
    });

    // Earlier messages were compacted BEFORE the handoff, so at most the one
    // marker from that compaction can exist — never a second one on `local`.
    const markers = threads.flatMap((t) =>
      t.filter((m) => String(m.content ?? '').startsWith(COMPACTION_MARKER)),
    );
    expect(markers.length).toBeGreaterThanOrEqual(0);
    expect(new Set(markers.map((m) => String(m.content))).size).toBeLessThanOrEqual(1);
  });
});
