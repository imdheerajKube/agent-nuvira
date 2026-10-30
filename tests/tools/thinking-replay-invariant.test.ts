/**
 * THINKING-MODE REPLAY — end-to-end regression for a REAL live fault.
 *
 * `~/.nuvira/debug-logs/cli-chat-1792147116253.log` (2026-10-16, `deepseek` /
 * `deepseek-flash`, native transport) recorded four consecutive rejections of the
 * same request, each with a different request_id:
 *
 *   400 The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * The loop kept re-sending it (continuation 2/4 … 4/4) because nothing could see
 * what was wrong: the thread carried reasoning on most assistant turns and none on
 * one tool-call turn, and DeepSeek requires the field on EVERY tool-call turn once
 * the conversation is in thinking mode.
 *
 * These tests drive the real loop and put the check where the endpoint puts it —
 * behind the adapter's wire builder — so the assertion is about the request the
 * provider would actually receive, not about an object the test shaped itself.
 */

import { describe, it, expect, vi } from 'vitest';
import { runToolLoop, type ToolLoopDeps, type StepResponse, type ToolMessage } from '../../src/tools/tool-loop.js';
import { buildWireMessages } from '../../src/inference/tools.js';
import { REASONING_NOT_RETAINED } from '../../src/inference/thinking-replay.js';

const ctx = { cwd: process.cwd(), threadBudgetChars: 200_000 } as never;

/** The endpoint's rule, stated as the endpoint states it. */
const REPLAY_400 =
  'Tool-calling API error (400): {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}';

/**
 * Emulates adapter → endpoint for one request, and throws exactly what DeepSeek
 * throws.
 *
 * The rule is the one MEASURED against the live endpoint on 2026-10-29, and it is
 * wider than the contract text suggests: once ANY assistant turn carries
 * reasoning, EVERY assistant turn must carry one — a plain prose turn without it
 * is rejected exactly like a tool-call turn without it:
 *
 *   · prose turn without reasoning, tool-call turn with      → 400
 *   · prose turn WITH the placeholder, same thread          → 200
 *
 * Encoding it here (rather than only in the fill logic) is what makes these tests
 * a check on the request the provider would receive.
 */
function sendLikeDeepSeek(thread: readonly ToolMessage[]): void {
  const wire = buildWireMessages(thread as ToolMessage[]);
  const assistants = wire.filter((m) => m.role === 'assistant');
  const anyReasoning = assistants.some((m) => typeof m.reasoning_content === 'string' && m.reasoning_content);
  if (!anyReasoning) return; // a thread that never had reasoning is accepted as-is
  for (const turn of assistants) {
    if (!turn.reasoning_content) throw new Error(REPLAY_400);
  }
}

describe('thinking-mode reasoning replay', () => {
  it('a step that returns no reasoning does not poison the conversation (the live 400)', async () => {
    const rawThreads: Array<ToolMessage[]> = [];
    let i = 0;
    const script: StepResponse[] = [
      {
        content: '',
        reasoningContent: 'I should read a.js first.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }],
      },
      // The step that started the live failure: a native tool call with NO
      // reasoning captured (a gateway that omitted it, or a call recovered from
      // text). The loop records what it got — it must not invent reasoning.
      { content: '', toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'b.js' } }] },
      { content: 'Both files read.', toolCalls: [] },
    ];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (thread: ToolMessage[]) => {
        rawThreads.push(thread);
        sendLikeDeepSeek(thread); // <- the endpoint's check, behind the wire builder
        return script[Math.min(i++, script.length - 1)];
      }),
      executeTool: vi.fn(async () => 'file contents'),
      onEvent: vi.fn(),
    };

    const result = await runToolLoop({ messages: [{ role: 'user', content: 'assess a.js and b.js' }], context: ctx, deps });

    // The turn completes: no 400, nothing to recover from.
    expect(result.content).toBe('Both files read.');
    expect(result.generationFailed).toBeUndefined();
    expect(deps.callModel).toHaveBeenCalledTimes(3);

    // AND the layering is honest: the loop's own thread still reflects exactly
    // what the model returned — the gap is filled at the WIRE, not faked in the
    // transcript, so nothing else reading the thread is misled.
    const gapTurn = rawThreads[2].find((m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'c2'));
    expect(gapTurn?.reasoningContent).toBeUndefined();
  });

  it('keeps the signal when COMPACTION removed every reasoned turn (the long-turn 400)', async () => {
    /**
     * The live failure of 2026-10-26, at 50 minutes on a real build: the per-step
     * rule above is not enough once the thread budget has trimmed the early reasoned
     * steps, because the wire layer's only signal ("some assistant turn here carries
     * reasoning") is gone with them. Four identical 400s followed, one per remaining
     * continuation. So a turn that has seen reasoning, and whose thread no longer
     * carries any, stamps the placeholder — which is a true statement, not invented
     * chain-of-thought.
     */
    let i = 0;
    const longContent = 'x'.repeat(2400);
    const script: StepResponse[] = [
      {
        content: '',
        reasoningContent: 'Read the schema first.',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'schema.ts' } }],
      },
      ...Array.from({ length: 6 }, (_, n) => ({
        content: '',
        toolCalls: [{ id: `c${n + 2}`, name: 'read_file', arguments: { path: `m${n}.ts` } }],
      })),
      { content: 'Done.', toolCalls: [] },
    ];
    const sent: ToolMessage[][] = [];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (thread: ToolMessage[]) => {
        sent.push(thread.map((m) => ({ ...m })));
        sendLikeDeepSeek(thread); // rejects like the endpoint does when the signal is gone
        return script[Math.min(i++, script.length - 1)];
      }),
      // Big results, so a small budget forces real trimming during the turn.
      executeTool: vi.fn(async () => longContent),
      onEvent: vi.fn(),
    };
    const result = await runToolLoop({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'read the modules' },
      ],
      context: ctx,
      deps,
      threadBudgetChars: 3000,
      maxSteps: 12,
      maxContinuations: 0,
      // A cacheable route is what turns on COMPACTION (a frozen prefix is only worth
      // keeping where a prefix cache exists), and compaction is what removes whole
      // assistant turns — the measured cause of the 400.
      servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
    });

    expect(result.content).toBe('Done.');
    const last = sent[sent.length - 1];
    // The premise: the turn that DID carry the model's own reasoning was trimmed
    // away, so the wire layer has no signal left to work from.
    expect(last.some((m) => m.role === 'assistant' && m.reasoningContent === 'Read the schema first.')).toBe(false);
    // The repair: a later tool-call turn carries the placeholder, which is why the
    // last request is not rejected.
    expect(
      last.some((m) => m.role === 'assistant' && m.reasoningContent === REASONING_NOT_RETAINED),
    ).toBe(true);
  });

  it('leaves a non-thinking conversation alone (no reasoning ever recorded)', async () => {
    let i = 0;
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (thread: ToolMessage[]) => {
        sendLikeDeepSeek(thread);
        return script[Math.min(i++, script.length - 1)];
      }),
      executeTool: vi.fn(async () => 'ok'),
      onEvent: vi.fn(),
    };
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'read a.js' }], context: ctx, deps });
    expect(result.content).toBe('Done.');
    expect(deps.callModel).toHaveBeenCalledTimes(2);
  });
});
