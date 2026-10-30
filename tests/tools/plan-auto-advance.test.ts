/**
 * PLAN AUTO-ADVANCE (2026-10-17).
 *
 * WHY. Measured on the slugkit release task: 9 of the turn's 34 tool calls were
 * `plan_todo` — a whole model round-trip, with the entire conversation re-sent, to
 * say "step 2 is done" about an `edit_file` the LOOP had already watched succeed
 * on the exact path that step names. The same shape produced 7 plan calls in the
 * Cline head-to-head and 10 on T2.
 *
 * So the loop advances the steps its own action ledger can justify, attaching the
 * call that justifies them. Two properties must hold and are pinned here:
 *   1. it may only REMOVE a round-trip, never a check (verification is untouched);
 *   2. it may never invent progress — a step nothing was observed for stays open,
 *      and a step about writing prose is never advanced on the model's behalf.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  planStepsClosedByEvidence,
  runToolLoop,
  type ToolLoopDeps,
  type StepResponse,
} from '../../src/tools/tool-loop.js';
import { getTool } from '../../src/tools/registry.js';
import type { ToolContext } from '../../src/tools/registry.js';

const ctx: ToolContext = { configManager: {} };
const AT = 1_700_000_000_000;

function snapshot(steps: Array<{ id: string; description: string; status?: string }>) {
  return {
    goal: 'release 0.1.1',
    revision: 1,
    steps: steps.map((s) => ({ status: 'pending', ...s })) as never,
  };
}

describe('plan auto-advance — which steps the ledger closes', () => {
  it('advances a step that names a file the turn actually wrote, with that call as evidence', () => {
    const out = planStepsClosedByEvidence({
      snapshot: snapshot([
        { id: 'fix', description: 'Fix src/slugify.js so punctuation collapses' },
        { id: 'doc', description: 'Update the README examples' },
      ]),
      written: [{ tool: 'edit_file', path: 'src/slugify.js' }],
      checks: [],
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('fix');
    expect(out[0].evidence).toEqual({ tool: 'edit_file', path: 'src/slugify.js', ok: true, at: AT });
    expect(out[0].reason).toContain('src/slugify.js');
  });

  it('matches on the bare filename too, but never on an unrelated step', () => {
    const out = planStepsClosedByEvidence({
      snapshot: snapshot([
        { id: 'a', description: 'Edit package.json to 0.1.1' },
        { id: 'b', description: 'Write the CHANGELOG entry' },
      ]),
      written: [{ tool: 'write_file', path: 'package.json' }],
      checks: [],
      at: AT,
    });
    expect(out.map((o) => o.id)).toEqual(['a']);
  });

  it('never advances a step about prose, even when the turn wrote files', () => {
    const out = planStepsClosedByEvidence({
      snapshot: snapshot([
        { id: 'report', description: 'Deliver the final report to the user' },
        { id: 'summary', description: 'Summarise what changed' },
      ]),
      written: [{ tool: 'write_file', path: 'notes.md' }],
      checks: [{ tool: 'run_terminal', command: 'npm test' }],
      at: AT,
    });
    expect(out).toHaveLength(0);
  });

  it('advances a check step ONLY when a check actually succeeded', () => {
    const plan = snapshot([{ id: 'verify', description: 'Run npm test and record the result' }]);
    const withoutChecks = planStepsClosedByEvidence({ snapshot: plan, written: [], checks: [], at: AT });
    expect(withoutChecks).toHaveLength(0);

    const withCheck = planStepsClosedByEvidence({
      snapshot: plan,
      written: [],
      checks: [{ tool: 'run_terminal', command: 'npm test' }],
      at: AT,
    });
    expect(withCheck).toHaveLength(1);
    expect(withCheck[0].evidence.command).toBe('npm test');
    expect(withCheck[0].evidence.ok).toBe(true);
  });

  /**
   * MEASURED (2026-10-25): these two steps were closed by `ls -la`, and the run
   * then had no reason to write a test or a tracking file. Reproduced verbatim
   * from the plan the model wrote on the three-agent platform build.
   */
  it('does NOT close the tests step on an inspection command (measured ls -la case)', () => {
    const out = planStepsClosedByEvidence({
      snapshot: snapshot([
        { id: 's6', description: 'Write and RUN unit + integration tests; add E2E (Playwright) spec' },
        {
          id: 's7',
          description: 'Run typecheck/lint/build + test suite, fix failures, update todo/progress/issues/changelog',
        },
      ]),
      written: [],
      checks: [
        { tool: 'run_terminal', command: 'ls -la' },
        { tool: 'run_terminal', command: 'cd repo && git status' },
        { tool: 'run_terminal', command: "docker info --format '{{.ServerVersion}}'" },
      ],
      at: AT,
    });
    expect(out).toEqual([]);
  });

  it('closes a step listing four checks only when all four ran', () => {
    const description = 'Run typecheck/lint/build + test suite, fix failures';
    const one = planStepsClosedByEvidence({
      snapshot: snapshot([{ id: 's7', description }]),
      written: [],
      checks: [{ tool: 'run_terminal', command: 'npx tsc --noEmit' }],
      at: AT,
    });
    expect(one).toEqual([]);

    const all = planStepsClosedByEvidence({
      snapshot: snapshot([{ id: 's7', description }]),
      written: [],
      checks: [
        { tool: 'run_terminal', command: 'npx tsc --noEmit' },
        { tool: 'run_terminal', command: 'npm run lint' },
        { tool: 'run_terminal', command: 'npm run build' },
        { tool: 'run_terminal', command: 'npx vitest run 2>&1 | tail -20' },
      ],
      at: AT,
    });
    expect(all.map((a) => a.id)).toEqual(['s7']);
    // Evidence is a check that really ran, not the last tool call of the turn.
    expect(all[0].evidence.command).toContain('vitest');
  });

  it('accepts one named kind on its own, and any real command for a generic verify step', () => {
    const named = planStepsClosedByEvidence({
      snapshot: snapshot([{ id: 't', description: 'Run the e2e tests and record the result' }]),
      written: [],
      checks: [{ tool: 'run_terminal', command: 'npx playwright test' }],
      at: AT,
    });
    expect(named.map((a) => a.id)).toEqual(['t']);

    const generic = planStepsClosedByEvidence({
      snapshot: snapshot([{ id: 'g', description: 'Verify the health endpoint responds' }]),
      written: [],
      checks: [{ tool: 'run_terminal', command: 'curl -sf localhost:3000/api/health' }],
      at: AT,
    });
    expect(generic.map((a) => a.id)).toEqual(['g']);
    // …but reading the file it would have to hit is still not verifying it.
    const inspection = planStepsClosedByEvidence({
      snapshot: snapshot([{ id: 'g', description: 'Verify the health endpoint responds' }]),
      written: [],
      checks: [{ tool: 'run_terminal', command: 'cat src/app/api/health/route.ts' }],
      at: AT,
    });
    expect(inspection).toEqual([]);
  });

  it('leaves settled steps alone and prefers the write over the check', () => {
    const out = planStepsClosedByEvidence({
      snapshot: snapshot([
        { id: 'done1', description: 'Fix src/a.js', status: 'done' },
        { id: 'blocked1', description: 'Fix src/b.js', status: 'blocked' },
        { id: 'both', description: 'Fix src/c.js then verify src/c.js' },
      ]),
      written: [{ tool: 'edit_file', path: 'src/c.js' }],
      checks: [{ tool: 'run_terminal', command: 'npm test' }],
      at: AT,
    });
    expect(out.map((o) => o.id)).toEqual(['both']);
    expect(out[0].evidence.path).toBe('src/c.js');
  });

  it('does nothing without a plan', () => {
    expect(planStepsClosedByEvidence({ snapshot: null, written: [{ tool: 'edit_file', path: 'a.js' }], checks: [], at: AT })).toEqual([]);
  });
});

