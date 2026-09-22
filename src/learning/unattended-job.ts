/**
 * Unattended jobs — the engine that finishes long work WITHOUT the user having
 * to say "continue" (enterprise-grade hardening, G11).
 *
 * THE BUG THIS CLOSES. The long-form ledger (G8) made a 100-page book
 * *possible*: it split the ask into bounded units and recorded progress. But it
 * left the CADENCE manual. Every batch ended with
 *
 *   "Reply \"continue\" and I will write the next batch"
 *
 * so a 39-unit book needed ~10 human turns. The user asked for a book and got a
 * job they had to keep pressing. That is a shortcut, not a delivery: "write me
 * a 100-page book" is itself the authorization to spend the time, and an
 * assistant that stops after 4 of 39 units to ask whether to continue has
 * substituted a protocol for the work.
 *
 * WHAT THIS MODULE IS. A persisted queue of IN-PROGRESS WORK, plus a runner
 * that keeps executing it until it is done, blocked on a genuine question, or
 * out of its own time budget. It is deliberately NOT the retry queue
 * (`deferred-task.ts`):
 *
 *   | | deferred-task | unattended-job |
 *   |---|---|---|
 *   | triggered by | a FAILURE | unfinished WORK |
 *   | authorization | the user replying "yes" | the original ask |
 *   | wait shape | backoff between attempts | run continuously |
 *   | budget | ~6h of retries | hours of actual work (default 10h) |
 *   | stops on | attempts/TTL | completion, a real question, or no progress |
 *
 * Merging the two would make "keep retrying the model" and "keep writing the
 * book" the same switch, and the consent semantics of each are opposites.
 *
 * THREE GUARANTEES THE RUNNER ENFORCES
 *  1. PROGRESS IS MEASURED, NOT CLAIMED. A batch that did not move the ledger
 *     is a stall even if every step reported success. Three stalls in a row
 *     stop the run and ask, because an agent looping without progress is the
 *     exact "goes in a loop and never delivers" behaviour this exists to end.
 *  2. IT STOPS FOR QUESTIONS, NOT FOR PERMISSION. The only thing that pauses
 *     work is a decision the user genuinely owns (see `autonomy-policy.ts`).
 *  3. IT NEVER RUNS UNBOUNDED. A deadline (default 10 hours), a stall cap, a
 *     failure cap and a per-drain batch cap.
 *
 * Storage: `<memory>/unattended-jobs.json`. Best-effort writes — bookkeeping
 * must never break the turn that scheduled the work.
 */

import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * How long a job may keep working before it gives up and reports.
 *
 * Ten hours because the ask this module exists for is "a 100/200-page book" or
 * "a phased build", and the user's requirement is explicit: those must run to
 * completion unattended rather than in 4-turn increments. It is a CEILING, not
 * a target — a job that finishes in ten minutes leaves the queue immediately.
 */
export const DEFAULT_DEADLINE_MS = 10 * 3_600_000;

/** Consecutive no-progress batches before the run stops and asks. */
export const MAX_STALLED_BATCHES = 3;

/** Consecutive hard failures (provider errors, verification failures). */
export const MAX_CONSECUTIVE_FAILURES = 6;

/** Batches one drain may run before yielding (keeps a tick responsive). */
export const MAX_BATCHES_PER_DRAIN = 6;

/**
 * How long a job may sit in `running` before it is treated as abandoned.
 *
 * A batch is claimed before it runs; if the process dies mid-batch — a restart,
 * a reboot, a crash, all normal over a ten-hour job — nothing resets it and a
 * `running` job is invisible to every query. The work would be stranded
 * silently, which is the failure mode the whole ledger exists to prevent. The
 * ceiling is generous (well past a single batch) so a live batch is never
 * stolen.
 */
export const STALE_RUNNING_MS = 25 * 60_000;

/** Bounded store — a queue is a convenience, not a backlog. */
const MAX_JOBS = 25;

const FILE_NAME = 'unattended-jobs.json';
const CURRENT_VERSION = 1;

// ─── Types ──────────────────────────────────────────────────────────────────

/** What kind of ongoing work this is. */
export type UnattendedKind = 'long-form' | 'phased';

export type UnattendedStatus = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'cancelled';

/** Where a job's progress must be reported. */
export interface UnattendedSurface {
  /** `dashboard`, `cli`, `whatsapp`, … — the drain is ownership-filtered on this. */
  platform: string;
  /** Session id / channel id the report goes to. */
  channelId: string;
}

