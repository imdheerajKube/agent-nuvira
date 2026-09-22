/**
 * G11 — unattended continuation of long work.
 *
 * Pins the end of the manual cadence: a batch outcome decides what happens
 * next, progress is MEASURED, and the run stops for a question or for its own
 * budget — never to ask permission to continue.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_DEADLINE_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_STALLED_BATCHES,
  UnattendedRunner,
  cancelUnattendedJobsFor,
  claimUnattendedJob,
  clearUnattendedJobs,
  dueUnattendedJobs,
  findUnattendedJob,
  listUnattendedJobs,
  recordBatchOutcome,
  resumeUnattendedJob,
  startUnattendedJob,
  unattendedStatusLine,
  type UnattendedJob,
} from '../../src/learning/unattended-job.js';
import {
  artifactsPresence,
  measureUnattendedProgress,
  scheduleFromPendingWork,
} from '../../src/learning/unattended-progress.js';
import { clearLongFormJobs, recordSectionOutcome, startOrResumeJob } from '../../src/learning/long-form.js';

let memDir: string;
let projectDir: string;
let prevMemDir: string | undefined;
let prevCfgDir: string | undefined;

const SURFACE = { platform: 'cli', channelId: '/tmp/project' };

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-uj-mem-'));
  projectDir = mkdtempSync(join(tmpdir(), 'nuvira-uj-proj-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  prevCfgDir = process.env.NUVIRA_CONFIG_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
  process.env.NUVIRA_CONFIG_DIR = join(memDir, 'cfg');
  clearUnattendedJobs();
  clearLongFormJobs();
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  if (prevCfgDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = prevCfgDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** A 4-unit book whose content already has `done` units on disk. */
function seedBook(opts: { done: number; total: number; withLedger?: boolean }): void {
  const chapters = join(projectDir, 'chapters');
  mkdirSync(chapters, { recursive: true });
  const { job } = startOrResumeJob({
    projectPath: projectDir,
    docPath: join(projectDir, 'book.md'),
    goal: 'write a story',
    deliverableClass: 'creative',
    target: { unit: 'sections', amount: opts.total, wordsTarget: opts.total * 900, unitCount: opts.total, source: 'test' },
  });
  if (!opts.withLedger) return;
  for (let i = 1; i <= opts.done; i++) {
    const rel = `chapters/${String(i).padStart(2, '0')}-chapter-${i}.md`;
    writeFileSync(join(projectDir, rel), 'word '.repeat(900), 'utf-8');
    recordSectionOutcome(job, i, { ok: true, words: 900 });
  }
}

describe('store lifecycle', () => {
  it('schedules a job with a long default budget and reports it as pending', () => {
    const { job, created } = startUnattendedJob({ kind: 'long-form', goal: 'write a book', projectPath: projectDir, surface: SURFACE });
    expect(created).toBe(true);
    expect(job.status).toBe('pending');
    expect(job.deadline - job.createdAt).toBe(DEFAULT_DEADLINE_MS);
    expect(dueUnattendedJobs().map((j) => j.id)).toEqual([job.id]);
  });

  it('is idempotent per (kind, project, surface) so batches never spawn twin workers', () => {
    const first = startUnattendedJob({ kind: 'long-form', goal: 'write a book', projectPath: projectDir, surface: SURFACE });
    const second = startUnattendedJob({ kind: 'long-form', goal: 'write a book', projectPath: projectDir, surface: SURFACE });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(listUnattendedJobs()).toHaveLength(1);
  });

  it('finds the live job for a surface and stops finding it after cancellation', () => {
    const { job } = startUnattendedJob({ kind: 'phased', goal: 'build the app', projectPath: projectDir, surface: SURFACE });
    expect(findUnattendedJob(SURFACE)?.id).toBe(job.id);
    expect(cancelUnattendedJobsFor(SURFACE)).toBe(1);
    expect(findUnattendedJob(SURFACE)).toBeUndefined();
  });
});