/** A store that records what the loop asked it to do. */
function fakePlanStore(steps: Array<{ id: string; description: string; status?: string }>) {
  const plan = snapshot(steps) as unknown as { steps: Array<{ id: string; description: string; status: string; evidence?: unknown; note?: string }>; goal: string; revision: number };
  const updates: Array<{ id: string; status: string; note?: string; provenance?: unknown }> = [];
  const store = {
    snapshot: () => plan as never,
    create: () => plan as never,
    update: (id: string, status: string, note?: string, provenance?: unknown) => {
      updates.push({ id, status, note, provenance });
      const step = plan.steps.find((s) => s.id === id);
      if (step) {
        step.status = status;
        if (note) step.note = note;
        step.evidence = (provenance as { evidence?: unknown } | undefined)?.evidence;
      }
      return plan as never;
    },
  } as unknown as ToolContext['planStore'];
  return { store, updates, plan };
}

function mockDeps(
  script: StepResponse[],
  execute: (name: string, args: Record<string, unknown>) => Promise<string>,
  onEvent: (line: string) => void,
): ToolLoopDeps {
  const callModel = vi.fn();
  let i = 0;
  callModel.mockImplementation(async () => script[Math.min(i++, script.length - 1)]);
  return { callModel, executeTool: vi.fn(execute), onEvent: vi.fn(onEvent) };
}

