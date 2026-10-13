/**
 * C4 — `trimThreadBudget` must actually bound the thread.
 *
 * Root cause this pins (trace-1791879575576-x731yp): step 4 ran a test command
 * whose result was huge; the result landed in the protected `RECENT_KEEP` tail,
 * which the oldest-first passes never touch — so step 5's prompt was ~5.29M
 * chars (~1.18M tokens), sent verbatim to `local/qwen2.5:0.5b` (a 32K window).
 * The recorded `inputTokens` was real, not a reporting artifact.
 */

import { describe, it, expect } from 'vitest';
import { trimThreadBudget, type ToolMessage } from '../../src/tools/tool-loop.js';

const TRIM_STUB = '[earlier tool result trimmed to fit the context budget]';

/** Small assistant/tool pair used as filler. */
function pair(n: number): ToolMessage[] {
  return [
    { role: 'assistant', content: `step ${n}`, toolCalls: [{ id: `c${n}`, name: 'read_file', arguments: { path: 'a.ts' } }] },
    { role: 'tool', content: `small result ${n}` },
  ];
}

/**
 * A thread whose single OVERSIZED tool result has `padBefore` filler pairs
 * before it and `padAfter` after it. With 0/0 the big result is the LAST
 * message (inside RECENT_KEEP); with padAfter >= 3 it sits outside the tail.
 */
function threadWithBigTool(padBefore: number, padAfter: number, toolChars: number): { thread: ToolMessage[]; bigIndex: number } {
  const msgs: ToolMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Assess the project.' },
  ];
  for (let i = 0; i < padBefore; i++) msgs.push(...pair(i));
  msgs.push({ role: 'assistant', content: 'running the tests', toolCalls: [{ id: 'big', name: 'run_terminal', arguments: { command: 'npx vitest run' } }] });
  const bigIndex = msgs.length;
  msgs.push({ role: 'tool', content: 'x'.repeat(toolChars), toolCallId: 'big' });
  for (let i = 0; i < padAfter; i++) msgs.push(...pair(100 + i));
  return { thread: msgs, bigIndex };
}

describe('trimThreadBudget — oversized recent-tail tool result (C4)', () => {
  it('clamps a huge tool result sitting in the protected recent tail', () => {
    // No padding → the big tool result is the LAST message, inside RECENT_KEEP.
    const { thread, bigIndex } = threadWithBigTool(0, 0, 5_000_000);
    expect(thread[bigIndex].content.length).toBe(5_000_000);

    const { thread: out, trimmed } = trimThreadBudget(thread, 10_000);

    expect(trimmed).toBeGreaterThanOrEqual(1);
    // It can no longer dominate the prompt.
    expect(out[bigIndex].content.length).toBeLessThan(20_000);
    // The clamp is NOT silent: it names the tool, counts the cut and says how to
    // recover the middle — a model cannot reason about a loss it cannot see.
    expect(out[bigIndex].content).toContain('trimmed to fit the context budget');
    expect(out[bigIndex].content).toContain('run_terminal');
    expect(out[bigIndex].content).toContain('chars elided from the middle');
    expect(out[bigIndex].content).toContain('offset/limit');
    // The user's ask + system prompt are untouched.
    expect(out[0].content).toBe('system prompt');
    expect(out[1].content).toBe('Assess the project.');
  });

  it('still collapses an OLD oversized tool result to the stub (regression)', () => {
    // Padding AFTER the big result → it is outside the recent tail.
    const { thread, bigIndex } = threadWithBigTool(0, 4, 5_000_000);
    expect(thread[bigIndex].content.length).toBe(5_000_000);

    const { thread: out, trimmed } = trimThreadBudget(thread, 10_000);

    expect(trimmed).toBeGreaterThanOrEqual(1);
    expect(out[bigIndex].content.endsWith(TRIM_STUB)).toBe(true);
    expect(out[bigIndex].content.length).toBeLessThan(1_000);
  });

  it('spends OLD output before touching a recent result (ordering)', () => {
    // The whole overage is payable by ONE old tool result. Clamping the recent
    // result first (the pre-ordering behaviour) clipped it to the 8,000-char
    // per-message cap even though nothing required that — recent context is the
    // model's working memory, so it must be spent last.
    const oldBig = 'o'.repeat(300_000);
    const recent = 'r'.repeat(9_000);
    const thread: ToolMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Assess the project.' },
      { role: 'assistant', content: 'reading a.ts', toolCalls: [{ id: 'old', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', content: oldBig, toolCallId: 'old' },
      ...pair(1),
      ...pair(2),
      { role: 'assistant', content: 'reading b.ts', toolCalls: [{ id: 'new', name: 'read_file', arguments: { path: 'b.ts' } }] },
      { role: 'tool', content: recent, toolCallId: 'new' },
    ];
    const recentIndex = thread.length - 1;

    const { thread: out, trimmed } = trimThreadBudget(thread, 10_000);

    // Only the OLD result paid, and it paid once.
    expect(trimmed).toBe(1);
    expect(out[3].content.endsWith(TRIM_STUB)).toBe(true);
    expect(out[recentIndex].content).toBe(recent);
  });

  it('names the tool and keeps the error lines from the elided middle', () => {
    const head = 'h'.repeat(20_000);
    const middleErr = [
      'PASS src/a.test.ts',
      'Error: expected 3 to be 4 — at src/a.test.ts:12:5',
      'x'.repeat(20_000),
      'FAIL src/b.test.ts',
      'AssertionError: 2 !== 3 (received 3)',
    ].join('\n');
    const tail = 't'.repeat(2_000);
    const thread: ToolMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Run the tests.' },
      { role: 'assistant', content: 'running', toolCalls: [{ id: 'big', name: 'run_terminal', arguments: { command: 'npx vitest run' } }] },
      { role: 'tool', content: head + middleErr + tail, toolCallId: 'big' },
    ];

    const { thread: out } = trimThreadBudget(thread, 10_000);
    const clamped = out[3].content;

    expect(clamped).toContain('run_terminal');
    expect(clamped).toContain('chars elided from the middle');
    // The REASON it failed survives the cut — a fix is not built blind.
    expect(clamped).toContain('Error: expected 3 to be 4');
    expect(clamped).toContain('FAIL src/b.test.ts');
    expect(clamped).toContain('AssertionError: 2 !== 3');
    // Head + tail are still verbatim, and the clamp never exceeds its cap.
    expect(clamped.startsWith('h')).toBe(true);
    expect(clamped.endsWith('t'.repeat(1_000))).toBe(true);
    expect(clamped.length).toBeLessThanOrEqual(8_000);
  });

  it('leaves a small thread completely untouched', () => {
    const thread: ToolMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const { thread: out, trimmed } = trimThreadBudget(thread, 10_000);
    expect(trimmed).toBe(0);
    expect(out).toBe(thread);
  });
});
