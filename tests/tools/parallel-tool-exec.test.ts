/**
 * W2 / W10 regressions for the tool loop:
 *
 *  1. Read-only tool calls emitted in ONE step run as a bounded fan-out —
 *     previously N reads cost N sequential round-trips.
 *  2. State-changing calls stay strictly serial (never overlap anything).
 *  3. Tool results reach the thread in the assistant's original tool_calls
 *     order, whatever order they finished in.
 *  4. The plan_todo guard counts PRIOR calls only — the off-by-one refused the
 *     tool's first invocation, making planning unusable in the loop.
 *  5. The pipeline duplicate guard matches the real `category: 'pipeline'`
 *     tools; the old guard tested a literal name that is not registered.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runToolLoop,
  isParallelSafeTool,
  PARALLEL_SAFE_TOOL_NAMES,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import type { ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };

function mockDeps(
  script: StepResponse[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return { callModel, executeTool: vi.fn(execute), onEvent: vi.fn() };
}

/** A deps set whose executeTool records peak concurrency and call order. */
function trackingDeps(script: StepResponse[]) {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const started: Record<string, number> = {};
  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    active += 1;
    peak = Math.max(peak, active);
    started[name] = Math.max(started[name] ?? 0, active);
    order.push(name);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return `result:${name}:${String(args.path ?? args.id ?? '')}`;
  };
  return { deps: mockDeps(script, execute), stats: () => ({ peak, order, started: { ...started } }) };
}

const readCall = (id: string, path: string) => ({ id, name: 'read_file', arguments: { path } });

/** The tool messages the loop fed back on the SECOND model step. */
function fedBackToolMessages(deps: ToolLoopDeps): Array<{ content: string; toolCallId?: string }> {
  const secondCall = deps.callModel.mock.calls[1][0] as Array<{ role: string; content: string; toolCallId?: string }>;
  return secondCall.filter((m) => m.role === 'tool');
}

describe('tool loop — parallel read-only execution', () => {
  it('runs independent read_file calls concurrently', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [readCall('c1', 'a.ts'), readCall('c2', 'b.ts'), readCall('c3', 'c.ts')],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const { deps, stats } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'read three files' }], context: ctx, deps });

    expect(stats().order).toEqual(['read_file', 'read_file', 'read_file']);
    expect(stats().peak).toBeGreaterThan(1); // actually overlapped
    expect(stats().peak).toBeLessThanOrEqual(4); // ...but bounded
  });

  it('honours the harness profile: maxParallelReads 1 serializes read calls', async () => {
    // R1 — a tiny model's profile sets maxParallelReads to 1, because it emits
    // one call at a time and interleaved results confuse it. The loop must
    // respect that rather than always fanning out to 4.
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [readCall('c1', 'a.ts'), readCall('c2', 'b.ts'), readCall('c3', 'c.ts')],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const { deps, stats } = trackingDeps(script);

    await runToolLoop({
      messages: [{ role: 'user', content: 'read three files' }],
      context: ctx,
      deps,
      maxParallelReads: 1,
    });

    expect(stats().order).toEqual(['read_file', 'read_file', 'read_file']);
    expect(stats().peak).toBe(1); // never overlapped
  });

  it('keeps state-changing calls strictly serial', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'c2', name: 'run_terminal', arguments: { command: 'echo hi' } },
          { id: 'c3', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const { deps, stats } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'mixed' }], context: ctx, deps });

    expect(stats().order).toEqual(['read_file', 'run_terminal', 'read_file']);
    // Nothing ever overlapped the terminal call.
    expect(stats().started['run_terminal']).toBe(1);
    expect(stats().peak).toBe(1);
  });

  it('feeds results back in the original tool_calls order', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [readCall('c1', 'first.ts'), readCall('c2', 'second.ts'), readCall('c3', 'third.ts')],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    // Stagger the sleeps so completion order is the REVERSE of call order.
    const callModel = vi.fn();
    let step = 0;
    callModel.mockImplementation(async () => script[Math.min(step++, script.length - 1)]);
    const delays: Record<string, number> = { first: 30, second: 20, third: 5 };
    const executeTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const key = String(args.path).split('.')[0];
      await new Promise((r) => setTimeout(r, delays[key] ?? 0));
      return `result:${args.path}`;
    });
    const deps: ToolLoopDeps = { callModel, executeTool, onEvent: vi.fn() };

    await runToolLoop({ messages: [{ role: 'user', content: 'read three' }], context: ctx, deps });

    const messages = fedBackToolMessages(deps);
    expect(messages.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    // Each result is in its own call's slot (the loop may append the advisory
    // P3d parallel-delegation tip to the 2nd gathered result — hence `startsWith`).
    expect(messages[0].content.startsWith('result:first.ts')).toBe(true);
    expect(messages[1].content.startsWith('result:second.ts')).toBe(true);
    expect(messages[2].content.startsWith('result:third.ts')).toBe(true);
    // ...and NOT the reverse (which is the completion order).
    expect(messages[0].content).not.toContain('third.ts');
  });

  it('does not parallelize a single read (no fan-out for one call)', async () => {
    const script: StepResponse[] = [
      { content: '', toolCalls: [readCall('c1', 'only.ts')] },
      { content: 'Done.', toolCalls: [] },
    ];
    const { deps, stats } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'one read' }], context: ctx, deps });
    expect(stats().peak).toBe(1);
  });
});

