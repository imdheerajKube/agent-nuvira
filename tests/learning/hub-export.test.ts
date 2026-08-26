/**
 * P5c #3 — Hub-export tests (`src/learning/hub-export.ts`).
 *
 * The configured default skill registry is the repo's own `.agents/skills/`
 * dir — it used to 404. These tests pin the GENERATED layout:
 *  - hubIndexFor renders the HubIndex contract the registry expects
 *  - skillMdFor renders frontmatter (name must match the index entry — the
 *    install path validates that) + the full methodology (params + steps)
 *  - writeHubSkills writes index.json + <name>/SKILL.md per skill
 *  - SYNC-DRIFT GUARD: the COMMITTED .agents/skills/ matches the current
 *    BUNDLED_SKILLS — if bundled-skills.ts changes without running
 *    `node scripts/sync-hub-skills.mjs`, this test fails loudly.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hubIndexFor, skillMdFor, writeHubSkills } from '../../src/learning/hub-export.js';
import { ALL_BUNDLED_SKILLS as BUNDLED_SKILLS } from '../../src/skills/bundled-skills.js';

/** A minimal fixture skill for the pure-render tests. */
const FIXTURE: typeof BUNDLED_SKILLS[number] = {
  id: 'skill-fixture',
  name: 'fixture-skill',
  description: 'A fixture skill for render tests',
  version: '2.1.0',
  goalPattern: 'fixture goal',
  steps: [
    { agentType: 'context-gatherer', description: 'Gather the fixture.', dependsOn: [] },
    { agentType: 'runner', description: 'Run the fixture.', dependsOn: ['step-0'] },
  ],
  parameters: [
    { name: 'target', description: 'Target path', type: 'file-path', required: true },
  ],
  tags: ['fixture'],
  sourceTrajectoryIds: [],
  qualityScore: 0.9,
  usageCount: 0,
  createdAt: 1,
  lastUsedAt: 1,
};

describe('hubIndexFor — the registry index contract', () => {
  it('renders one HubSkillEntry per skill with the registry shape', () => {
    const index = hubIndexFor([FIXTURE], '2026-08-17T00:00:00.000Z');
    expect(index.version).toBe(1);
    expect(index.updatedAt).toBe('2026-08-17T00:00:00.000Z');
    expect(index.skills).toEqual([
      {
        name: 'fixture-skill',
        description: 'A fixture skill for render tests',
        version: '2.1.0',
        author: 'agent-nuvira',
        tags: ['fixture'],
        source: 'agent-nuvira/bundled',
        updatedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);
  });
});

describe('skillMdFor — frontmatter + methodology depth', () => {
  it('frontmatter name matches the index entry (install validates this)', () => {
    const md = skillMdFor(FIXTURE);
    const declared = md.match(/^name:\s*([^\s]+)\s*$/m)?.[1];
    expect(declared).toBe('fixture-skill');
    expect(/^---[ \t]*$/m.test(md)).toBe(true);
    expect(md).toContain('version: 2.1.0');
  });

  it('carries parameters + ordered steps with agent types and deps', () => {
    const md = skillMdFor(FIXTURE);
    expect(md).toContain('## Parameters');
    expect(md).toContain('- target (file-path (required)): Target path');
    expect(md).toContain('## Steps');
    expect(md).toContain('1. [context-gatherer] Gather the fixture.');
    expect(md).toContain('2. [runner] Run the fixture. (after: step-0)');
  });
});

describe('writeHubSkills — layout on disk', () => {
  it('writes index.json + <name>/SKILL.md per skill and returns the paths', () => {
    const written = writeHubSkills([FIXTURE], join('/tmp', 'buff-hub-export-fixture'));
    expect(written).toEqual([
      join('/tmp', 'buff-hub-export-fixture', 'index.json'),
      join('/tmp', 'buff-hub-export-fixture', 'fixture-skill', 'SKILL.md'),
    ]);
    expect(existsSync(join('/tmp', 'buff-hub-export-fixture', 'fixture-skill', 'SKILL.md'))).toBe(true);
  });
});

describe('SYNC-DRIFT GUARD — committed .agents/skills matches BUNDLED_SKILLS', () => {
  const repoRoot = join(import.meta.dirname, '..', '..');

  it('index.json lists every bundled skill at the current version', () => {
    const indexPath = join(repoRoot, '.agents', 'skills', 'index.json');
    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      skills: Array<{ name: string; version: string }>;
    };
    const expected = BUNDLED_SKILLS.map((s) => ({ name: s.name, version: s.version })).sort((a, b) => a.name.localeCompare(b.name));
    const actual = index.skills.map((s) => ({ name: s.name, version: s.version })).sort((a, b) => a.name.localeCompare(b.name));
    expect(actual).toEqual(expected);
  });

  it('every bundled skill has a committed SKILL.md whose frontmatter matches', () => {
    for (const skill of BUNDLED_SKILLS) {
      const skillPath = join(repoRoot, '.agents', 'skills', skill.name, 'SKILL.md');
      expect(existsSync(skillPath), `missing .agents/skills/${skill.name}/SKILL.md — run: node scripts/sync-hub-skills.mjs`).toBe(true);
      const md = readFileSync(skillPath, 'utf-8');
      const declared = md.match(/^name:\s*([^\s]+)\s*$/m)?.[1];
      expect(declared).toBe(skill.name);
      expect(md).toContain(`## Steps`);
      expect(md).toContain(`[${skill.steps[0].agentType}]`);
    }
  });
});
