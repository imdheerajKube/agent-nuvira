/**
 * G7 + G8 — authored deliverables are planned as prose units.
 *
 * The defect this pins (live, six failing orchestrator runs): "write a
 * 100-page story" produced a plan of pure software steps — a Python script
 * that would write the story — and zero units of prose. The goal of these
 * tests is that the story ask produces WRITER steps whose expected file is a
 * chapter, and that the work resumes instead of restarting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLongFormPlan,
  extractStatedTitle,
  isContinuationAsk,
  longFormContinuationNote,
  resolveDocumentPath,
  shouldPlanAsAuthored,
} from '../../src/agents/long-form-plan.js';
import {
  MAX_UNITS_PER_RUN,
  clearLongFormJobs,
  findInProgressJob,
  recordSectionOutcome,
} from '../../src/learning/long-form.js';

let memDir: string;
let projectDir: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-lfp-mem-'));
  projectDir = mkdtempSync(join(tmpdir(), 'nuvira-lfp-proj-'));
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

const STORY_GOAL =
  'draft a plan and create story by getting detailed plan executed, I will appreciate if a pdf is created with 100 page story like Harry Potter';

describe('resolveDocumentPath', () => {
  it('honours an explicit path in the goal', () => {
    const p = resolveDocumentPath('write the story to /tmp/books/Mahagatha.md please', projectDir, 'creative');
    expect(p).toBe('/tmp/books/Mahagatha.md');
  });

  it('normalises the stray space the REAL request contained', () => {
    // Verbatim from the failing run: "…/Documents/story/ Mahagatha.md".
    const p = resolveDocumentPath(
      'Start writing these chapters of this story at /tmp/story/ Mahagatha.md and continue',
      projectDir,
      'creative',
    );
    expect(p).toBe('/tmp/story/Mahagatha.md');
  });

  it('resolves a relative path against the project', () => {
    expect(resolveDocumentPath('write it into output/book.md', projectDir, 'creative'))
      .toBe(join(projectDir, 'output/book.md'));
  });

  it('uses a quoted title when no path is given', () => {
    expect(resolveDocumentPath('write me a story called "Mahagatha"', projectDir, 'creative'))
      .toBe(join(projectDir, 'mahagatha.md'));
  });

  it('uses a title the user STATED without quotes', () => {
    // The live request said "a 5 page story called Mahagatha about a village
    // boy" — no quotes, so the file landed as story.md instead of the user's
    // own name for their work. The stated title ends at the first
    // continuation word.
    expect(
      resolveDocumentPath(
        'write a 5 page story called Mahagatha about a village boy who discovers he has magic',
        projectDir,
        'creative',
      ),
    ).toBe(join(projectDir, 'mahagatha.md'));
    expect(resolveDocumentPath('write a book titled The Long Road in winter', projectDir, 'creative'))
      .toBe(join(projectDir, 'the-long-road.md'));
    expect(resolveDocumentPath('write a novel named Winter Light', projectDir, 'creative'))
      .toBe(join(projectDir, 'winter-light.md'));
    // The extractor stops at the first continuation word rather than filing the
    // whole clause as a filename.
    expect(extractStatedTitle('write a story called Mahagatha about a village boy')).toBe('Mahagatha');
    expect(extractStatedTitle('write a story about rain')).toBeNull();
  });

  it('falls back to a predictable name per class', () => {
    expect(resolveDocumentPath('write a story about rain', projectDir, 'creative'))
      .toBe(join(projectDir, 'story.md'));
    expect(resolveDocumentPath('write a report on sales', projectDir, 'document'))
      .toBe(join(projectDir, 'document.md'));
  });
});

describe('isContinuationAsk', () => {
  it('recognises bare follow-ups', () => {
    for (const g of ['continue', 'Continue', 'keep going', 'next chapters', 'carry on', 'finish it', 'आगे लिखो']) {
      expect(isContinuationAsk(g), g).toBe(true);
    }
  });

  it('does not treat a long new ask as a continuation', () => {
    expect(isContinuationAsk('continue building the react dashboard with websockets and auth and tests')).toBe(false);
    expect(isContinuationAsk('add a csv export button to the report page')).toBe(false);
  });
});

describe('buildLongFormPlan', () => {
  it('returns null for a software goal — the code path is untouched', () => {
    expect(buildLongFormPlan({ goal: 'add a csv export button', workingDir: projectDir })).toBeNull();
    expect(buildLongFormPlan({ goal: 'fix the failing auth test', workingDir: projectDir })).toBeNull();
  });

  it('plans the 100-page story as bounded WRITER units, not a program', () => {
    const plan = buildLongFormPlan({ goal: STORY_GOAL, workingDir: projectDir })!;
    expect(plan).not.toBeNull();

    // A bounded batch — a run that tried all 39 units is the failure mode.
    expect(plan.steps).toHaveLength(MAX_UNITS_PER_RUN);
    for (const step of plan.steps) {
      expect(step.agentType).toBe('writer');
      expect(step.expectedFiles).toHaveLength(1);
      expect(step.expectedFiles![0]).toMatch(/^chapters\/\d\d-chapter-\d+\.md$/);
      // The step must NOT ask for software.
      expect(step.description).not.toMatch(/python|script|reportlab/i);
      expect(step.description).toMatch(/prose/i);
    }

    expect(plan.units.size).toBe(MAX_UNITS_PER_RUN);
    const first = plan.units.get(plan.steps[0].id)!;
    expect(first.title).toBe('Chapter 1');
    expect(first.index).toBe(1);
    expect(first.total).toBeGreaterThan(30);
    expect(first.targetWords).toBeGreaterThan(0);
    // The document the user asked for is the assembled target, not the unit.
    expect(first.docPath).toBe(join(projectDir, 'story.md'));
    expect(plan.progressLine).toMatch(/chapter 0\/\d+/);
  });

  it('gives each unit continuity context from the previous unit', () => {
    const opts = { goal: 'write a story in 3 chapters', workingDir: projectDir };
    const plan = buildLongFormPlan(opts)!;
    const first = plan.units.get(plan.steps[0].id)!;
    expect(first.previousTail).toBe(''); // opening unit has nothing before it

    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, first.path), 'The door opened onto a silent hall.', 'utf-8');
    recordSectionOutcome(plan.job, 1, { ok: true, words: 8 });

    const next = buildLongFormPlan(opts)!;
    expect(next.steps).toHaveLength(2); // 3 chapters, 1 done
    const second = next.units.get(next.steps[0].id)!;
    expect(second.index).toBe(2);
    expect(second.previousTail).toContain('silent hall');
  });

  it('RESUMES in-flight work for a bare "continue" instead of starting over', () => {
    const story = buildLongFormPlan({ goal: 'write the story to /tmp/x/Mahagatha.md — 20 pages', workingDir: projectDir })!;
    const originalDoc = story.job.docPath;
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, story.job.sections[0].path), 'word '.repeat(900), 'utf-8');
    recordSectionOutcome(story.job, 1, { ok: true, words: 900 });
    expect(findInProgressJob(projectDir)).not.toBeNull();

    // "continue" names no class, no length and no path — only the ledger can
    // tell us what to keep writing.
    const resumed = buildLongFormPlan({ goal: 'continue', workingDir: projectDir, forceResume: true })!;
    expect(resumed.resumed).toBe(true);
    expect(resumed.job.docPath).toBe(originalDoc);
    expect(resumed.units.get(resumed.steps[0].id)!.index).toBe(2);
  });

  it('does nothing for a bare "continue" when no work is in flight', () => {
    expect(buildLongFormPlan({ goal: 'continue', workingDir: projectDir, forceResume: true })).toBeNull();
  });
});

describe('longFormContinuationNote', () => {
  it('states what exists and how to continue', () => {
    const plan = buildLongFormPlan({ goal: 'write a story in 4 chapters', workingDir: projectDir })!;
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, plan.job.sections[0].path), 'word '.repeat(2_400), 'utf-8');
    recordSectionOutcome(plan.job, 1, { ok: true, words: 2_400 });

    const note = longFormContinuationNote(plan.job, projectDir);
    expect(note).toMatch(/chapter 1\/4/);
    expect(note).toMatch(/3 units remaining/);
    expect(note).toMatch(/reply "continue"/i);
  });

  it('celebrates completion when every unit is done', () => {
    const plan = buildLongFormPlan({ goal: 'write a story in 1 chapter', workingDir: projectDir })!;
    mkdirSync(join(projectDir, 'chapters'), { recursive: true });
    writeFileSync(join(projectDir, plan.job.sections[0].path), 'word '.repeat(2_500), 'utf-8');
    recordSectionOutcome(plan.job, 1, { ok: true, words: 2_500 });
    expect(longFormContinuationNote(plan.job, projectDir)).toMatch(/All 1 units written/);
  });
});

describe('shouldPlanAsAuthored', () => {
  it('is the orchestrator\'s switch', () => {
    expect(shouldPlanAsAuthored(STORY_GOAL)).toBe(true);
    expect(shouldPlanAsAuthored('build a react app')).toBe(false);
  });
});
