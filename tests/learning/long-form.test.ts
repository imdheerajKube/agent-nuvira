/**
 * G8 — bounded long-form execution.
 *
 * Pins the structural fix for the 100-page story: the old pipeline capped the
 * writer at 2048 tokens (~4 pages), never decomposed the ask, and had no notion
 * of partial completion, so every run re-derived the same doomed plan.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORDS_PER_GENERATION,
  WORDS_PER_PAGE,
  MAX_UNITS_PER_RUN,
  assembleDocument,
  clearLongFormJobs,
  countWords,
  estimatePages,
  findInProgressJob,
  formatProgress,
  getJob,
  jobProgress,
  longFormKey,
  nextPendingSections,
  nextUnitBrief,
  parseLongFormTarget,
  planSections,
  recordSectionOutcome,
  saveJob,
  sectionTitle,
  startOrResumeJob,
} from '../../src/learning/long-form.js';

let memDir: string;
let projectDir: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-lf-mem-'));
  projectDir = mkdtempSync(join(tmpdir(), 'nuvira-lf-proj-'));
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
  clearLongFormJobs();
});

afterEach(() => {
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** The verbatim goal: 100 pages. */
const STORY_GOAL = 'draft a plan and create story, I will appreciate if a pdf is created with 100 page story like Harry Potter';

describe('parseLongFormTarget', () => {
  it('reads the real 100-page story request', () => {
    const t = parseLongFormTarget(STORY_GOAL)!;
    expect(t.unit).toBe('pages');
    expect(t.amount).toBe(100);
    expect(t.wordsTarget).toBe(100 * WORDS_PER_PAGE);
    // The whole point: the work is split, not attempted in one generation.
    expect(t.unitCount).toBe(Math.ceil(t.wordsTarget / WORDS_PER_GENERATION));
    expect(t.unitCount).toBeGreaterThan(30);
  });

  it('understands words, chapters, pages and sections', () => {
    expect(parseLongFormTarget('write about 5000 words')!.unit).toBe('words');
    expect(parseLongFormTarget('a story in 12 chapters')!.unit).toBe('chapters');
    expect(parseLongFormTarget('10 पेज की कहानी')!.unit).toBe('pages');
    expect(parseLongFormTarget('write it in 8 sections')!.unit).toBe('sections');
  });

  it('handles comma-separated magnitudes', () => {
    expect(parseLongFormTarget('a 1,000 page epic')!.amount).toBe(1000);
  });

  it('defaults an unnumbered book to a chaptered plan', () => {
    const t = parseLongFormTarget('write me a novel')!;
    expect(t.unit).toBe('chapters');
    expect(t.unitCount).toBeGreaterThan(1);
  });

  it('returns null when no magnitude is named', () => {
    expect(parseLongFormTarget('write a poem about rain')).toBeNull();
    expect(parseLongFormTarget('')).toBeNull();
  });
});

describe('planSections', () => {
  it('splits into units whose targets SUM to the whole ask', () => {
    const t = parseLongFormTarget(STORY_GOAL)!;
    const sections = planSections(t, 'creative');
    expect(sections).toHaveLength(t.unitCount);
    const sum = sections.reduce((a, s) => a + s.targetWords, 0);
    expect(sum).toBe(t.wordsTarget);
  });

  it('zero-pads unit files so they sort correctly', () => {
    const t = parseLongFormTarget('write a 30 page report')!;
    const sections = planSections(t, 'document');
    expect(sections[0].path).toMatch(/^chapters\/01-section-1\.md$/);
    expect(sections[9].path).toMatch(/^chapters\/10-section-10\.md$/);
  });

  it('names units by class', () => {
    expect(sectionTitle('creative', 3)).toBe('Chapter 3');
    expect(sectionTitle('document', 3)).toBe('Section 3');
  });
});

