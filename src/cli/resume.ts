/**
 * `nuvira resume` — continue a turn the process did not finish.
 *
 * WHY THIS EXISTS. The session store (`learning/session-store.ts`) already writes
 * the live thread at every step boundary, and a turn that crashes, is cancelled or
 * hits its step budget leaves that snapshot OPEN. But nothing ever READ it back:
 * the only way to continue was to retype the ask, which is not a continuation —
 * it is a new prompt, and on a multi-day build it is the wrong unit of work.
 *
 * WHAT A RESUME IS, AND IS NOT. It continues the STORED goal from its stored
 * transcript. It never asks a new question, never re-plans from scratch, and never
 * invents an ask: the snapshot's own `goal` is what runs. This is the same turn,
 * picked up where it stopped.
 *
 * WHY IT IS A LOOP. A long build ends its turns for reasons that are not
 * completion: a per-turn step budget, a provider failure, a killed process. One
 * `resume` call therefore runs one turn and then looks at the snapshot again — and
 * `--until-done` keeps doing that until the session CLOSES (the agent finished),
 * makes no progress twice in a row (a stall), or the deadline expires. That is how
 * a project spans days without a human pressing "continue": the work, not the
 * process, is the durable thing.
 *
 * WHY IT IS BOUNDED. A resume loop that cannot stop is the exact "wastes tokens in
 * a loop" failure this repository is trying to eliminate. Three independent stops:
 * a wall-clock deadline (default 24h), a stall cap (three consecutive rounds that
 * did not move the session), and a failure cap (three consecutive generation
 * failures). Every stop is reported with what happened, never silently.
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { ConfigManager } from '../config/manager.js';
import { runLoopExecutor } from './loop-executor.js';
import { logger } from '../utils/logger.js';
import {
  findResumableSessionFor,
  loadSessionSnapshot,
  type SessionSnapshot,
} from '../learning/session-store.js';
// The server-safe half (rows + detached spawn), so the dashboard does not import
// the CLI command tree just to list unfinished work.
import {
  listResumableRuns,
  spawnResumeProcess,
  toResumableRun,
  type ResumableRun,
} from '../learning/durable-runs.js';

export { listResumableRuns, type ResumableRun };

/** How long one `resume --until-done` may run before it reports and stops. */
export const DEFAULT_RESUME_DEADLINE_MS = 24 * 3_600_000;

/** Rounds one resume may run. A round is one full turn, not one model call. */
export const DEFAULT_MAX_ROUNDS = 200;

/** Consecutive rounds that left the session open without being bounded. */
export const MAX_STALLED_ROUNDS = 3;

/** Consecutive generation failures before the run reports and stops. */
export const MAX_FAILED_ROUNDS = 3;

/** Everything `driveResumableRun` needs, injected so the loop is testable. */
export interface ResumeDeps {
  /** Run ONE turn of the stored goal. `resume: false` = rehydrate, do not replay. */
  execute(
    goal: string,
    cwd: string,
    opts: { resume: false; sessionStore: true },
  ): Promise<{ bounded?: boolean; generationFailed?: boolean; cancelled?: boolean; content?: string }>;
  /** The still-open snapshot for this goal/cwd, or null once the turn closed. */
  findOpen(goal: string, cwd: string): SessionSnapshot | null;
  now(): number;
  log(line: string): void;
}

export type ResumeStatus = 'finished' | 'stalled' | 'failed' | 'deadline' | 'cancelled';

export interface ResumeOutcome {
  status: ResumeStatus;
  rounds: number;
  /** Steps across all rounds, as the snapshots reported them. */
  steps: number;
  /** The last round's content (its final message), for the operator summary. */
  lastContent: string;
  reason?: string;
}

/**
 * Continue one stored run until the session closes or a bound fires.
 *
 * The loop reads the session again after every round instead of trusting the
 * round's own result: a snapshot that is still OPEN is unfinished work (a bounded
 * turn, a crash, a cancel), and only a CLOSED snapshot means the turn reached its
 * clean end. That is the same rule `findResumableSessionFor` uses, so a resume can
 * never continue a finished conversation.
 */
