/**
 * Audit W4 — `endsAgentStep` is now a real contract.
 *
 * The 8 dispenser tools (`build`/`resume`/`repair`/`document`/`website`/
 * `analyze`/`test`/`publish`) each run an entire task on their own and return
 * the deliverable as their result text. The flag that said so was declared on
 * the `Tool` interface and read by NOTHING, so the loop always asked for one
 * more model step: a full round trip that re-sent the whole tool schema purely
 * to have the model paraphrase the pipeline's own output — with a live window
 * for a second dispatch of the same pipeline.
 *
 * Pinned here:
 *   1. a SUCCESSFUL dispenser ends the step (no further model call) and its
 *      result text becomes the answer;
 *   2. a real summary the model wrote in the same step wins over that text;
 *   3. a FAILED/refused dispatch does NOT end the step — the model must react;
 *   4. `ask_user` does not end the step: the user's answer is input to act on;
 *   5. ordinary tools never end the step.
 */

import { describe, it, expect, vi } from 'vitest';
import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };

function mockDeps(
  script: StepResponse[],
  execute?: (name: string, args: Record<string, unknown>) => Promise<string>,
): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return {
    callModel,
    executeTool: execute || vi.fn(async (name: string) => `executed ${name}`),
    onEvent: vi.fn(),
  };
}

const BUILD_SUMMARY = '✅ build succeeded\nImplemented the login flow.\n- src/auth.ts (new)';

describe('endsAgentStep — dispatcher tools', () => {
  it('the registry marks the dispensers terminal and the control tools not', () => {
    for (const name of ['build', 'resume', 'repair', 'document', 'website', 'analyze', 'test', 'publish']) {
      expect(getTool(name)?.endsAgentStep, `${name} should end the step`).toBe(true);
    }
    for (const name of ['ask_user', 'suggest_followups', 'read_file', 'plan_todo']) {
      expect(getTool(name)?.endsAgentStep, `${name} should NOT end the step`).toBe(false);
    }
  });

  it('a successful dispatch ends the step and delivers the tool result', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'build', arguments: { goal: 'add login' } }] },
        { content: 'THIS STEP MUST NEVER RUN', toolCalls: [] },
      ],
      async () => BUILD_SUMMARY,
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'add login' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(BUILD_SUMMARY);
    expect(result.toolCalls).toEqual(['build']);
    expect(result.steps).toBe(1);
    expect(result.bounded).toBe(false);
  });

  it('prefers a real summary the model wrote in the same step', async () => {
    const modelText = 'Added the login flow and wired the session store.';
    const deps = mockDeps(
      [{ content: modelText, toolCalls: [{ id: 'c1', name: 'build', arguments: { goal: 'add login' } }] }],
      async () => BUILD_SUMMARY,
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'add login' }],
      context: ctx,
      deps,
    });

    expect(result.content).toBe(modelText);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });

  it('does NOT end the step when the dispatch failed', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'build', arguments: { goal: 'add login' } }] },
        { content: 'The pipeline failed, retrying differently.', toolCalls: [] },
      ],
      async () => 'Error: pipeline aborted — no provider available',
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'add login' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('The pipeline failed, retrying differently.');
    expect(result.steps).toBe(2);
  });

  it('does NOT end the step for ask_user — the answer is input to act on', async () => {
    const deps = mockDeps(
      [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'ask_user', arguments: { question: 'Which?', choices: [{ label: 'A' }, { label: 'B' }] } },
          ],
        },
        { content: 'Proceeding with A.', toolCalls: [] },
      ],
      async () => 'User selected: A',
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'ambiguous' }],
      context: { ...ctx, askUser: vi.fn().mockResolvedValue({ answer: 'A', index: 0 }) },
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Proceeding with A.');
  });

  it('ordinary tools never end the step', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { content: 'Read it.', toolCalls: [] },
      ],
      async () => 'file contents',
    );

    const result = await runToolLoop({ messages: [{ role: 'user', content: 'read a.ts' }], context: ctx, deps });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('Read it.');
  });

  it('still collects followups called alongside a successful dispatch', async () => {
    const deps = mockDeps(
      [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: 'build', arguments: { goal: 'add login' } },
            { id: 'c2', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Add tests?' }] } },
          ],
        },
      ],
      // `build` is faked (a real call would boot the pipeline); the followups
      // sink is exercised through the REAL registry tool, exactly as the loop
      // wires it for a live turn.
      async (name, args, liveCtx) => {
        if (name === 'build') return BUILD_SUMMARY;
        // Run against the loop's OWN per-step context so the followups sink
        // it injects is the one the real tool writes to.
        const tool = getTool(name);
        return tool ? tool.run(args, liveCtx) : `executed ${name}`;
      },
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'add login' }],
      context: ctx,
      deps,
    });

    expect(result.content).toBe(BUILD_SUMMARY);
    expect(result.followups).toEqual([{ prompt: 'Add tests?' }]);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });
});