describe('the ledger — start, resume, record', () => {
  it('creates a job and reports it as not resumed', () => {
    const target = parseLongFormTarget(STORY_GOAL)!;
    const { job, resumed } = startOrResumeJob({
      projectPath: projectDir,
      docPath: join(projectDir, 'story.md'),
      goal: STORY_GOAL,
      target,
      deliverableClass: 'creative',
    });
    expect(resumed).toBe(false);
    expect(job.sections).toHaveLength(target.unitCount);
    expect(jobProgress(job).done).toBe(0);
    expect(getJob(projectDir, join(projectDir, 'story.md'))!.key).toBe(job.key);
  });

  it('RESUMES an in-progress job instead of starting a second book', () => {
    const target = parseLongFormTarget(STORY_GOAL)!;
    const docPath = join(projectDir, 'story.md');
    const first = startOrResumeJob({ projectPath: projectDir, docPath, goal: STORY_GOAL, target, deliverableClass: 'creative' });
    // The unit's file must exist, or resume correctly re-opens it as pending.
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, first.job.sections[0].path), 'word '.repeat(910), 'utf-8');
    recordSectionOutcome(first.job, 1, { ok: true, words: 910 });

    const second = startOrResumeJob({ projectPath: projectDir, docPath, goal: 'continue', target, deliverableClass: 'creative' });
    expect(second.resumed).toBe(true);
    expect(second.job.sections[0].status).toBe('done');
    expect(second.job.sections[0].words).toBe(910);
    expect(jobProgress(second.job).done).toBe(1);
  });

  it('re-opens a unit whose file vanished — the ledger never claims phantom work', () => {
    const target = parseLongFormTarget('write a 5 page essay')!;
    const docPath = join(projectDir, 'essay.md');
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath, goal: 'write a 5 page essay', target, deliverableClass: 'document' });
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    const unitPath = join(projectDir, job.sections[0].path);
    writeFileSync(unitPath, 'word '.repeat(300), 'utf-8');
    recordSectionOutcome(job, 1, { ok: true, words: 300 });
    expect(jobProgress(job).done).toBe(1);

    unlinkSync(unitPath); // the user (or a failed write) removed it
    const again = startOrResumeJob({ projectPath: projectDir, docPath, goal: 'write a 5 page essay', target, deliverableClass: 'document' });
    expect(again.job.sections[0].status).toBe('pending');
    expect(jobProgress(again.job).done).toBe(0);
  });

  it('counts a failed unit without counting its words', () => {
    const target = parseLongFormTarget('write a 5 page essay')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'essay.md'), goal: 'write a 5 page essay', target, deliverableClass: 'document' });
    recordSectionOutcome(job, 1, { ok: false, error: 'truncated response' });
    expect(job.sections[0].status).toBe('failed');
    expect(job.sections[0].lastError).toBe('truncated response');
    expect(job.words).toBe(0);
    // A failed unit stays in the pending queue, so it is retried not skipped.
    expect(nextPendingSections(job).map((s) => s.index)).toContain(1);
  });

  it('marks the job done only when EVERY unit is done', () => {
    const target = parseLongFormTarget('write 2 chapters')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'b.md'), goal: 'write 2 chapters', target, deliverableClass: 'creative' });
    for (const s of job.sections.slice(0, -1)) recordSectionOutcome(job, s.index, { ok: true, words: 100 });
    expect(jobProgress(job).complete).toBe(false);
    recordSectionOutcome(job, job.sections[job.sections.length - 1].index, { ok: true, words: 100 });
    expect(jobProgress(job).complete).toBe(true);
  });
});

describe('bounded batches — a run always ends with delivered work', () => {
  it('caps the units planned per run', () => {
    const target = parseLongFormTarget(STORY_GOAL)!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 's.md'), goal: STORY_GOAL, target, deliverableClass: 'creative' });
    expect(nextPendingSections(job)).toHaveLength(MAX_UNITS_PER_RUN);
    // …and the next batch starts after the ones already done.
    for (const s of job.sections.slice(0, MAX_UNITS_PER_RUN)) recordSectionOutcome(job, s.index, { ok: true, words: 900 });
    expect(nextPendingSections(job).map((s) => s.index)).toEqual([5, 6, 7, 8]);
  });

  it('gives each brief a target and the previous unit tail for continuity', () => {
    const target = parseLongFormTarget('write 3 chapters')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'c.md'), goal: 'write 3 chapters', target, deliverableClass: 'creative' });
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, job.sections[0].path), 'The hall was silent, and then the door opened.', 'utf-8');
    recordSectionOutcome(job, 1, { ok: true, words: 10 });

    const briefs = nextUnitBrief(job, 2);
    expect(briefs[0].index).toBe(2);
    expect(briefs[0].previousTail).toContain('the door opened');
    expect(briefs[0].targetWords).toBeGreaterThan(0);
  });
});

