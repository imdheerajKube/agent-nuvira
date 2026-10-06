/**
 * E3b — Tool loop tests (verified against the
 * clone): continues while the model emits tool calls, ends on a no-tools
 * response; think-only responses continue; tool errors force a retry step;
 * the step bound is never infinite. All driven with injected mocks — no
 * network, no TTY.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  runToolLoop,
  isThinkOnlyResponse,
  MAX_THINK_CONTINUES,
  MAX_CAPABILITY_MAX_CONTINUATIONS,
  MAX_CAPABILITY_CONTINUATION_STEPS,
  buildWorkDigest,
  upsertWorkDigest,
  WORK_DIGEST_MARKER,
  selfReviewNudge,
  zeroActionNudge,
  planRequiredNudge,
  isBareAcknowledgment,
  extractFallbackToolCalls,
  fallbackHintForTool,
  makeParallelSuggester,
  type LoopTraceEvent,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext, type FollowupSuggestion } from '../../src/tools/registry.js';
import { requestAuthorizesWrites } from '../../src/learning/autonomy-policy.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  /**
   * Found by RUNNING the loop, not by reading it (two live eval runs,
   * 2026-09-23): continuing on reasoning was UNBOUNDED, so a model that emitted
   * reasoning-without-acting produced 31 consecutive continue steps, one tool
   * call and a 0% score — printing "model reasoning… (continuing)" the whole
   * way. A spin is not a stall the user can act on.
   */
  it('BOUNDS a think-only spin — reasoning must not eat the whole budget', async () => {
    const onTraceEvent = vi.fn();
    // `hmm` is the reasoning-keyword form of think-only output (pinned beside
    // this test), used here so the literal needs no angle brackets.
    const deps = mockDeps([{ content: 'hmm', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps,
      onTraceEvent,
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.steps).toBeLessThanOrEqual(MAX_THINK_CONTINUES + 2);
    // Reported honestly as unfinished, never as a completed answer.
    expect(result.bounded).toBe(true);
    const summaries = onTraceEvent.mock.calls.map((c) => String((c[0] as LoopTraceEvent).summary ?? ''));
    expect(summaries.some((s) => /reasoning-only output repeated/.test(s))).toBe(true);
  });

  /**
   * The distinction that makes the trace evidence honest: `isThinkOnlyResponse('')`
   * is true (an empty string holds no answer), so a provider returning NOTHING
   * was reported as "the model is reasoning". The two are bounded together but
   * named apart — one is the agent deliberating, the other is a transport
   * failure, and a system whose own record confuses them is untrustworthy about
   * both.
   */
  it('names an EMPTY response as a provider failure, not as the model reasoning', async () => {
    const onTraceEvent = vi.fn();
    const deps = mockDeps([{ content: '', toolCalls: [] }]);
    await runToolLoop({
      messages: [{ role: 'user', content: 'q' }],
      context: ctx,
      deps,
      onTraceEvent,
      maxSteps: 30,
      maxContinuations: 0,
    });

    const summaries = onTraceEvent.mock.calls.map((c) => String((c[0] as LoopTraceEvent).summary ?? ''));
    expect(summaries.some((s) => /empty response/.test(s))).toBe(true);
    expect(summaries.some((s) => /reasoning instead of an answer/.test(s))).toBe(false);
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

  /**
   * D1 — the delivered answer must be the run's OWN last word.
   *
   * Measured in `trace-1791300903944-upblb7` (an 82-step run): the longest step
   * was seq 65's 4,024-char "Built and verified. Here's the rundown." draft, while
   * seq 80/82 were 155/165-char CORRECTIONS of it ("My README claim was wrong —
   * I never actually tested that install"). Because `lastContent` used to be
   * replaced only when the new text was at least as long, the turn delivered the
   * draft — and the user read a claim the agent had already disproved itself.
   * Length is the wrong proxy for "a trailing wrapper must not clobber the essay",
   * because a correction is also short. What separates a correction from a closing
   * wrapper is whether the turn DID something in between: text written after real
   * work is an account of a LATER state and supersedes; a closing paragraph
   * written with no work since is presentation.
   */
  it('delivers the run’s own later, SHORTER correction when real work happened since the draft (D1)', async () => {
    const draft =
      'Built and verified. Here is the full rundown: the service reads the model registry, ranks providers by ' +
      'measured quality, records the served pair, and falls back through the configured chain when a call fails.';
    const correction = 'My earlier claim was wrong — that file DOES resolve; I never actually tested the install.';
    expect(correction.length).toBeLessThan(draft.length); // the old length-only rule would have kept the draft
    const script: StepResponse[] = [
      { content: draft, toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'npm run build' } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'run_terminal', arguments: { command: 'ls dist' } }] },
      { content: correction, toolCalls: [] },
    ];
    const deps = mockDeps(script);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'explain how the routing works' }],
      context: ctx,
      deps,
      requireVerification: false,
    });
    expect(result.content).toBe(correction);
    expect(result.content).not.toBe(draft);
  });

  /**
   * The mirror — S1 must survive the D1 fix. A CLOSING wrapper (a short sign-off
   * written with no work since the stored answer) is presentation, not an update,
   * so it must not displace the essay. The essay's own step ran a tool, which is
   * exactly the case the deferred stamp exists for: a step's OWN tool call must
   * not make its own answer look superseded by the next step's wrapper.
   */
  it('a closing wrapper with no work since the essay does NOT displace it (S1 held)', async () => {
    const essay =
      'The routing works like this: the CLI resolves the configured default, the auto router scores candidates, ' +
      'and each fallback is labelled by what the registry has actually proven about it.';
    const wrapper = 'All set — let me know if you want anything else.';
    expect(wrapper.length).toBeLessThan(essay.length);
    const script: StepResponse[] = [
      { content: essay, toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'git log -1' } }] },
      {
        content: wrapper,
        toolCalls: [{ id: 'c2', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Go deeper?' }] } }],
      },
    ];
    const deps = mockDeps(script);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'explain how the routing works' }],
      context: ctx,
      deps,
      requireVerification: false,
    });
    expect(result.content).toBe(essay);
    expect(result.content).not.toContain('let me know');
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

  /**
   * The shape models ACTUALLY write — our tool's name as the ARGUMENTS key.
   * Live: a dashboard chat (2026-09-22) ended 13 of 16 assistant turns with
   * this block; the strip could not see it and the followups were thrown away,
   * so the reader got raw JSON and no chips. Recovery must produce a REAL
   * suggest_followups call so the loop's sink collects them for every surface.
   */
  it('recovers a name-keyed suggest_followups payload as a real call', () => {
    const raw =
      'The project is ready.\n\n---\n' +
      '{"suggest_followups":[' +
      '{"label":"Verify tab switching","prompt":"The tab switching is now working correctly."},' +
      '{"label":"Finalize project","prompt":"I am happy with the features."}]}';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(text).toBe('The project is ready.');
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('suggest_followups');
    const followups = (calls[0].arguments as { followups: { prompt: string; label?: string }[] }).followups;
    expect(followups.map((f) => f.label)).toEqual(['Verify tab switching', 'Finalize project']);
    expect(followups.every((f) => f.prompt.length > 0)).toBe(true);
  });

  it('recovers the name-keyed payload from a fenced block too', () => {
    const raw =
      'All done.\n```json\n{"suggest_followups":[{"prompt":"Go deeper"}]}\n```';
    const { text, calls } = extractFallbackToolCalls(raw);
    expect(text).toBe('All done.');
    expect(calls.map((c) => c.name)).toEqual(['suggest_followups']);
  });

  it('leaves user JSON under that key alone (no call, text intact)', () => {
    const strings = 'Here is your config:\n{"suggest_followups":["alpha","beta"]}';
    const { text, calls } = extractFallbackToolCalls(strings);
    expect(text).toBe(strings);
    expect(calls.length).toBe(0);
    const scalar = 'Note: {"suggest_followups": "see section 4"}';
    expect(extractFallbackToolCalls(scalar).text).toBe(scalar);
    // Unterminated (no closing brace) — must NOT be mistaken for the payload.
    expect(extractFallbackToolCalls('Answer {"tool": broken').text).toContain('broken');
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

  it('max capability mode raises the DEFAULT continuation budget (cost is not a concern)', async () => {
    // A model that never ends on its own: only the budget stops it. With the
    // default mode this would stop after 2 continuations; `max` grants the
    // longest bounded budget so a long build can finish.
    const endless: StepResponse = { content: '', toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: {} }] };
    const deps = mockDeps([endless], async () => 'result');
    const maxCtx: ToolContext = { configManager: { getAll: () => ({ routing: { capabilityMode: 'max' } }) } };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'long build' }],
      context: maxCtx,
      deps,
      maxSteps: 2,
      // No explicit maxContinuations/continuationSteps — the mode supplies them.
    });
    expect(result.bounded).toBe(true);
    expect(result.continuations).toBe(MAX_CAPABILITY_MAX_CONTINUATIONS);
    expect(deps.callModel).toHaveBeenCalledTimes(2 + MAX_CAPABILITY_MAX_CONTINUATIONS * MAX_CAPABILITY_CONTINUATION_STEPS);
  });

  it('an explicit continuation budget still wins over max capability mode', async () => {
    const endless: StepResponse = { content: '', toolCalls: [{ id: 'c1', name: 'verify_requirement', arguments: {} }] };
    const deps = mockDeps([endless], async () => 'result');
    const maxCtx: ToolContext = { configManager: { getAll: () => ({ routing: { capabilityMode: 'max' } }) } };
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'long build' }],
      context: maxCtx,
      deps,
      maxSteps: 2,
      maxContinuations: 1,
      continuationSteps: 3,
    });
    expect(result.continuations).toBe(1);
    expect(deps.callModel).toHaveBeenCalledTimes(5);
  });
});

