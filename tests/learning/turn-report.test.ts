/**
 * Workstream E — TurnReport (plan → track → verify → report).
 *
 * The report is DERIVED FROM RECORDED EVIDENCE: verification is a function of
 * what tools actually ran plus the honesty flags — never the model's narration.
 */

import { describe, it, expect } from 'vitest';

import { buildTurnReport, formatTurnReport } from '../../src/learning/turn-report.js';
import type { Plan } from '../../src/tools/plan-store.js';

function plan(steps: Array<{ id: string; description: string; status: Plan['steps'][number]['status']; note?: string }>): Plan {
  return { goal: 'do the thing', steps, revision: 1, updatedAt: Date.now() };
}

describe('buildTurnReport — verification verdict', () => {
  it('is not-applicable and silent for a plain answer', () => {
    const r = buildTurnReport({ goal: 'say hi', toolCalls: [], successfulToolCalls: [] });
    expect(r.verification).toBe('not-applicable');
    expect(r.summary).toBeNull();
  });

  it('is verified when a change was observed by a verification tool', () => {
    const r = buildTurnReport({
      goal: 'fix bug',
      plan: plan([
        { id: 's1', description: 'edit', status: 'done' },
        { id: 's2', description: 'test', status: 'done' },
      ]),
      toolCalls: ['edit_file', 'run_terminal'],
      successfulToolCalls: ['edit_file', 'run_terminal'],
      mutations: 1,
      changedPaths: ['src/a.ts'],
    });
    expect(r.verification).toBe('verified');
    expect(r.summary).toContain('2/2 steps done');
    expect(r.summary).toContain('1 file(s) changed');
    expect(r.summary).toContain('verification: verified');
    // No annotation on a verified turn.
    expect(r.steps.every((s) => s.evidence === undefined)).toBe(true);
  });

  it('is unverified when a change had no observation', () => {
    const r = buildTurnReport({
      goal: 'change it',
      toolCalls: ['edit_file'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
    });
    expect(r.verification).toBe('unverified');
  });

  it('is unverified when ANY honesty flag is set (flags beat clean evidence)', () => {
    const r = buildTurnReport({
      goal: 'build it',
      successfulToolCalls: ['write_file', 'run_terminal'],
      mutations: 1,
      flags: { unverifiedBuildClaim: true },
    });
    expect(r.verification).toBe('unverified');
  });

  it('is blocked when a plan step is blocked, and annotates done steps', () => {
    const r = buildTurnReport({
      goal: 'ship it',
      plan: plan([
        { id: 's1', description: 'done part', status: 'done' },
        { id: 's2', description: 'blocked part', status: 'blocked', note: 'missing key' },
      ]),
      successfulToolCalls: ['edit_file'],
      mutations: 1,
    });
    expect(r.verification).toBe('blocked');
    expect(r.stepCounts.blocked).toBe(1);
    expect(r.stepCounts.done).toBe(1);
    expect(r.steps.find((s) => s.id === 's1')?.evidence).toContain('blocked');
  });

  it('dedupes changed paths and counts step statuses', () => {
    const r = buildTurnReport({
      goal: 'g',
      plan: plan([
        { id: 'a', description: 'a', status: 'pending' },
        { id: 'b', description: 'b', status: 'running' },
      ]),
      changedPaths: ['x', 'x', 'y'],
    });
    expect(r.changedPaths).toEqual(['x', 'y']);
    expect(r.stepCounts).toMatchObject({ pending: 1, running: 1, total: 2 });
  });
});

describe('formatTurnReport', () => {
  it('renders steps and an explicit UNVERIFIED warning', () => {
    const r = buildTurnReport({
      goal: 'change it',
      plan: plan([{ id: 's1', description: 'edit the file', status: 'done' }]),
      successfulToolCalls: ['edit_file'],
      mutations: 1,
    });
    const text = formatTurnReport(r);
    expect(text).toContain('Turn report — change it');
    expect(text).toContain('edit the file');
    expect(text).toContain('UNVERIFIED');
  });

  it('renders a BLOCKED warning', () => {
    const r = buildTurnReport({
      goal: 'g',
      plan: plan([{ id: 's1', description: 'x', status: 'blocked' }]),
    });
    expect(formatTurnReport(r)).toContain('BLOCKED');
  });
});
