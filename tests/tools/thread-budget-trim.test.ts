/**
 * Thread budget — the bound must hold, and (since 2026-10-25) it must hold
 * WITHOUT rewriting the prompt prefix on every call.
 *
 * Two failures are pinned here:
 *
 * 1. C4 (trace-1791879575576-x731yp): step 4 ran a test command whose result was
 *    huge; it landed in the protected `RECENT_KEEP` tail, which the oldest-first
 *    passes never touch — so step 5's prompt was ~5.29M chars (~1.18M tokens),
 *    sent verbatim to a 32K model. The recorded `inputTokens` was real.
 *
 * 2. The CACHE failure (2026-10-25 audit head-to-head, 52 model calls): the
 *    pre-compaction trimmer re-stubbed older messages on every call — 22 trim
 *    events — and the provider's cache-read share fell from 99.8 % to 12–17 % on
 *    exactly those calls, re-billing ~90K tokens each at 50× the cached rate.
 *    One compaction per breach, with a watermark that freezes everything before
 *    it, is the fix.
 */

import { describe, it, expect } from 'vitest';
import {
  COMPACTION_MARKER,
  WORK_DIGEST_MARKER,
  trimThreadBudget,
  type ToolMessage,
} from '../../src/tools/tool-loop.js';

const TRIM_STUB = '[earlier tool result trimmed to fit the context budget]';

/** Small assistant/tool pair used as filler. */
function pair(n: number): ToolMessage[] {
  return [
    { role: 'assistant', content: `step ${n}`, toolCalls: [{ id: `c${n}`, name: 'read_file', arguments: { path: 'a.ts' } }] },
    { role: 'tool', content: `small result ${n}`, toolCallId: `c${n}` },
  ];
}

