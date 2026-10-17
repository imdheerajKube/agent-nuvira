/**
 * R1 — EVIDENCE-GATED PLAN STEPS.
 *
 * The defect this closes is measured, not hypothesised: on the head-to-head audit a
 * plan table reported `14 failed / 422 passed ✅ done` BEFORE any command in the
 * transcript had run. A claim about a measurement was wearing the same tick as a
 * measured result. The fix is a label, never a refusal — a step whose proof is a
 * decision rather than an execution is legitimate, so nothing is blocked; what
 * changes is that the claim can no longer LOOK verified.
 *
 * The load-bearing subtlety is where the demotion does NOT apply: a context that
 * cannot tell "nothing ran" from "no ledger" must never demote. That is the rule
 * `enforceEvidenceProvenance` already documents for a finding's evidence, and the
 * first test below pins that a direct `update` (a test, a probe, a rehydrated
 * session) leaves the step exactly as it was.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PlanStore,
  normalizePlan,
  planProvenanceFromActions,
} from '../../src/tools/plan-store.js';
import { getTool } from '../../src/tools/registry.js';

const GOAL = 'audit the project';
const STEPS = [
  { id: 's1', description: 'map the modules' },
  { id: 's2', description: 'run the suite' },
];

describe('planProvenanceFromActions — what the turn actually did', () => {
  it('records NO verdict when there was no ledger', () => {
    // A direct store call cannot distinguish "nothing ran" from "no ledger", so it
    // must not demote on the strength of an empty list.
    expect(planProvenanceFromActions(undefined)).toEqual({ hasLedger: false });
  });

  it('reports an empty ledger as a ledger with nothing behind the claim', () => {
    expect(planProvenanceFromActions([])).toEqual({ hasLedger: true });
  });

  it('ignores the plan tool\'s OWN calls — they are the claim, not the evidence', () => {
    // Without this, marking a step done right after creating the plan would cite
    // the create call as proof of work.
    const provenance = planProvenanceFromActions([
      { tool: 'plan_todo', ok: true },
      { tool: 'plan_todo', ok: true },
    ]);
    expect(provenance).toEqual({ hasLedger: true });
  });

  it('cites the LAST real action, with its command, outcome and time', () => {
    const provenance = planProvenanceFromActions(
      [
        { tool: 'read_file', ok: true, path: 'src/a.ts' },
        { tool: 'run_terminal', ok: true, command: 'npm test' },
        { tool: 'plan_todo', ok: true },
      ],
      1_700_000_000_000,
    );
    expect(provenance.hasLedger).toBe(true);
    expect(provenance.evidence).toEqual({
      tool: 'run_terminal',
      command: 'npm test',
      ok: true,
      at: 1_700_000_000_000,
    });
  });

  it('cites a FAILED call too — a failing command is real evidence about a failure', () => {
    const provenance = planProvenanceFromActions([{ tool: 'run_terminal', ok: false, command: 'make' }], 5);
    expect(provenance.evidence?.ok).toBe(false);
    expect(provenance.evidence?.tool).toBe('run_terminal');
  });
});

describe('PlanStore — the label, and where it does NOT apply', () => {
  it('leaves a direct update exactly as it was (no ledger, no verdict)', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done');
    const step = store.snapshot()!.steps[0]!;
    expect(step.status).toBe('done');
    expect(step.asserted).toBeUndefined();
    expect(step.evidence).toBeUndefined();
    // The table still shows a plain tick, because nothing here says otherwise.
    expect(store.toTable()).toContain('✅ done');
    expect(store.progress().asserted).toBe(0);
  });

  it('renders ⚠️ instead of ✅ for a done step the turn could not back', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', 'suite green', { hasLedger: true });
    expect(store.toTable()).toContain('⚠️ done (asserted)');
    expect(store.toTable()).toContain('1 asserted (no tool call behind the claim)');
    expect(store.progress()).toMatchObject({ done: 1, asserted: 1 });
    // The MODEL did set the status; the table still reports the count honestly and
    // the reader is told what it is worth.
    expect(store.progress().percent).toBe(50);
  });

  it('attaches the backing call as evidence and keeps the plain tick', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s2', 'done', 'suite green', {
      hasLedger: true,
      evidence: { tool: 'run_terminal', command: 'npm test', ok: true, at: 42 },
    });
    const step = store.snapshot()!.steps[1]!;
    expect(step.evidence).toEqual({ tool: 'run_terminal', command: 'npm test', ok: true, at: 42 });
    expect(step.asserted).toBeUndefined();
    expect(store.toTable()).toContain('✅ done');
    expect(store.progress().asserted).toBe(0);
  });

  it('retracts the warning when the done claim is withdrawn', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', undefined, { hasLedger: true });
    expect(store.progress().asserted).toBe(1);
    store.update('s1', 'running');
    expect(store.snapshot()!.steps[0]!.asserted).toBeUndefined();
    expect(store.progress().asserted).toBe(0);
  });

  it('upgrades an asserted step once real evidence arrives', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', undefined, { hasLedger: true });
    expect(store.progress().asserted).toBe(1);
    store.update('s1', 'done', undefined, {
      hasLedger: true,
      evidence: { tool: 'run_terminal', command: 'npm test', ok: true, at: 7 },
    });
    expect(store.progress().asserted).toBe(0);
    expect(store.toTable()).toContain('✅ done');
  });

  it('warns the reader when a COMPLETE plan rests on asserted steps', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', undefined, { hasLedger: true });
    store.update('s2', 'done', undefined, { hasLedger: true });
    expect(store.progress().complete).toBe(true);
    const summary = store.summary();
    expect(summary).toContain('2/2 steps achieved');
    expect(summary).toMatch(/ASSERTED, not verified/);
    // And a plan whose steps were all backed says nothing of the sort.
    const clean = new PlanStore();
    clean.create(GOAL, STEPS);
    for (const id of ['s1', 's2']) {
      clean.update(id, 'done', undefined, {
        hasLedger: true,
        evidence: { tool: 'run_terminal', command: 'npm test', ok: true, at: 1 },
      });
    }
    expect(clean.summary()).not.toMatch(/ASSERTED/);
  });

  it('keeps provenance across a re-declaration (it must not launder a claim)', () => {
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', undefined, { hasLedger: true });
    store.update('s2', 'done', 'verified', {
      hasLedger: true,
      evidence: { tool: 'run_terminal', command: 'npm test', ok: true, at: 9 },
    });
    store.create(GOAL, STEPS); // the same goal, re-declared
    const [first, second] = store.snapshot()!.steps;
    expect(first!.asserted).toBe(true);
    expect(second!.evidence?.tool).toBe('run_terminal');
  });

  it('survives a reload from disk', () => {
    // `asserted` is a statement about what the reader should trust; dropping it on
    // the next process start would quietly promote an unverified step.
    const store = new PlanStore();
    store.create(GOAL, STEPS);
    store.update('s1', 'done', undefined, { hasLedger: true });
    store.update('s2', 'done', undefined, {
      hasLedger: true,
      evidence: { tool: 'run_terminal', command: 'npm test', ok: true, at: 3 },
    });
    const restored = normalizePlan(JSON.parse(JSON.stringify(store.snapshot())))!;
    expect(restored.steps[0]!.asserted).toBe(true);
    expect(restored.steps[1]!.evidence?.command).toBe('npm test');
  });

  it('drops a malformed persisted evidence record instead of trusting it', () => {
    const restored = normalizePlan({
      goal: GOAL,
      steps: [{ id: 's1', description: 'x', status: 'done', evidence: { tool: '  ' } }],
    })!;
    expect(restored.steps[0]!.evidence).toBeUndefined();
  });
});

describe('the plan_todo tool — the model is told which way its claim was recorded', () => {
  const run = async (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
    store: PlanStore,
  ): Promise<string> => {
    const tool = getTool('plan_todo');
    expect(tool, 'plan_todo is registered').toBeDefined();
    return await tool!.run(args, { configManager: {}, planStore: store, ...ctx } as never);
  };

  it('records ASSERTED and says so when the ledger is empty', async () => {
    const store = new PlanStore();
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-plan-evidence-'));
    try {
      await run({ action: 'create', goal: GOAL, steps: STEPS }, { cwd: dir, executedActions: [] }, store);
      const out = await run({ action: 'update', id: 's1', status: 'done', note: 'suite green' }, { cwd: dir, executedActions: [] }, store);
      expect(out).toContain('ASSERTED, not verified');
      expect(out).toContain('no tool call has run in this turn');
      expect(out).toContain('⚠️ done (asserted)');
      expect(store.progress().asserted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the backing call and stays quiet when there IS one', async () => {
    const store = new PlanStore();
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-plan-evidence-'));
    try {
      await run({ action: 'create', goal: GOAL, steps: STEPS }, { cwd: dir, executedActions: [] }, store);
      const out = await run(
        { action: 'update', id: 's2', status: 'done', note: 'suite green' },
        { cwd: dir, executedActions: [{ tool: 'run_terminal', ok: true, command: 'npm test' }] },
        store,
      );
      expect(out).not.toContain('ASSERTED');
      expect(out).toContain('✅ done');
      expect(store.snapshot()!.steps[1]!.evidence?.command).toBe('npm test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not demote when no ledger was supplied at all (a bare tool call)', async () => {
    const store = new PlanStore();
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-plan-evidence-'));
    try {
      await run({ action: 'create', goal: GOAL, steps: STEPS }, { cwd: dir }, store);
      const out = await run({ action: 'update', id: 's1', status: 'done' }, { cwd: dir }, store);
      expect(out).not.toContain('ASSERTED');
      expect(store.progress().asserted).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