describe('tool loop — G1 verification gate + G2 edit-claim honesty', () => {
  const editCall = (n: string): StepResponse => ({
    content: '',
    toolCalls: [{ id: `e${n}`, name: 'edit_file', arguments: { path: 'a.js', old_string: 'x', new_string: 'y' } }],
  });

  it('nudges ONCE when files changed and nothing verified them', async () => {
    const deps = mockDeps([
      editCall(1),
      { content: 'I have fixed the bug.', toolCalls: [] },
      { content: 'I have fixed the bug.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    // step 1 edit, step 2 answer -> nudge, step 3 answer -> end.
    expect(deps.callModel).toHaveBeenCalledTimes(3);
    expect(result.unverifiedEdit).toBe(true);
    expect(result.unverifiedEditClaim).toBe(true);
  });

  it('does NOT nudge when a verification tool ran', async () => {
    const deps = mockDeps([
      editCall(1),
      { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
      { content: 'I fixed it and the tests pass.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    expect(deps.callModel).toHaveBeenCalledTimes(3);
    expect(result.unverifiedEdit).toBeUndefined();
    expect(result.unverifiedEditClaim).toBeUndefined();
  });

  it('requireVerification: false suppresses the nudge but STILL flags the edit', async () => {
    const deps = mockDeps([
      editCall(1),
      { content: 'I have fixed it.', toolCalls: [] },
    ]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'fix it' }],
      context: ctx,
      deps,
      requireVerification: false,
    });
    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.unverifiedEdit).toBe(true);
    expect(result.unverifiedEditClaim).toBe(true);
  });

  it('fires the gate on the concluding suggest_followups exit too (the common edit-turn shape)', async () => {
    const deps = mockDeps([
      editCall(1),
      {
        content: 'I have fixed it.',
        toolCalls: [{ id: 's1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Verify now?' }] } }],
      },
      { content: 'I have fixed it.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    expect(deps.callModel).toHaveBeenCalledTimes(3);
    expect(result.unverifiedEdit).toBe(true);
  });

  it('leaves a plain read-only turn completely unaffected', async () => {
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] },
      { content: 'Here is what the file does.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'explain a.js' }], context: ctx, deps });
    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.unverifiedEdit).toBeUndefined();
    expect(result.unverifiedEditClaim).toBeUndefined();
  });

  it('an IRRELEVANT successful run does not satisfy the gate (echo hi)', async () => {
    // Session 4: success alone is not verification — the run must exercise the
    // changed artifact. `echo hi` succeeds and proves nothing.
    const deps = mockDeps(
      [
        editCall(1),
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'echo hi' } }] },
        { content: 'I have fixed it.', toolCalls: [] },
        { content: 'I have fixed it.', toolCalls: [] },
      ],
      async (name) =>
        name === 'run_terminal'
          ? 'run_terminal: `echo hi` ✅ succeeded.\nOutput:\nhi'
          : `executed ${name}`,
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    expect(result.unverifiedEdit).toBe(true);
  });

  it('a RELEVANT run (npm test / naming the file) satisfies the gate', async () => {
    const deps = mockDeps(
      [
        editCall(1),
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
        { content: 'Fixed.', toolCalls: [] },
      ],
      async (name) =>
        name === 'run_terminal' ? 'run_terminal: `npm test` ✅ succeeded.' : `executed ${name}`,
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    expect(result.unverifiedEdit).toBeUndefined();
  });

  it('a FAILED verification does not satisfy the gate (live no-op run_terminal)', async () => {
    // Observed live: the model answered the verification nudge with a
    // `run_terminal` carrying no command. The tool must report an Error so the
    // turn still counts as unverified.
    const deps = mockDeps(
      [
        editCall(1),
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: {} }] },
        { content: 'I have fixed it.', toolCalls: [] },
        { content: 'I have fixed it.', toolCalls: [] },
      ],
      async (name) => (name === 'run_terminal' ? 'Error: run_terminal: empty command — supply the `command` to run.' : `executed ${name}`),
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'fix it' }], context: ctx, deps });
    expect(result.unverifiedEdit).toBe(true);
    expect(result.unverifiedEditClaim).toBe(true);
  });
});

/**
 * G13 — the loop must not end a turn on a request for permission to do work the
 * user's own request already authorized.
 *
 * Observed live: given "develop a web-based interactive book…", the loop ended
 * with "Do you want me to create the full project structure…?" — and over a chat
 * surface that question IS the answer, so the user had to reply before anything
 * was built.
 */
