/**
 * Measured progress for an unattended job (enterprise-grade hardening, G11).
 *
 * WHY THIS IS ITS OWN MODULE. The runner's central guarantee is that progress
 * is MEASURED, not claimed: a batch that reports success but did not move the
 * deliverable is a stall, and three stalls stop the run and ask. That rule is
 * only as good as the measurement, so the measurement lives in one place,
 * reading artifacts off disk — and every surface (CLI, dashboard, gateway)
 * measures the same way instead of each inventing its own idea of "done".
 *
 * The two inputs:
 *   1. the long-form ledger — how much of the CONTENT exists (words, units);
 *   2. the job's `expectedArtifacts` — the files the deliverable promises
 *      (site, chapter index, optional tools). For a composite ask this is what
 *      stops "the prose phase finished" being reported as "the deliverable is
 *      done" while the site is still missing.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findLatestJob, formatProgress, jobProgress } from './long-form.js';
import { startUnattendedJob, type BatchOutcome, type UnattendedJob, type UnattendedSurface } from './unattended-job.js';

/**
 * Weight of the content phase in a composite deliverable's percentage.
 *
 * The content IS the deliverable, so it dominates; the surrounding artifacts
 * are the remaining third. Weighting them any lower would let a beautiful
 * empty shell sit at 99% after one chapter.
 */
export const CONTENT_WEIGHT = 0.7;

/**
 * How many expected artifacts exist on disk (relative paths resolved against
 * the project root).
 *
 * Split out from the job-shaped wrapper because the orchestrator asks the same
 * question at planning time — "has this deliverable already been produced?" —
 * before any job record exists.
 */
export function artifactsPresence(
  projectPath: string,
  expected: string[] | undefined,
): { present: number; total: number; missing: string[] } {
  const paths = expected ?? [];
  if (paths.length === 0) return { present: 0, total: 0, missing: [] };
  const missing: string[] = [];
  let present = 0;
  for (const rel of paths) {
    const abs = isAbsolute(rel) ? rel : resolve(projectPath, rel);
    if (existsSync(abs)) present++;
    else missing.push(rel);
  }
  return { present, total: paths.length, missing };
}

/** How many of a job's expected artifacts exist on disk. */
export function countPresentArtifacts(job: UnattendedJob): { present: number; total: number; missing: string[] } {
  return artifactsPresence(job.projectPath, job.expectedArtifacts);
}

/**
 * Measure the job from disk.
 *
 * Never throws: a measurement failure must degrade to "no progress recorded",
 * which the runner correctly treats as a stall, rather than crashing the drain
 * that is holding the user's promised work.
 */
export function measureUnattendedProgress(job: UnattendedJob): BatchOutcome {
  try {
    const ledger = findLatestJob(job.projectPath);
    const artifacts = countPresentArtifacts(job);

    if (!ledger) {
      // No content ledger for this project: either the job is a phased build
      // with no prose, or the first batch has not recorded anything yet. The
      // artifacts are then the only honest signal.
      if (artifacts.total > 0) {
        const pct = Math.round((artifacts.present / artifacts.total) * 100);
        return {
          progress: pct,
          progressLine: `${artifacts.present}/${artifacts.total} deliverable files present`,
          finished: artifacts.present === artifacts.total,
        };
      }
      return { progress: 0, progressLine: 'no progress recorded yet' };
    }

    const contentProgress = jobProgress(ledger);
    const contentPercent = contentProgress.percent;

    if (artifacts.total === 0) {
      return {
        progress: contentPercent,
        progressLine: formatProgress(ledger),
        finished: contentProgress.complete,
      };
    }

    const artifactPercent = Math.round((artifacts.present / artifacts.total) * 100);
    const combined = Math.round(contentPercent * CONTENT_WEIGHT + artifactPercent * (1 - CONTENT_WEIGHT));
    const finished = contentProgress.complete && artifacts.present === artifacts.total;

    return {
      progress: finished ? 100 : combined,
      progressLine:
        `${formatProgress(ledger)} · ${artifacts.present}/${artifacts.total} deliverable files` +
        (artifacts.missing.length > 0 && artifacts.missing.length <= 3
          ? ` (missing ${artifacts.missing.join(', ')})`
          : ''),
      finished,
    };
  } catch {
    return { progress: 0, progressLine: 'progress measurement unavailable' };
  }
}

/**
 * Is the deliverable complete right now?
 *
 * Used by surfaces to decide whether to keep scheduling a job at all — a
 * resumed "continue" turn that finds the work already done must not start a
 * second book (the ledger's oldest failure mode).
 */
export function isDeliverableComplete(job: UnattendedJob): boolean {
  const measured = measureUnattendedProgress(job);
  return measured.finished === true;
}

/**
 * The slice of an orchestrator result a surface needs to schedule the rest of
 * the work.
 *
 * Declared STRUCTURALLY (not imported from the orchestrator) because the
 * gateway, the CLI and the dashboard all consume it, and a shared consumer must
 * not drag the whole agent graph into its import closure.
 */
export interface PendingWorkLike {
  kind: 'long-form' | 'phased';
  goal: string;
  projectPath: string;
  continuationPrompt: string;
  expectedArtifacts?: string[];
  progressLine: string;
  percent: number;
  reason: string;
}

/**
 * Schedule the continuation of a run that ended with unfinished work — the
 * replacement for asking the user to type "continue".
 *
 * Returns the scheduled job, or `null` when there is nothing left to do. That
 * second case matters as much as the first: a run that finished its deliverable
 * must not enqueue a continuation that would immediately re-run and rebuild it.
 *
 * @param pending the orchestrator's `result.pendingWork` (may be undefined)
 * @param surface who to report to and which drain owns the work
 */
export function scheduleFromPendingWork(
  pending: PendingWorkLike | undefined,
  surface: UnattendedSurface,
  options: { deadlineMs?: number; notify?: boolean } = {},
): UnattendedJob | null {
  if (!pending) return null;

  const presence = artifactsPresence(pending.projectPath, pending.expectedArtifacts);
  const filesComplete = presence.total === 0 || presence.present === presence.total;
  if (pending.percent >= 100 && filesComplete) return null;

  return startUnattendedJob({
    kind: pending.kind,
    goal: pending.goal,
    projectPath: pending.projectPath,
    surface,
    continuationPrompt: pending.continuationPrompt,
    ...(pending.expectedArtifacts ? { expectedArtifacts: pending.expectedArtifacts } : {}),
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.notify !== undefined ? { notify: options.notify } : {}),
  }).job;
}
