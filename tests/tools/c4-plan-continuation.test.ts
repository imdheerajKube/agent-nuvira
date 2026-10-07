/**
 * C4 — EXPERIMENT (not a fix). The original report claimed "4 continuations; the
 * plan is re-derived rather than carried", but the measured evidence (12
 * `plan_todo` calls in ms-apart BURSTS) cannot distinguish a re-derivation after a
 * continuation from the model advancing its own plan — several `plan_todo` calls
 * inside ONE model response look identical to several across a continuation.
 *
 * So this file MEASURES the thing the report asserted, in the two places a plan
 * can meet a "continuation":
 *
 *   A. CONTINUATION WITHIN ONE TURN (the real one: the step bound is extended and
 *      the SAME thread is kept — see `runToolLoop`'s bounded auto-continuation).
 *   B. A LATER TURN (a fresh loop, the same per-session plan store — which is what
 *      the tool description promises: "the table persists across the whole
 *      conversation AND across sessions").
 *
 * For each, it records the plan store's revision, step ids and statuses before and
 * after, plus whether the model was given any evidence of the existing plan.
 */

import { describe, it, expect, vi } from 'vitest';

import { runToolLoop, type ToolLoopDeps, type StepResponse, type ToolLoopOptions } from '../../src/tools/tool-loop.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';
import { PlanStore } from '../../src/tools/plan-store.js';

interface PlanView {
  revision: number;
  goal: string;
  steps: Array<{ id: string; status: string; description: string }>;
}

function view(store: PlanStore): PlanView {
  const p = store.snapshot();
  return p
    ? { revision: p.revision, goal: p.goal, steps: p.steps.map((s) => ({ id: s.id, status: s.status, description: s.description })) }
    : { revision: -1, goal: '(none)', steps: [] };
}

/** A loop whose tools really run (so plan_todo mutates the real store). */
function deps(script: StepResponse[], toolResults: string[], requests: unknown[][]): ToolLoopDeps {
  let i = 0;
  return {
    callModel: vi.fn(async (messages: unknown) => {
      // DEEP COPY: the loop keeps mutating its `thread` array in place, so a
      // stored reference would show the FINAL thread for every request and
      // measure the wrong thing.
      requests.push(JSON.parse(JSON.stringify(messages)) as unknown[]);
      return script[Math.min(i++, script.length - 1)];
    }),
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, c: ToolContext) => {
      const t = getTool(name);
      if (!t) throw new Error(`no tool ${name}`);
      const out = await t.run(args, c);
      toolResults.push(out);
      return out;
    }),
    onEvent: vi.fn(),
  };
}

const CREATE = (goal: string, ids: string[]): StepResponse => ({
  content: '',
  toolCalls: [
    {
      id: 'p1',
      name: 'plan_todo',
      arguments: { action: 'create', goal, steps: ids.map((id) => ({ id, description: `do ${id}` })) },
    },
  ],
});

const UPDATE = (id: string): StepResponse => ({
  content: '',
  toolCalls: [{ id: 'p2', name: 'plan_todo', arguments: { action: 'update', id, status: 'done', note: `${id} finished` } }],
});

const DONE = (text: string): StepResponse => ({ content: text, toolCalls: [] });

function runLoop(opts: Partial<ToolLoopOptions> & { context: ToolContext }, d: ToolLoopDeps) {
  return runToolLoop({
    messages: [{ role: 'user', content: 'build the thing' }],
    context: opts.context,
    deps: d,
    ...opts,
  } as ToolLoopOptions & { deps: ToolLoopDeps });
}

