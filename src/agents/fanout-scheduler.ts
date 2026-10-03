/**
 * Live fan-out scheduler (Phase 5b / G3).
 *
 * WHY THIS EXISTS
 * ---------------
 * The orchestrator used to dispatch a batch as a FIXED set: it computed the
 * runnable tasks once, ran them all with `Promise.all`, and only recomputed the
 * runnable set on the NEXT outer iteration. So a task that a just-finished
 * task UNBLOCKED sat idle until every sibling in the batch had settled, even
 * though a lane was free — the "freed slot" the plan (G3) asked to fill.
 *
 * This module is the missing piece: a bounded worker pool that, every time a
 * task settles, re-polls for newly runnable work and PROMOTES it into the same
 * batch while lanes remain. It is deliberately pure — it knows nothing about
 * the vault, the agents, or the LLM — so the scheduling rule can be tested
 * without a pipeline.
 *
 * WHY THE DEFAULT CONCURRENCY IS THE INITIAL GROUP SIZE
 * -----------------------------------------------------
 * The old behaviour started EVERY currently-runnable task at once (no cap).
 * Keeping the cap at `initial.length` means the first wave is byte-for-byte the
 * same as before — nothing about the existing fan-out changes — while
 * promotions fill the lanes that then free up. A caller that wants a hard cap
 * can pass `maxConcurrency`.
 *
 * WHY EXCLUSIVE TASKS ARE NEVER ADMITTED HERE
 * -------------------------------------------
 * `tester` / `debugger` / `runner` (and strategy-marked serial steps) share
 * files, ports and sandboxes; the orchestrator runs them one at a time. A
 * promoted task that is exclusive must not start inside a parallel lane, so
 * `isExclusive` filters both the initial set and anything the poll returns —
 * those are left for the serial group / next iteration.
 */

/** The minimum a schedulable task must expose: a stable id. */
export interface FanoutTask {
  id: string;
}

export interface LiveFanoutOptions<T extends FanoutTask> {
  /** Tasks runnable at the start of the batch, in priority order. */
  initial: readonly T[];
  /**
   * Recompute the tasks runnable NOW. Called after each settle; the scheduler
   * filters out anything already admitted or exclusive, so callers can return
   * the raw runnable set each time.
   */
  poll: () => readonly T[];
  /** A task that must run ALONE (exclusive agent / serial strategy). */
  isExclusive: (task: T) => boolean;
  /** Execute one task. Resolves when it settles. */
  run: (task: T) => Promise<void>;
  /** Called as each task is admitted — status/board updates live here. */
  onAdmit?: (task: T) => void;
  /**
   * Max concurrent non-exclusive lanes. Defaults to the initial group size
   * (which reproduces the previous unbounded-at-start fan-out).
   */
  maxConcurrency?: number;
}

export interface LiveFanoutResult {
  /** Every task id the scheduler ran, in admission order. */
  admitted: string[];
  /** Ids admitted AFTER the initial set — i.e. promoted as lanes freed. */
  promoted: string[];
}

/**
 * Run a batch with live promotion. Never rejects for an individual task's
 * failure; if any task throws, the first error is re-thrown AFTER the pool
 * drains, so a caller still observes the failure (and every other task that
 * could make progress still did).
 */
export async function runLiveFanout<T extends FanoutTask>(
  opts: LiveFanoutOptions<T>,
): Promise<LiveFanoutResult> {
  const initialAdmitted = opts.initial.filter((task) => !opts.isExclusive(task));
  const max = Math.max(1, opts.maxConcurrency ?? Math.max(1, initialAdmitted.length));

  const queue: T[] = [];
  const admitted: string[] = [];
  const promoted: string[] = [];
  const seen = new Set<string>();
  const errors: unknown[] = [];

  const admit = (task: T, isPromoted: boolean): void => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    queue.push(task);
    admitted.push(task.id);
    if (isPromoted) promoted.push(task.id);
    opts.onAdmit?.(task);
  };

  for (const task of initialAdmitted) admit(task, false);

  return new Promise<LiveFanoutResult>((resolve, reject) => {
    let active = 0;
    let settled = false;

    const pump = (): void => {
      if (settled) return;
      while (active < max) {
        if (queue.length === 0) {
          // Nothing queued — look for newly unblocked work and promote it.
          for (const task of opts.poll()) {
            if (opts.isExclusive(task) || seen.has(task.id)) continue;
            admit(task, true);
          }
          if (queue.length === 0) break;
        }
        const task = queue.shift()!;
        active += 1;
        Promise.resolve()
          .then(() => opts.run(task))
          .catch((err: unknown) => {
            errors.push(err);
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) {
        settled = true;
        if (errors.length > 0) reject(errors[0]);
        else resolve({ admitted, promoted });
      }
    };

    pump();
  });
}
