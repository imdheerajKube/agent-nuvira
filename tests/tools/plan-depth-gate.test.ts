/**
 * THE PLAN-DEPTH GATE, DRIVEN THROUGH THE REAL LOOP.
 *
 * The unit tests pin the fact (`planDepthIssue`). This pins when the loop says it: on the
 * step that CREATED the plan, once, before the build's later gates start measuring
 * progress against it — because a coarse plan makes every later gate agree that the work
 * is done.
 *
 * The failure being prevented is measured, not hypothetical: 2026-10-27, one arm planned
 * 15 phases (~150 tasks) and shipped 69 endpoints; the other planned seven steps, one of
 * which read "auth/JWT, RBAC, projects, tasks, documents, notifications, AI assistant,
 * admin", and shipped 51.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runToolLoop } from '../../src/tools/tool-loop.js';
import type { ToolMessage } from '../../src/inference/interface.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plan-depth-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ASK = [
  'Build a production-ready SaaS platform.',
  '',
  'Requirements:',
  '- Projects',
  '- Tasks',
  '- Documents',
  '- AI Assistant',
  '- Notifications',
  '- Admin Dashboard',
].join('\n');

interface Step {
  id: string;
  description: string;
  status: string;
}

function planStore(steps: Step[]) {
  return {
    snapshot: () => ({ goal: 'ship the platform', revision: 1, steps }),
    update: () => true,
  };
}

/**
 * A plan the turn can rewrite while it runs — which is what "collapses back into one step
 * mid-build" actually looks like: the same store, a new step list, a bumped revision.
 */
function mutableStore(initial: Step[]) {
  const state = { steps: [...initial], revision: 1 };
  return {
    state,
    replace(steps: Step[]): void {
      state.steps = steps;
      state.revision += 1;
    },
    snapshot: () => ({ goal: 'ship the platform', revision: state.revision, steps: state.steps }),
    update: () => true,
  };
}

async function run(input: {
  steps: Step[];
  script: Array<{ content: string; calls?: Array<[string, Record<string, unknown>]> }>;
  /** Mutates the world after the Nth model call returns, before its tools execute. */
  store?: ReturnType<typeof mutableStore>;
  between?: (call: number) => void;
}) {
  const threads: ToolMessage[][] = [];
  const events: string[] = [];
  const gates: string[] = [];
  let call = 0;
  const result = await runToolLoop({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: ASK },
    ],
    context: {
      cwd: root,
      configManager: {},
      planStore: input.store ?? planStore(input.steps),
    } as never,
    deps: {
      callModel: async (thread: ToolMessage[]) => {
        threads.push(thread.map((m) => ({ ...m })));
        const step = input.script[Math.min(call, input.script.length - 1)];
        call += 1;
        input.between?.(call);
        return {
          content: step.content,
          toolCalls: (step.calls ?? []).map(([name, args], i) => ({ id: `c${call}-${i}`, name, arguments: args })),
        } as never;
      },
      executeTool: async () => 'ok',
      onEvent: (line: string) => events.push(line),
    } as never,
    onTraceEvent: (e: { gate?: string }) => {
      if (e.gate) gates.push(e.gate);
    },
    maxSteps: 6,
    maxContinuations: 0,
    maxStepExtensions: 0,
    requireVerification: false,
    requireSelfReview: false,
    requireAction: false,
    servedRoute: () => ({ providerType: 'deepseek', model: 'deepseek-flash' }),
  });
  return { result, threads, events, gates };
}

const harness = (threads: ToolMessage[][]): string[] =>
  threads.flat().map((m) => (m.role === 'system' ? String(m.content ?? '') : '')).filter((c) => c.startsWith('[harness]'));

