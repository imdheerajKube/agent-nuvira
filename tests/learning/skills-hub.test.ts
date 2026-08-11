/**
 * J3 — Skills hub tests (`src/learning/skills-hub.ts`).
 *
 * Uses a LOCAL-DIR registry (BUFF_SKILLS_REGISTRY pointing at a temp dir) so
 * no network is ever touched (plan acceptance: mocked registry). Covers:
 * - fetchHubIndex / searchHubSkills from a local index
 * - installHubSkill: fresh install writes SKILL.md + provenance + sha256
 * - sandbox: invalid skill names refused; missing SKILL.md refused; bad frontmatter refused
 * - reinstall: same content → "already up to date"; changed content → quarantined
 * - updateHubSkills: newer version updates, current stays, missing stays
 * - listHubSkills: provenance merge + origin filter
 * - isValidSkillName / clearSkillsIndexCache
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const homeHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-skills-hub-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => homeHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import {
  fetchHubIndex,
  searchHubSkills,
  installHubSkill,
  updateHubSkills,
  listHubSkills,
  getHubSkillEntry,
  isValidSkillName,
  clearSkillsIndexCache,
  type HubSkillEntry,
} from '../../src/learning/skills-hub.js';

const INDEX = {
  version: 1,
  updatedAt: '2026-08-10',
  skills: [
    {
      name: 'release-bumper',
      description: 'Bump versions and tag a release',
      version: '1.2.0',
      author: 'dheeraj',
      tags: ['release', 'git'],
      source: 'agent-nuvira/skills',
      updatedAt: '2026-08-01',
    },
    {
      name: 'security-audit',
      description: 'Audit dependencies for known vulnerabilities',
      version: '0.9.0',
      author: 'dheeraj',
      tags: ['security', 'npm'],
      source: 'agent-nuvira/skills',
      updatedAt: '2026-07-20',
    },
  ],
} as const;

function makeEntry(name: string): HubSkillEntry {
  return INDEX.skills.find((s) => s.name === name) as unknown as HubSkillEntry;
}

/** A valid SKILL.md with frontmatter. */
function skillMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: test skill\nversion: 1.0.0\n---\n\n# ${name}\n\nSteps to do the thing.\n`;
}

// Temp project root for .agents/skills installs.
let registryDir = '';
let projectDir = '';
const realRegistry = process.env.BUFF_SKILLS_REGISTRY;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'buff-skills-reg-'));
  projectDir = mkdtempSync(join(tmpdir(), 'buff-skills-proj-'));
  writeFileSync(join(registryDir, 'index.json'), JSON.stringify(INDEX), 'utf-8');
  for (const s of INDEX.skills) {
    const dir = join(registryDir, s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(s.name), 'utf-8');
  }
  // Fresh provenance + index cache + quarantine per test (the mocked homedir
  // is shared across tests in this file — without this, install records and
  // the TTL index cache leak between tests and update/list see stale state).
  rmSync(join(homeHolder.value, '.buff', 'skills-hub'), { recursive: true, force: true });
  process.env.BUFF_SKILLS_REGISTRY = `file://${registryDir}`;
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  if (realRegistry === undefined) delete process.env.BUFF_SKILLS_REGISTRY;
  else process.env.BUFF_SKILLS_REGISTRY = realRegistry;
  vi.restoreAllMocks();
});

describe('skills-hub — index + search (local registry, no network)', () => {
  it('fetches the index from the configured local registry', async () => {
    const skills = await fetchHubIndex();
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toEqual(['release-bumper', 'security-audit']);
  });

  it('searches by name, description, and tags', async () => {
    expect((await searchHubSkills('release')).map((s) => s.name)).toEqual(['release-bumper']);
    expect((await searchHubSkills('vulnerab')).map((s) => s.name)).toEqual(['security-audit']);
    expect((await searchHubSkills('npm')).map((s) => s.name)).toEqual(['security-audit']);
    expect(await searchHubSkills('zzz_nothing')).toEqual([]);
  });

  it('serves repeat reads from the TTL cache', async () => {
    await fetchHubIndex();
    await fetchHubIndex();
    // Second read must not throw — cached path.
    const skills = await fetchHubIndex();
    expect(skills).toHaveLength(2);
  });
});