describe('tool loop — authorized-work nudge', () => {
  const STORY_ASK =
    'write a 12 page story called Kharig Nights about a village boy who finds a lamp in a banyan root';

  const PERMISSION_QUESTION =
    'I have the plan ready. Do you want me to create the full project structure with all the chapter files?';

  it('nudges the model to proceed, and delivers the real answer instead of the question', async () => {
    const deps = mockDeps([
      { content: PERMISSION_QUESTION, toolCalls: [] },
      { content: 'Chapter 1 is written and saved to chapters/01-chapter-1.md.', toolCalls: [] },
    ]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: STORY_ASK }],
      context: ctx,
      deps,
      // This test isolates the PERMISSION nudge. The deliverable gate (G13b)
      // would also fire here — the scripted reply claims a file was saved and no
      // write happened — and it has its own tests below. Disabling it here keeps
      // the two gates independently assertable, the same way step-count tests
      // disable the verification gate.
      requireDeliverable: false,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Chapter 1 is written');
    expect(result.content).not.toContain('Do you want me to create');
    // The nudge tells the model the request already authorized the work.
    const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    expect(secondCall.some((m) => m.role === 'user' && m.content.includes('already asked for this work'))).toBe(true);
  });

  it('does NOT nudge when the request never authorized the work', async () => {
    const deps = mockDeps([{ content: PERMISSION_QUESTION, toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'what does the writer agent do?' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(PERMISSION_QUESTION);
  });

  it('does NOT nudge on a genuine content question', async () => {
    const deps = mockDeps([{ content: 'Which of these two titles do you prefer?', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: STORY_ASK }], context: ctx, deps });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('Which of these two titles');
  });

  it('is bounded to ONE nudge — a model that keeps asking cannot loop', async () => {
    const deps = mockDeps([
      { content: PERMISSION_QUESTION, toolCalls: [] },
      { content: PERMISSION_QUESTION, toolCalls: [] },
      { content: PERMISSION_QUESTION, toolCalls: [] },
    ]);
    await runToolLoop({ messages: [{ role: 'user', content: STORY_ASK }], context: ctx, deps });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
  });

  it('keeps real work delivered when the request authorized it (nudge only when nothing was done)', async () => {
    // The question is the LAST sentence after a substantive deliverable: the
    // nudge must not throw the deliverable away.
    //
    // Hermetic: `realExecute` runs the REAL `write_file`, so the workspace is a
    // temp dir — never the repo (an earlier version of this test wrote a stray
    // `chapters/01.md` into the project root).
    const workdir = mkdtempSync(join(tmpdir(), 'nuvira-loop-nudge-'));
    try {
      const deps = mockDeps(
        [
          { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'chapters/01.md', content: 'prose' } }] },
          { content: 'Chapter 1 is on disk.\n\nDo you want me to create the next chapter?', toolCalls: [] },
          { content: 'Chapter 2 is on disk too.', toolCalls: [] },
        ],
        realExecute,
      );
      const result = await runToolLoop({
        messages: [{ role: 'user', content: STORY_ASK }],
        context: { ...ctx, cwd: workdir, writesAuthorized: requestAuthorizesWrites(STORY_ASK) },
        deps,
        requireVerification: false,
      });

      expect(result.toolCalls).toContain('write_file');
      // The post-nudge answer is delivered — and the trailing PERMISSION
      // question is not what the user is handed. Without stripping it, the
      // longer "Chapter 1 is on disk.\n\nDo you want me to…?" would outrank the
      // real follow-up under the longest-substantive rule.
      expect(result.content).toContain('Chapter 2 is on disk too');
      expect(result.content).not.toContain('Do you want me to create the next chapter');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe('tool loop — the request itself is the authorization (G16)', () => {
  // The wiring test for the whole audit: the gates can only stop asking for
  // permission if the RAW request reaches them. The loop used to derive a single
  // file-shaped boolean, which cannot answer "does the request name THIS file".
  const FIX_ASK = 'fix the calculator so that division by zero returns 0 instead of NaN';

  it('threads the raw request into the tools, so a named file is edited without a round trip', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'nuvira-loop-authz-'));
    try {
      mkdirSync(join(workdir, 'src'), { recursive: true });
      writeFileSync(join(workdir, 'src/calc.ts'), 'export const div = (a: number, b: number) => a / b;\n', 'utf-8');

      const deps = mockDeps(
        [
          {
            content: '',
            toolCalls: [
              {
                id: 'e1',
                name: 'edit_file',
                arguments: {
                  path: 'src/calc.ts',
                  old_string: 'a / b;',
                  new_string: 'b === 0 ? 0 : a / b;',
                },
              },
            ],
          },
          { content: 'Fixed: division by zero now returns 0.', toolCalls: [] },
        ],
        realExecute,
      );

      const result = await runToolLoop({
        messages: [{ role: 'user', content: FIX_ASK }],
        // NOTE: no `writesAuthorized` is passed — the loop must derive both the
        // verdict and the raw text from the messages itself.
        context: { ...ctx, cwd: workdir },
        deps,
        requireVerification: false,
      });

      expect(result.toolCalls).toContain('edit_file');
      expect(readFileSync(join(workdir, 'src/calc.ts'), 'utf-8')).toContain('b === 0 ? 0 : a / b;');
      // The tool reported the judgment call back to the model, which is the
      // proof it applied the edit rather than asking for permission.
      const fedBack = JSON.stringify(deps.callModel.mock.calls[1][0]);
      expect(fedBack).toContain('Applied without asking');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('still hands the tools NO authorization when the request never asked for the work', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'nuvira-loop-authz-'));
    try {
      writeFileSync(join(workdir, 'keep.txt'), 'original\n', 'utf-8');

      const deps = mockDeps(
        [
          {
            content: '',
            toolCalls: [
              { id: 'e2', name: 'edit_file', arguments: { path: 'keep.txt', old_string: 'original', new_string: 'changed' } },
            ],
          },
          { content: 'Done.', toolCalls: [] },
        ],
        realExecute,
      );

      await runToolLoop({
        messages: [{ role: 'user', content: 'what does the writer agent do?' }],
        context: { ...ctx, cwd: workdir },
        deps,
        requireVerification: false,
      });

      // Unauthorized work is untouched, and the model was told to ask.
      expect(readFileSync(join(workdir, 'keep.txt'), 'utf-8')).toBe('original\n');
      expect(JSON.stringify(deps.callModel.mock.calls[1][0])).toContain('state-changing — NOT applied');
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

/**
 * G13b — THE DELIVERABLE GATE.
 *
 * The failure this closes, captured live: a request that asked for a 12-page
 * story to be WRITTEN was answered with a complete, genuinely good story in the
 * chat reply and NOTHING on disk. The turn reported success, so every surface
 * read it as finished work, the ledger never saw a deliverable to continue or
 * assemble, and the one ask where the artifact matters most was the one path
 * that never checked for it.
 *
 * Two properties are load-bearing here and are asserted separately: the gate
 * asks for the artifact (bounded, once, naming the destination the REQUEST gave),
 * and the residual is reported honestly whether or not the gate ran.
 */
describe('tool loop — deliverable gate (G13b)', () => {
  /** A file-shaped authored ask that names its destination. */
  const STORY_TO_PATH =
    'write a 12 page story to /tmp/kharig-nights.md about a village boy who finds a lamp';
  /** The same work, asked as CHAT — no artifact requested. */
  const CHAT_STORY = 'tell me a story about a village boy who finds a lamp';
  const PROSE = 'Once, in the village of Kharig, a boy found a lamp in a banyan root. The end.';

  it('does not let a story ask be satisfied by prose — the artifact is written', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'nuvira-loop-deliverable-'));
    try {
      const target = join(workdir, 'kharig-nights.md');
      const deps = mockDeps(
        [
          // Step 1 — the model composes the whole story in the reply and calls
          // no tool. This is the exact shipped failure.
          { content: PROSE, toolCalls: [] },
          // Step 2 — after the nudge, it writes the file.
          {
            content: '',
            toolCalls: [
              { id: 'w1', name: 'write_file', arguments: { path: target, content: PROSE } },
            ],
          },
          { content: `Saved to ${target}.`, toolCalls: [] },
        ],
        realExecute,
      );

      const result = await runToolLoop({
        messages: [{ role: 'user', content: `write a 12 page story to ${target} about a village boy` }],
        context: { ...ctx, cwd: workdir },
        deps,
      });

      // The artifact EXISTS — the whole point of the gate.
      expect(readFileSync(target, 'utf-8')).toContain('Kharig');
      // The nudge told the model the destination the REQUEST gave, not one it
      // would otherwise have invented.
      // Read the RAW message contents, not their JSON form: JSON.stringify
      // escapes a Windows path's backslashes (`\\`), so a containment check on
      // the serialized turn can never match `target` there.
      const nudgeTurn = (deps.callModel.mock.calls[1][0] as Array<{ content?: string }>)
        .map((m) => m.content ?? '')
        .join('\n');
      expect(nudgeTurn).toContain(`write a 12 page story to ${target}`);
      expect(nudgeTurn).toContain('write the complete work to');
      // A turn that produced the file is not flagged as undelivered.
      expect(result.undeliveredArtifact).toBeFalsy();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('names no destination it was not given — and still asks for the artifact', async () => {
    const deps = mockDeps([
      { content: PROSE, toolCalls: [] },
      { content: 'Understood.', toolCalls: [] },
    ]);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write a 12 page story called Kharig Nights about a village boy' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
    const nudgeTurn = JSON.stringify(deps.callModel.mock.calls[1][0]);
    expect(nudgeTurn).toContain('write the complete work to a file');
    // Never invents a path the request did not give.
    expect(nudgeTurn).not.toContain('/tmp/');
    // …and if the model still writes nothing, the residual is reported.
    expect(result.undeliveredArtifact).toBe(true);
  });

  it('is bounded to ONE nudge', async () => {
    const deps = mockDeps([
      { content: PROSE, toolCalls: [] },
      { content: PROSE, toolCalls: [] },
      { content: PROSE, toolCalls: [] },
    ]);

    await runToolLoop({
      messages: [{ role: 'user', content: 'write a 12 page story called Kharig Nights' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(2);
  });

  it('leaves a CHAT story ask alone — no artifact was requested', async () => {
    const deps = mockDeps([{ content: PROSE, toolCalls: [] }]);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: CHAT_STORY }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(PROSE);
    expect(result.undeliveredArtifact).toBeFalsy();
  });

  it('leaves a consult alone — a turn that ENDS on a question to the reader', async () => {
    // "Which title do you prefer?" is a decision input the user asked to be
    // consulted on, unlike "Do you want me to create the files?" (a stall the
    // permission nudge settles). Bulldozing it would be the cadence complaint
    // in reverse.
    const deps = mockDeps([{ content: 'Which of these two titles do you prefer?', toolCalls: [] }]);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write a 12 page story called Kharig Nights' }],
      context: ctx,
      deps,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.undeliveredArtifact).toBeFalsy();
  });

  it('a turn that already wrote files is never nudged for a missing artifact', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'nuvira-loop-deliverable-'));
    try {
      const target = join(workdir, 'chapter-01.md');
      const deps = mockDeps(
        [
          {
            content: '',
            toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: target, content: 'Chapter 1.' } }],
          },
          { content: 'Chapter 1 is written.', toolCalls: [] },
        ],
        realExecute,
      );

      const result = await runToolLoop({
        messages: [{ role: 'user', content: `write a story to ${target}` }],
        context: { ...ctx, cwd: workdir },
        deps,
        // The VERIFICATION gate is a different feature with its own tests; it
        // would fire here (a write with no check) and add a third call.
        requireVerification: false,
      });

      expect(deps.callModel).toHaveBeenCalledTimes(2);
      expect(result.undeliveredArtifact).toBeFalsy();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it('requireDeliverable:false restores the pre-gate behaviour exactly', async () => {
    const deps = mockDeps([{ content: PROSE, toolCalls: [] }]);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write a 12 page story called Kharig Nights' }],
      context: ctx,
      deps,
      requireDeliverable: false,
    });

    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(PROSE);
  });
});

/**
 * G18 — the loop engine's non-LLM facts: tool calls, gate decisions and
 * REFUSALS.
 *
 * The gap this closes was recorded as a limit on every earlier audit: the loop
 * wrote no trace, so "the trace store showed 0 refusals" meant *it cannot see
 * refusals*, not *there were none*, and the audit of the confirmation gates had
 * to be done by reading code and driving the real tools. These tests pin the
 * three event kinds AND the honesty property that came out of the first live
 * verification run: a DECLINED call must not be recorded — or COUNTED — as work
 * done.
 */
describe('tool loop — trace events (G18)', () => {
  /** Collect every event the loop emits for one turn. */
  function collect(): { events: LoopTraceEvent[]; sink: (e: LoopTraceEvent) => void } {
    const events: LoopTraceEvent[] = [];
    return { events, sink: (e) => events.push(e) };
  }

  /**
   * SELF-DIAGNOSIS — the same action failing repeatedly must trigger ONE
   * bounded nudge to diagnose the cause, not another blind retry.
   *
   * The live macOS-build turn re-issued `npx tauri build` ~10 times against the
   * same missing Rust/Cargo. Nothing in the loop noticed the repetition: a
   * refusal was remembered, a command that RAN and FAILED was not. This drives
   * the REAL loop with the identical failing call and asserts the `diagnosis`
   * gate fires with the corrective message, and that a run of DISTINCT failures
   * does NOT fire it (ordinary iteration is not a loop).
   */
  it('fires ONE diagnosis nudge when the SAME action fails repeatedly', async () => {
    const { events, sink } = collect();
    const seenThreads: string[][] = [];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (messages: readonly { role: string; content: string }[]) => {
        seenThreads.push(messages.map((m) => String(m.content ?? '')));
        // Always re-issue the identical failing command, then finally stop.
        const calls = messages.filter((m) => m.role === 'tool').length;
        return calls < 3
          ? { content: '', toolCalls: [{ id: `c${calls}`, name: 'run_terminal', arguments: { command: 'npx tauri build' } }] }
          : { content: 'Diagnosed: cargo is missing; installing it first.', toolCalls: [] };
      }),
      executeTool: vi.fn(async () => 'Error: run_terminal: `npx tauri build` ❌ failed (exit 1).\nOutput:\ncommand not found: cargo'),
      onEvent: vi.fn(),
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'build the mac app' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    const diagnosis = events.filter((e) => e.kind === 'gate' && e.gate === 'diagnosis');
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].summary).toContain('npx tauri build');
    // The corrective message reached the model: a later prompt carries it.
    const nudgeSeen = seenThreads.some((t) => t.some((c) => c.includes('ROOT CAUSE')));
    expect(nudgeSeen).toBe(true);
  });

  it('does NOT fire the diagnosis nudge for ordinary iteration (distinct failures)', async () => {
    const { events, sink } = collect();
    const cmds = ['npm test', 'npm run build', 'npm run lint'];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (messages: readonly { role: string; content: string }[]) => {
        const calls = messages.filter((m) => m.role === 'tool').length;
        return calls < cmds.length
          ? { content: '', toolCalls: [{ id: `c${calls}`, name: 'run_terminal', arguments: { command: cmds[calls] } }] }
          : { content: 'Three checks tried.', toolCalls: [] };
      }),
      executeTool: vi.fn(async () => 'Error: run_terminal: ❌ failed (exit 1).'),
      onEvent: vi.fn(),
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'check the project' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'diagnosis')).toHaveLength(0);
  });

  it('generalizes self-diagnosis: a sustained all-fail stall fires even when NO action repeats', async () => {
    // The second loop shape: a weak model substitutes a NEW command each step,
    // every one failing the same underlying way. Nothing repeats exactly, so
    // `repeatedFailure` never fires — the sustained no-progress streak must.
    const { events, sink } = collect();
    const seenThreads: string[][] = [];
    const cmds = ['npx tauri build', 'cargo build', 'rustc src/main.rs', 'cargo install tauri-cli'];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (messages: readonly { role: string; content: string }[]) => {
        seenThreads.push(messages.map((m) => String(m.content ?? '')));
        const calls = messages.filter((m) => m.role === 'tool').length;
        return calls < cmds.length
          ? { content: '', toolCalls: [{ id: `c${calls}`, name: 'run_terminal', arguments: { command: cmds[calls] } }] }
          : { content: 'Diagnosed: the Rust toolchain is missing; installing it first.', toolCalls: [] };
      }),
      executeTool: vi.fn(async () => 'Error: run_terminal: ❌ failed (exit 127).\nOutput:\ncommand not found: cargo'),
      onEvent: vi.fn(),
    };

    await runToolLoop({
      messages: [{ role: 'user', content: 'build the mac app' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    const diagnosis = events.filter((e) => e.kind === 'gate' && e.gate === 'diagnosis');
    expect(diagnosis).toHaveLength(1);
    expect(diagnosis[0].summary).toContain('none succeeded');
    expect(seenThreads.some((t) => t.some((c) => c.includes('STALL')))).toBe(true);
  });

  it('records a tool call with its args, result preview, verdict and duration', async () => {
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/router.ts' } }] },
        { content: 'Read it.', toolCalls: [] },
      ],
      async () => 'export const router = 1;',
    );

    await runToolLoop({
      messages: [{ role: 'user', content: 'read src/router.ts' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    const tool = events.find((e) => e.kind === 'tool');
    expect(tool?.tool).toBe('read_file');
    expect(tool?.ok).toBe(true);
    expect(tool?.args).toContain('src/router.ts');
    expect(tool?.result).toContain('export const router');
    expect(typeof tool?.durationMs).toBe('number');
  });

  it('records a CONFIRMATION refusal with its gate, and never as a success', async () => {
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.md', content: 'x' } }] },
        { content: 'Understood.', toolCalls: [] },
      ],
      async () =>
        'Error: write_file: needs explicit confirmation — call ask_user first, then retry with confirm:true',
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write a poem about rain' }],
      context: ctx,
      deps,
      requireDeliverable: false,
      onTraceEvent: sink,
    });

    const refusal = events.find((e) => e.kind === 'refusal');
    expect(refusal?.tool).toBe('write_file');
    expect(refusal?.gate).toBe('confirmation');
    expect(refusal?.ok).toBe(false);
    expect(result.successfulToolCalls ?? []).not.toContain('write_file');
  });

  it('records a WORKSPACE-boundary denial as a refusal — the denial that used no `Error:` prefix', async () => {
    // Found live on the first G18 verification run: the workspace guard returned
    // "… escapes the workspace (…) — denied" with NO `Error:` prefix, so the loop
    // counted the call as one that RAN and the trace said "write_file ran". An
    // outcome reading the same as its opposite is the exact shape G18 exists to
    // eliminate.
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: '/etc/hosts', content: 'x' } }] },
        { content: 'I could not write there.', toolCalls: [] },
      ],
      async () => "write_file: path '/etc/hosts' escapes the workspace (/tmp/proj) — denied",
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write the report to /etc/hosts' }],
      context: ctx,
      deps,
      requireDeliverable: false,
      onTraceEvent: sink,
    });

    const refusal = events.find((e) => e.kind === 'refusal');
    expect(refusal?.tool).toBe('write_file');
    expect(refusal?.gate).toBe('workspace');
    expect(refusal?.ok).toBe(false);
    // Attempted, but NOT done — the two lists must disagree here.
    expect(result.toolCalls).toContain('write_file');
    expect(result.successfulToolCalls ?? []).not.toContain('write_file');
  });

  it('classifies the REAL `confirmFirst` wording as a confirmation refusal — it read as a success', async () => {
    // The wording `coding-tools.ts` actually returns: "write_file: state-changing —
    // NOT applied. Ask the user first via ask_user (…), then retry write_file with
    // confirm:true once they approve." It matched none of the classifier's patterns
    // ("retry with confirm" is not "retry write_file with confirm"), so a write that
    // was NOT applied counted as a call that RAN: it landed in `successfulToolCalls`,
    // its path landed in `mutatedPaths`, and the verification gate then asked the
    // model to verify a file nothing had written. Found by the child's gate, which
    // reported `unverifiedEdit` for an empty diff.
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.md', content: 'x' } }] },
        { content: 'a.md was not written — the tool needs your approval first.', toolCalls: [] },
      ],
      async () =>
        'write_file: state-changing — NOT applied. Ask the user first via ask_user ("Apply writing 1 chars to a.md?" with a one-line summary), then retry write_file with confirm:true once they approve.',
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'write the notes to a.md' }],
      context: ctx,
      deps,
      requireDeliverable: false,
      onTraceEvent: sink,
    });

    const refusal = events.find((e) => e.kind === 'refusal');
    expect(refusal?.tool).toBe('write_file');
    expect(refusal?.gate).toBe('confirmation');
    expect(result.successfulToolCalls ?? []).not.toContain('write_file');
    // And no verification was asked for: there was nothing to verify.
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'verification')).toEqual([]);
    expect(deps.callModel).toHaveBeenCalledTimes(2);
  });

  it('records the authorized-work nudge as a gate DECISION', async () => {
    const { events, sink } = collect();
    const deps = mockDeps([
      {
        content: 'I have the plan ready. Do you want me to create the full project structure?',
        toolCalls: [],
      },
      { content: 'Created the structure.', toolCalls: [] },
    ]);

    await runToolLoop({
      messages: [{ role: 'user', content: 'create the project files for a booking app' }],
      context: ctx,
      deps,
      requireDeliverable: false,
      onTraceEvent: sink,
    });

    const gate = events.find((e) => e.kind === 'gate');
    expect(gate?.gate).toBe('permission');
    expect(gate?.summary).toMatch(/permission/i);
  });

  it('records the DELIVERABLE nudge as a gate decision naming the requested path', async () => {
    const { events, sink } = collect();
    const deps = mockDeps([
      { content: 'Here is the story: once upon a time…', toolCalls: [] },
      { content: 'Saved.', toolCalls: [] },
    ]);

    await runToolLoop({
      messages: [{ role: 'user', content: 'write a 12 page story to /tmp/kharig-nights.md' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    const gate = events.find((e) => e.kind === 'gate' && e.gate === 'deliverable');
    expect(gate).toBeTruthy();
    expect(gate?.summary).toContain('/tmp/kharig-nights.md');
  });

  it('records the step bound as a decision when the turn runs out of road', async () => {
    const { events, sink } = collect();
    // The model loops forever on the same call — the bound is what ends it.
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
    ]);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'keep reading a.ts' }],
      context: ctx,
      deps,
      maxSteps: 3,
      onTraceEvent: sink,
    });

    expect(result.bounded).toBe(true);
    const bound = events.find((e) => e.gate === 'budget');
    expect(bound?.kind).toBe('decision');
    // The summary names the EFFECTIVE bound (the continuation budget extends it
    // past `maxSteps`), so the number is asserted as present rather than equal.
    expect(bound?.summary).toMatch(/step budget \(\d+\) was reached/);
  });

  it('does not let a broken sink break the turn it observes', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { content: 'Read it.', toolCalls: [] },
      ],
      async () => 'contents',
    );

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'read a.ts' }],
      context: ctx,
      deps,
      onTraceEvent: () => {
        throw new Error('recorder exploded');
      },
    });

    expect(result.content).toBe('Read it.');
  });
});