describe('plan auto-advance — in the loop', () => {
  it('advances the step the edit closed, with evidence, and spends no plan call', async () => {
    const { store, updates } = fakePlanStore([
      { id: 'fix', description: 'Fix src/slugify.js so punctuation collapses' },
      { id: 'verify', description: 'Run npm test and record the real result' },
      { id: 'report', description: 'Deliver the final report' },
    ]);
    const events: string[] = [];
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'src/slugify.js', old_string: 'a', new_string: 'b' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => '✅ edited src/slugify.js', (l) => events.push(l));
    await runToolLoop({
      messages: [{ role: 'user', content: 'fix the slugifier and release it' }],
      context: { ...ctx, planStore: store },
      deps,
      requirePlan: false,
      requireVerification: false,
    });

    const fixed = updates.find((u) => u.id === 'fix');
    expect(fixed?.status).toBe('done');
    expect((fixed?.provenance as { hasLedger?: boolean })?.hasLedger).toBe(true);
    expect((fixed?.provenance as { evidence?: { path?: string } })?.evidence?.path).toBe('src/slugify.js');
    expect(fixed?.note).toContain('observed work');
    // The check step did NOT run a check, and prose is never advanced for the model.
    expect(updates.find((u) => u.id === 'verify')).toBeUndefined();
    expect(updates.find((u) => u.id === 'report')).toBeUndefined();
    expect(events.some((l) => l.includes('🗺️') && l.includes('no plan call spent'))).toBe(true);
  });

  it('closes a check step when the check really ran and succeeded', async () => {
    const { store, updates } = fakePlanStore([{ id: 'verify', description: 'Run npm test and record the real result' }]);
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
      { content: 'Tests pass.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => 'TAP version 13\n# tests 6\n# pass 6\n# fail 0', () => {});
    await runToolLoop({
      messages: [{ role: 'user', content: 'verify the tests' }],
      context: { ...ctx, planStore: store },
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    const verify = updates.find((u) => u.id === 'verify');
    expect(verify?.status).toBe('done');
    expect((verify?.provenance as { evidence?: { command?: string } })?.evidence?.command).toBe('npm test');
  });

  it('does NOT close a check step whose command FAILED — no invented progress', async () => {
    const { store, updates } = fakePlanStore([{ id: 'verify', description: 'Run npm test and record the real result' }]);
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'run_terminal', arguments: { command: 'npm test' } }] },
      { content: 'Two tests fail.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => 'Error: command failed with exit code 1\n# fail 2', () => {});
    await runToolLoop({
      messages: [{ role: 'user', content: 'verify the tests' }],
      context: { ...ctx, planStore: store },
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    expect(updates.some((u) => u.id === 'verify')).toBe(false);
  });

  it('advances once per step, never twice for the same step', async () => {
    const { store, updates } = fakePlanStore([{ id: 'fix', description: 'Fix src/a.js' }]);
    const script: StepResponse[] = [
      { content: '', toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'src/a.js', old_string: 'a', new_string: 'b' } }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'edit_file', arguments: { path: 'src/a.js', old_string: 'b', new_string: 'c' } }] },
      { content: 'Done.', toolCalls: [] },
    ];
    const deps = mockDeps(script, async () => '✅ edited src/a.js', () => {});
    await runToolLoop({
      messages: [{ role: 'user', content: 'fix src/a.js' }],
      context: { ...ctx, planStore: store },
      deps,
      requirePlan: false,
      requireVerification: false,
    });
    expect(updates.filter((u) => u.id === 'fix')).toHaveLength(1);
  });
});

// The saving is only structural if the MODEL stops spending calls on bookkeeping
// the trace already shows. The tool description is the only place it is told, so
// a well-meaning rewrite of that string must not quietly restore the habit.
describe('plan auto-advance — the model is told not to re-state it', () => {
  it('plan_todo description points at the loop and forbids re-stating visible progress', () => {
    const description = getTool('plan_todo')?.description ?? '';
    expect(description).toMatch(/advances a step to done BY ITSELF/i);
    expect(description).toMatch(/do NOT spend a call re-stating progress/i);
    // The old wording created the cost: update every step, twice.
    expect(description).not.toMatch(/update each step as it starts and again as it finishes/i);
  });
});