export async function driveResumableRun(
  run: { id: string; goal: string; cwd: string },
  deps: ResumeDeps,
  options: {
    deadlineMs?: number;
    maxRounds?: number;
    maxStalledRounds?: number;
    maxFailedRounds?: number;
  } = {},
): Promise<ResumeOutcome> {
  // A NON-POSITIVE deadline means "no cap was asked for", never "already
  // expired". `0` slipped through `??` (it is not nullish), so the loop returned
  // `deadline` before its first round: `nuvira resume run <id>` — the very command
  // the stop message tells the user to run — reported "the 0-minute deadline
  // expired" after 0 rounds and continued nothing. Every caller that wants a
  // wall clock passes positive minutes; the rest get the documented default.
  const deadlineMs =
    typeof options.deadlineMs === 'number' && options.deadlineMs > 0
      ? options.deadlineMs
      : DEFAULT_RESUME_DEADLINE_MS;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxStalledRounds = options.maxStalledRounds ?? MAX_STALLED_ROUNDS;
  const maxFailedRounds = options.maxFailedRounds ?? MAX_FAILED_ROUNDS;
  const started = deps.now();

  let rounds = 0;
  let steps = 0;
  let stalled = 0;
  let failed = 0;
  let lastContent = '';

  while (rounds < maxRounds) {
    if (deps.now() - started >= deadlineMs) {
      return {
        status: 'deadline',
        rounds,
        steps,
        lastContent,
        reason: `the ${Math.round(deadlineMs / 60_000)}-minute deadline expired with the turn still open`,
      };
    }

    rounds += 1;
    let result: Awaited<ReturnType<ResumeDeps['execute']>>;
    try {
      result = await deps.execute(run.goal, run.cwd, { resume: false, sessionStore: true });
    } catch (err) {
      result = { generationFailed: true, content: err instanceof Error ? err.message : String(err) };
    }
    lastContent = typeof result.content === 'string' ? result.content : '';
    if (result.cancelled) {
      return { status: 'cancelled', rounds, steps, lastContent, reason: 'the turn was cancelled' };
    }

    const open = deps.findOpen(run.goal, run.cwd);
    if (!open) {
      return { status: 'finished', rounds, steps, lastContent };
    }
    steps += open.accumulators.steps;

    // A BOUNDED round did the work its budget allowed — that is progress, not a
    // stall. Anything else that leaves the session open did not finish, and three
    // of those in a row is the loop this command exists to refuse.
    stalled = result.bounded ? 0 : stalled + 1;
    failed = result.generationFailed ? failed + 1 : 0;

    if (failed >= maxFailedRounds) {
      return {
        status: 'failed',
        rounds,
        steps,
        lastContent,
        reason: `${failed} consecutive rounds failed to generate (the provider, not the ask)`,
      };
    }
    if (stalled >= maxStalledRounds) {
      return {
        status: 'stalled',
        rounds,
        steps,
        lastContent,
        reason: `${stalled} consecutive rounds left the turn open without advancing it`,
      };
    }
  }

  return {
    status: 'deadline',
    rounds,
    steps,
    lastContent,
    reason: `the ${maxRounds}-round cap was reached with the turn still open`,
  };
}