// ─── WS4 (#26): the operator's tool hooks, from the loop ────────────────────

describe('WS4 tool hooks — the veto, and what it must NOT touch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-hooks-'));
  const logPath = join(dir, 'hook-log.jsonl');
  const scriptPath = join(dir, 'hook.mjs');

  /** The hook the operator declares here: deny `read_file`, record everything. */
  writeFileSync(
    scriptPath,
    [
      "import { appendFileSync } from 'node:fs';",
      "let raw = '';",
      "process.stdin.setEncoding('utf8');",
      'for await (const c of process.stdin) raw += c;',
      'const p = JSON.parse(raw);',
      'appendFileSync(process.env.WS4_LOG, JSON.stringify({ phase: p.phase, tool: p.tool }) + String.fromCharCode(10));',
      "if (p.phase === 'before' && p.tool === 'read_file') process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'reads are frozen' }));",
    ].join('\n'),
  );

  // Declared in `beforeAll`, not at collection time: a hook left declared for the
  // whole FILE would sit in front of every other test's tool calls, and a
  // `read_file` those tests expect to succeed would come back refused.
  let before: string | undefined;
  let after: string | undefined;
  let log: string | undefined;
  beforeAll(() => {
    before = process.env.NUVIRA_TOOL_HOOK_BEFORE;
    after = process.env.NUVIRA_TOOL_HOOK_AFTER;
    log = process.env.WS4_LOG;
    process.env.NUVIRA_TOOL_HOOK_BEFORE = `node ${scriptPath}`;
    process.env.NUVIRA_TOOL_HOOK_AFTER = `node ${scriptPath}`;
    process.env.WS4_LOG = logPath;
  });

  /** Every hook invocation recorded so far, as `phase:tool`. */
  const invocations = (): string[] =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const entry = JSON.parse(line) as { phase: string; tool: string };
        return `${entry.phase}:${entry.tool}`;
      });

  it('refuses the denied call and runs the NEXT one normally', async () => {
    // The regression this pins: a decision must not outlive the call it was made
    // for. A veto that leaked forward would refuse every later call in the turn,
    // which looks like a working policy and is a broken agent.
    const ran: string[] = [];
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { content: '', toolCalls: [{ id: 'c2', name: 'list_dir', arguments: { path: '.' } }] },
        { content: 'Done.', toolCalls: [] },
      ],
      async (name) => {
        ran.push(name);
        return 'ran';
      },
    );

    const events: string[] = [];
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'read then list' }],
      context: ctx,
      deps: {
        ...deps,
        onEvent: (line: string) => {
          events.push(line);
        },
      },
      surface: 'cli-chat',
    });

    expect(result.content).toBe('Done.');
    // The denied tool never ran; the next one did.
    expect(ran).toEqual(['list_dir']);
    expect(events.join('\n')).toContain('read_file — refused by a tool hook');
    // And the model was told, in the shape every other failed call takes.
    const calls = deps.callModel.mock.calls;
    const second = calls[1][0] as Array<{ role: string; content: string }>;
    expect(
      second.some((m) => m.role === 'tool' && m.content.includes('refused by a tool hook')),
    ).toBe(true);

    // The hook saw the denied call (before only — a veto is not a call that ran)
    // and the call that ran (before AND after). A leaked decision would show up
    // here as a second before with no after.
    expect(invocations()).toEqual(['before:read_file', 'before:list_dir', 'after:list_dir']);
  });

  afterAll(() => {
    if (before === undefined) delete process.env.NUVIRA_TOOL_HOOK_BEFORE;
    else process.env.NUVIRA_TOOL_HOOK_BEFORE = before;
    if (after === undefined) delete process.env.NUVIRA_TOOL_HOOK_AFTER;
    else process.env.NUVIRA_TOOL_HOOK_AFTER = after;
    if (log === undefined) delete process.env.WS4_LOG;
    else process.env.WS4_LOG = log;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 4c — onStep step-boundary snapshot', () => {
  it('reports the live thread + accumulators once per step that ran tools', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { content: '', toolCalls: [{ id: 'c2', name: 'list_dir', arguments: { path: '.' } }] },
        { content: 'Done.', toolCalls: [] },
      ],
      async (name) => `${name} ok`,
    );
    const seen: Array<{ steps: number; threadLen: number; tools: string[] }> = [];
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      context: ctx,
      deps,
      onStep: (s) => seen.push({ steps: s.steps, threadLen: s.thread.length, tools: [...s.successfulTools] }),
    });

    expect(result.content).toBe('Done.');
    // Two tool-bearing steps; the final answer step has no tool boundary.
    expect(seen.length).toBe(2);
    expect(seen[0].tools).toContain('read_file');
    expect(seen[1].tools).toContain('list_dir');
    // The thread GROWS as tool results land, so the second snapshot is larger.
    expect(seen[1].threadLen).toBeGreaterThan(seen[0].threadLen);
  });

  it('a throwing onStep never breaks the turn', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }] },
        { content: 'Done.', toolCalls: [] },
      ],
      async () => 'ok',
    );
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'go' }],
      context: ctx,
      deps,
      onStep: () => {
        throw new Error('snapshot blew up');
      },
    });
    expect(result.content).toBe('Done.');
  });
});

