/**
 * The self-review gate must reach an ASSESSMENT turn — one that changed nothing.
 *
 * The gate's original condition is `progress.mutatedPaths.length > 0`, which is
 * right for a change: with no edit there is nothing to re-read. An assessment is
 * the exception the condition cannot express — its deliverable is a set of CLAIMS
 * about code nobody changed.
 *
 * Why it matters (measured, 2026-10-16): on the same model and the same project,
 * an assessment run published two findings about inputs the shipped UI cannot
 * produce ("typing `alert(1)` runs the code" — the display is `disabled` and the
 * key filter drops every letter). The question this gate asks — "is each claim in
 * your answer backed by a tool result from THIS turn?" — is exactly the one that
 * catches that, and no gate was asking it on a findings-only turn.
 *
 * Off by default, so every existing caller is byte-identical; these tests pin
 * both the OFF default and the ON behaviour, including that it stays BOUNDED
 * (one nudge, and none at all for a short turn).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  type LoopTraceEvent,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };

function collect() {
  const events: LoopTraceEvent[] = [];
  return { events, sink: (e: LoopTraceEvent) => events.push(e) };
}

/**
 * A substantial READ-ONLY turn: six file reads, then an answer. No tool in the
 * script mutates anything, which is the shape of an assessment.
 */
function readOnlyAssessmentTurn(seenThreads: string[][]): ToolLoopDeps {
  const reads = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
  let i = 0;
  return {
    callModel: vi.fn(async (messages: readonly { role: string; content?: string }[]) => {
      seenThreads.push(messages.map((m) => String(m.content ?? '')));
      const done = messages.filter((m) => m.role === 'tool').length;
      if (done < reads.length) {
        return {
          content: '',
          toolCalls: [
            { id: `r${done}`, name: 'read_file', arguments: { path: reads[done] } },
          ],
        } satisfies StepResponse;
      }
      return { content: 'Findings: three bugs, each with file:line.', toolCalls: [] } satisfies StepResponse;
    }),
    executeTool: vi.fn(async () => 'file contents'),
    onEvent: vi.fn(),
  };
}

const reviews = (events: LoopTraceEvent[]) => events.filter((e) => e.kind === 'gate' && e.gate === 'self-review');

describe('self-review on an assessment turn that changed nothing', () => {
  it('does NOT fire by default (every existing caller is byte-identical)', async () => {
    const { events, sink } = collect();
    const seenThreads: string[][] = [];
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'assess the project and identify the bugs' }],
      context: ctx,
      deps: readOnlyAssessmentTurn(seenThreads),
      onTraceEvent: sink,
    });

    expect(reviews(events)).toHaveLength(0);
    expect(seenThreads.some((t) => t.some((c) => c.includes('REVIEW your result')))).toBe(false);
    expect(result.content).toContain('Findings:');
  });

  it('fires ONCE and reaches the model when the turn declares itself an assessment', async () => {
    const { events, sink } = collect();
    const seenThreads: string[][] = [];
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'assess the project and identify the bugs' }],
      context: ctx,
      deps: readOnlyAssessmentTurn(seenThreads),
      onTraceEvent: sink,
      selfReviewWhenUnchanged: true,
    });

    expect(reviews(events)).toHaveLength(1);
    // It must reach the MODEL, not just the trace.
    expect(seenThreads.some((t) => t.some((c) => c.includes('REVIEW your result')))).toBe(true);
    // …and the ask it re-checks is the ORIGINAL one, not the nudge.
    expect(seenThreads.some((t) => t.some((c) => c.includes('assess the project and identify the bugs')))).toBe(true);
    // The turn still ends with the model's own answer.
    expect(result.content).toContain('Findings:');
  });

  it('stays bounded: a SHORT read-only turn gets no nudge even when declared an assessment', async () => {
    const { events, sink } = collect();
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async () =>
        ({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } }] }) satisfies StepResponse),
      executeTool: vi.fn(async () => 'file contents'),
      onEvent: vi.fn(),
    };
    await runToolLoop({
      messages: [{ role: 'user', content: 'assess a.ts' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
      selfReviewWhenUnchanged: true,
    });
    expect(reviews(events)).toHaveLength(0);
  });
});