describe('C4 experiment — what happens to the plan across a continuation', () => {
  it('C. a turn with no plan gets no plan block (the reminder only exists when there IS one)', async () => {
    const store = new PlanStore();
    const requests: unknown[][] = [];
    const d = deps([DONE('hello')], [], requests);
    await runLoop({ context: { configManager: {}, planStore: store } }, d);
    const first = JSON.stringify(requests[0] ?? []);
    expect(first).not.toContain('already tracking');
    expect(first).not.toContain('Advance THIS plan');
  });

  it('D. a COMPLETED plan is not re-shown (no noise for finished work)', async () => {
    const store = new PlanStore();
    store.create('ship it', [{ id: 's1', description: 'do s1' }]);
    store.update('s1', 'done');
    const requests: unknown[][] = [];
    const d = deps([DONE('all done already')], [], requests);
    await runLoop({ context: { configManager: {}, planStore: store } }, d);
    expect(JSON.stringify(requests[0] ?? [])).not.toContain('already tracking');
  });

  it('A. CONTINUATION within one turn: the plan is carried, a second CREATE is refused', async () => {
    const store = new PlanStore();
    const results: string[] = [];
    const requests: unknown[][] = [];
    const d = deps(
      [
        CREATE('ship it', ['s1', 's2', 's3']),
        // The continuation step tries to DECLARE THE PLAN AGAIN (the shape the
        // report suspected): does the harness replace it?
        CREATE('ship it', ['t1', 't2', 't3']),
        DONE('done'),
      ],
      results,
      requests,
    );
    const before = view(store);
    const result = await runLoop(
      {
        context: { configManager: {}, planStore: store },
        maxSteps: 1,
        maxContinuations: 1,
        continuationSteps: 2,
      },
      d,
    );
    const after = view(store);
    const threadText = JSON.stringify(requests);
    // eslint-disable-next-line no-console
    console.log(
      'C4-A ' +
        JSON.stringify(
          {
            continuations: result.continuations,
            steps: result.steps,
            before,
            after,
            toolResults: results,
            secondCreateRefused: threadText.includes('do NOT declare it again'),
          },
          null,
          2,
        ),
    );
    expect(result.continuations).toBe(1);
    expect(after.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('B. ACROSS TURNS (the promise the tool description makes): a re-declaration CARRIES the progress', async () => {
    const store = new PlanStore();
    const results1: string[] = [];
    const requests1: unknown[][] = [];
    const d1 = deps([CREATE('ship it', ['s1', 's2', 's3']), UPDATE('s1'), DONE('step one done')], results1, requests1);
    await runLoop({ context: { configManager: {}, planStore: store } }, d1);
    const afterTurn1 = view(store);

    // Turn 2: a fresh loop, a fresh request, the SAME store. The model has no
    // memory of the plan (only the thread it can see), so it declares its plan
    // again — the way the measured run's bursts would look one turn later.
    const results2: string[] = [];
    const requests2: unknown[][] = [];
    const d2 = deps([CREATE('ship it', ['s1', 's2', 's3']), DONE('all done')], results2, requests2);
    await runLoop({ context: { configManager: {}, planStore: store } }, d2);
    const afterTurn2 = view(store);

    // Is the EXISTING plan visible to the model when turn 2 STARTS? Measured on
    // the FIRST request of the turn, not on the whole thread (a later request in
    // the same turn carries the tool results the model itself produced, which
    // would flatter the answer).
    //
    // Before the fix this was FALSE — the store was read only to answer "does a
    // plan exist" — and that is why a later turn re-declared its plan. It is now
    // shown, with the step ids and the one correct move (update).
    const firstRequestText = JSON.stringify(requests2[0] ?? []);
    const planVisible = firstRequestText.includes('ship it') && firstRequestText.includes('s1');

    // eslint-disable-next-line no-console
    console.log(
      'C4-B ' +
        JSON.stringify(
          {
            afterTurn1,
            afterTurn2,
            secondTurnSawThePlan: planVisible,
            turn2FirstRequest: firstRequestText.slice(0, 1200),
            results2,
          },
          null,
          2,
        ),
    );
    expect(afterTurn1.steps[0].status).toBe('done');
    // FIXED: the re-declaration keeps the work that was already done, and says so.
    expect(afterTurn2.steps[0].status).toBe('done');
    // (New in Bundle 4d: the turn STARTED knowing the plan — see the assertions
    // on `planVisible` below.)
    expect(afterTurn2.steps.slice(1).every((s) => s.status === 'pending')).toBe(true);
    expect(results2.join('\n')).toContain('♻️ Carried 1 step(s)');
    // The plan is SHOWN at the start of the turn, with its ids, its real statuses
    // and the instruction that advancing it is an update.
    expect(planVisible).toBe(true);
    expect(firstRequestText).toContain('already tracking');
    expect(firstRequestText).toContain('1/3 done');
    expect(firstRequestText).toContain('Advance THIS plan');
    expect(firstRequestText).toContain('Do NOT declare it again');
  });
});
