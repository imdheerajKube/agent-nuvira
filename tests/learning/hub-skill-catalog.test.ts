/**
 * I7 P0 — Hub skill catalog tests (`src/learning/hub-skill-catalog.ts`).
 *
 * The catalog scans `<project>/.agents/skills/<name>/SKILL.md` (hub install
 * target) and `~/.nuvira/skills/<name>/SKILL.md` (user-level), filters
 * `skills.disabled[]`, and matches goals for the orchestrator's guidance
 * injection. All tests are hermetic: temp project + temp home.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readHubCatalog,
  readDisabledSkills,
  listMatchableHubSkills,
  findHubSkillMatch,
  parseCatalogFrontmatter,
  setSkillEnabled,
  platformAllows,
  toolsetAllows,
  normalizePlatform,
} from '../../src/learning/hub-skill-catalog.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetSkillStore } from '../../src/learning/skill-store.js';

function skillMd(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${extra}Methodology steps for ${name}.\n`;
}

let projectDir = '';
let homeDir = '';
let configDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'buff-cat-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'buff-cat-home-'));
  configDir = mkdtempSync(join(tmpdir(), 'buff-cat-cfg-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('parseCatalogFrontmatter', () => {
  it('extracts name + description, stripping quotes', () => {
    const fm = parseCatalogFrontmatter('---\nname: my-skill\ndescription: "Deploy things"\n---\nbody');
    expect(fm).toEqual({ name: 'my-skill', description: 'Deploy things' });
  });

  it('returns empty for a file with no frontmatter', () => {
    expect(parseCatalogFrontmatter('no frontmatter here')).toEqual({});
  });

  it('P6c — parses inline arrays (platforms, env vars)', () => {
    const fm = parseCatalogFrontmatter(
      '---\nname: mac-tool\nplatforms: [macos, linux]\nrequired_environment_variables: [API_KEY, REGION]\n---\nbody',
    );
    expect(fm.platforms).toEqual(['macos', 'linux']);
    expect(fm.requiredEnvVars).toEqual(['API_KEY', 'REGION']);
  });

  it('P6c — parses block lists (requires_toolsets, fallback_for_toolsets)', () => {
    const fm = parseCatalogFrontmatter(
      '---\nname: terminal-helper\nrequires_toolsets:\n  - coding\n  - terminal\nfallback_for_toolsets:\n  - web\n---\nbody',
    );
    expect(fm.requiresToolsets).toEqual(['coding', 'terminal']);
    expect(fm.fallbackForToolsets).toEqual(['web']);
  });

  it('P6c — parses the config map (key: value lines)', () => {
    const fm = parseCatalogFrontmatter(
      '---\nname: cfg-skill\nconfig:\n  log_level: debug\n  retries: "3"\n---\nbody',
    );
    expect(fm.config).toEqual({ log_level: 'debug', retries: '3' });
  });
});

describe('P6c — frontmatter depth gates', () => {
  const skillWith = (extra: string) => ({
    id: 'x',
    name: 'x',
    description: 'x',
    body: 'x',
    root: 'project' as const,
    ...(extra ? (parseCatalogFrontmatter(`---\n${extra}---\nbody`) as object) : {}),
  });

  it('platformAllows: undeclared → everywhere; declared → normalized match', () => {
    const any = skillWith('');
    expect(platformAllows(any, 'darwin')).toBe(true);
    expect(platformAllows(any, 'win32')).toBe(true);

    const macOnly = { ...skillWith('platforms: [macos, linux]\n') } as ReturnType<typeof skillWith> & { platforms: string[] };
    expect(platformAllows(macOnly, 'darwin')).toBe(true); // darwin ≡ macos
    expect(platformAllows(macOnly, 'win32')).toBe(false); // windows hidden

    const winOnly = { ...skillWith('platforms: [windows]\n') } as ReturnType<typeof skillWith> & { platforms: string[] };
    expect(platformAllows(winOnly, 'win32')).toBe(true); // win32 ≡ windows
    expect(platformAllows(winOnly, 'darwin')).toBe(false);
  });

  it('toolsetAllows: requires_toolsets needs every named toolset present', () => {
    const needsCoding = { ...skillWith('requires_toolsets:\n  - coding\n') } as ReturnType<typeof skillWith> & { requiresToolsets: string[] };
    expect(toolsetAllows(needsCoding, new Set(['coding', 'web']))).toBe(true);
    expect(toolsetAllows(needsCoding, new Set(['web']))).toBe(false);
    // Default (no set) = all catalog toolsets present.
    expect(toolsetAllows(needsCoding)).toBe(true);
  });

  it('toolsetAllows: fallback_for_toolsets visible ONLY when the toolset is absent', () => {
    const fallback = { ...skillWith('fallback_for_toolsets:\n  - web\n') } as ReturnType<typeof skillWith> & { fallbackForToolsets: string[] };
    expect(toolsetAllows(fallback, new Set(['coding']))).toBe(true); // web absent → fallback active
    expect(toolsetAllows(fallback, new Set(['web']))).toBe(false); // web present → fallback hidden
  });

  it('normalizePlatform maps darwin→macos and win32→windows', () => {
    expect(normalizePlatform('darwin')).toBe('macos');
    expect(normalizePlatform('win32')).toBe('windows');
    expect(normalizePlatform('linux')).toBe('linux');
  });

  it('listMatchableHubSkills hides a macos-only skill on win32', () => {
    const dir = join(projectDir, '.agents', 'skills', 'mac-tool');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: mac-tool\nplatforms: [macos]\n---\n# body\n', 'utf-8');

    expect(listMatchableHubSkills(undefined, projectDir, homeDir, 'darwin')).toHaveLength(1);
    expect(listMatchableHubSkills(undefined, projectDir, homeDir, 'win32')).toHaveLength(0);
  });

  it('listMatchableHubSkills applies the toolset gate with an explicit present set', () => {
    const dir = join(projectDir, '.agents', 'skills', 'term-helper');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: term-helper\nrequires_toolsets:\n  - coding\n---\n# body\n', 'utf-8');

    expect(listMatchableHubSkills(undefined, projectDir, homeDir, 'linux', new Set(['coding']))).toHaveLength(1);
    expect(listMatchableHubSkills(undefined, projectDir, homeDir, 'linux', new Set(['web']))).toHaveLength(0);
  });

  it('readHubCatalog carries the depth fields (parser → catalog, no loss)', () => {
    const dir = join(projectDir, '.agents', 'skills', 'env-heavy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: env-heavy\nplatforms: [linux]\nrequired_environment_variables: [DB_URL, API_TOKEN]\nconfig:\n  log_level: debug\n---\n# body\n',
      'utf-8',
    );
    const skill = readHubCatalog(projectDir, homeDir)[0];
    expect(skill.platforms).toEqual(['linux']);
    expect(skill.requiredEnvVars).toEqual(['DB_URL', 'API_TOKEN']);
    expect(skill.config).toEqual({ log_level: 'debug' });
  });
});

describe('readHubCatalog', () => {
  it('scans the project .agents/skills root', () => {
    const dir = join(projectDir, '.agents', 'skills', 'deployer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd('deployer', 'Deploy to cloudflare'), 'utf-8');

    const skills = readHubCatalog(projectDir, homeDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: 'deployer', name: 'deployer', root: 'project' });
    expect(skills[0].body).toContain('Methodology steps for deployer');
  });

  it('scans the home ~/.nuvira/skills root', () => {
    const dir = join(homeDir, '.nuvira', 'skills', 'auditor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd('auditor', 'Audit dependencies'), 'utf-8');

    const skills = readHubCatalog(projectDir, homeDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: 'auditor', root: 'home' });
  });

  it('project root wins over home on name collision', () => {
    for (const root of [join(projectDir, '.agents', 'skills', 'dupe'), join(homeDir, '.nuvira', 'skills', 'dupe')]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), skillMd('dupe', 'same skill'), 'utf-8');
    }
    const skills = readHubCatalog(projectDir, homeDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].root).toBe('project');
  });

  it('ignores dirs whose names are not sandbox-safe (no traversal)', () => {
    const evil = join(projectDir, '.agents', 'skills', '..', '..', 'evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'SKILL.md'), skillMd('evil', 'should not be read'), 'utf-8');

    expect(readHubCatalog(projectDir, homeDir)).toEqual([]);
  });
});

describe('disabled filtering + matching', () => {
  it('excludes skills listed in skills.disabled', () => {
    const dir = join(projectDir, '.agents', 'skills', 'deployer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd('deployer', 'Deploy to cloudflare'), 'utf-8');

    // No config → matchable.
    expect(listMatchableHubSkills(undefined, projectDir, homeDir)).toHaveLength(1);

    // Config with the skill disabled → excluded.
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { disabled: ['deployer'] } });
    expect(listMatchableHubSkills(cm, projectDir, homeDir)).toHaveLength(0);
    expect(readDisabledSkills(cm)).toEqual(['deployer']);
  });

  it('findHubSkillMatch scores by goal keywords and returns the SKILL.md body', () => {
    mkdirSync(join(projectDir, '.agents', 'skills', 'website-deploy'), { recursive: true });
    writeFileSync(
      join(projectDir, '.agents', 'skills', 'website-deploy', 'SKILL.md'),
      skillMd('website-deploy', 'Publish a static website to cloudflare pages'),
      'utf-8',
    );

    const match = findHubSkillMatch('publish my website to cloudflare', undefined, projectDir, homeDir);
    expect(match).not.toBeNull();
    expect(match!.id).toBe('website-deploy');
    expect(match!.body).toContain('Methodology steps');
  });

  it('returns null when nothing scores and when the match is disabled', () => {
    expect(findHubSkillMatch('unrelated goal about databases', undefined, projectDir, homeDir)).toBeNull();

    mkdirSync(join(projectDir, '.agents', 'skills', 'website-deploy'), { recursive: true });
    writeFileSync(
      join(projectDir, '.agents', 'skills', 'website-deploy', 'SKILL.md'),
      skillMd('website-deploy', 'Publish a static website to cloudflare pages'),
      'utf-8',
    );
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { disabled: ['website-deploy'] } });
    expect(findHubSkillMatch('publish my website to cloudflare', cm, projectDir, homeDir)).toBeNull();
  });
});

describe('setSkillEnabled (P3 — Agent Hub Skills toggle writer)', () => {
  // knownSkillIds() also consults the compiled SkillStore singleton, so pin
  // BUFF_MEMORY_DIR to a temp dir + reset the singleton — otherwise the test
  // would construct the store against the developer's real ~/.nuvira.
  let memDir = '';
  const envBackup: Record<string, string | undefined> = {};
  beforeEach(() => {
    envBackup.NUVIRA_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;
    memDir = mkdtempSync(join(tmpdir(), 'buff-cat-mem-'));
    process.env.NUVIRA_MEMORY_DIR = memDir;
    resetSkillStore();
  });
  afterEach(() => {
    if (envBackup.NUVIRA_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = envBackup.NUVIRA_MEMORY_DIR;
    rmSync(memDir, { recursive: true, force: true });
  });

  const installWebsiteDeploy = () => {
    mkdirSync(join(projectDir, '.agents', 'skills', 'website-deploy'), { recursive: true });
    writeFileSync(
      join(projectDir, '.agents', 'skills', 'website-deploy', 'SKILL.md'),
      skillMd('website-deploy', 'Publish a static website to cloudflare pages'),
      'utf-8',
    );
  };

  it('disables a known skill (disabled list grows) and re-enables it (shrinks) — other entries survive', () => {
    installWebsiteDeploy();
    const cm = new ConfigManager(configDir);
    // Pre-existing entry must never be clobbered by a toggle of another skill.
    cm.save({ skills: { disabled: ['release-bumper'] } });

    setSkillEnabled('website-deploy', false, cm, projectDir, homeDir);
    expect(readDisabledSkills(cm)).toEqual(['release-bumper', 'website-deploy']);
    // The match gate honors the toggle immediately (no recompile, no restart).
    expect(findHubSkillMatch('publish my website to cloudflare', cm, projectDir, homeDir)).toBeNull();

    setSkillEnabled('website-deploy', true, cm, projectDir, homeDir);
    expect(readDisabledSkills(cm)).toEqual(['release-bumper']);
    expect(findHubSkillMatch('publish my website to cloudflare', cm, projectDir, homeDir)).not.toBeNull();
  });

  it('throws for an unknown skill id (typo-safe, mirrors setToolsetEnabled)', () => {
    const cm = new ConfigManager(configDir);
    expect(() => setSkillEnabled('does-not-exist', false, cm, projectDir, homeDir)).toThrow(/Unknown skill/);
  });
});
