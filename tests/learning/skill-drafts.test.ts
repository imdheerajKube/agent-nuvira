/**
 * P6a — /learn-style skill authoring tests.
 *
 * The preview-card gate: skill_manage create writes a DRAFT (never a live
 * skill); accept promotes it into the live stores (hub SKILL.md + compiled
 * SkillStore so `nuvira skill list` shows it); reject discards it. The learn
 * prompt is the standards-guided authoring instruction (a prompt, not a
 * pipeline — the plan's phase-7 principle).
 *
 * Layers under test:
 *   1. Draft store (skill-drafts.ts) — create validates frontmatter + name,
 *      accept writes both live representations, write_file adds a reference
 *      file (sandboxed), delete removes.
 *   2. Skill tool skill_manage actions (create → pending, patch → updated,
 *      delete → gone; draft payload emitted via ctx.emit).
 *   3. Learn-prompt builder (learn-prompt.ts) — empty request → "this
 *      conversation" default; URL + constraints both kept; standards present.
 *
 * Hermetic: temp HOME (os.homedir mock) isolates ~/.nuvira; the store's dirs
 * are injectable per call where the API allows.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome = '';
let testProject = '';

const holder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { home: mkdtempSync(join(base, 'buff-draft-home-')), project: mkdtempSync(join(base, 'buff-draft-proj-')) };
});

vi.mock('node:os', () => ({
  homedir: () => holder.home,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

vi.mock('../../src/learning/hub-skill-catalog.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/learning/hub-skill-catalog.js');
  return {
    ...actual,
    readHubCatalog: (projectRoot: string = holder.project, home: string = holder.home) =>
      actual.readHubCatalog(projectRoot, home),
    listMatchableHubSkills: (cm?: unknown, projectRoot: string = holder.project, home: string = holder.home) =>
      actual.listMatchableHubSkills(cm as never, projectRoot, home),
  };
});

import { runSkillTool } from '../../src/tools/skill-tool.js';
import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import {
  writeDraft,
  getDraft,
  listDrafts,
  deleteDraft,
  writeDraftFile,
  acceptDraft,
  validateAuthoredSkill,
  compileAuthoredSkill,
} from '../../src/learning/skill-drafts.js';
import { buildLearnPrompt, AUTHORING_STANDARDS } from '../../src/learning/learn-prompt.js';

/** A valid SKILL.md the agent would draft (frontmatter + steps + params). */
function validSkillMd(name = 's3-upload'): string {
  return [
    '---',
    `name: ${name}`,
    'description: Upload build artifacts to an S3 bucket and verify the object exists.',
    'tags: [upload, s3, artifacts]',
    '---',
    '',
    '## Steps',
    '',
    '### Step 1 — [context-gatherer] Map the build output',
    'Read the project config to find the built output directory.',
    '',
    '### Step 2 — [runner] Sync the directory',
    'Run aws s3 sync with the output directory and the bucket target.',
    'depends on: step 1',
    '',
    '### Step 3 — [reviewer] Verify the upload',
    'List the bucket objects and confirm the expected file exists.',
    'depends on: step 2',
    '',
    '## Parameters',
    '',
    '- bucket — the S3 bucket name (required: yes, type: string)',
    '- outputDir — the built output directory (required: no, type: file-path)',
    '',
  ].join('\n');
}

