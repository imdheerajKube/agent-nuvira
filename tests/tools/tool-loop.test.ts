/**
 * E3b — Tool loop tests (Freebuff run-agent-step parity, verified against the
 * clone): continues while the model emits tool calls, ends on a no-tools
 * response; think-only responses continue; tool errors force a retry step;
 * the step bound is never infinite. All driven with injected mocks — no
 * network, no TTY.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  isThinkOnlyResponse,
  extractFallbackToolCalls,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext, type FollowupSuggestion } from '../../src/tools/registry.js';

/** Run the REAL registry tool (so sinks + askUser injection are exercised). */
async function realExecute(name: string, args: Record<string, unknown>, c: ToolContext): Promise<string> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args, c);
}

const ctx: ToolContext = { configManager: {} };

/** Build a mock deps set with a scripted sequence of step responses. */
function mockDeps(script: StepResponse[], execute?: (name: string, args: Record<string, unknown>) => Promise<string>): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return {
    callModel,
    executeTool: execute || vi.fn(async (name: string, args: Record<string, unknown>) => `executed ${name}`),
    onEvent: vi.fn(),
  };
}

describe('tool loop — end-turn semantics', () => {
  it('ends immediately when the model returns content with no tool calls', async () => {
    const deps = mockDeps([{ content: 'The answer.', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.content).toBe('The answer.');
    expect(result.steps).toBe(1);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(deps.executeTool).not.toHaveBeenCalled();
  });

  it('executes a tool call, feeds the result back, and ends on the next answer', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: { request: 'build x' } }] },
        { content: 'Done, built x.', toolCalls: [] },
      ],
      async () => 'requirementState: complete',
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'build x' }], context: ctx, deps });
    expect(result.toolCalls).toEqual(['verify_requirement']);
    expect(result.content).toBe('Done, built x.');
    expect(result.steps).toBe(2);
    // The tool result was fed back as a tool message.
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(secondCall.some((m) => m.role === 'tool' && m.content.includes('requirementState: complete'))).toBe(true);
  });

  it('collects suggest_followups into the result', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Next step?' }] } }] },
      { content: 'Here is the answer.', toolCalls: [] },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'hi' }], context: ctx, deps });
    expect(result.followups).toEqual([{ prompt: 'Next step?' }] as FollowupSuggestion[]);
    expect(result.content).toBe('Here is the answer.');
  });

  it('renders ask_user via the injected ctx.askUser renderer', async () => {
    const askUser = vi.fn().mockResolvedValue({ answer: 'Fix it', index: 1 });
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'ask_user',
            arguments: { question: 'Build or answer?', choices: [{ label: 'Build it' }, { label: 'Fix it' }] },
          },
        ],
      },
      { content: 'Fixing it now.', toolCalls: [] },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'ambiguous' }],
      context: { ...ctx, askUser },
      deps,
    });
    expect(askUser).toHaveBeenCalledWith('Build or answer?', [{ label: 'Build it' }, { label: 'Fix it' }], false);
    expect(result.content).toBe('Fixing it now.');
  });

  it('continues on think-only responses (Freebuff isThinkOnlyResponse parity)', async () => {
    const deps = mockDeps([
      { content: '<think>Let me consider the options carefully</think>', toolCalls: [] },
      { content: 'The real answer.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], context: ctx, deps });
    expect(result.steps).toBe(2);
    expect(result.content).toBe('The real answer.');
  });

  it('feeds unknown-tool errors back so the model retries with a known tool', async () => {
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'c1', name: 'not_a_tool', arguments: {} }] },
      { content: 'ok now the real answer', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], context: ctx, deps });
    const toolMsg = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(toolMsg.some((m) => m.role === 'tool' && m.content.includes('unknown tool'))).toBe(true);
    expect(result.toolCalls).toEqual(['not_a_tool']);
  });

  it('feeds execution errors back as tool results (hadToolCallError parity)', async () => {
    const deps = mockDeps(
      [{ content: '', toolCalls: [{ id: 'c1', name: 'build', arguments: {} }] }],
      async () => {
        throw new Error('boom');
      },
    );
    // build with no goal throws inside its run; the loop must capture it.
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { ...deps, executeTool: async () => { throw new Error('boom'); } },
      maxSteps: 1,
    });
    const toolMsg = deps.callModel.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(toolMsg.some((m) => m.role === 'tool' && m.content.includes('Error: boom'))).toBe(true);
    expect(result.bounded).toBe(true);
  });

  it('is bounded by maxSteps — never an infinite loop', async () => {
    const endless: StepResponse = { content: '', toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: {} }] };
    const deps = mockDeps([endless], async () => 'result');
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], context: ctx, deps, maxSteps: 3 });
    expect(result.bounded).toBe(true);
    expect(result.steps).toBe(3);
  });

  it('returns a graceful message when generation fails', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('API down'));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'x' },
    });
    expect(result.content).toContain("couldn't complete");
    expect(result.bounded).toBe(false);
    // E3c: generationFailed signals the no-model fallback decision.
    expect(result.generationFailed).toBe(true);
  });

  it('does NOT flag generationFailed when a tool already ran (never re-runs work)', async () => {
    // Step 1: the model calls `build` (tool executes). Step 2: generation dies.
    // The turn MADE PROGRESS — the caller must not fall back to re-running the
    // pipeline (that would double-execute the build).
    const callModel = vi.fn();
    callModel
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'build', arguments: { goal: 'create a module' } }],
      })
      .mockRejectedValueOnce(new Error('API down'));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'create a module' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'built' },
    });
    expect(result.toolCalls).toEqual(['build']);
    expect(result.generationFailed).toBe(false);
    expect(result.bounded).toBe(false);
  });
});

describe('tool loop — helpers', () => {
  it('isThinkOnlyResponse detects bare think blocks and empty content', () => {
    expect(isThinkOnlyResponse('')).toBe(true);
    expect(isThinkOnlyResponse('<think>hmm</think>')).toBe(true);
    expect(isThinkOnlyResponse('hmm')).toBe(true);
    expect(isThinkOnlyResponse('The answer is 42.')).toBe(false);
    expect(isThinkOnlyResponse('<think>thought</think>\nAnswer here.')).toBe(false);
  });

  it('extractFallbackToolCalls strips JSON tool blocks and keeps the answer text', () => {
    const raw = 'The answer.\n{"tool":"suggest_followups","arguments":{"followups":[{"prompt":"Next"}]}}';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(text).toBe('The answer.');
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('suggest_followups');
    expect((calls[0].arguments as { followups: unknown[] }).followups.length).toBe(1);
  });

  it('extractFallbackToolCalls leaves malformed JSON in the text', () => {
    const raw = 'Answer {"tool": broken';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(calls.length).toBe(0);
    expect(text).toContain('broken');
  });
});