describe('progress reporting', () => {
  it('quotes chapters, words AND pages so progress is unambiguous', () => {
    const target = parseLongFormTarget(STORY_GOAL)!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 's.md'), goal: STORY_GOAL, target, deliverableClass: 'creative' });
    recordSectionOutcome(job, 1, { ok: true, words: 900 });
    const line = formatProgress(job);
    expect(line).toMatch(/chapter 1\/\d+/);
    expect(line).toMatch(/900\/35,000 words/);
    expect(line).toMatch(/pages/);
  });

  it('computes pages from words', () => {
    expect(estimatePages(WORDS_PER_PAGE * 3)).toBe(3);
    expect(jobProgress({
      sections: [{ index: 1, title: 'Chapter 1', path: 'a', targetWords: 350, status: 'done', words: 350, attempts: 1 }],
      target: { unit: 'pages', amount: 1, wordsTarget: 350, unitCount: 1, source: 'x' },
    } as never).percent).toBe(100);
  });
});

describe('assembly', () => {
  it('refuses to assemble an unfinished job (never a half-book presented as done)', () => {
    const target = parseLongFormTarget('write 3 chapters')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'book.md'), goal: 'write 3 chapters', target, deliverableClass: 'creative' });
    expect(assembleDocument(job)).toBeNull();
  });

  it('concatenates the units into the document the user asked for', () => {
    const target = parseLongFormTarget('write 2 chapters')!;
    const docPath = join(projectDir, 'book.md');
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath, goal: 'write 2 chapters', target, deliverableClass: 'creative' });
    // A chapter is the unit the user counted, so "2 chapters" is 2 units.
    expect(job.sections).toHaveLength(2);
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    job.sections.forEach((s, i) => {
      writeFileSync(join(projectDir, s.path), `Body of unit ${i + 1}.`.repeat(20), 'utf-8');
      recordSectionOutcome(job, s.index, { ok: true, words: 60 });
      saveJob(job);
    });

    const assembled = assembleDocument(job)!;
    expect(assembled.files).toBe(2);
    expect(existsSync(docPath)).toBe(true);
    const text = readFileSync(docPath, 'utf-8');
    expect(text).toMatch(/^# Chapter 1/);
    expect(text).toMatch(/# Chapter 2/);
    expect(assembled.words).toBe(countWords(text));
    expect(assembled.pages).toBeGreaterThan(0);
  });
});

describe('findInProgressJob', () => {
  it('finds the project\'s unfinished work so a "continue" turn resumes it', () => {
    const target = parseLongFormTarget('write 4 chapters')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'x.md'), goal: 'write 4 chapters', target, deliverableClass: 'creative' });
    expect(findInProgressJob(projectDir)!.key).toBe(job.key);
    expect(findInProgressJob('/somewhere/else')).toBeNull();
  });

  it('stops offering a job once it is complete', () => {
    const target = parseLongFormTarget('write 1 chapter')!;
    const { job } = startOrResumeJob({ projectPath: projectDir, docPath: join(projectDir, 'y.md'), goal: 'write 1 chapter', target, deliverableClass: 'creative' });
    recordSectionOutcome(job, 1, { ok: true, words: 900 });
    expect(findInProgressJob(projectDir)).toBeNull();
  });
});

describe('longFormKey', () => {
  it('is stable for the same project + document', () => {
    const a = longFormKey(projectDir, join(projectDir, 'a.md'));
    const b = longFormKey(projectDir, join(projectDir, './a.md'));
    expect(a).toBe(b);
  });
});
