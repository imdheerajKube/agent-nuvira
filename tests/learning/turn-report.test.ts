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

describe('buildTurnReport — the accuracy evidence the router learns from (B2/B3 wiring)', () => {
  it('derives failedToolCalls as the difference between attempted and successful', () => {
    const r = buildTurnReport({
      goal: 'edit and check',
      toolCalls: ['edit_file', 'run_terminal', 'run_terminal'],
      successfulToolCalls: ['edit_file', 'run_terminal'],
    });
    // Attempted twice, succeeded once: the run TRIED to check and the second attempt
    // did not succeed. The difference is multiset-aware, so it cannot be silently
    // rounded to "all fine" by a dedupe.
    expect(r.failedToolCalls).toEqual(['run_terminal']);
  });

  it('leaves checksPassed UNDEFINED when no check ran — never `false`', () => {
    // "Nobody checked" is not "the check failed". Booking the former as a failure
    // would penalise a turn that was never asked to prove anything.
    const r = buildTurnReport({
      goal: 'answer a question',
      toolCalls: ['read_file'],
      successfulToolCalls: ['read_file'],
    });
    expect(r.checksPassed).toBeUndefined();
    expect(r.failedToolCalls).toEqual([]);
  });

  it('reports checksPassed true when a check ran and succeeded', () => {
    const r = buildTurnReport({
      goal: 'fix bug',
      toolCalls: ['edit_file', 'run_terminal'],
      successfulToolCalls: ['edit_file', 'run_terminal'],
      mutations: 1,
    });
    expect(r.checksPassed).toBe(true);
  });

  it('reports checksPassed false when a check was attempted and failed', () => {
    const r = buildTurnReport({
      goal: 'fix bug',
      toolCalls: ['edit_file', 'run_terminal'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
    });
    expect(r.checksPassed).toBe(false);
    expect(r.failedToolCalls).toEqual(['run_terminal']);
  });

  it('is false when the only check failed, even with nothing mutated', () => {
    const r = buildTurnReport({ goal: 'run the tests', toolCalls: ['run_terminal'], successfulToolCalls: [] });
    expect(r.checksPassed).toBe(false);
  });
});

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

describe('assumptions taken on the user\'s behalf (E1)', () => {
  const ASSUMED = 'assumed "Postgres" for: Which database?  (nobody was reachable to answer)';

  it('is never silent, even on a turn that changed nothing', () => {
    // The whole defect was silence: a plain answer where the harness had decided
    // something for the user produced NO summary, so the disclosure block (which
    // chat renders only when a summary exists) never printed.
    const r = buildTurnReport({ goal: 'say hi', toolCalls: [], successfulToolCalls: [], assumptions: [ASSUMED] });
    expect(r.summary).not.toBeNull();
    expect(r.summary).toContain('1 decision(s) made for you');
    expect(r.assumptions).toEqual([ASSUMED]);
  });

  it('renders the decision, not just a count', () => {
    const r = buildTurnReport({ goal: 'build it', assumptions: [ASSUMED] });
    const text = formatTurnReport(r);
    expect(text).toContain('decided for you');
    expect(text).toContain('assumed "Postgres" for: Which database?');
  });

  it('stays silent when the user drove the turn', () => {
    const r = buildTurnReport({ goal: 'say hi' });
    expect(r.assumptions).toEqual([]);
    expect(r.summary).toBeNull();
  });
});

describe('C6 — what the turn COST', () => {
  const SPEND = { usd: 0.0234, tokens: 1_192_115, calls: 82 };

  it('states the spend on a turn that did work', () => {
    // The measured run A: 1,192,115 input tokens over 82 steps, reported nowhere.
    const r = buildTurnReport({
      goal: 'build it',
      plan: plan([{ id: 's1', description: 'edit', status: 'done' }]),
      toolCalls: ['edit_file'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
      cost: SPEND,
    });
    expect(r.cost).toEqual(SPEND);
    expect(r.summary).toContain('cost: $0.0234');
    expect(r.summary).toContain('1.19M tok');
    expect(r.summary).toContain('82 calls');
  });

  it('does NOT shout about a cheap turn that did nothing', () => {
    // A one-line answer on a cheap model costs a fraction of a cent; a cost line
    // on every reply is noise, which is the opposite of making spend visible.
    const r = buildTurnReport({ goal: 'say hi', cost: { usd: 0.00003, tokens: 420, calls: 1 } });
    expect(r.cost).toEqual({ usd: 0.00003, tokens: 420, calls: 1 });
    expect(r.summary).toBeNull();
    // …but it is still RENDERED, for a caller that prints the report on its own
    // terms (the dashboard reads `report.cost` rather than the summary).
    expect(formatTurnReport(r)).toContain('💰 cost:');
  });

  it('speaks up when a trivial-looking turn actually cost something', () => {
    const r = buildTurnReport({ goal: 'say hi', cost: { usd: 0.02, tokens: 90_000, calls: 3 } });
    expect(r.summary).not.toBeNull();
    expect(r.summary).toContain('cost: $0.0200');
  });

  it('says nothing about cost when the ledger recorded no call', () => {
    // Absence is not "free" — a turn that never reached a provider has no price to
    // print, and `$0.000000` would claim it was free.
    const r = buildTurnReport({ goal: 'say hi' });
    expect(r.cost).toBeUndefined();
    expect(r.summary).toBeNull();
    expect(formatTurnReport(r)).not.toContain('cost');
  });

  it('renders the spend on the console block too', () => {
    const r = buildTurnReport({
      goal: 'build it',
      toolCalls: ['edit_file'],
      successfulToolCalls: ['edit_file'],
      mutations: 1,
      cost: { usd: 0.0004, tokens: 12_345, calls: 2 },
    });
    const text = formatTurnReport(r);
    expect(text).toContain('💰 cost: $0.000400 / 12.3K tok (2 calls)');
  });
});
