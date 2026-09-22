/**
 * G12 — phased planning for hybrid deliverables.
 *
 * The ask these pin: "develop a web-based interactive book with voice
 * narration". Planning it as prose loses the site; planning it as code loses
 * the book. It has to be PHASES, ordered shape → content → experience →
 * services → verify, with a verification step that we generate ourselves.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCompositePlan, buildVerifyCommand, phaseSummary } from '../../src/agents/composite-plan.js';
import { clearLongFormJobs } from '../../src/learning/long-form.js';

let memDir: string;
let projectDir: string;
let prevMemDir: string | undefined;

const WEB_BOOK_GOAL =
  'develop a web-based interactive book: a 20 page story with voice narration for each chapter, presented as a website';

beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-cp-mem-'));
  projectDir = mkdtempSync(join(tmpdir(), 'nuvira-cp-proj-'));
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

describe('buildCompositePlan — who gets a phased plan', () => {
  it('ignores a plain prose ask (that is the long-form engine’s job)', () => {
    expect(buildCompositePlan({ goal: 'write a 20 page story in 5 chapters', workingDir: projectDir })).toBeNull();
  });

  it('ignores a plain software ask (that is the code planner’s job)', () => {
    expect(buildCompositePlan({ goal: 'add a csv export button to the dashboard', workingDir: projectDir })).toBeNull();
    expect(
      buildCompositePlan({ goal: 'build a react dashboard with a python fastapi backend', workingDir: projectDir }),
    ).toBeNull();
  });

  it('builds phases for a web-based interactive book', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    expect(plan).not.toBeNull();
    expect(plan.substrates).toEqual(expect.arrayContaining(['prose', 'web']));
    expect(plan.phases.map((p) => p.kind)).toEqual(['scaffold', 'content', 'interactivity', 'assets', 'verify']);
  });
});

describe('the phases produce the whole deliverable, in order', () => {
  it('starts with the SHAPE, so the content has somewhere to land', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const scaffold = plan.phases[0];
    expect(scaffold.kind).toBe('scaffold');
    expect(scaffold.steps[0].expectedFiles).toEqual([
      'site/index.html',
      'site/styles.css',
      'site/reader.js',
    ]);
    // Opens from disk: no build step, no install, no server.
    expect(scaffold.steps[0].description).toMatch(/no build step, no server, no package install/i);
  });

  it('plans the CONTENT as bounded prose units, not as a program', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const content = plan.phases.find((p) => p.kind === 'content')!;
    // 20 pages ≈ 7,000 words ≈ 8 units of ~900.
    expect(plan.job.sections).toHaveLength(8);
    expect(content.steps).toHaveLength(4); // one bounded batch per run
    for (const step of content.steps) {
      expect(step.agentType).toBe('writer');
      expect(step.expectedFiles?.[0]).toMatch(/^content\/chapters\//);
      expect(plan.proseUnits.get(step.id)?.deliverableClass).toBe('creative');
    }
    // The unit plan is wired to follow the scaffold, and to run in order.
    expect(content.steps[0].dependsOn).toEqual(['scaffold-site']);
    expect(content.steps[1].dependsOn).toEqual([content.steps[0].id]);
  });

  it('adds the EXPERIENCE layer that makes the content usable', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const interactive = plan.phases.find((p) => p.kind === 'interactivity')!;
    expect(interactive.steps[0].expectedFiles).toEqual(['site/chapters.js']);
    // It must enumerate at load time — a hard-coded count breaks at chapter 39.
    expect(interactive.steps[0].description).toMatch(/enumerate the directory contents at load time/i);
    // Continuity: it runs AFTER the last content step.
    const lastContent = plan.phases.find((p) => p.kind === 'content')!.steps.at(-1)!.id;
    expect(interactive.steps[0].dependsOn).toEqual([lastContent]);
  });

  it('treats a Python narration service as OPTIONAL, never as the only path', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const assets = plan.phases.find((p) => p.kind === 'assets')!;
    expect(assets.steps[0].expectedFiles).toEqual(['tools/narrate.py']);
    expect(assets.steps[0].description).toMatch(/must NOT be required for the site to work/i);
    // …while the site itself narrates through the browser with nothing installed.
    const scaffold = plan.phases.find((p) => p.kind === 'scaffold')!;
    expect(scaffold.steps[0].description).toMatch(/nothing installed/i);
  });

  it('ends with a VERIFICATION step that depends on every other step', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const verify = plan.phases.at(-1)!;
    expect(verify.kind).toBe('verify');
    expect(verify.steps[0].agentType).toBe('runner');
    const allOthers = plan.steps.filter((s) => s.id !== verify.steps[0].id).map((s) => s.id);
    expect(verify.steps[0].dependsOn).toEqual(expect.arrayContaining(allOthers));
  });

  it('promises every artifact the deliverable needs, so completion can be MEASURED', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    expect(plan.expectedArtifacts).toEqual(
      expect.arrayContaining(['content/book.md', 'site/index.html', 'site/chapters.js', 'tools/narrate.py']),
    );
    for (const section of plan.job.sections) {
      expect(plan.expectedArtifacts).toContain(section.path);
    }
  });

  it('marks the greenfield steps so they are written by the one-shot writer', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    // A read→edit→verify loop has nothing to read in a directory that does not
    // exist yet; these steps CREATE files, and the live run showed the
    // tool-calling writer returning zero changes for them.
    expect(plan.creationStepIds).toEqual(
      expect.arrayContaining(['scaffold-site', 'site-chapter-index', 'tools-narrate']),
    );
    // The prose units and the verifier are not creation steps.
    expect(plan.creationStepIds.some((id) => id.startsWith('long-form-unit-'))).toBe(false);
    expect(plan.creationStepIds).not.toContain('verify-deliverable');
  });

  it('describes itself in one line for the run report', () => {
    const plan = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    expect(plan.deliverableSummary).toMatch(/prose/);
    expect(plan.deliverableSummary).toMatch(/phase/);
    expect(phaseSummary(plan)).toMatch(/Shape the site/);
    expect(phaseSummary(plan)).toMatch(/Verify the whole deliverable/);
  });

  it('gives the SAME job back on a re-plan, so phases resume instead of restarting', () => {
    const first = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    const second = buildCompositePlan({ goal: 'continue', workingDir: projectDir, verdict: undefined })!;
    // "continue" carries no class, so it is planned against the ledger the same
    // way — the key is stable either way.
    const third = buildCompositePlan({ goal: WEB_BOOK_GOAL, workingDir: projectDir })!;
    expect(third.job.key).toBe(first.job.key);
    expect(third.job.sections).toHaveLength(second ? second.job.sections.length : first.job.sections.length);
  });
});

describe('buildVerifyCommand — the check is OURS, not the model’s', () => {
  it('asserts files exist AND that the site reads its chapters from disk', () => {
    const cmd = buildVerifyCommand({
      artifacts: ['content/book.md', 'site/index.html'],
      siteDir: 'site',
      chaptersDir: 'content/chapters',
    });
    expect(cmd).toMatch(/^node -e "/);
    expect(cmd).toMatch(/MISSING FILES/);
    expect(cmd).toMatch(/THE SITE DOES NOT READ ITS CHAPTERS FROM/);
    expect(cmd).toMatch(/process\.exit\(1\)/);
    // The site check reads the site's own sources for the chapters DIRECTORY.
    // Deliberately NOT a per-file check: a correct reader enumerates the
    // directory at load time and names no chapter file in its source, so
    // requiring filenames would fail the implementation we asked for.
    expect(cmd).toMatch(/readdirSync/);
    expect(cmd).toMatch(/content\/chapters/);
  });

  it('omits the site check for a deliverable with no web layer', () => {
    const cmd = buildVerifyCommand({ artifacts: ['content/book.md'] });
    expect(cmd).toMatch(/MISSING FILES/);
    expect(cmd).not.toMatch(/DOES NOT READ ITS CHAPTERS/);
  });
});