describe('work digest — the memory a compacted thread keeps', () => {
  it('records changes, command verdicts and tools (bounded, deduped)', () => {
    const digest = buildWorkDigest({
      successfulTools: ['read_file', 'run_terminal', 'read_file'],
      mutatedPaths: ['src/a.ts', 'src/a.ts', 'src/b.ts'],
      executedActions: [
        { tool: 'run_terminal', ok: false, command: 'npm test' },
        { tool: 'run_terminal', ok: true, command: 'npm run build' },
        { tool: 'read_file', ok: true, path: 'src/a.ts' },
      ],
    });
    expect(digest.startsWith(WORK_DIGEST_MARKER)).toBe(true);
    expect(digest).toContain('src/a.ts');
    expect(digest).toContain('❌ npm test');
    expect(digest).toContain('✅ npm run build');
    expect(digest).toContain('Tools used: read_file, run_terminal');
  });

  it('returns nothing for a turn that has done nothing (no prompt noise)', () => {
    expect(buildWorkDigest({ successfulTools: [], mutatedPaths: [], executedActions: [] })).toBe('');
  });

  it('upserts ONE digest (never stacks) and keeps it just after the ask', () => {
    const thread = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'the ask' },
      { role: 'assistant', content: '', toolCalls: [] },
    ] as unknown as Parameters<typeof upsertWorkDigest>[0];
    upsertWorkDigest(thread, `${WORK_DIGEST_MARKER}\nold`);
    upsertWorkDigest(thread, `${WORK_DIGEST_MARKER}\nnew`);
    const digests = thread.filter((m) => m.content.startsWith(WORK_DIGEST_MARKER));
    expect(digests).toHaveLength(1);
    expect(digests[0].content).toContain('new');
    expect(thread[1].role).toBe('user'); // the ask is still second
    expect(thread[2].content.startsWith(WORK_DIGEST_MARKER)).toBe(true);
  });

  it('injects the digest into the thread once compaction fires', async () => {
    const big = 'y'.repeat(3000);
    const seenThreads: string[][] = [];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (messages: readonly { role: string; content?: string }[]) => {
        seenThreads.push(messages.map((m) => String(m.content ?? '')));
        const calls = messages.filter((m) => m.role === 'tool').length;
        return calls < 8
          ? { content: '', toolCalls: [{ id: `c${calls}`, name: 'read_file', arguments: { path: `f${calls}.txt` } }] }
          : { content: 'done', toolCalls: [] };
      }),
      executeTool: vi.fn(async () => big),
      onEvent: vi.fn(),
    };
    await runToolLoop({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read everything' }],
      context: ctx,
      deps,
      maxSteps: 12,
      threadBudgetChars: 2000,
      maxContinuations: 0,
    });
    expect(seenThreads.some((t) => t.some((c) => c.startsWith(WORK_DIGEST_MARKER)))).toBe(true);
  });
});