/** A pair whose tool result is big enough to move the thread past a small budget. */
function fatPair(n: number): ToolMessage[] {
  return [
    { role: 'assistant', content: `step ${n}`, toolCalls: [{ id: `f${n}`, name: 'read_file', arguments: { path: 'a.ts' } }] },
    { role: 'tool', content: 'p'.repeat(2_000), toolCallId: `f${n}` },
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

/** Every tool result still has its parent assistant `tool_calls` block (wire-valid). */
function wireValid(thread: ToolMessage[]): boolean {
  const open = new Set<string>();
  for (const m of thread) {
    if (m.role === 'assistant') {
      if (open.size > 0) return false; // previous group never completed
      for (const c of m.toolCalls ?? []) if (c?.id) open.add(c.id);
    } else if (m.role === 'tool') {
      if (!m.toolCallId || !open.has(m.toolCallId)) return false;
      open.delete(m.toolCallId);
    }
  }
  return open.size === 0;
}

describe('trimThreadBudget — oversized recent-tail tool result (C4)', () => {
  it('clamps a huge tool result sitting in the protected recent tail', () => {
    // No padding → the big tool result is the LAST message, inside RECENT_KEEP,
    // and there is no safe cut behind it → the clamp path must pay.
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

describe('trimThreadBudget — ONE compaction, then a frozen prefix', () => {
  const DIGEST = `${WORK_DIGEST_MARKER}\n• Files changed (1): src/a.ts\n• Commands run:\n  ✅ npm test`;

  it('replaces an old span with ONE digest message instead of stubbing message by message', () => {
    const { thread } = threadWithBigTool(0, 4, 5_000_000);
    const { thread: out, trimmed, compacted, sealed } = trimThreadBudget(thread, 10_000, { digest: DIGEST });

    expect(compacted).toBe(true);
    expect(trimmed).toBeGreaterThanOrEqual(1);
    // The oversized transcript is GONE (one marker, not 5M chars of 'x').
    expect(out.some((m) => m.content.startsWith(COMPACTION_MARKER))).toBe(true);
    expect(out.every((m) => !m.content.includes('xxxxxxxxxx'))).toBe(true);
    expect(out.reduce((a, m) => a + m.content.length, 0)).toBeLessThan(10_000);
    // The model can see that the turn continued, what was kept, and how to recover.
    const marker = out[sealed].content;
    expect(marker).toContain(COMPACTION_MARKER);
    expect(marker).toContain('Nothing was restarted and no work was undone');
    expect(marker).toContain('read_file');
    expect(marker).toContain('re-run the command');
    // …and the FACTS survive (did the build pass?), not just the fact of a cut.
    expect(marker).toContain('npm test');
    expect(marker).toContain('src/a.ts');
    // The ask and the system prompt are never touched.
    expect(out[0].content).toBe('system prompt');
    expect(out[1].content).toBe('Assess the project.');
    // The result is still a wire-valid conversation.
    expect(wireValid(out)).toBe(true);
  });

  it('spends OLD output while leaving the recent tail verbatim', () => {
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

    const { thread: out, trimmed } = trimThreadBudget(thread, 10_000, { digest: DIGEST });

    expect(trimmed).toBeGreaterThanOrEqual(1);
    // The 300K result is gone; the recent working memory is untouched.
    expect(out.every((m) => m.content !== oldBig)).toBe(true);
    expect(out[out.length - 1].content).toBe(recent);
    expect(recentIndex).toBe(thread.length - 1);
  });

  it('is CACHE-STABLE: re-running with the returned watermark rewrites nothing', () => {
    const { thread } = threadWithBigTool(0, 4, 500_000);
    const first = trimThreadBudget(thread, 10_000, { digest: DIGEST });
    expect(first.compacted).toBe(true);

    // A LATER call arrives with a different digest (the turn kept working) and
    // the thread is under budget again. Nothing may be rewritten: the prefix is
    // what the provider cached.
    const second = trimThreadBudget(first.thread, 10_000, {
      sealedThrough: first.sealed,
      digest: `${DIGEST}\n• new fact that must not invalidate the cache`,
    });
    expect(second.trimmed).toBe(0);
    expect(second.compacted).toBe(false);
    expect(second.thread).toBe(first.thread);
    expect(second.sealed).toBe(first.sealed);
  });

  it('compacts again ONLY past the watermark, keeping exactly one marker', () => {
    const { thread } = threadWithBigTool(0, 4, 500_000);
    const first = trimThreadBudget(thread, 10_000, { digest: DIGEST });
    const marker = first.thread[first.sealed].content;

    // The turn keeps working and the thread grows past the budget again.
    const grown: ToolMessage[] = [...first.thread];
    for (let i = 0; i < 20; i++) grown.push(...fatPair(500 + i));
    const second = trimThreadBudget(grown, 10_000, { sealedThrough: first.sealed, digest: DIGEST });

    expect(second.compacted).toBe(true);
    expect(second.thread.filter((m) => m.content.startsWith(COMPACTION_MARKER))).toHaveLength(1);
    // The watermark does not move backwards, so the frozen prefix stays frozen.
    expect(second.sealed).toBeGreaterThanOrEqual(first.sealed);
    // …and the facts from the first compaction are still in the marker.
    expect(second.thread[second.sealed].content).toContain('npm test');
    expect(marker).toContain(COMPACTION_MARKER);
    expect(wireValid(second.thread)).toBe(true);
  });

  it('preferTrim skips the compaction — the fallback for a route with no prefix cache', () => {
    // On a provider that does not cache prefixes, a frozen span is full-price dead
    // weight: the oldest-first trim is strictly cheaper. `preferTrim` is how the
    // loop asks for it (see `learning/prompt-cache.ts`).
    const { thread } = threadWithBigTool(0, 4, 500_000);
    const { thread: out, compacted, trimmed } = trimThreadBudget(thread, 10_000, {
      digest: DIGEST,
      preferTrim: true,
    });

    expect(compacted).toBe(false);
    expect(trimmed).toBeGreaterThanOrEqual(1);
    expect(out.some((m) => m.content.startsWith(COMPACTION_MARKER))).toBe(false);
    expect(wireValid(out)).toBe(true);
    expect(out.reduce((a, m) => a + m.content.length, 0)).toBeLessThanOrEqual(10_000);
  });

  it('honours an existing watermark even under preferTrim (no span is resurrected)', () => {
    const { thread } = threadWithBigTool(0, 4, 500_000);
    const first = trimThreadBudget(thread, 10_000, { digest: DIGEST });
    const grown: ToolMessage[] = [...first.thread];
    for (let i = 0; i < 20; i++) grown.push(...fatPair(700 + i));

    const second = trimThreadBudget(grown, 10_000, { sealedThrough: first.sealed, preferTrim: true });
    expect(second.thread[second.sealed].content).toContain(COMPACTION_MARKER);
    expect(second.thread.filter((m) => m.content.startsWith(COMPACTION_MARKER))).toHaveLength(1);
    expect(wireValid(second.thread)).toBe(true);
  });

  it('falls back to the stub passes when there is no safe cut (no orphaned tool results)', () => {
    // One assistant turn with TWO results, no other boundary: cutting anywhere
    // inside the group would orphan a result, so the stub passes must pay.
    const thread: ToolMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'run both' },
      {
        role: 'assistant',
        content: 'running both',
        toolCalls: [
          { id: 'a', name: 'run_terminal', arguments: { command: 'npm test' } },
          { id: 'b', name: 'run_terminal', arguments: { command: 'npm run build' } },
        ],
      },
      { role: 'tool', content: 'a'.repeat(50_000), toolCallId: 'a' },
      { role: 'tool', content: 'b'.repeat(50_000), toolCallId: 'b' },
    ];

    const { thread: out, compacted } = trimThreadBudget(thread, 10_000, { digest: DIGEST });

    expect(compacted).toBe(false);
    expect(wireValid(out)).toBe(true);
    expect(out[3].content.endsWith(TRIM_STUB) || out[3].content.includes('trimmed to fit')).toBe(true);
  });
});