/** `3m ago` / `2h ago` / `4d ago`. */
function ageLabel(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export class ResumeCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('resume')
      .description('Continue a turn that crashed or ran out of budget — same ask, from its checkpoint');

    cmd
      .command('list')
      .description('Show every unfinished (open) turn, newest first')
      .option('--cwd <dir>', 'Only turns for this directory')
      .action((options: { cwd?: string }) => {
        const runs = listResumableRuns(options.cwd);
        if (runs.length === 0) {
          logger.info('No unfinished turns — every stored session is closed.');
          return;
        }
        logger.highlight(`\n↩️  ${runs.length} unfinished turn(s)`);
        for (const run of runs) {
          console.log(
            `   • [OPEN] ${run.goal.replace(/\s+/g, ' ').slice(0, 80)}\n` +
              `     ${run.steps} step(s), ${run.mutatedPaths} file(s) changed, ${ageLabel(run.savedAt)} — ${run.cwd}\n` +
              `     id: ${run.id}`,
          );
        }
        console.log('');
        logger.info('Continue one with: `nuvira resume run <id>` (or `nuvira resume run --all`)');
      });

    cmd
      .command('run [id]')
      .description('Continue an unfinished turn (default: the newest open turn in this directory)')
      .option('--all', 'Continue every unfinished turn, oldest-stored first')
      .option('--cwd <dir>', 'Where to look for the default turn (default: the current directory)')
      .option('--until-done', 'Keep running turns until the session closes or a bound stops it')
      .option('--deadline <minutes>', 'Wall-clock cap for --until-done (default: 1440)', (v) => parseInt(v, 10), 1440)
      .option('--detach', 'Run the continuation in a detached process and return immediately')
      .action(async (id: string | undefined, options: {
        all?: boolean;
        cwd?: string;
        untilDone?: boolean;
        deadline?: number;
        detach?: boolean;
      }) => {
        const minutes = Number.isFinite(options.deadline) && options.deadline! > 0 ? options.deadline! : 1440;
        if (options.detach) {
          detachResume({ id, all: options.all, cwd: options.cwd, minutes });
          return;
        }

        const targets = resolveTargets(id, options);
        if (targets.length === 0) {
          logger.error('No unfinished turn found. `nuvira resume list` shows what is stored.');
          return;
        }

        let finished = 0;
        let stopped = 0;
        for (const run of targets) {
          logger.highlight(`\n↩️  resuming: ${run.goal.replace(/\s+/g, ' ').slice(0, 100)}`);
          logger.info(`   ${run.cwd}  ·  ${run.steps} step(s) already done`);

          const outcome = await withCwd(run.cwd, () =>
            driveResumableRun(run, {
              execute: (goal) =>
                runLoopExecutor(goal, new ConfigManager(), {
                  // Rehydrate the stored transcript; do NOT replay the resume
                  // ledger. A resume continues THIS turn, so the conversation is
                  // the state — replaying recorded model calls would re-derive a
                  // thread the snapshot already holds.
                  resume: false,
                  sessionStore: true,
                }),
              findOpen: (goal, cwd) => findResumableSessionFor(goal, cwd),
              now: () => Date.now(),
              log: (line) => logger.info(line),
            }, {
              // `--until-done` bounds the LOOP (one round vs. many); the wall
              // clock is a cap in both cases. Passing 0 for the one-round path
              // made that path expire before it ran (see `driveResumableRun`),
              // so `nuvira resume run <id>` without `--until-done` did nothing.
              deadlineMs: minutes * 60_000,
              maxRounds: options.untilDone ? DEFAULT_MAX_ROUNDS : 1,
            }),
          );

          const tail = outcome.lastContent.trim().replace(/\s+/g, ' ').slice(0, 300);
          if (outcome.status === 'finished') {
            finished += 1;
            logger.success(`   ✅ finished after ${outcome.rounds} round(s), ${outcome.steps} step(s).`);
          } else {
            stopped += 1;
            logger.warn(`   ⏸  stopped (${outcome.status}) after ${outcome.rounds} round(s): ${outcome.reason ?? ''}`);
            logger.info(`   The snapshot stays OPEN — run \`nuvira resume run ${run.id}\` to pick it up again.`);
          }
          if (tail) console.log(`   last: ${tail}`);
        }

        console.log('');
        logger.info(`${finished} turn(s) finished, ${stopped} left open.`);
      });

    return cmd;
  }
}

/** Resolve which stored runs this invocation continues. */
export function resolveTargets(
  id: string | undefined,
  options: { all?: boolean; cwd?: string },
): ResumableRun[] {
  if (id) {
    const snap = loadSessionSnapshot(id);
    if (!snap || !snap.open) return [];
    return [toResumableRun(snap)];
  }
  const runs = listResumableRuns(options.all ? undefined : options.cwd ?? process.cwd());
  if (options.all) return runs.slice().reverse();
  return runs.slice(0, 1);
}

/** Run `fn` with `process.chdir(dir)`, restoring the previous directory. */
async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  let changed = false;
  try {
    process.chdir(dir);
    changed = true;
  } catch {
    // A deleted workspace is reported by the run itself; never crash the command.
  }
  try {
    return await fn();
  } finally {
    if (changed) {
      try {
        process.chdir(previous);
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Start the same continuation in a detached process.
 *
 * Detached survives the terminal closing (its own session, its own stdio), which
 * is what a multi-hour build needs. It does NOT survive a reboot: the snapshot
 * does, and one `nuvira resume run --all` after a restart continues it. Install a
 * login item yourself if a reboot must resume without you.
 */
export function detachResume(input: {
  id?: string;
  all?: boolean;
  cwd?: string;
  minutes: number;
}): void {
  try {
    const started = spawnResumeProcess({
      id: input.id,
      all: input.all,
      cwd: input.cwd,
      minutes: input.minutes,
    });
    logger.success(`   ▶️  resume running detached (pid ${started.pid ?? '?'}).`);
    logger.info(`   Log: ${started.logPath}`);
    logger.info('   It survives this terminal. After a reboot, run `nuvira resume run --all --until-done` again.');
  } catch (err) {
    logger.error(`Could not start the detached resume: ${err instanceof Error ? err.message : String(err)}`);
  }
}
