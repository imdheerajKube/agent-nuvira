/**
 * I7 P1 — Multi-source skill registry tests (`src/learning/skills-registry.ts`).
 *
 * Covers: source-kind detection, unified search across a LOCAL-DIR fixture
 * (no network), git-repo cloning/indexing with a stubbed `git clone`, and
 * install-from-source reusing the sandboxed hub path. Hermetic: temp home
 * (repo cache) + temp registry fixture + temp project.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const homeHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-reg-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => homeHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

// Stub `git clone` (used by the git-repo adapter): "clone" by materializing a
// minimal repo (skills/<name>/SKILL.md + .git) at the cache target.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], _opts?: unknown): Buffer => {
      if (cmd === 'git') {
        const target = String((args as string[]).at(-1));
        const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
        const { join } = require('node:path') as typeof import('node:path');
        mkdirSync(target, { recursive: true });
        mkdirSync(join(target, '.git'), { recursive: true });
        mkdirSync(join(target, 'skills', 'repo-skill'), { recursive: true });
        writeFileSync(
          join(target, 'skills', 'repo-skill', 'SKILL.md'),
          '---\nname: repo-skill\ndescription: repo skill\n---\n\n# repo-skill\n\nSteps.\n',
          'utf-8',
        );
        return Buffer.from('');
      }
      return actual.execFileSync(cmd, args as never, _opts as never);
    },
  };
});

import {
  detectSourceKind,
  configuredRegistries,
  allSources,
  searchAllRegistries,
  findEntryAcrossRegistries,
  installFromSource,
} from '../../src/learning/skills-registry.js';
import { ConfigManager } from '../../src/config/manager.js';
import { readFileSync, existsSync } from 'node:fs';

const INDEX = {
  version: 1,
  updatedAt: '2026-08-12',
  skills: [
    { name: 'release-bumper', description: 'Bump versions and tag a release', version: '1.2.0', author: 'dheeraj', tags: ['release', 'git'], source: 'team/skills', updatedAt: '2026-08-01' },
    { name: 'security-audit', description: 'Audit dependencies for known vulnerabilities', version: '0.9.0', author: 'dheeraj', tags: ['security', 'npm'], source: 'team/skills', updatedAt: '2026-07-20' },
  ],
} as const;

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: fixture skill\n---\n\n# ${name}\n\nSteps.\n`;
}

let registryDir = '';
let projectDir = '';
let configDir = '';
const realRegistry = process.env.BUFF_SKILLS_REGISTRY;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), 'buff-reg-reg-'));
  projectDir = mkdtempSync(join(tmpdir(), 'buff-reg-proj-'));
  configDir = mkdtempSync(join(tmpdir(), 'buff-reg-cfg-'));
  writeFileSync(join(registryDir, 'index.json'), JSON.stringify(INDEX), 'utf-8');
  for (const s of INDEX.skills) {
    const dir = join(registryDir, s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillMd(s.name), 'utf-8');
  }
  rmSync(join(homeHolder.value, '.buff', 'skills-hub'), { recursive: true, force: true });
  process.env.BUFF_SKILLS_REGISTRY = `file://${registryDir}`;
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  if (realRegistry === undefined) delete process.env.BUFF_SKILLS_REGISTRY;
  else process.env.BUFF_SKILLS_REGISTRY = realRegistry;
  vi.restoreAllMocks();
});

describe('source detection + config', () => {
  it('detects the source kind from a base string', () => {
    expect(detectSourceKind('https://raw.githubusercontent.com/x/y/main/skills')).toBe('github-raw');
    expect(detectSourceKind('https://browse.sh/api/skills')).toBe('browse-sh');
    expect(detectSourceKind('git+https://github.com/x/skills')).toBe('git-repo');
    expect(detectSourceKind(`file://${registryDir}`)).toBe('local-dir');
  });

  it('buffconfig skills.registries wins over the env override', () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { registries: ['git+https://github.com/acme/skills', `file://${registryDir}`] } });
    expect(configuredRegistries(cm)).toEqual(['git+https://github.com/acme/skills', `file://${registryDir}`]);
    expect(allSources(cm).map((s) => s.kind)).toEqual(['git-repo', 'local-dir']);
  });
});

describe('unified search (local-dir fixture, no network)', () => {
  it('searches across configured registries with source tags', async () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { registries: [`file://${registryDir}`] } });

    const results = await searchAllRegistries('release', { cm });
    expect(results.map((r) => r.name)).toEqual(['release-bumper']);
    expect(results[0].sourceKind).toBe('local-dir');
  });

  it('respects --source kind filtering', async () => {
    const results = await searchAllRegistries('release', { sourceKind: 'git-repo' });
    expect(results).toEqual([]);
  });
});

describe('git-repo adapter (stubbed clone)', () => {
  it('indexes a cloned repo and fetches a skill from it', async () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { registries: ['git+https://github.com/acme/skills'] } });

    const found = await findEntryAcrossRegistries('repo-skill', { cm });
    expect(found).not.toBeNull();
    expect(found!.source.kind).toBe('git-repo');
    expect(found!.value.name).toBe('repo-skill');

    // Install from the git-repo source → lands in the project .agents/skills.
    const result = await installFromSource(found!.value, found!.source, projectDir);
    expect(result.ok).toBe(true);
    const installed = join(projectDir, '.agents', 'skills', 'repo-skill', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, 'utf-8')).toContain('# repo-skill');
  });
});

describe('install from a local-dir source', () => {
  it('installs using the source fetch + provenance', async () => {
    const found = await findEntryAcrossRegistries('security-audit');
    expect(found).not.toBeNull();

    const result = await installFromSource(found!.value, found!.source, projectDir);
    expect(result.ok).toBe(true);
    expect(result.version).toBe('0.9.0');
    expect(existsSync(join(projectDir, '.agents', 'skills', 'security-audit', 'SKILL.md'))).toBe(true);
  });
});
