/**
 * Phase 5b / G3 — the live fan-out scheduler.
 *
 * The behaviour that matters is the one the fixed `Promise.all` batch could not
 * do: a task UNBLOCKED by a sibling starts in the SAME batch as soon as a lane
 * frees, instead of waiting for the whole batch to settle. These tests drive the
 * scheduler with fake tasks so the scheduling rule is pinned without a pipeline.
 */

import { describe, it, expect } from 'vitest';
import { runLiveFanout, type FanoutTask } from '../../src/agents/fanout-scheduler.js';

interface Task extends FanoutTask {
  exclusive?: boolean;
  /** Deferred so a test controls exactly when it settles. */
  settle: () => void;
}

/** Flush pending microtasks AND the macrotask queue the scheduler schedules on. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A task whose promise resolves only when its `settle` is called. */
function controlledTask(id: string, exclusive = false): Task {
  const box: { resolve?: () => void } = {};
  const settle = (): void => box.resolve?.();
  // Attach nothing yet; `run` will install the resolver.
  return {
    id,
    exclusive,
    settle: () => settle(),
  };
}

describe('runLiveFanout', () => {
  it('runs every initial task and resolves when all settle', async () => {
    const a = controlledTask('a');
    const b = controlledTask('b');
    const started: string[] = [];
    const run = async (task: Task): Promise<void> => {
      started.push(task.id);
      await new Promise<void>((resolve) => {
        task.settle = resolve;
      });
    };
    const promise = runLiveFanout<Task>({
      initial: [a, b],
      poll: () => [],
      isExclusive: (t) => t.exclusive === true,
      run,
    });
    // Both initial lanes start immediately (default concurrency = initial size).
    await tick();
    expect(started.sort()).toEqual(['a', 'b']);
    a.settle();
    b.settle();
    const result = await promise;
    expect(result.admitted).toEqual(['a', 'b']);
    expect(result.promoted).toEqual([]);
  });

  it('promotes a newly unblocked task into the SAME batch when a lane frees', async () => {
    // One initial lane; when it finishes, `poll` reports a now-unblocked task.
    const first = controlledTask('first');
    const unblocked = controlledTask('second');
    const runOrder: string[] = [];
    let polled = false;

    const run = async (task: Task): Promise<void> => {
      runOrder.push(task.id);
      await new Promise<void>((resolve) => {
        task.settle = resolve;
      });
    };

    const promise = runLiveFanout<Task>({
      initial: [first],
      // Second only becomes runnable once first has settled.
      poll: () => {
        if (polled) return [];
        polled = true;
        return [unblocked];
      },
      isExclusive: (t) => t.exclusive === true,
      run,
    });

    await tick();
    expect(runOrder).toEqual(['first']);
    // Free the lane — the scheduler must pick up `second` in this same batch.
    first.settle();
    await tick();
    expect(runOrder).toEqual(['first', 'second']);
    unblocked.settle();
    const result = await promise;
    expect(result.admitted).toEqual(['first', 'second']);
    expect(result.promoted).toEqual(['second']);
  });

  it('never exceeds maxConcurrency', async () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => controlledTask(id));
    let peak = 0;
    let active = 0;
    const run = async (task: Task): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        task.settle = () => {
          active -= 1;
          resolve();
        };
      });
    };
    const promise = runLiveFanout<Task>({
      initial: tasks,
      poll: () => [],
      isExclusive: (t) => t.exclusive === true,
      run,
      maxConcurrency: 2,
    });
    // Let the pool fill the two lanes, then drain it.
    for (let i = 0; i < 20; i += 1) {
      await tick();
      for (const t of tasks) t.settle();
    }
    await promise;
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('never admits an exclusive task (initial or promoted)', async () => {
    const normal = controlledTask('normal');
    const exclusiveInitial = controlledTask('exclusive-init', true);
    const exclusivePromoted = controlledTask('exclusive-promo', true);
    const runIds: string[] = [];
    const run = async (task: Task): Promise<void> => {
      runIds.push(task.id);
      await new Promise<void>((resolve) => {
        task.settle = resolve;
      });
    };
    const promise = runLiveFanout<Task>({
      initial: [normal, exclusiveInitial],
      poll: () => [exclusivePromoted],
      isExclusive: (t) => t.exclusive === true,
      run,
    });
    await tick();
    expect(runIds).toEqual(['normal']);
    normal.settle();
    const result = await promise;
    expect(result.admitted).toEqual(['normal']);
    expect(result.promoted).toEqual([]);
  });

  it('drains the pool, then re-throws the first task error', async () => {
    const boom = controlledTask('boom');
    const ok = controlledTask('ok');
    const run = async (task: Task): Promise<void> => {
      if (task.id === 'boom') throw new Error('boom failed');
      await new Promise<void>((resolve) => {
        task.settle = resolve;
      });
    };
    const promise = runLiveFanout<Task>({
      initial: [boom, ok],
      poll: () => [],
      isExclusive: (t) => t.exclusive === true,
      run,
    });
    await tick();
    ok.settle();
    await expect(promise).rejects.toThrow('boom failed');
  });

  it('resolves immediately for an empty batch', async () => {
    const result = await runLiveFanout<Task>({
      initial: [],
      poll: () => [],
      isExclusive: () => false,
      run: async () => {},
    });
    expect(result).toEqual({ admitted: [], promoted: [] });
  });
});
