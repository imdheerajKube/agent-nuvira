/**
 * P0.7 — PlanStore tests (creating AND tracking plans).
 *
 * The chat agent's plan capability: declare ordered steps, update statuses
 * (pending → running → done/blocked), reference across turns (the store
 * outlives a single tool call). Pure in-memory — no fs, no LLM.
 */

import { describe, it, expect } from 'vitest';
import { PlanStore, defaultPlanStore } from '../../src/tools/plan-store.js';

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
});