describe('tool loop — planner + pipeline dispatch guards', () => {
  it('allows the FIRST plan_todo call of a turn to execute', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'plan_todo', arguments: { action: 'create', goal: 'ship it', steps: [{ description: 'step 1' }] } }],
      },
      { content: 'Planned.', toolCalls: [] },
    ];
    const { deps } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'plan it' }], context: ctx, deps });

    const messages = fedBackToolMessages(deps);
    expect(deps.executeTool).toHaveBeenCalled();
    expect(messages[0].content).toContain('result:plan_todo');
    expect(messages[0].content).not.toContain('already called');
  });

  it('refuses a SECOND plan_todo CREATE in the same turn (the planner loop)', async () => {
    const planArg = { action: 'create', goal: 'ship it', steps: [{ description: 'step 1' }] };
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'plan_todo', arguments: planArg },
          { id: 'c2', name: 'plan_todo', arguments: planArg },
        ],
      },
      { content: 'Planned.', toolCalls: [] },
    ];
    const { deps } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'plan it twice' }], context: ctx, deps });

    const messages = fedBackToolMessages(deps);
    expect(messages[0].content).not.toContain('do NOT declare it again');
    expect(messages[1].content).toContain('do NOT declare it again');
  });

  it('ALLOWS plan_todo UPDATES in the same turn as the create (tracking, not looping)', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            name: 'plan_todo',
            arguments: { action: 'create', goal: 'ship it', steps: [{ id: 'step-1', description: 'step 1' }] },
          },
          {
            id: 'c2',
            name: 'plan_todo',
            arguments: { action: 'update', id: 'step-1', status: 'done', note: 'shipped' },
          },
        ],
      },
      { content: 'Done.', toolCalls: [] },
    ];
    const { deps } = trackingDeps(script);
    await runToolLoop({ messages: [{ role: 'user', content: 'plan and do it' }], context: ctx, deps });

    const messages = fedBackToolMessages(deps);
    // The update EXECUTES (it is the tracking the user watches); no refusal.
    expect(messages[1].content).toContain('result:plan_todo');
    expect(messages[1].content).not.toContain('do NOT declare it again');
    expect(messages[1].content).not.toContain('has been updated');
  });

  it('refuses a duplicate pipeline dispatch within one step', async () => {
    // Two identical pipeline dispatches must not both run. The FIRST one is
    // made to FAIL on purpose: a successful dispatch now ends the step (the
    // endsAgentStep exit), which would hide this guard's refusal message — a
    // failed one stays in the loop, exactly where the guard has to hold.
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'build', arguments: { goal: 'make a thing' } },
          { id: 'c2', name: 'build', arguments: { goal: 'make a thing' } },
        ],
      },
      { content: 'Built.', toolCalls: [] },
    ];
    const failing: string[] = [];
    const { deps } = trackingDeps(script);
    deps.executeTool = vi.fn(async (name: string) => {
      failing.push(name);
      return 'Error: pipeline aborted — no provider available';
    });
    await runToolLoop({ messages: [{ role: 'user', content: 'build x twice' }], context: ctx, deps });

    const messages = fedBackToolMessages(deps);
    expect(messages[0].content).not.toContain('already dispatched');
    expect(messages[1].content).toContain('already dispatched');
    expect(failing).toEqual(['build']);
  });

  it('a SUCCESSFUL dispatch ends the step, so a duplicate cannot even be attempted', async () => {
    const script: StepResponse[] = [
      {
        content: '',
        toolCalls: [
          { id: 'c1', name: 'build', arguments: { goal: 'make a thing' } },
          { id: 'c2', name: 'build', arguments: { goal: 'make a thing' } },
        ],
      },
      { content: 'Built.', toolCalls: [] },
    ];
    const executed: string[] = [];
    const { deps } = trackingDeps(script);
    deps.executeTool = vi.fn(async (name: string) => {
      executed.push(name);
      return '✅ build succeeded';
    });
    const result = await runToolLoop({
      messages: [{ role: 'user', content: 'build x twice' }],
      context: ctx,
      deps,
    });

    expect(executed).toEqual(['build']);
    expect(result.content).toBe('✅ build succeeded');
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });
});

describe('parallel-safe allowlist is conservative', () => {
  it('contains only read-only tools', () => {
    for (const name of ['read_file', 'list_dir', 'glob', 'code_search', 'web_search', 'read_page']) {
      expect(isParallelSafeTool(name)).toBe(true);
    }
  });

  it('never marks a state-changing, blocking, or tiering tool as parallel-safe', () => {
    for (const name of [
      'write_file',
      'edit_file',
      'run_terminal',
      'tool_search', // mutates the tiering state
      'plan_todo',
      'ask_user', // blocks on user input
      'build',
      'delegate',
      'gateway_send',
    ]) {
      expect(isParallelSafeTool(name)).toBe(false);
    }
    expect(PARALLEL_SAFE_TOOL_NAMES.size).toBe(6);
  });
});