describe('recordBatchOutcome — the cadence is decided here, not by a human', () => {
  it('marks the job DONE when the batch finished the deliverable', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    claimUnattendedJob(job.id);
    const after = recordBatchOutcome(job.id, { finished: true, progress: 100, progressLine: '39/39' })!;
    expect(after.status).toBe('done');
    // A finished job is no longer due — nothing may re-run it.
    expect(dueUnattendedJobs()).toHaveLength(0);
  });

  it('keeps running while progress moves', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    claimUnattendedJob(job.id);
    const after = recordBatchOutcome(job.id, { progress: 10, progressLine: 'chapter 4/39' })!;
    expect(after.status).toBe('pending');
    expect(after.stalledBatches).toBe(0);
    expect(dueUnattendedJobs()).toHaveLength(1);
  });

  it('stops and ASKS after repeated batches with no measurable progress', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    // The FIRST batch moves the ledger (0 → 25%); everything after it is flat.
    claimUnattendedJob(job.id);
    recordBatchOutcome(job.id, { progress: 25, progressLine: 'chapter 4/39' });
    let last = job;
    for (let i = 0; i < MAX_STALLED_BATCHES; i++) {
      claimUnattendedJob(job.id);
      last = recordBatchOutcome(job.id, { progress: 25, progressLine: 'stuck at 25%' })!;
    }
    expect(last.status).toBe('blocked');
    expect(last.stalledBatches).toBe(MAX_STALLED_BATCHES);
    expect(last.pendingQuestion).toMatch(/no measurable progress/i);
    expect(dueUnattendedJobs()).toHaveLength(0);
  });

  it('resets the stall counter as soon as progress resumes', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    claimUnattendedJob(job.id);
    recordBatchOutcome(job.id, { progress: 20 });
    claimUnattendedJob(job.id);
    recordBatchOutcome(job.id, { progress: 20 }); // stalled once
    claimUnattendedJob(job.id);
    const after = recordBatchOutcome(job.id, { progress: 45 })!;
    expect(after.stalledBatches).toBe(0);
    expect(after.status).toBe('pending');
  });

  it('counts hard failures separately from stalls and gives up after the cap', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    let last = job;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      claimUnattendedJob(job.id);
      last = recordBatchOutcome(job.id, { error: 'provider 503' })!;
    }
    expect(last.status).toBe('failed');
    expect(last.stopReason).toMatch(/503/);
  });

  it('never reports completion for a batch that failed verification', () => {
    const { job } = startUnattendedJob({ kind: 'phased', goal: 'g', projectPath: projectDir, surface: SURFACE });
    claimUnattendedJob(job.id);
    // Every file exists, the verify step still failed → NOT done.
    const after = recordBatchOutcome(job.id, { finished: true, progress: 100, error: 'site does not present chapter 12' })!;
    expect(after.status).toBe('pending');
    expect(after.failures).toBe(1);
  });

  it('resumes a blocked job when the user answers, with a fresh stall counter', () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    for (let i = 0; i < MAX_STALLED_BATCHES; i++) {
      claimUnattendedJob(job.id);
      recordBatchOutcome(job.id, { progress: 0 });
    }
    const resumed = resumeUnattendedJob(job.id)!;
    expect(resumed.status).toBe('pending');
    expect(resumed.stalledBatches).toBe(0);
    expect(resumed.pendingQuestion).toBeUndefined();
  });
});

