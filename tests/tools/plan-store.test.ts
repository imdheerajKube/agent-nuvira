/**
 * P0.7 — PlanStore tests (creating AND tracking plans).
 *
 * The chat agent's plan capability: declare ordered steps, update statuses
 * (pending → running → done/blocked), reference across turns (the store
 * outlives a single tool call). Pure in-memory — no fs, no LLM.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  PlanStore,
  defaultPlanStore,
  createPersistentPlanStore,
  planFilePath,
  readPlanFile,
  writePlanFile,
  normalizePlan,
} from '../../src/tools/plan-store.js';

describe('PlanStore', () => {
  it('creates a plan with pending steps and a default id when omitted', () => {
    const store = new PlanStore();
    const plan = store.create('Fix the failing test', [
      { id: 'reproduce', description: 'Reproduce the failure' },
      { description: 'Read the failing test' },
    ]);
    expect(plan.goal).toBe('Fix the failing test');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toEqual({ id: 'reproduce', description: 'Reproduce the failure', status: 'pending' });
    expect(plan.steps[1].id).toBe('step-2');
    expect(plan.revision).toBe(1);
  });

  it('returns null snapshot before any create', () => {
    const store = new PlanStore();
    expect(store.snapshot()).toBeNull();
    expect(store.toGUI()).toBeNull();
    expect(store.update('x', 'done')).toBeNull();
    expect(store.toText()).toContain('No plan yet');
  });

  it('updates a step status and bumps the revision', () => {
    const store = new PlanStore();
    store.create('Fix the failing test', [
      { id: 'reproduce', description: 'Reproduce the failure' },
      { id: 'fix', description: 'Fix the bug' },
      { id: 'verify', description: 'Verify with npm test' },
    ]);
    store.update('reproduce', 'running');
    store.update('reproduce', 'done');
    store.update('fix', 'blocked');
    const plan = store.snapshot()!;
    expect(plan.steps.find((s) => s.id === 'reproduce')?.status).toBe('done');
    expect(plan.steps.find((s) => s.id === 'fix')?.status).toBe('blocked');
    expect(plan.steps.find((s) => s.id === 'verify')?.status).toBe('pending');
    expect(plan.revision).toBe(4); // create(1) + three real changes → 4
  });

  it('unknown step id and unknown status are no-ops (no revision bump)', () => {
    const store = new PlanStore();
    store.create('Go', [{ id: 'a', description: 'A' }]);
    const before = store.snapshot()!;
    store.update('nope', 'done');
    store.update('a', 'nonsense' as never);
    expect(store.snapshot()!.revision).toBe(before.revision);
  });

  it('create REPLACES the previous plan (course correction)', () => {
    const store = new PlanStore();
    store.create('Old goal', [{ id: 'a', description: 'A' }]);
    const repl = store.create('New goal', [{ id: 'b', description: 'B' }]);
    expect(repl.goal).toBe('New goal');
    expect(repl.steps).toHaveLength(1);
    expect(repl.steps[0].id).toBe('b');
    expect(store.snapshot()!.steps).toHaveLength(1);
  });

  it('renders a readable checklist with counts and status icons', () => {
    const store = new PlanStore();
    store.create('Fix the failing test', [
      { id: 'reproduce', description: 'Reproduce the failure' },
      { id: 'fix', description: 'Fix the bug' },
    ]);
    store.update('reproduce', 'done');
    store.update('fix', 'running');
    const text = store.toText();
    expect(text).toContain('1/2 done');
    expect(text).toContain('✅');
    expect(text).toContain('🔄');
  });

  it('toGUI returns the GUI-friendly snapshot (goal + steps + revision)', () => {
    const store = new PlanStore();
    store.create('Go', [{ id: 'a', description: 'A' }]);
    const gui = store.toGUI()!;
    expect(gui).toEqual({
      goal: 'Go',
      steps: [{ id: 'a', description: 'A', status: 'pending' }],
      revision: 1,
    });
  });

  it('defaultPlanStore returns a shared usable store (no-throw fallback)', () => {
    const store = defaultPlanStore();
    expect(store.snapshot()).toBeDefined();
    expect(typeof store.create).toBe('function');
    expect(typeof store.update).toBe('function');
  });

  // ─── Tabular progress view + completion summary ───────────────────────────

  it('toTable renders a markdown progress table with a goal, count and percent', () => {
    const store = new PlanStore();
    store.create('Fix the failing test', [
      { id: 'a', description: 'Reproduce' },
      { id: 'b', description: 'Fix it' },
    ]);
    store.update('a', 'done');
    const table = store.toTable();
    expect(table).toContain('Fix the failing test');
    expect(table).toContain('1/2 done (50%)');
    expect(table).toContain('| # | Step | Status |');
    expect(table).toContain('| 1 | Reproduce | ✅ done |');
    expect(table).toContain('| 2 | Fix it | ⬜ pending |');
  });

  it('adds a Notes column only once a step reports a note', () => {
    const store = new PlanStore();
    store.create('Go', [{ id: 'a', description: 'A' }]);
    expect(store.toTable()).not.toContain('Notes');
    store.update('a', 'done', 'shipped it');
    const table = store.toTable();
    expect(table).toContain('| Notes |');
    expect(table).toContain('shipped it');
  });

  it('progress() counts done/blocked and reports completion', () => {
    const store = new PlanStore();
    store.create('Go', [
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
      { id: 'c', description: 'C' },
      { id: 'd', description: 'D' },
    ]);
    store.update('a', 'done');
    store.update('b', 'blocked');
    const p = store.progress();
    expect(p).toEqual({ done: 1, blocked: 1, total: 4, percent: 25, complete: false, settled: false });
    store.update('c', 'done');
    store.update('d', 'done');
    // A blocked step means no work is outstanding, but the plan is not "complete".
    const partial = store.progress();
    expect(partial.complete).toBe(false);
    expect(partial.settled).toBe(true);
    store.update('b', 'done');
    const finished = store.progress();
    expect(finished.complete).toBe(true);
    expect(finished.percent).toBe(100);
  });

  it('toText names the step in progress while running, then shows the achieved summary', () => {
    const store = new PlanStore();
    store.create('Ship the release', [
      { id: 'a', description: 'Build' },
      { id: 'b', description: 'Publish' },
    ]);
    store.update('a', 'running');
    expect(store.toText()).toContain('Working on step 1/2: Build');
    store.update('a', 'done', 'built');
    store.update('b', 'done', 'published');
    const text = store.toText();
    expect(text).toContain('Plan complete — 2/2 steps achieved');
    expect(text).toContain('published');
  });

  it('summary() reports outstanding work when the plan settles with a blocked step', () => {
    const store = new PlanStore();
    store.create('Go', [
      { id: 'a', description: 'A' },
      { id: 'b', description: 'B' },
      { id: 'c', description: 'C' },
    ]);
    store.update('a', 'done');
    store.update('b', 'blocked');
    const summary = store.summary();
    expect(summary).toContain('1/3 achieved');
    expect(summary).toContain('1 blocked');
    expect(summary).toContain('1 outstanding');
  });

  // ─── onChange + persistence ───────────────────────────────────────────────

  it('onChange fires on create, real updates and hydrate', () => {
    const onChange = vi.fn();
    const store = new PlanStore({ onChange });
    store.create('Go', [{ id: 'a', description: 'A' }]);
    store.update('a', 'done');
    store.update('a', 'done'); // no-op → no second call
    const callsAfterUpdates = onChange.mock.calls.length;
    expect(callsAfterUpdates).toBe(2);
    store.hydrate({ goal: 'Restored', steps: [{ id: 'x', description: 'X', status: 'pending' }], revision: 1, updatedAt: 1 });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(store.snapshot()!.goal).toBe('Restored');
  });

  it('normalizePlan rejects junk and defaults unknown statuses to pending', () => {
    expect(normalizePlan(null)).toBeNull();
    expect(normalizePlan({ goal: 'x', steps: [] })).toBeNull();
    const plan = normalizePlan({ goal: 'g', steps: [{ id: 'a', description: 'A', status: 'bogus' }], revision: '2' });
    expect(plan?.revision).toBe(2);
    expect(plan?.steps[0].status).toBe('pending');
  });

  it('createPersistentPlanStore round-trips a plan through a scope file', () => {
    const scope = `test-scope-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const path = planFilePath(scope);
    // Nothing there yet → an empty store.
    const first = createPersistentPlanStore(scope);
    expect(first.snapshot()).toBeNull();

    first.create('Persist me', [{ id: 'a', description: 'A' }]);
    first.update('a', 'done', 'did A');
    expect(readPlanFile(path)?.goal).toBe('Persist me');

    // A NEW store for the same scope restores it (cross-session continuity).
    const second = createPersistentPlanStore(scope);
    expect(second.snapshot()!.goal).toBe('Persist me');
    expect(second.snapshot()!.steps[0]).toEqual({ id: 'a', description: 'A', status: 'done', note: 'did A' });

    // Clearing writes an empty plan the next store hydrates as "none".
    writePlanFile(path, null);
    expect(createPersistentPlanStore(scope).snapshot()).toBeNull();
  });
});