describe('self-review — the wrong-direction catch', () => {
  function collect() {
    const events: LoopTraceEvent[] = [];
    return { events, sink: (e: LoopTraceEvent) => events.push(e) };
  }

  it('names the ask and demands evidence from THIS turn', () => {
    const text = selfReviewNudge('build the mac app and give me the app');
    expect(text).toContain('build the mac app');
    expect(text).toMatch(/ORIGINAL request/);
    expect(text).toMatch(/EVERY part/);
    expect(text).toMatch(/backed by a tool result from THIS turn/);
    // It must forbid padding, not invite a longer answer.
    expect(text).toMatch(/Do NOT restate the work in more words/);
  });

  it('fires ONCE for a substantial VERIFIED turn and reaches the model', async () => {
    const { events, sink } = collect();
    const seenThreads: string[][] = [];
    const files = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'];
    const deps: ToolLoopDeps = {
      callModel: vi.fn(async (messages: readonly { role: string; content?: string }[]) => {
        seenThreads.push(messages.map((m) => String(m.content ?? '')));
        const tools = messages.filter((m) => m.role === 'tool').length;
        if (tools < files.length) {
          return {
            content: '',
            toolCalls: [{ id: `e${tools}`, name: 'edit_file', arguments: { path: files[tools], old_string: 'x', new_string: 'y' } }],
          };
        }
        if (tools === files.length) {
          return { content: '', toolCalls: [{ id: 'v1', name: 'run_terminal', arguments: { command: 'npm test' } }] };
        }
        return { content: 'Refactor complete and the tests pass.', toolCalls: [] };
      }),
      executeTool: vi.fn(async (name: string) => (name === 'run_terminal' ? 'all tests passed' : 'ok')),
      onEvent: vi.fn(),
    };

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'refactor the calculator so every operation works, and make sure the tests pass' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });

    const reviews = events.filter((e) => e.kind === 'gate' && e.gate === 'self-review');
    expect(reviews).toHaveLength(1);
    expect(seenThreads.some((t) => t.some((c) => c.includes('REVIEW your result')))).toBe(true);
    expect(result.content).toContain('Refactor complete');
  });

  it('does NOT fire for a SHORT edit turn (byte-identical to before)', async () => {
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'e1', name: 'edit_file', arguments: { path: 'a.js', old_string: 'x', new_string: 'y' } }] },
        { content: 'Edited a.js.', toolCalls: [] },
      ],
      async () => 'ok',
    );
    await runToolLoop({
      messages: [{ role: 'user', content: 'tweak a.js' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'self-review')).toHaveLength(0);
  });

  it('does NOT fire when the turn changed nothing (a read-only answer)', async () => {
    const { events, sink } = collect();
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.js' } }] },
        { content: 'Here is what a.js does.', toolCalls: [] },
      ],
      async () => 'const x = 1;',
    );
    await runToolLoop({
      messages: [{ role: 'user', content: 'explain a.js' }],
      context: ctx,
      deps,
      onTraceEvent: sink,
    });
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'self-review')).toHaveLength(0);
  });
});

// ─── ZERO-ACTION gate ───────────────────────────────────────────────────────
// Found live (loop arm of `nuvira eval parity`): a fully specified four-part
// coding ask ended in prose with ZERO tool calls and ZERO file edits, five runs
// out of six — and `generationFailed` stayed false, so every surface read the
// turn as completed. The gates that existed all key on a POSITIVE shape in the
// reply (an announced action, a permission question, an authored file) and so
// missed a plain non-answer. This gate keys on the REQUEST and the ABSENCE of
// action.
const WORK_ASK = 'Make these four changes in this project, then verify them: fix add in math.js, add subtract, write test.js, and run the test.';

describe('tool loop — ZERO-ACTION gate (a directed work request answered with nothing)', () => {
  it('nudges ONCE to do the work, then honours the requirement', async () => {
    const threads: Array<Array<{ role: string; content: string }>> = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      { content: 'Sure, I can help with that.', toolCalls: [] },
      { content: 'Here is how it could be done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const deps: ToolLoopDeps = { callModel, executeTool: vi.fn(async (n) => `executed ${n}`), onEvent: vi.fn() };
    const result = await runToolLoop({ messages: [{ role: 'user', content: WORK_ASK }], context: ctx, deps });
    // step 1 non-answer → nudge → step 2 answer → end.
    expect(callModel).toHaveBeenCalledTimes(2);
    // The nudge reached the model on the second call.
    expect(threads[1].some((m) => m.content.includes('Nothing has been done yet'))).toBe(true);
    // Residual honesty: the request directed work and none was done.
    expect(result.noActionTaken).toBe(true);
  });

  it('does NOT fire for a plain chat ask (no directed work)', async () => {
    const deps = mockDeps([{ content: '2 + 2 is 4.', toolCalls: [] }]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: 'what is 2+2?' }], context: ctx, deps });
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.noActionTaken).toBeUndefined();
  });

  it('does NOT fire when a tool already succeeded (a read-only answer)', async () => {
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'math.js' } }] },
        { content: 'Here is what math.js does.', toolCalls: [] },
      ],
      async () => 'const x = 1;',
    );
    const result = await runToolLoop({ messages: [{ role: 'user', content: WORK_ASK }], context: ctx, deps });
    expect(deps.callModel).toHaveBeenCalledTimes(2);
    // The flag is set only when nothing was done (the codebase convention for
    // honesty flags); a turn that acted leaves it absent.
    expect(result.noActionTaken).toBeUndefined();
  });

  it('fires on the concluding suggest_followups exit when only the conclusion ran', async () => {
    const deps = mockDeps([
      {
        content: 'I have completed the changes.',
        toolCalls: [{ id: 's1', name: 'suggest_followups', arguments: { followups: [{ prompt: 'Verify now?' }] } }],
      },
      { content: 'All set.', toolCalls: [] },
    ]);
    const result = await runToolLoop({ messages: [{ role: 'user', content: WORK_ASK }], context: ctx, deps });
    // step 1 conclude (no real work) → nudge → step 2 answer → end.
    expect(deps.callModel).toHaveBeenCalledTimes(2);
    expect(result.noActionTaken).toBe(true);
  });

  it('respects requireAction: false (byte-identical to before)', async () => {
    const deps = mockDeps([{ content: 'Sure, I can help.', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      requireAction: false,
    });
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    // The residual flag is a function of what the turn DID, not of the gate.
    expect(result.noActionTaken).toBe(true);
  });

  it('never fires when the request forbade writes', async () => {
    const deps = mockDeps([{ content: 'The file says hello.', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'Read report.txt and answer in chat — do not write any files.' }],
      context: ctx,
      deps,
    });
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(result.noActionTaken).toBeUndefined();
  });

  it('zeroActionNudge names the ask and forbids a plan/apology in place of the work', async () => {
    const text = zeroActionNudge(WORK_ASK);
    expect(text).toContain('Nothing has been done yet');
    expect(text).toContain('math.js');
    expect(text).toContain('Do NOT reply with a plan');
  });
});

