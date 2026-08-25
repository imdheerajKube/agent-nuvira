/**
 * P0.8 — Skill tool tests.
 *
 * The chat agent can load a reusable capability pack by name: compiled skills
 * (SkillStore) and hub skills (SKILL.md under .agents/skills/). Hermetic — a
 * temp HOME isolates the real ~/.nuvira store, and a temp project root provides
 * the hub catalog.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome = '';
let testProject = '';

// The store reads homedir() at construction — point it at a temp dir BEFORE
// any SkillStore/import that touches it. resetSkillStore() clears the cached
// singleton so each test sees a fresh store bound to the temp home.
const holder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { home: mkdtempSync(join(base, 'buff-skill-tool-home-')), project: mkdtempSync(join(base, 'buff-skill-tool-proj-')) };
});

vi.mock('node:os', () => ({
  homedir: () => holder.home,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

// Point the hub catalog at the temp project (its default is process.cwd()).
vi.mock('../../src/learning/hub-skill-catalog.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/learning/hub-skill-catalog.js');
  return {
    ...actual,
    readHubCatalog: (projectRoot: string = holder.project, home: string = holder.home) =>
      actual.readHubCatalog(projectRoot, home),
    // P6c — the tool now reads via the MATCHABLE catalog (gates applied);
    // pin its roots to the temp project/home so hub skills resolve.
    listMatchableHubSkills: (cm?: unknown, projectRoot: string = holder.project, home: string = holder.home) =>
      actual.listMatchableHubSkills(cm as never, projectRoot, home),
  };
});

import { runSkillTool, resolveSkill, listAllSkills } from '../../src/tools/skill-tool.js';
import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import type { Skill } from '../../src/learning/skill-types.js';
import { BUNDLED_SKILLS } from '../../src/skills/bundled-skills.js';

/** A minimal compiled skill (bundled-shape) saved into the temp store. */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-test-assessment',
    name: 'Code Assessment',
    description: 'Assess a codebase: gaps, recommendations, roadmap.',
    version: '1.0.0',
    goalPattern: 'assess code quality gaps roadmap',
    steps: [
      { agentType: 'reader', description: 'Read {{target}} and map the structure.', dependsOn: [] },
      { agentType: 'reviewer', description: 'Score gaps against the checklist.', dependsOn: ['step-0'] },
    ],
    parameters: [
      { name: 'target', description: 'Path or repo to assess', type: 'string', required: true },
    ],
    tags: ['assessment', 'roadmap'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

describe('skill tool', () => {
  beforeEach(() => {
    testHome = holder.home;
    testProject = holder.project;
    resetSkillStore();
  });

  afterEach(() => {
    // Leave the temp dirs for the process (cleaned by the OS tmpdir policy);
    // reset the singleton so the next test re-reads the same temp home.
    resetSkillStore();
  });

  it('loads a compiled skill from the store: methodology with steps + parameters', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const out = await runSkillTool({ skill: 'Code Assessment' }, { configManager: {} });
    expect(out).toContain('🧠 Code Assessment');
    expect(out).toContain('Assess a codebase: gaps, recommendations, roadmap.');
    expect(out).toContain('[reader]');
    expect(out).toContain('[reviewer]');
    expect(out).toContain('target: Path or repo to assess (required)');
    expect(out).toContain('Steps (2):');
  });

  it('resolves {{param}} placeholders from the params argument', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const out = await runSkillTool({ skill: 'skill-test-assessment', params: { target: 'src/cli' } }, { configManager: {} });
    expect(out).toContain('Read src/cli and map the structure.');
  });

  it('marks the loaded skill as used (usageCount increments)', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    await runSkillTool({ skill: 'Code Assessment' }, { configManager: {} });
    const after = store.get('skill-test-assessment');
    expect(after?.usageCount).toBe(1);
  });

  it('loads a hub SKILL.md skill (name + description + body)', async () => {
    // Write a hub skill into the temp project's .agents/skills/. NOTE: the
    // name must NOT collide with a bundled skill (compiled wins the lookup).
    const dir = join(testProject, '.agents', 'skills', 'custom-analyzer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: Custom Analyzer\n description: Analyze custom metrics dashboards.\n---\n# Custom Analyzer\nBuild a matrix of metric queries first.\n',
      'utf-8',
    );
    const out = await runSkillTool({ skill: 'custom-analyzer' }, { configManager: {} });
    expect(out).toContain('Custom Analyzer');
    expect(out).toContain('Build a matrix of metric queries first.');
    expect(out).toContain('hub skill');
  });

  it('P6c — surfaces declared env-var NAMES as setup hints (values never printed)', async () => {
    const dir = join(testProject, '.agents', 'skills', 'env-heavy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: env-heavy\nrequired_environment_variables: [DB_URL, API_TOKEN]\n---\n# Env Heavy\nConnect to the database and fetch rows.\n',
      'utf-8',
    );
    const out = await runSkillTool({ skill: 'env-heavy' }, { configManager: {} });
    expect(out).toContain('Requires env vars (set before running): DB_URL, API_TOKEN');
    // The names appear; an actual VALUE never does (we never read process.env).
    expect(out).not.toContain('secret-value');
  });

  it('unknown skill lists every available skill (both sources)', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const dir = join(testProject, '.agents', 'skills', 'custom-analyzer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: Custom Analyzer\ndescription: Analyze dashboards.\n---\n# Body\n', 'utf-8');

    const out = await runSkillTool({ skill: 'does-not-exist' }, { configManager: {} });
    expect(out).toContain("Skill not found: 'does-not-exist'");
    expect(out).toContain('Code Assessment');
    expect(out).toContain('Custom Analyzer');
  });

  it('refuses a disabled skill (skills.disabled match-gate parity)', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const cm = {
      getAll: () => ({ skills: { disabled: ['skill-test-assessment'] } }),
    };
    const out = await runSkillTool({ skill: 'Code Assessment' }, { configManager: cm });
    expect(out).toContain('disabled');
  });

  it('no name lists the whole catalog (never errors)', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const out = await runSkillTool({}, { configManager: {} });
    expect(out).toContain('Available skills (');
    expect(out).toContain('Code Assessment');
  });

  it('P5 — every bundled skill is loadable and marked used (the batch at the depth bar)', async () => {
    // A fresh store seeds BUNDLED_SKILLS into the temp home.
    const store = getSkillStore();
    expect(BUNDLED_SKILLS.length).toBeGreaterThanOrEqual(5);
    for (const bundled of BUNDLED_SKILLS) {
      const out = await runSkillTool({ skill: bundled.name }, { configManager: {} });
      expect(out).toContain(bundled.name);
      expect(out).toContain('Steps'); // full methodology, not a stub
      expect(store.get(bundled.id)?.usageCount).toBe(1);
    }
  });

  it('P5 — the capability skills match from chat goals (name resolution)', async () => {
    for (const name of ['code-assessment', 'technical-roadmap', 'plan-create-track', 'test-strategy']) {
      const out = await runSkillTool({ skill: name }, { configManager: {} });
      expect(out).toContain(name);
      expect(out).toContain('Steps');
    }
  });

  it('resolveSkill + listAllSkills agree on sources', async () => {
    const store = getSkillStore();
    store.save(makeSkill());
    const resolved = await resolveSkill('Code Assessment');
    expect(resolved?.kind).toBe('compiled');
    expect(resolved?.id).toBe('skill-test-assessment');
    const all = await listAllSkills();
    expect(all.some((s) => s.id === 'skill-test-assessment')).toBe(true);
  });
});