/** One unit of ongoing work, as much as the runner needs to keep it going. */
export interface UnattendedJob {
  id: string;
  kind: UnattendedKind;
  /** The ORIGINAL ask, verbatim — a batch re-states it so intent survives hours. */
  goal: string;
  /** Absolute project root the work happens in. */
  projectPath: string;
  /** Where to report. */
  surface: UnattendedSurface;
  /**
   * What to send the engine to make it do the next batch.
   *
   * Usually "continue", which the long-form planner resolves against the ledger
   * (so a batch never restarts the book). Kept as data rather than hard-coded
   * so a phased build can carry a richer brief.
   */
  continuationPrompt: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number;
  /** Absolute epoch ms after which the job stops and reports. */
  deadline: number;
  /** Batches executed. */
  batches: number;
  /** Consecutive batches that produced no measurable progress. */
  stalledBatches: number;
  /** Consecutive hard failures. */
  failures: number;
  status: UnattendedStatus;
  /** Last MEASURED completion, 0–100 (from the ledgers, not from a claim). */
  progress: number;
  /** Human-readable progress, e.g. "chapter 12/39 · 10,800 words". */
  progressLine?: string;
  /** Why it stopped, when it did not finish. */
  stopReason?: string;
  /** The one question blocking the run, when status is `blocked`. */
  pendingQuestion?: string;
  /** Report progress to the user as the job runs (off for silent builds). */
  notify: boolean;
  /**
   * Files that must ALL exist for the deliverable to count as finished.
   *
   * Set by a composite plan (site + chapters + optional tools). The progress
   * measurement treats their presence as part of completion, so "the prose
   * phase finished" is never reported as "the deliverable is done" when the
   * experience layer is still missing.
   */
  expectedArtifacts?: string[];
}

/** What a surface tells the store after running one batch. */
export interface BatchOutcome {
  /**
   * Measured completion 0–100, read from the ledgers/artifacts.
   *
   * MUST be measured: this is what separates a slow-but-working job from a
   * loop, and an agent-reported number would defeat the whole check.
   */
  progress?: number;
  /** Human-readable progress line, e.g. "chapter 12/39 complete". */
  progressLine?: string;
  /** The work is finished — the deliverable exists. */
  finished?: boolean;
  /** A genuine decision the run cannot make for the user (from the policy). */
  question?: string;
  /** The batch failed (provider error, verification failure). */
  error?: string;
}

/** Everything needed to schedule ongoing work. */
export interface StartUnattendedInput {
  kind: UnattendedKind;
  goal: string;
  projectPath: string;
  surface: UnattendedSurface;
  continuationPrompt?: string;
  /** Override the time budget (tests use a short one). */
  deadlineMs?: number;
  notify?: boolean;
  /** Files that must all exist for the job to count as finished. */
  expectedArtifacts?: string[];
}

// ─── Storage ────────────────────────────────────────────────────────────────

interface StoreShape {
  version: number;
  jobs: UnattendedJob[];
}

function envBuffSafe(name: string): string | undefined {
  try {
    return envBuff(name);
  } catch {
    return undefined;
  }
}

/** Memory dir, honouring the same test/dev override the long-form ledger uses. */
function memoryDir(): string {
  const override = envBuffSafe('MEMORY_DIR');
  if (override) return override;
  try {
    return join(resolveNuviraHome(), 'memory');
  } catch {
    return join(process.cwd(), '.nuvira-memory');
  }
}

function storePath(): string {
  return join(memoryDir(), FILE_NAME);
}

function isJobShape(value: unknown): value is UnattendedJob {
  if (!value || typeof value !== 'object') return false;
  const j = value as Partial<UnattendedJob>;
  return (
    typeof j.id === 'string' &&
    typeof j.goal === 'string' &&
    typeof j.projectPath === 'string' &&
    typeof j.createdAt === 'number' &&
    typeof j.deadline === 'number' &&
    typeof j.continuationPrompt === 'string' &&
    !!j.surface &&
    typeof j.surface.platform === 'string' &&
    typeof j.surface.channelId === 'string'
  );
}

/**
 * Self-heal jobs abandoned mid-batch (see STALE_RUNNING_MS), applied on READ so
 * no process has to remember a recovery pass, and written back so the next
 * reader sees the repair too.
 */