// ─── PLAN gate (E2) ─────────────────────────────────────────────────────────
// A workspace-directing turn about to MUTATE without a declared plan is stopped
// ONCE: the first mutating batch is refused and the model is told to plan first.
// Bounded by design — the SECOND attempt runs even without a plan, so the gate
// guides rather than walls.
describe('tool loop — PLAN gate (declare a plan before mutating)', () => {
  it('nudges once when a directed turn mutates without a plan', async () => {
    const events: LoopTraceEvent[] = [];
    const threads: Array<Array<{ role: string; content: string }>> = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.js', content: 'x' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const deps: ToolLoopDeps = { callModel, executeTool: vi.fn(async (n) => `executed ${n}`), onEvent: vi.fn() };
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: (e) => events.push(e),
    });
    // The nudge reached the model on the next step.
    expect(threads[1]?.some((m) => m.content.includes('declare a short PLAN'))).toBe(true);
    // …and it was recorded as a bounded gate decision.
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(1);
  });

  it('blocks the first mutation ONCE, then lets the retry through (hard gate)', async () => {
    const events: LoopTraceEvent[] = [];
    const threads: Array<Array<{ role: string; content: string }>> = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.js', content: 'x' } }] },
      { content: '', toolCalls: [{ id: 'w2', name: 'write_file', arguments: { path: 'a.js', content: 'x' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const executeTool = vi.fn(async (n: string) => `executed ${n}`);
    const deps: ToolLoopDeps = { callModel, executeTool, onEvent: vi.fn() };
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: (e) => events.push(e),
    });
    // The FIRST write never reached the executor — the gate blocked it once.
    // The retry on the next step ran (the block is bounded, never a wall).
    expect(executeTool).toHaveBeenCalledTimes(1);
    // The model was handed the refusal before it retried.
    expect(threads[1]?.some((m) => m.content.includes('declare a plan first via plan_todo'))).toBe(true);
    // A refusal event records the blocked first mutation; the gate decided once.
    expect(events.filter((e) => e.kind === 'refusal' && e.gate === 'plan')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(1);
  });

  it('nudges but does NOT block a terminal command (a build is a step, not a change)', async () => {
    const events: LoopTraceEvent[] = [];
    const executeTool = vi.fn(async (n: string) => `executed ${n}`);
    const deps = mockDeps(
      [
        { content: '', toolCalls: [{ id: 't1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
        { content: 'Done.', toolCalls: [] },
      ],
      executeTool,
    );
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: (e) => events.push(e),
    });
    // The command RAN (nudge-only), and the gate still told the model to plan.
    expect(executeTool.mock.calls.some((c) => c[0] === 'run_terminal')).toBe(true);
    expect(events.filter((e) => e.kind === 'refusal' && e.gate === 'plan')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(1);
  });

  it('does NOT block a batch that declares a plan in the same step', async () => {
    const events: LoopTraceEvent[] = [];
    const executeTool = vi.fn(async (n: string) => `executed ${n}`);
    const deps = mockDeps(
      [
        {
          content: '',
          toolCalls: [
            { id: 'p1', name: 'plan_todo', arguments: { action: 'create', goal: 'g', steps: ['a', 'b'] } },
            { id: 'w1', name: 'write_file', arguments: { path: 'a.js', content: 'x' } },
          ],
        },
        { content: 'Done.', toolCalls: [] },
      ],
      executeTool,
    );
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: (e) => events.push(e),
    });
    // The model was already doing the right thing: nothing was blocked and the
    // gate did not fire.
    expect(executeTool.mock.calls.some((c) => c[0] === 'write_file')).toBe(true);
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(0);
  });

  it('does NOT fire when a plan already exists', async () => {
    const events: LoopTraceEvent[] = [];
    const planCtx: ToolContext = {
      ...ctx,
      planStore: { snapshot: () => ({ goal: 'g', steps: [], revision: 1, updatedAt: Date.now() }) } as never,
    };
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.js', content: 'x' } }] },
      { content: 'Done.', toolCalls: [] },
    ]);
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: planCtx,
      deps,
      onTraceEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(0);
  });

  it('respects requirePlan: false', async () => {
    const events: LoopTraceEvent[] = [];
    const deps = mockDeps([
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'a.js', content: 'x' } }] },
      { content: 'Done.', toolCalls: [] },
    ]);
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      requirePlan: false,
      onTraceEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'plan')).toHaveLength(0);
  });

  it('never lands a planning nudge between an assistant tool_calls message and its tool results', async () => {
    // Regression: DeepSeek (native) rejects the next request with "An assistant
    // message with 'tool_calls' must be followed by tool messages responding to
    // each 'tool_call_id'" when ANY other role sits inside the group. The plan
    // and pre-flight nudges are decided before the results exist, so they must
    // be queued and flushed after the group, not pushed between it.
    type Msg = { role: string; content: string; toolCalls?: Array<{ id: string }>; toolCallId?: string };
    const threads: Msg[][] = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'run_terminal', arguments: { command: 'npm test' } },
          { id: 'c2', name: 'run_terminal', arguments: { command: 'npm run build' } },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Msg[]) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const deps: ToolLoopDeps = {
      callModel,
      executeTool: vi.fn(async (n: string) => `executed ${n}`),
      onEvent: vi.fn(),
    };
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: () => {},
    });

    // Look at the thread as the model saw it on the SECOND call.
    const seen = threads[1] ?? [];
    const assistantIdx = seen.findIndex(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const ids = seen[assistantIdx].toolCalls!.map((t) => t.id);
    // Every call id is answered by a `tool` message, in order, IMMEDIATELY after
    // the assistant message — the exact shape the provider demands.
    ids.forEach((id, k) => {
      const m = seen[assistantIdx + 1 + k];
      expect(m?.role).toBe('tool');
      expect(m?.toolCallId).toBe(id);
    });
    // Any planning nudge is strictly after the whole group.
    const nudgeIdx = seen.findIndex((m) => m.role === 'user' && m.content.includes('declare a short PLAN'));
    if (nudgeIdx !== -1) expect(nudgeIdx).toBeGreaterThan(assistantIdx + ids.length);
  });

  it("carries the step's reasoning_content onto the assistant message it replays", async () => {
    // DeepSeek v4 in thinking mode rejects the next request unless the prior
    // assistant turn's reasoning_content is sent back with its tool calls.
    type Msg = { role: string; content: string; reasoningContent?: string };
    const threads: Msg[][] = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      {
        content: '',
        reasoningContent: 'thinking about the build',
        toolCalls: [{ id: 'r1', name: 'run_terminal', arguments: { command: 'npm test' } }],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Msg[]) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const deps: ToolLoopDeps = {
      callModel,
      executeTool: vi.fn(async (n: string) => `executed ${n}`),
      onEvent: vi.fn(),
    };
    await runToolLoop({
      messages: [{ role: 'user', content: WORK_ASK }],
      context: ctx,
      deps,
      onTraceEvent: () => {},
    });
    const assistant = (threads[1] ?? []).find((m) => m.role === 'assistant' && m.reasoningContent);
    expect(assistant?.reasoningContent).toBe('thinking about the build');
  });

  it('planRequiredNudge names the ask and forbids planning-instead-of-working', () => {
    const text = planRequiredNudge(WORK_ASK);
    expect(text).toContain('declare a short PLAN');
    expect(text).toContain('math.js');
    expect(text).toContain('do NOT let planning replace the work');
  });
});

