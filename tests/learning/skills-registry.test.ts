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
        // Repos whose URL contains `missing-repo` fail to clone (clone-failed probe path).
        if (String(args).includes('missing-repo')) {
          throw new Error('fatal: repository not found');
        }
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
  probeRegistries,
  unreachableRegistryHint,
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
const realRegistry = process.env.NUVIRA_SKILLS_REGISTRY;

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
  rmSync(join(homeHolder.value, '.nuvira', 'skills-hub'), { recursive: true, force: true });
  process.env.NUVIRA_SKILLS_REGISTRY = `file://${registryDir}`;
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  if (realRegistry === undefined) delete process.env.NUVIRA_SKILLS_REGISTRY;
  else process.env.NUVIRA_SKILLS_REGISTRY = realRegistry;
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

  it('P5c #3 — the default resolves to the PACKAGED .agents/skills dir (private-repo-independent)', () => {
    // No config, no env override → the built-in default is the packaged
    // `.agents/skills/` dir that ships in the npm package + repo checkout
    // (local-dir), NOT the GitHub raw URL — so the registry resolves without
    // any GitHub access and the repo can stay private.
    const savedEnv = process.env.NUVIRA_SKILLS_REGISTRY;
    delete process.env.NUVIRA_SKILLS_REGISTRY;
    try {
      const registries = configuredRegistries();
      expect(registries).toHaveLength(1);
      expect(registries[0]).toMatch(/^file:\/\//);
      expect(registries[0]).toMatch(/\.agents[/\\]skills/);
      expect(allSources()[0].kind).toBe('local-dir');
      // The packaged dir actually resolves (index.json present) — the exact
      // 404-vs-resolve regression: the default must never silently 404.
      expect(probeRegistries()).resolves.toMatchObject([{ reachable: true }]);
    } finally {
      if (savedEnv === undefined) delete process.env.NUVIRA_SKILLS_REGISTRY;
      else process.env.NUVIRA_SKILLS_REGISTRY = savedEnv;
    }
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

describe('P5c #3 — registry health probe (never silently 404)', () => {
  it('local-dir: reachable with entry count when index.json parses', async () => {
    const probes = await probeRegistries();
    expect(probes).toHaveLength(1);
    expect(probes[0].source.kind).toBe('local-dir');
    expect(probes[0].reachable).toBe(true);
    expect(probes[0].entryCount).toBe(2);
  });

  it('local-dir: unreachable (missing-index) when index.json is absent', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'buff-reg-empty-'));
    try {
      const cm = new ConfigManager(configDir);
      cm.save({ skills: { registries: [`file://${empty}`] } });
      const probes = await probeRegistries(cm);
      expect(probes).toHaveLength(1);
      expect(probes[0].reachable).toBe(false);
      expect(probes[0].reason).toBe('missing-index');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('github-raw: 404 is surfaced with its HTTP status (the default-registry case)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const cm = new ConfigManager(configDir);
      cm.save({ skills: { registries: ['https://raw.githubusercontent.com/acme/nope/main/.agents/skills'] } });
      const probes = await probeRegistries(cm);
      expect(probes).toHaveLength(1);
      expect(probes[0].reachable).toBe(false);
      expect(probes[0].status).toBe(404);
      expect(probes[0].reason).toBe('http-error');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/acme/nope/main/.agents/skills/index.json',
        expect.objectContaining({ signal: expect.anything() }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('github-raw: a 200 index reports reachable with its entry count', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ skills: [{ name: 'a' }, { name: 'b' }] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    try {
      const cm = new ConfigManager(configDir);
      cm.save({ skills: { registries: ['https://raw.githubusercontent.com/acme/ok/main/.agents/skills'] } });
      const probes = await probeRegistries(cm);
      expect(probes[0].reachable).toBe(true);
      expect(probes[0].status).toBe(200);
      expect(probes[0].entryCount).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('git-repo: clone failure is surfaced as clone-failed', async () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { registries: ['git+https://github.com/acme/missing-repo'] } });
    // The git stub throws for URLs containing `missing-repo` → clone fails.
    const probes = await probeRegistries(cm);
    expect(probes[0].source.kind).toBe('git-repo');
    expect(probes[0].reachable).toBe(false);
    expect(probes[0].reason).toBe('clone-failed');
    expect(probes[0].entryCount).toBe(0);
  });

  it('git-repo: a clonable repo reports reachable with its entry count', async () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { registries: ['git+https://github.com/acme/ok-repo'] } });
    const probes = await probeRegistries(cm);
    expect(probes[0].source.kind).toBe('git-repo');
    expect(probes[0].reachable).toBe(true);
    expect(probes[0].entryCount).toBe(1); // the stubbed repo-skill
  });

  it('unreachableRegistryHint names each broken source with status + fix', () => {
    const hint = unreachableRegistryHint([
      {
        source: { kind: 'github-raw', base: 'https://raw.githubusercontent.com/acme/nope/main/.agents/skills' },
        reachable: false,
        status: 404,
        reason: 'http-error',
        entryCount: 0,
      },
    ]);
    expect(hint).toContain('HTTP 404');
    expect(hint).toContain('https://raw.githubusercontent.com/acme/nope/main/.agents/skills');
    expect(hint).toContain('skills.registries[]');
    expect(hint).toContain('NUVIRA_SKILLS_REGISTRY');
    // No broken sources → empty hint (callers fall back to the generic tip).
    expect(
      unreachableRegistryHint([{ source: { kind: 'local-dir', base: '/x' }, reachable: true, entryCount: 2 }]),
    ).toBe('');
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
