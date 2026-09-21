/**
 * E3b — Tool loop tests (verified against the
 * clone): continues while the model emits tool calls, ends on a no-tools
 * response; think-only responses continue; tool errors force a retry step;
 * the step bound is never infinite. All driven with injected mocks — no
 * network, no TTY.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  isThinkOnlyResponse,
  isBareAcknowledgment,
  extractFallbackToolCalls,
  fallbackHintForTool,
  makeParallelSuggester,
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

  it('continues on think-only responses', async () => {
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
    // Continuations disabled: the original hard bound is untouched.
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps,
      maxSteps: 3,
      maxContinuations: 0,
    });
    expect(result.bounded).toBe(true);
    expect(result.steps).toBe(3);
  });

  it('is STILL bounded when auto-continuation is on — the hard cap is maxSteps + budget', async () => {
    const endless: StepResponse = { content: '', toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: {} }] };
    const deps = mockDeps([endless], async () => 'result');
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps,
      maxSteps: 3,
      maxContinuations: 2,
      continuationSteps: 4,
    });
    expect(result.bounded).toBe(true);
    // 3 initial + 2 x 4 extended — never unbounded.
    expect(result.steps).toBe(11);
    expect(result.continuations).toBe(2);
  });

  it('returns a graceful message when generation fails', async () => {
    const callModel = vi.fn().mockRejectedValue(new Error('API down'));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'x' },
      // This pins the EXHAUSTED path — the pause between resume attempts is
      // irrelevant here and would only slow the suite down.
      continuationDelayMs: 0,
    });
    expect(result.content).toContain("couldn't complete");
    expect(result.bounded).toBe(false);
    // E3c: generationFailed signals the no-model fallback decision.
    expect(result.generationFailed).toBe(true);
  });

  it('NEVER leaks the raw provider error into the delivered content (live 429 regression)', async () => {
    // Live incident: a WhatsApp/dashboard sender received
    //   I couldn't complete that request (Gemini streaming tool-calling API
    //   error (429): {"error":{"code":429,"message":"You exceeded your
    //   current quota…","details":[…"quotaValue":"16000"…]}}).
    // The raw provider payload is for the log/trace only.
    const raw =
      'Gemini streaming tool-calling API error (429): {"error":{"code":429,' +
      '"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"quotaValue":"16000"}]}}';
    const callModel = vi.fn().mockRejectedValue(new Error(raw));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'x' },
      continuationDelayMs: 0,
    });
    // No provider wire text anywhere in what the user sees.
    expect(result.content).not.toContain('429');
    expect(result.content).not.toContain('RESOURCE_EXHAUSTED');
    expect(result.content).not.toContain('quotaValue');
    expect(result.content).not.toContain('{"error"');
    expect(result.content).not.toContain('Gemini');
    // It is a short human sentence, and the turn is still a FAILURE.
    expect(result.content).toMatch(/rate limit|try again/i);
    expect(result.generationFailed).toBe(true);
  });

  it('ends the turn after suggest_followups when the answer is in the SAME step (deliver → suggest)', async () => {
    // The contract: "END EVERY RESPONSE by calling suggest_followups".
    // When the model delivers its answer text AND calls suggest_followups in
    // one step, the turn is complete — the loop must NOT request another step
    // (that forced models to repeat followups 4–5× and clobber the answer).
    const script: StepResponse[] = [
      {
        content: 'The cow essay is complete. Cows give milk and are herbivores.',
        toolCalls: [
          { id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Write about horses?' }] } },
        ],
      },
      // A second model response would have been requested before the fix.
      { content: 'STALE EXTRA STEP — must never be requested.', toolCalls: [] },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'essay on cow' }], context: ctx, deps });
    expect(result.steps).toBe(1);
    expect(result.content).toBe('The cow essay is complete. Cows give milk and are herbivores.');
    expect(result.followups).toEqual([{ prompt: 'Write about horses?' }] as FollowupSuggestion[]);
    expect(result.bounded).toBe(false);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });

  it('JSON-only suggest_followups after the answer ends the turn with the delivered answer (S1)', async () => {
    // Pathological case: the model answered in step 1, then only emitted
    // JSON-only suggest_followups blocks. The delivered answer must survive —
    // and the turn must END at the first successful followups instead of
    // looping to the bound (the old loop forced more steps whose trailing
    // wrapper text clobbered the essay).
    const script: StepResponse[] = [
      { content: 'The essay. Cows are mammals.', toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'x' } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: { followups: [{ prompt: 'A' }] } }] },
      { content: '', toolCalls: [{ id: 'c3', name: 'suggest_followups', arguments: { followups: [{ prompt: 'B' }] } }] },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'essay' }],
      context: ctx,
      deps,
      maxSteps: 3,
    });
    // The turn ends at step 2 (successful followups + prior substantive answer).
    expect(result.bounded).toBe(false);
    expect(result.steps).toBe(2);
    expect(result.content).toBe('The essay. Cows are mammals.'); // NOT clobbered by ''
    expect(result.followups).toEqual([{ prompt: 'A' }] as FollowupSuggestion[]);
  });

  it('the LAST suggest_followups call wins (no accumulated stale suggestions)', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Stale A' }, { prompt: 'Stale B' }] } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Final' }] } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'q' }], context: ctx, deps });
    expect(result.followups).toEqual([{ prompt: 'Final' }] as FollowupSuggestion[]);
    expect(result.content).toBe('Done.');
  });

  it('never re-runs a dispatched pipeline: a successful `build` ends the step', async () => {
    // Step 1 calls `build` (endsAgentStep). The loop must NOT request step 2 —
    // so the dying generator below is never even reached, and the caller can
    // never fall back to re-running the pipeline (double-executing the build).
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
      deps: { callModel, executeTool: async () => '✅ build succeeded' },
    });
    expect(result.toolCalls).toEqual(['build']);
    expect(result.content).toBe('✅ build succeeded');
    expect(result.generationFailed).toBeFalsy();
    expect(result.bounded).toBe(false);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('does NOT flag generationFailed when a NON-terminal tool already ran', async () => {
    // Step 1: an ordinary tool runs (the loop continues). Step 2: generation
    // dies — the turn RESUMES (bounded) rather than handing back a failure,
    // and the completed search is never repeated.
    const callModel = vi.fn();
    callModel
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'x' } }],
      })
      .mockRejectedValueOnce(new Error('API down'))
      .mockResolvedValueOnce({ content: 'Found x in a.ts.', toolCalls: [] });
    const executeTool = vi.fn(async () => 'search hits');
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'find x' }],
      context: ctx,
      deps: { callModel, executeTool },
      continuationDelayMs: 0,
    });
    expect(result.toolCalls).toEqual(['code_search']);
    expect(result.content).toBe('Found x in a.ts.');
    expect(result.continuations).toBe(1);
    // The resumed turn SUCCEEDED — no generation failure is signalled (the
    // field is only set on the exhausted path; consumers use `?? false`).
    expect(result.generationFailed).toBeFalsy();
    expect(result.bounded).toBe(false);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed step response as a recoverable failure mid-turn, not a crash', async () => {
    // Step 1 gathers (progress); step 2 returns junk; the resume recovers it.
    const callModel = vi.fn();
    callModel
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'x' } }],
      })
      .mockResolvedValueOnce(undefined as unknown as StepResponse)
      .mockResolvedValueOnce({ content: 'Recovered fine.', toolCalls: [] });
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'x' },
      continuationDelayMs: 0,
    });
    expect(result.content).toBe('Recovered fine.');
    expect(result.continuations).toBe(1);
  });

  it('a malformed FIRST step degrades gracefully instead of crashing the turn', async () => {
    const callModel = vi.fn().mockResolvedValue(undefined as unknown as StepResponse);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps: { callModel, executeTool: async () => 'x' },
      continuationDelayMs: 0,
    });
    expect(typeof result.content).toBe('string');
    expect(result.generationFailed).toBe(true);
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

  it('extractFallbackToolCalls strips malformed JSON blocks instead of leaking them into the answer', () => {
    // Brace-matched but unparseable (trailing comma in the followups array) —
    // the block must NOT leak raw JSON into the user-facing answer.
    const raw = 'The essay is complete. {"tool":"suggest_followups","arguments":{"followups":[{"prompt":"x"},]}}';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(calls.length).toBe(0);
    expect(text).toBe('The essay is complete.');
    expect(text).not.toContain('"tool"');
  });

  it('extractFallbackToolCalls leaves unterminated JSON (no closing brace) untouched', () => {
    const raw = 'Answer {"tool": broken';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(calls.length).toBe(0);
    expect(text).toContain('broken');
  });

  it('isBareAcknowledgment flags short lead-ins but not real answers', () => {
    expect(isBareAcknowledgment('Sure, I can help with that!')).toBe(true);
    expect(isBareAcknowledgment('Let me write that essay for you.')).toBe(true);
    expect(isBareAcknowledgment('Sure!')).toBe(true);
    expect(isBareAcknowledgment('Okay, let me take a look.')).toBe(true);
    // Real answers (even short ones) are NOT acknowledgments
    expect(isBareAcknowledgment('The essay is complete.')).toBe(false);
    expect(isBareAcknowledgment('Done.')).toBe(false);
    expect(isBareAcknowledgment('')).toBe(false);
  });

  it('P0.6 — emits tool:started (before) and tool:called (after) with the call id + outcome', async () => {
    const emits: Array<{ event: string; data: Record<string, unknown> }> = [];
    const emitCtx: ToolContext = {
      configManager: {},
      emit: (event, data) => {
        emits.push({ event: String(event), data: data as Record<string, unknown> });
      },
    };
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'verify_requirement', arguments: { request: 'build x' } },
          { id: 'c2', name: 'verify_requirement', arguments: { request: 'broken' } },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(
      script,
      async (name: string, args: Record<string, unknown>) => {
        // A thrown error exercises the catch branch: ok:false + `error` field.
        if (args.request === 'broken') throw new Error('exploded');
        return 'requirementState: complete';
      },
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'go' }], context: emitCtx, deps });
    expect(result.content).toBe('Done.');

    const started = emits.filter((e) => e.event === 'tool:started');
    const called = emits.filter((e) => e.event === 'tool:called');
    expect(started).toHaveLength(2);
    expect(called).toHaveLength(2);
    // started carries the stable call id + args; called carries ok + duration.
    expect(started[0].data).toMatchObject({ id: 'c1', tool: 'verify_requirement', args: { request: 'build x' } });
    expect(called[0].data).toMatchObject({ id: 'c1', tool: 'verify_requirement', ok: true });
    expect(typeof called[0].data.durationMs).toBe('number');
    // The catch branch: ok:false + `error` field (not the Error: prefix path).
    expect(called[1].data).toMatchObject({ id: 'c2', tool: 'verify_requirement', ok: false, error: 'exploded' });
  });

  it('P3c — a failed mapped tool gets the deterministic fallback hint (advisory)', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'npm test' } }],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => 'Error: exit 1');
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'go' }], context: ctx, deps });
    // The tool result fed back to the model carries the hint.
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = secondCall.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Error: exit 1');
    expect(toolMsg?.content).toContain('delegate with agent_type "tester"');
    expect(result.content).toBe('Done.');
  });

  it('P3c — fallbackHintForTool is pure: fires on error, NEVER on success', () => {
    expect(fallbackHintForTool('run_terminal', 'Error: boom')).toContain('tester');
    expect(fallbackHintForTool('read_file', 'Error: ENOENT')).toContain('code_search');
    expect(fallbackHintForTool('run_terminal', '✅ succeeded')).toBeNull();
    expect(fallbackHintForTool('unmapped_tool', 'Error: x')).toBeNull();
  });

  it('P3c — an unmapped tool error does NOT get a hint (no behavior change)', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: { request: 'x' } }],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => 'Error: nope');
    await runToolLoop({ messages: [{ role: 'user', content: 'go' }], context: ctx, deps });
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = secondCall.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Error: nope');
    expect(toolMsg?.content).not.toContain('💡');
  });

  it('P3d — 2+ successful independent gather steps inject ONE parallel delegate suggestion', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => '1 | line');
    await runToolLoop({ messages: [{ role: 'user', content: 'go' }], context: ctx, deps });
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsgs = secondCall.filter((m) => m.role === 'tool');
    // The suggestion rides on the 2nd read_file's result — once only.
    expect(toolMsgs[1].content).toContain('IN PARALLEL');
    expect(toolMsgs[0].content).not.toContain('IN PARALLEL');
    expect(toolMsgs[1].content).toContain('delegate');
  });

  it('P3d — makeParallelSuggester is deterministic: fires once, never on failure', () => {
    const s = makeParallelSuggester();
    expect(s.note('read_file', true)).toBeNull(); // 1st — quiet
    const tip = s.note('read_file', true); // 2nd — fires
    expect(tip).toContain('IN PARALLEL');
    expect(tip).toContain('delegate');
    expect(s.note('read_file', true)).toBeNull(); // already fired
    // Failed calls never count.
    const s2 = makeParallelSuggester();
    expect(s2.note('web_search', false)).toBeNull();
    expect(s2.note('web_search', false)).toBeNull();
    expect(s2.hasFired).toBe(false);
    // Non-independent tools never count.
    const s3 = makeParallelSuggester();
    expect(s3.note('run_terminal', true)).toBeNull();
    expect(s3.note('run_terminal', true)).toBeNull();
    expect(s3.hasFired).toBe(false);
  });

  it('P3d — no parallel suggestion on a single independent call or on failures', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => '1 | line');
    await runToolLoop({ messages: [{ role: 'user', content: 'go' }], context: ctx, deps });
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = secondCall.find((m) => m.role === 'tool');
    expect(toolMsg?.content).not.toContain('IN PARALLEL');
  });

  it('a bare-acknowledgment + suggest_followups does NOT end the turn — the real answer must follow', async () => {
    // Misordered model: step 1 emits ONLY a lead-in + valid followups (the
    // contract violation the user reported). The loop must NOT deliver the
    // lead-in as the answer — it continues so the essay arrives in step 2.
    const script: StepResponse[] = [
      {
        content: 'Sure, I can help with that!',
        toolCalls: [{ id: 'c1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Next?' }] } }],
      },
      {
        content: 'The elephant essay: elephants are the largest land animals.',
        toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: { followups: [{ prompt: 'More?' }] } }],
      },
    ];
    const deps = mockDeps(script, realExecute);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'essay' }], context: ctx, deps });
    expect(result.content).toBe('The elephant essay: elephants are the largest land animals.');
    expect(result.steps).toBe(2);
    expect(result.followups).toEqual([{ prompt: 'More?' }] as FollowupSuggestion[]);
    expect(result.bounded).toBe(false);
  });
});

// ─── Bounded auto-continuation (mid-turn model death / step bound) ──────────
// The user-facing contract: a turn that dies MID-WAY must be resumed rather
// than handed back half-done — and the resume must never re-run work, never
// loop forever, and never change the no-model-failure signalling.

describe('tool loop — bounded auto-continuation', () => {
  /** Deps whose callModel throws on the given 0-based attempt indices. */
  function failingDeps(script: StepResponse[], failAt: number[]): ToolLoopDeps {
    let i = 0;
    const callModel = vi.fn(async () => {
      const attempt = i++;
      if (failAt.includes(attempt)) throw new Error('All LLM providers exhausted (429 on every candidate)');
      return script[Math.min(attempt, script.length - 1)];
    });
    return { callModel, executeTool: vi.fn(async (name: string) => `executed ${name}`), onEvent: vi.fn() };
  }

  it('resumes the SAME turn after a mid-turn generation death (work is not repeated)', async () => {
    // Step 1 gathers (tool runs); step 2's generation dies; the loop resumes
    // and step 2 answers.
    const deps = failingDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { action: 'load', toolset: 'media' } }] },
        { content: 'Finished after the hiccup.', toolCalls: [] },
      ],
      [1],
    );
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'do the thing' }],
      context: ctx,
      deps,
      continuationDelayMs: 0,
    });
    expect(result.content).toBe('Finished after the hiccup.');
    expect(result.continuations).toBe(1);
    expect(result.generationFailed).toBeFalsy();
    // The completed tool call ran EXACTLY once — the resume keeps the thread.
    expect(deps.executeTool).toHaveBeenCalledTimes(1);
  });

  it('preserves partial progress when every attempt dies (bounded, no infinite retry)', async () => {
    const deps = failingDeps(
      [{ content: 'Partial answer so far.', toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { action: 'load', toolset: 'media' } }] }],
      [1, 2, 3, 4, 5, 6, 7],
    );
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      context: ctx,
      deps,
      maxContinuations: 2,
      continuationDelayMs: 0,
    });
    expect(result.continuations).toBe(2);
    expect(result.content).toBe('Partial answer so far.');
    // Progress was made, so this is NOT the no-model path.
    expect(result.generationFailed).toBe(false);
    // 1 successful step + 3 failing attempts (initial + 2 continuations) — never unbounded.
    expect(deps.callModel).toHaveBeenCalledTimes(4);
  });

  it('a turn that RAN A TOOL but produced no answer is a FAILURE, not a success', async () => {
    // Live evidence (dashboard chat, 2026-09-21): the model narrated for a few
    // steps, a `code_search` ran, every candidate then failed the answer-quality
    // gate, and the loop returned the honest line — with `generationFailed:
    // false`, because "something happened" was mistaken for "an answer was
    // delivered". The bubble read "The model wrote its own working notes instead
    // of an answer…" while the surface offered no retry and queued nothing, the
    // gateway would have called the turn fine, and the line was eligible for the
    // answer cache.
    const deps = failingDeps(
      [{ content: '', toolCalls: [{ id: 'c1', name: 'tool_search', arguments: { action: 'load', toolset: 'media' } }] }],
      [1, 2],
    );
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'explain how routing works' }],
      context: ctx,
      deps,
      maxContinuations: 1,
      continuationDelayMs: 0,
    });

    expect(deps.executeTool).toHaveBeenCalledTimes(1); // the tool really ran
    expect(result.generationFailed).toBe(true); // …and there is still no answer
    expect(result.content.trim().length).toBeGreaterThan(0); // the honest line
    expect(result.content).not.toContain('429 on every candidate'); // never raw provider text
  });

  it('does NOT burn time resuming when nothing at all happened', async () => {
    // callModel already walked every candidate — re-walking immediately gains
    // nothing, so the turn surfaces generationFailed straight away for the
    // caller's no-model path (and stays as fast as before on a hard outage).
    const deps = failingDeps([{ content: 'unused', toolCalls: [] }], [0, 1, 2, 3, 4]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      context: ctx,
      deps,
      maxContinuations: 1,
      continuationDelayMs: 0,
    });
    expect(result.generationFailed).toBe(true);
    expect(result.continuations).toBe(0);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });

  it('maxContinuations: 0 keeps the previous behavior byte-identical', async () => {
    const deps = failingDeps([{ content: 'unused', toolCalls: [] }], [0]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      context: ctx,
      deps,
      maxContinuations: 0,
      continuationDelayMs: 0,
    });
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.continuations).toBe(0);
    expect(result.generationFailed).toBe(true);
  });

  it('extends the step bound while the model still has work to do', async () => {
    // maxSteps=2 is exhausted by two tool steps; the continuation grants more
    // and the turn finishes with the real answer instead of "step limit".
    const step = (n: number): StepResponse => ({
      content: '',
      toolCalls: [{ id: `c${n}`, name: 'tool_search', arguments: { action: 'load', toolset: 'media' } }],
    });
    const deps = mockDeps([step(1), step(2), step(3), { content: 'All four steps done.', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'long build' }],
      context: ctx,
      deps,
      maxSteps: 2,
      maxContinuations: 1,
      continuationSteps: 4,
    });
    expect(result.content).toBe('All four steps done.');
    expect(result.bounded).toBe(false);
    expect(result.continuations).toBe(1);
  });

  it('is still honestly bounded once the continuation budget is spent', async () => {
    const step: StepResponse = {
      content: '',
      toolCalls: [{ id: 'c', name: 'tool_search', arguments: { action: 'load', toolset: 'media' } }],
    };
    const deps = mockDeps([step]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'never ends' }],
      context: ctx,
      deps,
      maxSteps: 2,
      maxContinuations: 1,
      continuationSteps: 2,
    });
    expect(result.bounded).toBe(true);
    expect(result.continuations).toBe(1);
    // 2 initial + 2 continuation steps; the model never terminates itself.
    expect(deps.callModel).toHaveBeenCalledTimes(4);
  });
});
