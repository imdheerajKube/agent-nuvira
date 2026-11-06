/**
 * `nuvira resume` — the continuation loop's own rules.
 *
 * A resume is finished only when the SESSION closes; a bounded round is progress
 * (it spent its budget on the work); and the loop must stop on its own when rounds
 * stop moving the turn or the provider keeps failing. Those are the three claims
 * this file pins, because each one is a way a long build either stops early (and
 * strands work) or spends tokens in a loop.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RESUME_DEADLINE_MS,
  driveResumableRun,
  MAX_FAILED_ROUNDS,
  MAX_STALLED_ROUNDS,
  type ResumeDeps,
} from '../../src/cli/resume.js';
import type { SessionSnapshot } from '../../src/learning/session-store.js';

const RUN = { id: 'run-1', goal: 'build the checkout flow', cwd: '/project' };

function snapshot(steps = 1): SessionSnapshot {
  return {
    id: RUN.id,
    goal: RUN.goal,
    cwd: RUN.cwd,
    savedAt: 0,
    revision: 1,
    open: true,
    headLength: 0,
    messages: [],
    accumulators: { steps, successfulTools: [], mutatedPaths: [] },
  };
}

/** A deps harness: each round returns `results[i]`, and `opens[i]` is what the store holds after it. */
function harness(input: {
  results: Array<{ bounded?: boolean; generationFailed?: boolean; cancelled?: boolean; content?: string }>;
  opens: Array<SessionSnapshot | null>;
  now?: () => number;
}): ResumeDeps & { rounds: () => number } {
  let i = 0;
  return {
    execute: vi.fn(async () => input.results[Math.min(i, input.results.length - 1)] ?? {}),
    findOpen: vi.fn(() => {
      const value = input.opens[Math.min(i, input.opens.length - 1)] ?? null;
      i += 1;
      return value;
    }),
    now: input.now ?? (() => 0),
    log: () => {},
    rounds: () => i,
  };
}

describe('driveResumableRun', () => {
  it('finishes as soon as the session closes', async () => {
    const deps = harness({ results: [{ bounded: true, content: 'done' }], opens: [null] });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 10 });

    expect(out.status).toBe('finished');
    expect(out.rounds).toBe(1);
    expect(out.lastContent).toBe('done');
  });

  it('continues across a bounded round instead of calling it done', async () => {
    const deps = harness({
      results: [{ bounded: true }, { bounded: false }],
      opens: [snapshot(12), null],
    });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 10 });

    expect(out.status).toBe('finished');
    expect(out.rounds).toBe(2);
    expect(out.steps).toBe(12);
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('stops after consecutive rounds that leave the turn open without advancing it', async () => {
    const deps = harness({
      results: [{ bounded: false }],
      opens: [snapshot(3)],
    });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 50 });

    expect(out.status).toBe('stalled');
    expect(out.rounds).toBe(MAX_STALLED_ROUNDS);
    expect(out.reason).toContain('without advancing');
  });

  it('a bounded round resets the stall counter (budget spent is progress)', async () => {
    const deps = harness({
      // unbounded, unbounded, then a bounded round, then open rounds…
      results: [{ bounded: false }, { bounded: false }, { bounded: true }, { bounded: false }],
      opens: [snapshot(1), snapshot(2), snapshot(3), snapshot(4)],
    });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 50 });

    // Three unbounded rounds in a row never happened: the bounded one reset it,
    // so the stop comes after three unbounded rounds FOLLOWING it (round 6).
    expect(out.status).toBe('stalled');
    expect(out.rounds).toBe(6);
  });

  it('stops after consecutive generation failures', async () => {
    const deps = harness({
      results: [{ generationFailed: true }],
      opens: [snapshot(0)],
    });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 50 });

    expect(out.status).toBe('failed');
    expect(out.rounds).toBe(MAX_FAILED_ROUNDS);
  });

  it('reports a deadline before spending a round when the clock is already spent', async () => {
    let clock = 0;
    const deps = harness({
      results: [{ bounded: true }],
      opens: [snapshot(1)],
      now: () => (clock += DEFAULT_RESUME_DEADLINE_MS),
    });

    const out = await driveResumableRun(RUN, deps, { deadlineMs: DEFAULT_RESUME_DEADLINE_MS });

    expect(out.status).toBe('deadline');
    expect(out.rounds).toBe(0);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('a cancelled round ends the resume and leaves the snapshot for a later run', async () => {
    const deps = harness({
      results: [{ cancelled: true }],
      opens: [snapshot(1)],
    });

    const out = await driveResumableRun(RUN, deps, { maxRounds: 10 });

    expect(out.status).toBe('cancelled');
    expect(out.rounds).toBe(1);
  });
});