describe('UnattendedRunner — runs to completion without a human in the loop', () => {
  it('advances the SAME job across batches until it reports finished', async () => {
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    const seen: number[] = [];
    const lines: string[] = [];
    let batches = 0;

    const runner = new UnattendedRunner({
      runBatch: async () => {
        batches += 1;
        seen.push(batches);
        // 3 batches to finish, each moving the measured percentage.
        return batches < 3
          ? { progress: batches * 30, progressLine: `batch ${batches}` }
          : { progress: 100, finished: true, progressLine: 'complete' };
      },
      notify: (_job, line) => {
        lines.push(line);
      },
    });

    const ran = await runner.drain();
    expect(ran).toBe(3);
    // No "continue" was ever requested — the same job advanced itself.
    expect(seen).toEqual([1, 2, 3]);
    expect(listUnattendedJobs()[0].status).toBe('done');
    expect(lines.some((l) => /Job complete/.test(l))).toBe(true);
    // Progress lines say no answer is needed; none of them ever ASKS for one.
    expect(lines.some((l) => /No reply needed/.test(l))).toBe(true);
    expect(lines.every((l) => !/(reply|say)\s*["“']?continue/i.test(l))).toBe(true);
  });

  it('stops exactly at the stall cap when batches make no progress', async () => {
    startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    let calls = 0;
    const runner = new UnattendedRunner({
      runBatch: async () => {
        calls += 1;
        return { progress: 0, progressLine: 'nothing moved' };
      },
    });
    await runner.drain();
    // One extra call is allowed: the message that stops the run is the one that
    // recorded the cap. Beyond that, nothing runs.
    expect(calls).toBe(MAX_STALLED_BATCHES);
    const job = listUnattendedJobs()[0];
    expect(job.status).toBe('blocked');
    expect(job.pendingQuestion).toBeTruthy();
  });

  it('does not run a job owned by another surface', async () => {
    startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: { platform: 'dashboard', channelId: 's1' } });
    let calls = 0;
    const runner = new UnattendedRunner({
      runBatch: async () => {
        calls += 1;
        return { progress: 50 };
      },
      owns: (job) => job.surface.platform !== 'dashboard',
    });
    expect(await runner.drain()).toBe(0);
    expect(calls).toBe(0);
  });

  it('fails a job whose time budget ran out, and says so', async () => {
    const { job } = startUnattendedJob({
      kind: 'long-form',
      goal: 'g',
      projectPath: projectDir,
      surface: SURFACE,
      deadlineMs: 60_000,
    });
    // Push the deadline into the past: the budget is spent.
    const lines: string[] = [];
    const runner = new UnattendedRunner({
      now: () => job.deadline + 1_000,
      runBatch: async () => ({ progress: 50 }),
      notify: (_job, line) => {
        lines.push(line);
      },
    });
    await runner.drain();
    const stored = listUnattendedJobs()[0];
    expect(stored.status).toBe('failed');
    expect(stored.stopReason).toMatch(/time budget/);
    expect(lines.some((l) => /could not finish/.test(l))).toBe(true);
  });

  it('a batch that throws counts as a failure and the run gives up at the cap', async () => {
    startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    const runner = new UnattendedRunner({
      runBatch: async () => {
        throw new Error('provider exploded');
      },
    });
    await runner.drain();
    const job = listUnattendedJobs()[0];
    // Never a silent no-op, and never an infinite retry: it fails loudly.
    expect(job.failures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(job.status).toBe('failed');
    expect(job.stopReason).toMatch(/provider exploded/);
  });
});

describe('measureUnattendedProgress — measured, never claimed', () => {
  it('reads content progress from the long-form ledger', () => {
    seedBook({ done: 1, total: 4, withLedger: true });
    const { job } = startUnattendedJob({ kind: 'long-form', goal: 'g', projectPath: projectDir, surface: SURFACE });
    const measured = measureUnattendedProgress(job);
    expect(measured.progress).toBe(25);
    expect(measured.progressLine).toMatch(/1\/4/);
    expect(measured.finished).toBe(false);
  });

  it('requires the deliverable’s own files before it counts as finished', () => {
    seedBook({ done: 4, total: 4, withLedger: true });
    writeFileSync(join(projectDir, 'book.md'), 'the whole book', 'utf-8');
    const { job } = startUnattendedJob({
      kind: 'phased',
      goal: 'build the interactive book',
      projectPath: projectDir,
      surface: SURFACE,
      expectedArtifacts: ['site/index.html', 'book.md'],
    });
    // The prose is complete, but the site is missing → NOT finished.
    const partial = measureUnattendedProgress(job);
    expect(partial.finished).toBe(false);
    expect(partial.progressLine).toMatch(/1\/2 deliverable files/);

    mkdirSync(join(projectDir, 'site'), { recursive: true });
    writeFileSync(join(projectDir, 'site', 'index.html'), '<html></html>', 'utf-8');
    const done = measureUnattendedProgress(job);
    expect(done.finished).toBe(true);
    expect(done.progress).toBe(100);
  });

  it('reports artifact counts for a job with no ledger at all', () => {
    mkdirSync(join(projectDir, 'tools'), { recursive: true });
    writeFileSync(join(projectDir, 'tools', 'narrate.py'), '# tts', 'utf-8');
    const { job } = startUnattendedJob({
      kind: 'phased',
      goal: 'g',
      projectPath: projectDir,
      surface: SURFACE,
      expectedArtifacts: ['tools/narrate.py', 'tools/export.mjs'],
    });
    const measured = measureUnattendedProgress(job);
    expect(measured.progress).toBe(50);
    expect(measured.finished).toBe(false);
  });
});

describe('scheduleFromPendingWork — what the surfaces call', () => {
  it('schedules nothing when the run actually finished everything', () => {
    const job = scheduleFromPendingWork(
      {
        kind: 'long-form',
        goal: 'g',
        projectPath: projectDir,
        continuationPrompt: 'continue',
        progressLine: 'done',
        percent: 100,
        reason: 'nothing left',
      },
      SURFACE,
    );
    expect(job).toBeNull();
  });

  it('schedules unfinished work and carries the artifact list through', () => {
    const job = scheduleFromPendingWork(
      {
        kind: 'phased',
        goal: 'build the interactive book',
        projectPath: projectDir,
        continuationPrompt: 'build the interactive book',
        expectedArtifacts: ['site/index.html'],
        progressLine: 'chapter 4/39',
        percent: 10,
        reason: '35 of 39 content units remaining',
      },
      SURFACE,
    )!;
    expect(job.kind).toBe('phased');
    expect(job.expectedArtifacts).toEqual(['site/index.html']);
    expect(job.continuationPrompt).toBe('build the interactive book');
    expect(unattendedStatusLine(job)).toMatch(/No reply needed/);
  });
});

describe('artifactsPresence', () => {
  it('resolves relative paths against the project root', () => {
    writeFileSync(join(projectDir, 'a.txt'), 'x', 'utf-8');
    const presence = artifactsPresence(projectDir, ['a.txt', 'b.txt']);
    expect(presence).toEqual({ present: 1, total: 2, missing: ['b.txt'] });
  });

  it('treats a missing artifact list as "nothing to check"', () => {
    expect(artifactsPresence(projectDir, undefined)).toEqual({ present: 0, total: 0, missing: [] });
  });
});

/** A job record is persisted JSON — the round-trip must not lose the surface. */
describe('persistence', () => {
  it('survives a reload with its counters and surface intact', () => {
    const { job } = startUnattendedJob({ kind: 'phased', goal: 'g', projectPath: projectDir, surface: SURFACE });
    claimUnattendedJob(job.id);
    recordBatchOutcome(job.id, { progress: 30, progressLine: 'chapter 3/10' });
    const reloaded = listUnattendedJobs()[0] as UnattendedJob;
    expect(reloaded.id).toBe(job.id);
    expect(reloaded.batches).toBe(1);
    expect(reloaded.progress).toBe(30);
    expect(reloaded.surface).toEqual(SURFACE);
    expect(reloaded.progressLine).toBe('chapter 3/10');
  });
});