// ─── D2.2 — project prerequisite PRE-FLIGHT through the real loop ────────────
// Before the first build of a turn, a Tauri project missing `src-tauri/build.rs`
// must be handed the exact fix BEFORE the build runs — not after ten identical
// retries.
describe('tool loop — project prerequisite pre-flight (D2.2)', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'buff-prereq-preflight-'));
    mkdirSync(join(root, 'src-tauri'), { recursive: true });
    // A Tauri project with NO build.rs — the live blocker.
    writeFileSync(
      join(root, 'src-tauri', 'Cargo.toml'),
      '[dependencies]\ntauri = { version = "1.5.0" }\n[build-dependencies]\ntauri-build = { version = "1.5.0" }\n[features]\ncustom-protocol = []\n',
    );
    writeFileSync(
      join(root, 'src-tauri', 'tauri.conf.json'),
      JSON.stringify({ bundle: { icon: [] } }),
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('hands the model the missing-prerequisite fix before the first build', async () => {
    const events: LoopTraceEvent[] = [];
    const threads: Array<Array<{ role: string; content: string }>> = [];
    const callModel = vi.fn();
    let i = 0;
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'b1', name: 'run_terminal', arguments: { command: 'npx tauri build' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    callModel.mockImplementation(async (messages: Array<{ role: string; content: string }>) => {
      threads.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    });
    const deps: ToolLoopDeps = { callModel, executeTool: vi.fn(async (n) => `executed ${n}`), onEvent: vi.fn() };
    await runToolLoop({
      messages: [{ role: 'user', content: 'build the app' }],
      context: { ...ctx, cwd: root },
      deps,
      onTraceEvent: (e) => events.push(e),
    });

    // The pre-flight instruction reached the model on the next step.
    expect(threads[1]?.some((m) => m.content.includes('PROJECT PREREQUISITES MISSING'))).toBe(true);
    expect(threads[1]?.some((m) => m.content.includes('build.rs'))).toBe(true);
    // …and it was recorded as a bounded gate decision.
    expect(events.filter((e) => e.kind === 'gate' && e.gate === 'prerequisite').length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * fix_model_routing P2 — MID-TURN MODEL HANDOFF.
 *
 * The failure this pins: a live dashboard turn took five consecutive EMPTY
 * responses from one model and ended `bounded` with zero tool calls, while
 * healthy models sat configured and unused. The user had to say "retry" — which
 * is the one thing the system must never require. The loop's rule is now: one
 * same-model retry, then ask the CALLER (who owns the pool) for a different
 * model, and only fall back to the old bounded ending when the caller says
 * there is genuinely nothing else.
 */
describe('tool loop — mid-turn model handoff (P2)', () => {
  it('hands off to a different model after a model answers with nothing twice', async () => {
    const onTraceEvent = vi.fn();
    const onEvent = vi.fn();
    let model = 'A';
    const callModel = vi.fn(
      async (): Promise<StepResponse> =>
        model === 'A' ? { content: '', toolCalls: [] } : { content: 'B answered it.', toolCalls: [] },
    );
    const requestModelSwitch = vi.fn(async () => {
      model = 'B';
      return true;
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), onEvent, requestModelSwitch },
      onTraceEvent,
      maxSteps: 30,
      maxContinuations: 0,
    });

    // The turn DELIVERED, on the second model, with no user action.
    expect(result.content).toBe('B answered it.');
    expect(result.bounded).toBe(false);
    // A delivered answer is never reported as a generation failure.
    expect(result.generationFailed ?? false).toBe(false);
    expect(result.modelHandoffs).toBe(1);
    // Asked exactly once, and named the case for what it is.
    expect(requestModelSwitch).toHaveBeenCalledTimes(1);
    expect(requestModelSwitch).toHaveBeenCalledWith('empty');
    // The decision is on the trace, not only in a log line.
    const events = onTraceEvent.mock.calls.map((c) => c[0] as LoopTraceEvent);
    expect(events.some((e) => e.kind === 'gate' && e.gate === 'handoff')).toBe(true);
    // And the replacement model was actually called.
    expect(callModel).toHaveBeenCalledTimes(3);
  });

  it('allows ONE same-model retry before it insists on a handoff', async () => {
    let n = 0;
    const callModel = vi.fn(
      async (): Promise<StepResponse> =>
        ++n === 1 ? { content: '', toolCalls: [] } : { content: 'ok on the second try', toolCalls: [] },
    );
    const requestModelSwitch = vi.fn(async () => true);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.content).toBe('ok on the second try');
    expect(result.steps).toBe(2);
    // A single empty completion is a blip, not a verdict — no model churn.
    expect(requestModelSwitch).not.toHaveBeenCalled();
    expect(result.modelHandoffs).toBeUndefined();
  });

  it('gives the handed-off model its OWN retry — the streak belongs to the model that failed', async () => {
    let model = 'A';
    let bCalls = 0;
    const callModel = vi.fn(async (): Promise<StepResponse> => {
      if (model === 'A') return { content: '', toolCalls: [] };
      bCalls += 1;
      return bCalls === 1 ? { content: '', toolCalls: [] } : { content: 'B answered', toolCalls: [] };
    });
    const requestModelSwitch = vi.fn(async () => {
      model = 'B';
      return true;
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.content).toBe('B answered');
    // B's first empty did NOT immediately drop B: its streak started at zero.
    expect(requestModelSwitch).toHaveBeenCalledTimes(1);
    expect(result.modelHandoffs).toBe(1);
  });

  it('drops the failed model\'s private reasoning on handoff, keeping it on a same-model retry', async () => {
    // A handoff replaces the MODEL. `reasoningContent` is provider-private: the
    // wire layer echoes it back on the assistant message, which some reasoning
    // models REQUIRE from THEMSELVES on a retry — but replaying it to a
    // DIFFERENT model either gets rejected (foreign `reasoning_content` /
    // tool-call ids) or anchors the new model to the reasoning that just
    // failed. So: strip on a pair change, keep on a same-model retry.
    let aCalls = 0;
    let sawOwnReasoningOnRetry = false;
    let handedOffThread: Array<{ role: string; reasoningContent?: string }> = [];
    const callModel = vi.fn(async (thread: unknown): Promise<StepResponse> => {
      const msgs = thread as Array<{ role: string; reasoningContent?: string }>;
      if (aCalls < 2) {
        aCalls += 1;
        if (aCalls === 2) {
          sawOwnReasoningOnRetry = msgs.some((m) => m.role === 'assistant' && !!m.reasoningContent);
        }
        return { content: '', toolCalls: [], reasoningContent: 'A private chain of thought' };
      }
      handedOffThread = msgs;
      return { content: 'B answered it.', toolCalls: [] };
    });
    const requestModelSwitch = vi.fn(async () => true);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.content).toBe('B answered it.');
    expect(result.modelHandoffs).toBe(1);
    // The SAME model's retry kept its own reasoning — the strip is scoped to a
    // pair change, not applied blindly.
    expect(sawOwnReasoningOnRetry).toBe(true);
    // The replacement model got the FACTS without the stranger's reasoning.
    expect(
      handedOffThread.filter((m) => m.role === 'assistant' && m.reasoningContent).length,
    ).toBe(0);
    expect(handedOffThread.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('falls back to the bounded ending when the caller has no other candidate', async () => {
    const callModel = vi.fn(async (): Promise<StepResponse> => ({ content: '', toolCalls: [] }));
    const requestModelSwitch = vi.fn(async () => false);

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      maxSteps: 30,
      maxContinuations: 0,
    });

    // Honest about being unfinished, and no phantom "handoff" was claimed.
    expect(result.bounded).toBe(true);
    expect(result.modelHandoffs).toBeUndefined();
    expect(result.steps).toBeLessThanOrEqual(MAX_THINK_CONTINUES + 2);
    // It DID ask — the loop does not give up while the caller might still have one.
    expect(requestModelSwitch.mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps the pre-P2 behaviour for a caller that supplies no hook (mocks, children)', async () => {
    const onTraceEvent = vi.fn();
    const deps = mockDeps([{ content: '', toolCalls: [] }]);
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps,
      onTraceEvent,
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.bounded).toBe(true);
    const events = onTraceEvent.mock.calls.map((c) => c[0] as LoopTraceEvent);
    expect(events.some((e) => e.kind === 'gate' && e.gate === 'handoff')).toBe(false);
  });

  it('does not let a broken switch hook kill the turn', async () => {
    const callModel = vi.fn(async (): Promise<StepResponse> => ({ content: '', toolCalls: [] }));
    const requestModelSwitch = vi.fn(async () => {
      throw new Error('pool exploded');
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      maxSteps: 30,
      maxContinuations: 0,
    });

    // Treated exactly like "no candidate": bounded, never a crash.
    expect(result.bounded).toBe(true);
  });
});

/**
 * fix_model_routing P3 — DELIVERY PERSISTENCE.
 *
 * Two invariants are pinned here:
 *   1. HAND-OFFS CANNOT BE CUT SHORT BY STEP ACCOUNTING. The empty completions
 *      a handoff costs are not the user's work, so each handoff grants step
 *      credit (an ATTEMPT budget separate from the step budget). A turn against
 *      three dead models must still deliver on the fourth — under the plain step
 *      bound it would have run out of road first, which is how a task gets
 *      abandoned while capable models are still queued.
 *   2. THE ENDING SAYS WHY. `bounded: true` conflated "no model can do this"
 *      with "the budget ran out", and those need opposite responses.
 */
describe('tool loop — delivery persistence + named termination (P3)', () => {
  it('delivers on the 4th model after three unusable ones, despite a small step budget', async () => {
    const order = ['A', 'B', 'C', 'D'];
    let idx = 0;
    let onD = 0;
    const callModel = vi.fn(async (): Promise<StepResponse> => {
      const model = order[idx];
      if (model === 'D') {
        onD += 1;
        return onD === 1 ? { content: '', toolCalls: [] } : { content: 'D delivered it.', toolCalls: [] };
      }
      return { content: '', toolCalls: [] };
    });
    const requestModelSwitch = vi.fn(async () => {
      if (idx < order.length - 1) idx += 1;
      return true;
    });

    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch },
      // Deliberately smaller than the number of attempts this needs WITHOUT the
      // P3 attempt credit (2 per model × 4 models = 8).
      maxSteps: 6,
      maxContinuations: 0,
    });

    expect(result.content).toBe('D delivered it.');
    expect(result.bounded).toBe(false);
    expect(result.termination).toBe('delivered');
    expect(result.modelHandoffs).toBe(3);
  });

  it('names a repeated-empty ending as a model shortage, not as a budget', async () => {
    const callModel = vi.fn(async (): Promise<StepResponse> => ({ content: '', toolCalls: [] }));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(), requestModelSwitch: vi.fn(async () => false) },
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.bounded).toBe(true);
    expect(result.termination).toBe('no-capable-candidate');
  });

  it('names a repeated THINK-ONLY ending as a reasoning spin (not a model shortage)', async () => {
    const callModel = vi.fn(async (): Promise<StepResponse> => ({ content: 'hmm', toolCalls: [] }));
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn() },
      maxSteps: 30,
      maxContinuations: 0,
    });

    expect(result.bounded).toBe(true);
    expect(result.termination).toBe('reasoning-spin');
  });

  it('names an exhausted-budget ending `budget-exhausted`', async () => {
    let n = 0;
    const callModel = vi.fn(async (): Promise<StepResponse> => {
      n += 1;
      return { content: '', toolCalls: [{ id: `c${n}`, name: 'list_dir', arguments: { path: '.' } }] };
    });
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn(async () => 'ok') },
      maxSteps: 2,
      maxContinuations: 0,
    });

    expect(result.bounded).toBe(true);
    expect(result.termination).toBe('budget-exhausted');
  });

  it('names a delivered turn and a cancelled turn explicitly', async () => {
    const delivered = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: mockDeps([{ content: 'Sure.', toolCalls: [] }]),
    });
    expect(delivered.termination).toBe('delivered');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: mockDeps([{ content: 'Sure.', toolCalls: [] }]),
      signal: controller.signal,
    });
    expect(cancelled.termination).toBe('cancelled');
    expect(cancelled.cancelled).toBe(true);
  });

  it('names a generation death with nothing to deliver as a model shortage', async () => {
    const callModel = vi.fn(async () => {
      throw new Error('All LLM providers exhausted (every candidate failed)');
    });
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'hi' }],
      context: ctx,
      deps: { callModel, executeTool: vi.fn() },
      maxContinuations: 0,
    });

    expect(result.termination).toBe('no-capable-candidate');
    expect(result.generationFailed).toBe(true);
  });
});