describe('skills-hub — install (sandbox + provenance + checksum)', () => {
  it('installs a skill to <project>/.agents/skills/<name>/ and records provenance', async () => {
    const result = await installHubSkill(makeEntry('release-bumper'), projectDir);
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.2.0');

    const target = join(projectDir, '.agents', 'skills', 'release-bumper', 'SKILL.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('# release-bumper');

    const listed = listHubSkills(undefined, projectDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'release-bumper', source: 'agent-nuvira/skills', version: '1.2.0', origin: 'local' });
    expect(listed[0].installed).toBe(true);
    expect(listed[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses invalid skill names (sandbox: no traversal/spaces/dots)', async () => {
    const result = await installHubSkill({ ...makeEntry('release-bumper'), name: '../../evil' }, projectDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Refused');
    expect(existsSync(join(projectDir, '.agents', 'skills', '..'))).toBe(false);
  });

  it('refuses a skill with no SKILL.md in the registry', async () => {
    const result = await installHubSkill(
      { ...makeEntry('release-bumper'), name: 'missing-skill' },
      projectDir,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SKILL.md not found');
  });

  it('refuses a skill without frontmatter', async () => {
    mkdirSync(join(registryDir, 'badskill'), { recursive: true });
    writeFileSync(join(registryDir, 'badskill', 'SKILL.md'), 'no frontmatter here', 'utf-8');
    const result = await installHubSkill({ ...makeEntry('release-bumper'), name: 'badskill' }, projectDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('frontmatter');
  });

  it('refuses a skill whose frontmatter name does not match the registry entry', async () => {
    mkdirSync(join(registryDir, 'mismatch'), { recursive: true });
    writeFileSync(join(registryDir, 'mismatch', 'SKILL.md'), skillMarkdown('different-name'), 'utf-8');
    const result = await installHubSkill({ ...makeEntry('release-bumper'), name: 'mismatch' }, projectDir);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('frontmatter declares name');
  });

  it('reinstall with identical content reports already up to date', async () => {
    await installHubSkill(makeEntry('security-audit'), projectDir);
    const second = await installHubSkill(makeEntry('security-audit'), projectDir);
    expect(second.ok).toBe(true);
    expect(second.reason).toBe('already up to date');
  });

  it('reinstall with CHANGED content quarantines instead of overwriting', async () => {
    await installHubSkill(makeEntry('security-audit'), projectDir);
    const target = join(projectDir, '.agents', 'skills', 'security-audit', 'SKILL.md');
    const original = readFileSync(target, 'utf-8');
    expect(original).toContain('# security-audit');

    // Change the registry copy → checksum mismatch on reinstall.
    writeFileSync(join(registryDir, 'security-audit', 'SKILL.md'), skillMarkdown('security-audit') + '\n# tampered\n', 'utf-8');
    const result = await installHubSkill(makeEntry('security-audit'), projectDir);
    expect(result.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    // Installed copy untouched.
    expect(readFileSync(target, 'utf-8')).toBe(original);
    // Quarantine file written.
    const quarantineDir = join(homeHolder.value, '.buff', 'skills-hub', 'quarantine');
    expect(readdirSync(quarantineDir).length).toBeGreaterThan(0);
  });
});

describe('skills-hub — update', () => {
  it('updates when the registry has a NEWER version, and keeps current ones', async () => {
    await installHubSkill(makeEntry('security-audit'), projectDir);

    // Registry bumps security-audit to 1.0.0 (newer than the installed 0.9.0)
    // with new content AND a version bump in the index.
    const bumped = {
      ...INDEX,
      skills: INDEX.skills.map((s) =>
        s.name === 'security-audit' ? { ...s, version: '1.0.0' } : s,
      ),
    };
    writeFileSync(join(registryDir, 'index.json'), JSON.stringify(bumped), 'utf-8');
    writeFileSync(join(registryDir, 'security-audit', 'SKILL.md'), skillMarkdown('security-audit') + '\n# v1.0.0\n', 'utf-8');

    const { updated, current, failed } = await updateHubSkills(projectDir);
    expect(updated).toContain('security-audit');
    expect(failed).toEqual([]);

    const target = join(projectDir, '.agents', 'skills', 'security-audit', 'SKILL.md');
    expect(readFileSync(target, 'utf-8')).toContain('v1.0.0');
    expect(current.length).toBe(0); // only one installed
  });

  it('never downgrades: a registry revert keeps the installed (newer) copy', async () => {
    // Install security-audit at the index's 0.9.0, then a local edit bumps the
    // INSTALLED copy's content (simulating a newer local version).
    await installHubSkill(makeEntry('security-audit'), projectDir);
    const target = join(projectDir, '.agents', 'skills', 'security-audit', 'SKILL.md');
    writeFileSync(target, skillMarkdown('security-audit') + '\n# local 1.5.0 edits\n', 'utf-8');

    // Registry index unchanged (0.9.0 < the installed provenance version) →
    // update must report it as current, NOT clobber the local copy.
    const { updated, current, failed } = await updateHubSkills(projectDir);
    expect(updated).toEqual([]);
    expect(current).toContain('security-audit');
    expect(failed).toEqual([]);
    expect(readFileSync(target, 'utf-8')).toContain('local 1.5.0 edits');
  });

  it('reports nothing when no skills are installed', async () => {
    const { updated, current, failed } = await updateHubSkills(projectDir);
    expect(updated).toEqual([]);
    expect(current).toEqual([]);
    expect(failed).toEqual([]);
  });
});

describe('skills-hub — list + helpers', () => {
  it('merges on-disk skills with provenance records', async () => {
    await installHubSkill(makeEntry('release-bumper'), projectDir);
  // A manually placed skill (local origin, no provenance).
  const manual = join(projectDir, '.agents', 'skills', 'handcrafted');
  mkdirSync(manual, { recursive: true });
    writeFileSync(join(manual, 'SKILL.md'), skillMarkdown('handcrafted'), 'utf-8');

    const all = listHubSkills(undefined, projectDir);
    expect(all.map((s) => s.name).sort()).toEqual(['handcrafted', 'release-bumper']);
    const manualEntry = all.find((s) => s.name === 'handcrafted');
    expect(manualEntry!.origin).toBe('local');
    expect(manualEntry!.source).toBe('local');
  });

  it('filters by origin', async () => {
    await installHubSkill(makeEntry('release-bumper'), projectDir);
    const local = listHubSkills('local', projectDir);
    expect(local.map((s) => s.name)).toEqual(['release-bumper']);
  });

  it('validates skill names and resolves entries from the index', async () => {
    expect(isValidSkillName('release-bumper')).toBe(true);
    expect(isValidSkillName('../../etc')).toBe(false);
    expect(isValidSkillName('has space')).toBe(false);
    const entry = await getHubSkillEntry('security-audit');
    expect(entry?.version).toBe('0.9.0');
    expect(await getHubSkillEntry('nope')).toBeNull();
  });

  it('clearSkillsIndexCache forces a re-fetch', async () => {
    await fetchHubIndex();
    clearSkillsIndexCache();
    const skills = await fetchHubIndex();
    expect(skills).toHaveLength(2);
  });
});