describe('P6a — draft store (skill-drafts.ts)', () => {
  beforeEach(() => {
    testHome = holder.home;
    // Pin the store root to the temp home this file mocks. The global test setup
    // (tests/setup/hermetic-env.ts) points every store at a throwaway dir so a
    // test can never write the developer's real ~/.nuvira — and
    // `defaultDraftsRoot()` appends 'skill-drafts' to that root, so it is
    // `.nuvira` here (not `.nuvira/memory`) that the assertions below address.
    process.env.NUVIRA_MEMORY_DIR = join(testHome, '.nuvira');
    process.env.BUFF_MEMORY_DIR = join(testHome, '.nuvira');
    testProject = holder.project;
    resetSkillStore();
    // Fresh slate under the SHARED mocked home (accept tests write the store).
    rmSync(join(testHome, '.nuvira', 'skill-drafts'), { recursive: true, force: true });
    rmSync(join(testHome, '.nuvira', 'skills'), { recursive: true, force: true });
  });

  afterEach(() => {
    resetSkillStore();
  });

  const draftsRoot = () => join(testHome, '.nuvira', 'skill-drafts');
  const skillsRoot = () => join(testHome, '.nuvira', 'skills');

  it('create validates frontmatter + name (the sandbox rule)', () => {
    // Bad name → refused before any write.
    expect(writeDraft('Bad Name', validSkillMd('Bad Name'), draftsRoot()).ok).toBe(false);
    expect(writeDraft('../evil', validSkillMd('../evil'), draftsRoot()).ok).toBe(false);
    // Missing/mismatched frontmatter → refused.
    expect(writeDraft('s3-upload', '# No frontmatter here', draftsRoot()).ok).toBe(false);
    expect(writeDraft('s3-upload', validSkillMd('other-name'), draftsRoot()).ok).toBe(false);
    // Too-thin body → refused.
    expect(writeDraft('s3-upload', '---\nname: s3-upload\ndescription: X.\n---\ntiny', draftsRoot()).ok).toBe(false);
    // Valid → written.
    const r = writeDraft('s3-upload', validSkillMd(), draftsRoot());
    expect(r.ok).toBe(true);
    expect(existsSync(join(draftsRoot(), 's3-upload', 'SKILL.md'))).toBe(true);
  });

  it('accept promotes the draft into BOTH live stores (hub SKILL.md + compiled SkillStore)', () => {
    const r = writeDraft('s3-upload', validSkillMd(), draftsRoot());
    expect(r.ok).toBe(true);
    const result = acceptDraft('s3-upload', { draftsRoot: draftsRoot(), skillsRoot: skillsRoot() });
    expect(result.ok).toBe(true);
    // 1. Hub SKILL.md under ~/.nuvira/skills/<name>/ (the skill tool loads it).
    expect(existsSync(join(skillsRoot(), 's3-upload', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(skillsRoot(), 's3-upload', 'SKILL.md'), 'utf-8')).toContain('name: s3-upload');
    // 2. Compiled Skill in the SkillStore (`nuvira skill list` shows it).
    const compiled = getSkillStore().get(result.skill!.id);
    expect(compiled).not.toBeNull();
    expect(compiled?.name).toBe('s3-upload');
    expect(compiled?.steps.length).toBeGreaterThanOrEqual(3);
    // 3. The draft is gone (it is now live).
    expect(getDraft('s3-upload', draftsRoot())).toBeNull();
    expect(listDrafts(draftsRoot())).toHaveLength(0);
  });

  it('compileAuthoredSkill derives steps from ### Step N sections and parameters from the bullet list', () => {
    const skill = compileAuthoredSkill('s3-upload', validSkillMd());
    expect(skill.steps.map((s) => s.agentType)).toEqual(['context-gatherer', 'runner', 'reviewer']);
    expect(skill.steps[1].dependsOn).toEqual(['step-0']);
    const bucket = skill.parameters.find((p) => p.name === 'bucket');
    expect(bucket).toMatchObject({ required: true, type: 'string' });
    const output = skill.parameters.find((p) => p.name === 'outputDir');
    expect(output).toMatchObject({ required: false, type: 'file-path' });
    expect(skill.sourceTrajectoryIds).toEqual(['learned']);
  });

  it('write_file adds a sandboxed reference file to the draft dir', () => {
    writeDraft('s3-upload', validSkillMd(), draftsRoot());
    const r = writeDraftFile('s3-upload', 'templates/bucket-policy.json', '{"Version":"2012-10-17"}', draftsRoot());
    expect(r.ok).toBe(true);
    expect(readFileSync(join(draftsRoot(), 's3-upload', 'templates', 'bucket-policy.json'), 'utf-8')).toContain('2012-10-17');
    // Traversal is refused.
    expect(writeDraftFile('s3-upload', '../../etc/passwd', 'x', draftsRoot()).ok).toBe(false);
  });

  it('delete removes the draft (reject); listDrafts reflects it', () => {
    writeDraft('s3-upload', validSkillMd(), draftsRoot());
    writeDraft('schema-check', validSkillMd('schema-check'), draftsRoot());
    expect(listDrafts(draftsRoot()).map((d) => d.name).sort()).toEqual(['s3-upload', 'schema-check']);
    expect(deleteDraft('schema-check', draftsRoot())).toBe(true);
    expect(deleteDraft('schema-check', draftsRoot())).toBe(false);
    expect(listDrafts(draftsRoot()).map((d) => d.name)).toEqual(['s3-upload']);
  });

  it('accept on a missing draft returns ok:false (nothing to accept)', () => {
    const result = acceptDraft('ghost', { draftsRoot: draftsRoot(), skillsRoot: skillsRoot() });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
  });
});

describe('P6a — skill tool skill_manage actions', () => {
  beforeEach(() => {
    testHome = holder.home;
    // Pin the store root to the temp home this file mocks. The global test setup
    // (tests/setup/hermetic-env.ts) points every store at a throwaway dir so a
    // test can never write the developer's real ~/.nuvira — and
    // `defaultDraftsRoot()` appends 'skill-drafts' to that root, so it is
    // `.nuvira` here (not `.nuvira/memory`) that the assertions below address.
    process.env.NUVIRA_MEMORY_DIR = join(testHome, '.nuvira');
    process.env.BUFF_MEMORY_DIR = join(testHome, '.nuvira');
    testProject = holder.project;
    resetSkillStore();
    // The compiled store + drafts live under the SHARED mocked home — a fresh
    // slate per test keeps accept/promote assertions honest.
    rmSync(join(testHome, '.nuvira', 'skill-drafts'), { recursive: true, force: true });
    rmSync(join(testHome, '.nuvira', 'skills'), { recursive: true, force: true });
  });

  afterEach(() => {
    resetSkillStore();
  });

  it('create writes a PENDING draft and emits the skill:draft payload (accept gate)', async () => {
    const emitted: unknown[] = [];
    const ctx = { configManager: {}, emit: (_e: string, data: unknown) => { emitted.push(data); } };
    const out = await runSkillTool(
      { manage: { action: 'create', name: 's3-upload', markdown: validSkillMd() } },
      ctx as never,
    );
    expect(out).toContain('PENDING');
    expect(out).toContain('accept');
    // The draft exists but is NOT a live skill yet.
    expect(getDraft('s3-upload', join(testHome, '.nuvira', 'skill-drafts'))).not.toBeNull();
    expect(getSkillStore().getAll().some((s) => s.name === 's3-upload')).toBe(false);
    // Structured payload emitted for the GUI preview card.
    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as { name: string; description: string };
    expect(payload.name).toBe('s3-upload');
    expect(payload.description).toContain('S3 bucket');
  });

  it('patch applies an old→new text replacement to the draft and re-emits', async () => {
    const emitted: unknown[] = [];
    const ctx = { configManager: {}, emit: (_e: string, data: unknown) => { emitted.push(data); } };
    await runSkillTool({ manage: { action: 'create', name: 's3-upload', markdown: validSkillMd() } }, ctx as never);
    const out = await runSkillTool(
      { manage: { action: 'patch', name: 's3-upload', oldText: 'Map the build output', newText: 'Map the DIST build output' } },
      ctx as never,
    );
    expect(out).toContain('Patched');
    expect(getDraft('s3-upload', join(testHome, '.nuvira', 'skill-drafts'))?.markdown).toContain('Map the DIST build output');
    expect(emitted).toHaveLength(2);
  });

  it('delete removes the draft (the reject path)', async () => {
    const ctx = { configManager: {}, emit: () => {} };
    await runSkillTool({ manage: { action: 'create', name: 's3-upload', markdown: validSkillMd() } }, ctx as never);
    const out = await runSkillTool({ manage: { action: 'delete', name: 's3-upload' } }, ctx as never);
    expect(out).toContain('Deleted');
    expect(getDraft('s3-upload', join(testHome, '.nuvira', 'skill-drafts'))).toBeNull();
  });

  it('create validates and returns a helpful error string (never throws)', async () => {
    const ctx = { configManager: {}, emit: () => {} };
    const out = await runSkillTool(
      { manage: { action: 'create', name: 'bad name', markdown: validSkillMd('bad name') } },
      ctx as never,
    );
    expect(out).toContain('Refused');
    expect(out).toContain('not in [a-z0-9-]');
  });

  it('accept promotes a draft created through the tool (end-to-end authoring)', async () => {
    const ctx = { configManager: {}, emit: () => {} };
    await runSkillTool({ manage: { action: 'create', name: 's3-upload', markdown: validSkillMd() } }, ctx as never);
    const result = acceptDraft('s3-upload', {
      draftsRoot: join(testHome, '.nuvira', 'skill-drafts'),
      skillsRoot: join(testHome, '.nuvira', 'skills'),
    });
    expect(result.ok).toBe(true);
    // The skill tool loads the accepted skill next turn (hub catalog).
    const loaded = await runSkillTool({ skill: 's3-upload' }, { configManager: {} });
    expect(loaded).toContain('s3-upload');
    expect(loaded).toContain('Sync the directory');
  });
});

describe('P6a — learn-prompt builder (learn-prompt.ts)', () => {
  it('empty request defaults to "this conversation"', () => {
    const prompt = buildLearnPrompt();
    expect(prompt).toContain('this conversation');
    expect(prompt).toContain(AUTHORING_STANDARDS);
  });

  it('request with URL + constraints keeps both', () => {
    const prompt = buildLearnPrompt('learn from https://docs.example.com/api/quickstart — 4 steps max, python only');
    expect(prompt).toContain('https://docs.example.com/api/quickstart');
    expect(prompt).toContain('4 steps max, python only');
    expect(prompt).toContain('GATHER');
  });

  it('asks the agent to DRAFT then present a preview card (never save directly)', () => {
    const prompt = buildLearnPrompt('learn the deploy flow');
    expect(prompt).toContain('action: create');
    expect(prompt).toContain('preview card');
    expect(prompt).toContain('Do NOT save anything yourself');
  });
});
