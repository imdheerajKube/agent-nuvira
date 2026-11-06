/**
 * Durable runs — the data a surface needs to CONTINUE work the process did not
 * finish, and the launch of that continuation.
 *
 * WHY THIS MODULE EXISTS (and is not in `cli/resume.ts`). Two callers need the
 * same facts: the `nuvira resume` command and the dashboard's Chat page. The
 * command also needs commander; the server must not import the CLI layer (it
 * would drag the whole command tree into a long-lived web process). So the
 * shared, dependency-light half lives here: how an OPEN snapshot is projected
 * into a row, and how a continuation process is spawned. The command keeps the
 * loop that drives rounds; the server only lists and starts.
 *
 * WHAT A ROW IDENTIFIES. Every row carries the snapshot's own `id` — the
 * deterministic key of (goal, cwd) — so a surface can continue EXACTLY that turn.
 * Nothing is inferred from "the last thing": the id is what the CLI accepts and
 * what the dashboard sends back.
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { resolveNuviraHome } from '../config/paths.js';
import { listSessionSnapshots, type SessionSnapshot } from './session-store.js';

/** A stored turn that is still open — the unit a resume continues. */
export interface ResumableRun {
  id: string;
  goal: string;
  cwd: string;
  savedAt: number;
  steps: number;
  mutatedPaths: number;
  preview: string;
}

/** Project the open snapshots into the rows a surface lists. */
export function listResumableRuns(cwd?: string): ResumableRun[] {
  const wanted = cwd ? normalizeDir(cwd) : null;
  return listSessionSnapshots()
    .filter((snap) => snap.open && snap.messages.length > 0)
    .filter((snap) => (wanted ? normalizeDir(snap.cwd) === wanted : true))
    .map(toResumableRun);
}

export function toResumableRun(snap: SessionSnapshot): ResumableRun {
  const lastUser = [...snap.messages].reverse().find((m) => m.role === 'user');
  return {
    id: snap.id,
    goal: snap.goal,
    cwd: snap.cwd,
    savedAt: snap.savedAt,
    steps: snap.accumulators.steps,
    mutatedPaths: snap.accumulators.mutatedPaths.length,
    preview: (lastUser?.content ?? snap.goal).replace(/\s+/g, ' ').slice(0, 120),
  };
}

function normalizeDir(dir: string): string {
  return (dir || '').replace(/[\\/]+$/, '');
}

/** Where a detached continuation writes its output. */
export function resumeLogDir(): string {
  return join(resolveNuviraHome(), 'memory', 'resume');
}

export interface ResumeProcess {
  pid?: number;
  logPath: string;
}

/**
 * Spawn `nuvira resume run …` in its own process, detached from the caller.
 *
 * WHY DETACHED, ALWAYS, FROM A SURFACE. A resume can run for hours; a dashboard
 * request (or a chat turn) that awaited it would hold a connection open and lose
 * the work when the tab closed. The caller gets the pid and the log path instead.
 *
 * The entry is usually the installed `dist/index.js`. In a source run it is a
 * `.ts` file, which `node` cannot execute directly, so tsx is loaded as the
 * runtime — the same dev harness the rest of the repo uses. A missing entry is a
 * refusal with a reason, not a half-started process.
 */
export function spawnResumeProcess(input: {
  id?: string;
  all?: boolean;
  cwd?: string;
  minutes?: number;
  /** Test seam; defaults to this process's own entry script. */
  entry?: string;
  logDir?: string;
}): ResumeProcess {
  const entry = input.entry ?? process.argv[1];
  if (!entry) throw new Error('this process has no entry script to re-launch');

  const dir = input.logDir ?? resumeLogDir();
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `resume-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const fd = openSync(logPath, 'a');

  const args = ['resume', 'run'];
  if (input.id) args.push(input.id);
  if (input.all) args.push('--all');
  if (input.cwd) args.push('--cwd', input.cwd);
  args.push('--until-done', '--deadline', String(Math.max(1, Math.round(input.minutes ?? 1440))));

  const isSource = /\.(ts|tsx|mts|cts)$/i.test(entry);
  const nodeArgs = isSource ? ['--import', 'tsx', entry, ...args] : [entry, ...args];

  try {
    const child = spawn(process.execPath, nodeArgs, {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort.
    }
  }
}