describe('the plan-depth gate', () => {
  it('asks ONCE, on the step that created a plan bundling six requirements', async () => {
    const steps: Step[] = [
      { id: 's1', description: 'Inspect the directory', status: 'done' },
      {
        id: 's2',
        description: 'Implement backend: projects, tasks, documents, notifications, AI assistant, admin',
        status: 'in_progress',
      },
      { id: 's3', description: 'Write tests', status: 'pending' },
    ];
    const { threads, events, gates } = await run({
      steps,
      script: [
        { content: '', calls: [['plan_todo', { action: 'create', goal: 'ship the platform' }]] },
        { content: '', calls: [['plan_todo', { action: 'update', stepId: 's2', status: 'done' }]] },
        { content: 'All done.' },
      ],
    });

    const ask = harness(threads).find((d) => d.includes('bundles'));
    expect(ask, 'a plan that puts six named requirements on one checkbox must be told').toBeDefined();
    expect(ask).toContain('s2');
    expect(ask).toContain('marked done as soon as the first of them exists');
    expect(gates.filter((g) => g === 'plan-depth')).toHaveLength(1);
    expect(events.filter((e) => e.includes('one checkbox')).length).toBeGreaterThanOrEqual(1);
  });

  it('re-checks at a PHASE BOUNDARY: a decomposed plan that collapses is caught', async () => {
    const decomposed: Step[] = [
      { id: 's1', description: 'Implement projects: list, create, update, delete', status: 'pending' },
      { id: 's2', description: 'Implement tasks with filters and assignment', status: 'pending' },
      { id: 's3', description: 'Implement documents with publish and versions', status: 'pending' },
      { id: 's4', description: 'Implement the AI assistant with conversation history', status: 'pending' },
      { id: 's5', description: 'Implement notifications, unread counts and read-all', status: 'pending' },
      { id: 's6', description: 'Implement the admin dashboard and user status controls', status: 'pending' },
    ];
    const store = mutableStore(decomposed);

    const { threads, gates } = await run({
      steps: decomposed,
      store,
      // The plan starts correct; four steps in, the model folds everything back into one
      // step — the exact shape of a build that starts broad and narrows without saying so.
      between: (call) => {
        if (call === 3) {
          store.replace([
            { id: 's1', description: 'Scaffold', status: 'done' },
            {
              id: 's2',
              description: 'Finish the backend: projects, tasks, documents, notifications, AI assistant, admin',
              status: 'in_progress',
            },
          ]);
        }
      },
      script: [
        { content: '', calls: [['plan_todo', { action: 'create', goal: 'ship the platform' }]] },
        { content: '', calls: [['write_file', { path: 'src/a.ts', content: 'x' }]] },
        { content: '', calls: [['plan_todo', { action: 'update', stepId: 's1', status: 'done' }]] },
        { content: '', calls: [['write_file', { path: 'src/b.ts', content: 'x' }]] },
        { content: 'All done.' },
      ],
    });

    // Count in the turn's LAST thread: a directive stays in the thread once pushed, so
    // summing over every snapshot counts the same message many times.
    const last = threads[threads.length - 1] ?? [];
    const asks = last.filter(
      (m) => m.role === 'system' && String(m.content).startsWith('[harness]') && String(m.content).includes('bundles'),
    );
    expect(asks, 'the collapsed plan must be caught, even though the first plan was fine').toHaveLength(1);
    expect(String(asks[0].content)).toContain('Finish the backend');
    expect(gates.filter((g) => g === 'plan-depth')).toHaveLength(1);
  });

  it('never repeats the same complaint when the plan has not changed', async () => {
    const bundled: Step[] = [
      { id: 's1', description: 'Scaffold', status: 'done' },
      {
        id: 's2',
        description: 'Finish the backend: projects, tasks, documents, notifications, AI assistant, admin',
        status: 'in_progress',
      },
      { id: 's3', description: 'Tests', status: 'pending' },
      { id: 's4', description: 'Docs', status: 'pending' },
    ];
    const store = mutableStore(bundled);
    const { threads, gates } = await run({
      steps: bundled,
      store,
      script: [
        { content: '', calls: [['plan_todo', { action: 'create', goal: 'ship the platform' }]] },
        // Two more rewrites that leave the SAME bundling in place: each is a boundary, and
        // each must stay silent — a repeated complaint is what makes a gate ignorable.
        { content: '', calls: [['plan_todo', { action: 'update', stepId: 's1', status: 'done' }]] },
        { content: '', calls: [['write_file', { path: 'src/a.ts', content: 'x' }]] },
        { content: 'All done.' },
      ],
    });
    expect(gates.filter((g) => g === 'plan-depth')).toHaveLength(1);
    const last = threads[threads.length - 1] ?? [];
    expect(
      last.filter(
        (m) => m.role === 'system' && String(m.content).startsWith('[harness]') && String(m.content).includes('bundles'),
      ),
    ).toHaveLength(1);
  });

  it('is silent for a plan that already decomposes the ask', async () => {
    const steps: Step[] = [
      { id: 's1', description: 'Implement projects: list, create, update, delete', status: 'pending' },
      { id: 's2', description: 'Implement tasks with filters and assignment', status: 'pending' },
      { id: 's3', description: 'Implement documents with publish and versions', status: 'pending' },
      { id: 's4', description: 'Implement the AI assistant with conversation history', status: 'pending' },
      { id: 's5', description: 'Implement notifications, unread counts and read-all', status: 'pending' },
      { id: 's6', description: 'Implement the admin dashboard and user status controls', status: 'pending' },
    ];
    const { threads, gates } = await run({
      steps,
      script: [
        { content: '', calls: [['plan_todo', { action: 'create', goal: 'ship the platform' }]] },
        { content: 'All done.' },
      ],
    });
    expect(gates).not.toContain('plan-depth');
    expect(harness(threads).some((d) => d.includes('bundles'))).toBe(false);
  });
});