function recoverStaleRunning(jobs: UnattendedJob[], now: number): UnattendedJob[] {
  let repaired = false;
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    const startedAt = job.lastRunAt || job.createdAt;
    if (now - startedAt <= STALE_RUNNING_MS) continue;
    job.status = 'pending';
    job.stopReason = undefined;
    repaired = true;
  }
  if (repaired) writeJobs(jobs);
  return jobs;
}

/** Read the queue. Best-effort: a corrupt file is an empty queue, never a throw. */
export function loadUnattendedJobs(now: number = Date.now()): UnattendedJob[] {
  try {
    const path = storePath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape;
    if (!parsed || !Array.isArray(parsed.jobs)) return [];
    return recoverStaleRunning(parsed.jobs.filter(isJobShape), now);
  } catch {
    return [];
  }
}

function writeJobs(jobs: UnattendedJob[]): void {
  try {
    const dir = memoryDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Newest first, bounded: the oldest job is the one most likely to have been
    // forgotten, and dropping it silently beats an unbounded file.
    const ordered = [...jobs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_JOBS);
    const payload: StoreShape = { version: CURRENT_VERSION, jobs: ordered };
    writeFileSync(storePath(), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Best-effort — bookkeeping must never break the turn that scheduled work.
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `job-${crypto.randomUUID().slice(0, 8)}`;
    }
  } catch {
    /* fall through */
  }
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/** Stable identity for "the ongoing work in this project, for this surface". */
function jobIdentity(kind: UnattendedKind, projectPath: string, surface: UnattendedSurface): string {
  return `${kind}|${projectPath}|${surface.platform}:${surface.channelId}`;
}

/**
 * Schedule ongoing work — or return the job already carrying it.
 *
 * Idempotent per (kind, project, surface) on purpose: every batch of a book
 * re-enters this function, and treating each re-entry as a new job would spawn
 * a duplicate worker per batch and have them race on the same chapters.
 */
export function startUnattendedJob(input: StartUnattendedInput): { job: UnattendedJob; created: boolean } {
  const jobs = loadUnattendedJobs();
  const now = Date.now();
  const identity = jobIdentity(input.kind, input.projectPath, input.surface);

  const existing = jobs.find(
    (j) => jobIdentity(j.kind, j.projectPath, j.surface) === identity && j.status !== 'cancelled' && j.status !== 'done',
  );
  if (existing) {
    // A live job keeps its own counters and deadline — re-entering must not
    // reset the time budget, or a job that keeps re-planning could run forever.
    existing.goal = input.goal;
    existing.updatedAt = now;
    if (input.continuationPrompt) existing.continuationPrompt = input.continuationPrompt;
    writeJobs(jobs);
    return { job: existing, created: false };
  }

  const job: UnattendedJob = {
    id: newId(),
    kind: input.kind,
    goal: input.goal,
    projectPath: input.projectPath,
    surface: input.surface,
    continuationPrompt: input.continuationPrompt ?? 'continue',
    createdAt: now,
    updatedAt: now,
    lastRunAt: 0,
    deadline: now + Math.max(60_000, input.deadlineMs ?? DEFAULT_DEADLINE_MS),
    batches: 0,
    stalledBatches: 0,
    failures: 0,
    status: 'pending',
    progress: 0,
    notify: input.notify !== false,
    ...(input.expectedArtifacts?.length ? { expectedArtifacts: input.expectedArtifacts } : {}),
  };
  writeJobs([job, ...jobs]);
  return { job, created: true };
}

export function getUnattendedJob(id: string): UnattendedJob | undefined {
  return loadUnattendedJobs().find((j) => j.id === id);
}

/** The live job for a surface (newest first), if any. */
export function findUnattendedJob(surface: UnattendedSurface): UnattendedJob | undefined {
  return loadUnattendedJobs().find(
    (j) =>
      j.surface.platform === surface.platform &&
      j.surface.channelId === surface.channelId &&
      (j.status === 'pending' || j.status === 'running' || j.status === 'blocked'),
  );
}

/** Every job still waiting for a turn (for status surfaces, newest first). */
export function listUnattendedJobs(): UnattendedJob[] {
  return loadUnattendedJobs();
}

/**
 * One drain OWNS a subset of the queue.
 *
 * The store is shared by every process that can run a turn, so each drain
 * declares what it owns — without this the gateway would claim a dashboard
 * session and try to deliver a book chapter to a messaging platform.
 */
export type JobOwnership = (job: UnattendedJob) => boolean;

/**
 * Jobs ready to run now: pending, inside their deadline, and not out of road.
 *
 * `blocked` jobs are deliberately excluded — they are waiting on the user, not
 * on the scheduler.
 */
export function dueUnattendedJobs(now: number = Date.now(), owns: JobOwnership = () => true): UnattendedJob[] {
  return loadUnattendedJobs(now).filter(
    (j) =>
      j.status === 'pending' &&
      j.deadline > now &&
      j.stalledBatches < MAX_STALLED_BATCHES &&
      j.failures < MAX_CONSECUTIVE_FAILURES &&
      owns(j),
  );
}

/** Jobs whose time budget ran out — the user must be told, not ghosted. */
export function expiredUnattendedJobs(now: number = Date.now(), owns: JobOwnership = () => true): UnattendedJob[] {
  return loadUnattendedJobs(now).filter((j) => j.status === 'pending' && j.deadline <= now && owns(j));
}

/**
 * Stop a job with a reason, without touching its counters.
 *
 * Used by the runner to expire jobs whose time budget ran out — the reason
 * must be RECORDED (the user is told why the promised work stopped), and doing
 * it here keeps the runner free of ledger-write logic.
 */
export function stopUnattendedJob(
  id: string,
  status: Extract<UnattendedStatus, 'failed' | 'cancelled' | 'done'>,
  reason: string,
  now: number = Date.now(),
): UnattendedJob | undefined {
  const jobs = loadUnattendedJobs(now);
  const job = jobs.find((j) => j.id === id);
  if (!job) return undefined;
  job.status = status;
  job.stopReason = reason;
  job.updatedAt = now;
  if (status === 'done') job.progress = 100;
  writeJobs(jobs);
  return job;
}

/** Stop a job (the user said stop, or the work is being replaced). */
export function cancelUnattendedJob(id: string, reason = 'cancelled by the user'): void {
  const jobs = loadUnattendedJobs();
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = 'cancelled';
  job.stopReason = reason;
  job.updatedAt = Date.now();
  writeJobs(jobs);
}

/** Drop every job for a surface (`stop`, `cancel`, a fresh unrelated ask). */
export function cancelUnattendedJobsFor(surface: UnattendedSurface, reason = 'cancelled by the user'): number {
  const jobs = loadUnattendedJobs();
  let changed = 0;
  for (const job of jobs) {
    if (job.surface.platform !== surface.platform || job.surface.channelId !== surface.channelId) continue;
    if (job.status === 'done' || job.status === 'cancelled' || job.status === 'failed') continue;
    job.status = 'cancelled';
    job.stopReason = reason;
    job.updatedAt = Date.now();
    changed++;
  }
  if (changed > 0) writeJobs(jobs);
  return changed;
}

/** Claim a job for one batch. Returns the claimed job, or undefined. */
export function claimUnattendedJob(id: string, now: number = Date.now()): UnattendedJob | undefined {
  const jobs = loadUnattendedJobs(now);
  const job = jobs.find((j) => j.id === id);
  if (!job || job.status !== 'pending') return undefined;
  job.status = 'running';
  job.lastRunAt = now;
  job.updatedAt = now;
  writeJobs(jobs);
  return job;
}

/**
 * Record what one batch actually did, and decide what happens next.
 *
 * This is where "no manual cadence" is enforced: the batch's own outcome
 * determines whether the job keeps running, stops because it is DONE, or stops
 * because it needs the user — nobody has to say "continue".
 *
 * @returns the updated job (undefined when the id is unknown).
 */
export function recordBatchOutcome(
  id: string,
  outcome: BatchOutcome,
  now: number = Date.now(),
): UnattendedJob | undefined {
  const jobs = loadUnattendedJobs(now);
  const job = jobs.find((j) => j.id === id);
  if (!job) return undefined;

  job.batches += 1;
  job.updatedAt = now;
  job.stopReason = undefined;
  job.pendingQuestion = undefined;
  if (outcome.progressLine) job.progressLine = outcome.progressLine;

  // ── A hard failure is checked FIRST, before completion. ──────────────────
  // A batch that failed verification can leave every file on disk and still
  // not be a delivered deliverable (a site that does not present the chapters).
  // Letting `finished` win would report success over exactly the failure the
  // verify step exists to catch.
  if (outcome.error) {
    job.failures += 1;
    if (job.failures >= MAX_CONSECUTIVE_FAILURES) {
      job.status = 'failed';
      job.stopReason = `stopped after ${job.failures} consecutive failed batches — last error: ${outcome.error.slice(0, 300)}`;
      writeJobs(jobs);
      return job;
    }
    job.status = 'pending';
    writeJobs(jobs);
    return job;
  }

  // ── Finished: the deliverable exists. ────────────────────────────────────
  if (outcome.finished) {
    job.status = 'done';
    job.progress = 100;
    job.stopReason = 'complete';
    writeJobs(jobs);
    return job;
  }

  // ── A genuine question: stop the RUN, not the work. ──────────────────────
  // Marked blocked rather than failed so the answer resumes from the ledger.
  if (outcome.question) {
    job.status = 'blocked';
    job.pendingQuestion = outcome.question;
    job.stopReason = 'waiting on a decision only the user can make';
    writeJobs(jobs);
    return job;
  }

  job.failures = 0;

  // ── Progress is MEASURED. A batch that did not move is a stall. ──────────
  const measured = typeof outcome.progress === 'number' ? outcome.progress : job.progress;
  const moved = measured > job.progress;
  job.progress = Math.max(job.progress, measured);
  job.stalledBatches = moved ? 0 : job.stalledBatches + 1;

  if (job.stalledBatches >= MAX_STALLED_BATCHES) {
    job.status = 'blocked';
    job.stopReason = `no measurable progress in ${job.stalledBatches} batches`;
    job.pendingQuestion =
      `I've run ${job.stalledBatches} batches with NO measurable progress — the deliverable has not grown ` +
      `(still ${job.progress}% — ${job.progressLine ?? 'no progress recorded'}). ` +
      'Something is genuinely wrong that I cannot resolve on my own; how would you like me to proceed?';
    writeJobs(jobs);
    return job;
  }

  if (now >= job.deadline) {
    job.status = 'failed';
    job.stopReason = 'time budget exhausted before the work finished';
    writeJobs(jobs);
    return job;
  }

  job.status = 'pending';
  writeJobs(jobs);
  return job;
}

/** Resume a blocked job after the user answered. */
export function resumeUnattendedJob(id: string, extraDeadlineMs = 0, now: number = Date.now()): UnattendedJob | undefined {
  const jobs = loadUnattendedJobs(now);
  const job = jobs.find((j) => j.id === id);
  if (!job) return undefined;
  job.status = 'pending';
  job.pendingQuestion = undefined;
  job.stopReason = undefined;
  // An answer is fresh authorization: the stall counter and the clock both get
  // a new run at it, or the job would stop again on the very next batch.
  job.stalledBatches = 0;
  job.failures = 0;
  if (extraDeadlineMs > 0) job.deadline = Math.max(job.deadline, now + extraDeadlineMs);
  job.updatedAt = now;
  writeJobs(jobs);
  return job;
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/** Percentage complete, clamped. */
export function jobPercent(job: UnattendedJob): number {
  return Math.max(0, Math.min(100, Math.round(job.progress)));
}

/**
 * The honest status line for a job.
 *
 * Deliberately quotes MEASURED progress and says explicitly that no reply is
 * needed — the user's complaint was having to reply at all, so a progress
 * report that ends by asking for one would repeat the mistake in miniature.
 */
export function unattendedStatusLine(job: UnattendedJob): string {
  const head = job.kind === 'long-form' ? '📖' : '🛠️';
  const pct = jobPercent(job);
  switch (job.status) {
    case 'done':
      return `${head} Job complete — ${job.progressLine ?? 'deliverable written'} (${job.batches} batch${job.batches === 1 ? '' : 'es'}).`;
    case 'blocked':
      return `${head} ${pct}% ${job.progressLine ?? ''}\n\n❓ ${job.pendingQuestion ?? job.stopReason ?? 'I need your input to continue.'}`.trim();
    case 'failed':
      return `${head} I could not finish this one — ${pct}% done${job.progressLine ? ` (${job.progressLine})` : ''}. ${job.stopReason ?? ''}`.trim();
    case 'cancelled':
      return `${head} Stopped — ${job.stopReason ?? 'cancelled'}.`;
    default:
      return (
        `${head} Still working — ${pct}%${job.progressLine ? ` · ${job.progressLine}` : ''} ` +
        `(batch ${job.batches + 1}). No reply needed; I'll keep going and report when it's done.`
      );
  }
}

/** How long the job may still run, in ms (0 when the budget is spent). */
export function remainingBudgetMs(job: UnattendedJob, now: number = Date.now()): number {
  return Math.max(0, job.deadline - now);
}

/** Test/reset hook. */
export function clearUnattendedJobs(): void {
  writeJobs([]);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/** What a surface must supply to have its work continued. */
export interface UnattendedRunnerDeps {
  /**
   * Run ONE batch of the job, and report what it did.
   *
   * The surface owns the turn (it knows how to reach its engine); the runner
   * owns the bookkeeping. The returned outcome MUST be measured from the
   * artifacts, not from what the agent claimed.
   */
  runBatch: (job: UnattendedJob) => Promise<BatchOutcome>;
  /** A user-facing line about the job (progress, completion, a question). */
  notify?: (job: UnattendedJob, line: string) => void | Promise<void>;
  /**
   * Is the surface busy for this job? A batch waits rather than colliding with
   * a live turn (which the surface would reject), losing nothing.
   */
  isBusy?: (job: UnattendedJob) => boolean;
  /** Which jobs this drain owns (default: all). */
  owns?: JobOwnership;
  now?: () => number;
  /** Batches per drain — higher means a tick finishes more of a long job. */
  maxBatchesPerDrain?: number;
}

/**
 * The unattended continuation loop.
 *
 * One instance per surface process. `drain()` is the periodic tick: it expires
 * anything out of time, reports it, then runs whatever is due — looping so a
 * single tick advances a long job as far as its budget allows instead of one
 * chapter per tick. Drains are serialized through an internal chain, because
 * two overlapping drains would run the same job twice and race on the same
 * files (exactly how the first end-to-end run produced four copies of the last
 * chapter).
 */
export class UnattendedRunner {
  private chain: Promise<void> = Promise.resolve();
  private active = false;

  constructor(private readonly deps: UnattendedRunnerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Is a drain currently running? Status surfaces use this to show activity. */
  get isRunning(): boolean {
    return this.active;
  }

  /** The jobs this runner would pick up right now. */
  due(): UnattendedJob[] {
    return dueUnattendedJobs(this.now(), this.deps.owns ?? (() => true));
  }

  /**
   * Advance every due job as far as one tick may.
   *
   * @returns how many batches were run.
   */
  async drain(): Promise<number> {
    this.chain = this.chain.then(() => this.runOnce()).catch(() => undefined);
    await this.chain;
    return this.lastBatches;
  }

  private lastBatches = 0;

  private async runOnce(): Promise<void> {
    this.active = true;
    this.lastBatches = 0;
    try {
      const now = this.now();

      // Expiry FIRST: a user who was promised the work must hear the outcome
      // even when the queue is busy with something else.
      for (const job of expiredUnattendedJobs(now, this.deps.owns ?? (() => true))) {
        const expired =
          stopUnattendedJob(job.id, 'failed', 'time budget exhausted before the work finished', now) ?? job;
        await this.safeNotify(expired, unattendedStatusLine(expired));
      }

      const budget = Math.max(1, this.deps.maxBatchesPerDrain ?? MAX_BATCHES_PER_DRAIN);
      for (let i = 0; i < budget; i++) {
        const next = this.due().find((job) => !(this.deps.isBusy?.(job) ?? false));
        if (!next) break;

        const claimed = claimUnattendedJob(next.id, this.now());
        if (!claimed) continue;

        let outcome: BatchOutcome;
        try {
          outcome = await this.deps.runBatch(claimed);
        } catch (err) {
          outcome = { error: err instanceof Error ? err.message : String(err) };
        }
        this.lastBatches += 1;

        const updated = recordBatchOutcome(claimed.id, outcome, this.now());
        if (updated && claimed.notify) {
          await this.safeNotify(updated, unattendedStatusLine(updated));
        }
      }
    } finally {
      this.active = false;
    }
  }

  /** A notification must never break the run that produced it. */
  private async safeNotify(job: UnattendedJob, line: string): Promise<void> {
    if (!this.deps.notify) return;
    try {
      await this.deps.notify(job, line);
    } catch {
      /* best-effort */
    }
  }
}
