/**
 * Release runners — the deterministic half of the publish pipeline.
 *
 * The pipeline's phases used to be handed to the LLM orchestrator, so a
 * mechanical release depended on plan quality and provider health: a live 3.3.2
 * attempt planned "add standard-version + write scripts/release.ts" for a goal
 * that says "Bump version (patch)". These tests pin the properties that make
 * the deterministic path trustworthy — the version arithmetic, the changelog
 * rules (a generated entry only when nobody wrote one), the npm error
 * translation, and that `buildPublishPhases` attaches a runner to EVERY phase.
 *
 * Filesystem phases run against a throwaway project in a temp directory.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RELEASE_PHASE_IDS,
  bumpVersionString,
  changelogHeadline,
  changelogSection,
  createReleaseRunners,
  describeNpmError,
  hasChangelogSection,
  runGitPhase,
  runTestsPhase,
  runVersionBumpPhase,
} from '../../src/agents/release-runner.js';
import { buildPublishPhases } from '../../src/cli/publish.js';

// ─── Version arithmetic ─────────────────────────────────────────────────────

describe('release-runner — version arithmetic', () => {
  it('bumps each part and rolls the lower ones over', () => {
    expect(bumpVersionString('3.3.1', 'patch')).toBe('3.3.2');
    expect(bumpVersionString('3.3.1', 'minor')).toBe('3.4.0');
    expect(bumpVersionString('3.3.1', 'major')).toBe('4.0.0');
  });

  it('rolls a 9 over instead of concatenating digits', () => {
    expect(bumpVersionString('1.2.9', 'patch')).toBe('1.2.10');
  });

  it('tolerates a short or malformed version', () => {
    expect(bumpVersionString('2', 'patch')).toBe('2.0.1');
    expect(bumpVersionString('1.4', 'minor')).toBe('1.5.0');
  });
});

// ─── Changelog rules ────────────────────────────────────────────────────────

const CHANGELOG = [
  '# Changelog',
  '',
  '## v3.3.1 — the permission model attaches to the intent',
  '',
  'Prose about the release.',
  '',
  '## v3.3.0 — older release',
  '',
  'Old prose.',
  '',
].join('\n');

describe('release-runner — changelog helpers', () => {
  it('finds a section for the exact version only', () => {
    expect(hasChangelogSection('3.3.1', CHANGELOG)).toBe(true);
    expect(hasChangelogSection('3.3.2', CHANGELOG)).toBe(false);
    // '3.3' must not match the '3.3.1' heading.
    expect(hasChangelogSection('3.3', CHANGELOG)).toBe(false);
  });

  it('extracts the headline, which becomes the commit subject', () => {
    expect(changelogHeadline('3.3.1', CHANGELOG)).toBe('the permission model attaches to the intent');
    expect(changelogHeadline('3.3.2', CHANGELOG)).toBe('');
  });

  it('extracts exactly one section, stopping at the next heading', () => {
    const section = changelogSection('3.3.1', CHANGELOG);
    expect(section).toContain('## v3.3.1');
    expect(section).toContain('Prose about the release.');
    expect(section).not.toContain('older release');
  });

  it('survives an empty changelog', () => {
    expect(hasChangelogSection('1.0.0', '')).toBe(false);
    expect(changelogSection('1.0.0', '')).toBe('');
  });
});

// ─── npm error translation ──────────────────────────────────────────────────

describe('release-runner — npm error translation', () => {
  it('names the fix for auth failures rather than dumping the log', () => {
    expect(describeNpmError('npm ERR! code ENEEDAUTH')).toContain('NPM_TOKEN');
    expect(describeNpmError('npm ERR! 403 Forbidden')).toContain('token');
    expect(describeNpmError('cannot publish over previously published version')).toContain('bump');
  });
});

// ─── Runner table ───────────────────────────────────────────────────────────

describe('release-runner — runner table', () => {
  it('has a runner for every published phase id', () => {
    const runners = createReleaseRunners('patch');
    for (const id of Object.values(RELEASE_PHASE_IDS)) {
      expect(typeof runners[id], id).toBe('function');
    }
  });

  it('attaches a runner to every phase buildPublishPhases produces', () => {
    const phases = buildPublishPhases(
      'patch',
      false,
      { git: { token: 'ghp_x' }, npm: { token: 'npm_x' } },
    );
    expect(phases.length).toBeGreaterThanOrEqual(5);
    for (const phase of phases) {
      expect(phase.runner, phase.id).toBeDefined();
    }
  });

  it('builds only the phases the credentials allow', () => {
    // A GitHub token picked up from the environment would add phase 5; this
    // case is about what the CREDENTIALS decide, so the env is pinned empty.
    vi.stubEnv('GITHUB_API_KEY', '');
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    const phases = buildPublishPhases('patch', true, { git: {}, npm: {} });
    vi.unstubAllEnvs();
    expect(phases.map((p) => p.id)).toEqual([RELEASE_PHASE_IDS.version]);
    expect(typeof phases[0].runner).toBe('function');
  });
});

// ─── Filesystem phases (throwaway project) ──────────────────────────────────

let project: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  project = mkdtempSync(join(tmpdir(), 'nuvira-release-test-'));
  process.chdir(project);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(project, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeProject(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(project, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(project, name), 'utf-8')) as Record<string, unknown>;
}

describe('release-runner — version bump phase', () => {
  it('bumps the manifest, syncs the lockfile version, and writes a changelog entry', async () => {
    writeProject({
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', scripts: {} }, null, 2) + '\n',
      'package-lock.json': JSON.stringify({ name: 'demo', version: '1.0.0', packages: { '': { version: '1.0.0' } } }, null, 2) + '\n',
      'CHANGELOG.md': '# Changelog\n\n## v1.0.0 — first\n\nProse.\n',
    });

    const result = await runVersionBumpPhase('patch');

    expect(result.success).toBe(true);
    expect(result.summary).toContain('1.0.0 -> 1.0.1');
    expect(readJson('package.json').version).toBe('1.0.1');
    const lock = readJson('package-lock.json') as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe('1.0.1');
    expect(lock.packages[''].version).toBe('1.0.1');

    const changelog = readFileSync(join(project, 'CHANGELOG.md'), 'utf-8');
    expect(changelog.startsWith('# Changelog')).toBe(true);
    expect(changelog).toContain('## v1.0.1 — released ');
    // The older, hand-written section is still there.
    expect(changelog).toContain('## v1.0.0 — first');
  });

  it('leaves an author-written entry for the new version alone', async () => {
    const authored = '# Changelog\n\n## v1.0.1 — a headline a human wrote\n\nThe prose.\n';
    writeProject({
      'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n',
      'CHANGELOG.md': authored,
    });

    const result = await runVersionBumpPhase('patch');

    expect(result.success).toBe(true);
    expect(result.summary).toContain('kept the existing entry');
    expect(readFileSync(join(project, 'CHANGELOG.md'), 'utf-8')).toBe(authored);
  });

  it('fails clearly without a manifest', async () => {
    const result = await runVersionBumpPhase('patch');
    expect(result.success).toBe(false);
    expect(result.summary).toContain('package.json');
  });

  // The 3.3.2 release is where this earned its place: the bump was committed and
  // pushed, then `prepublishOnly`'s test run failed on the staleness guard
  // ("cast records v3.3.1 but package.json is v3.3.2") and the publish could not
  // finish. Version-pinned artifacts have to move in the SAME commit.
  it('runs the project hook that regenerates version-pinned artifacts', async () => {
    writeProject({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        scripts: { 'release:artifacts': 'node -e "require(\'fs\').writeFileSync(\'artifact.txt\',\'ok\')"' },
      }, null, 2) + '\n',
    });

    const result = await runVersionBumpPhase('patch');

    expect(result.success).toBe(true);
    expect(result.summary).toContain('version-pinned artifacts regenerated');
    expect(readFileSync(join(project, 'artifact.txt'), 'utf-8')).toBe('ok');
  });

  it('skips the hook cleanly when the project declares none', async () => {
    writeProject({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n' });
    const result = await runVersionBumpPhase('patch');
    expect(result.success).toBe(true);
    expect(result.summary).toContain('no release:artifacts hook');
  });

  it('fails the bump when the hook fails, rather than committing a stale version', async () => {
    writeProject({
      'package.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        scripts: { 'release:artifacts': 'node -e "process.exit(3)"' },
      }, null, 2) + '\n',
    });

    const result = await runVersionBumpPhase('patch');

    expect(result.success).toBe(false);
    expect(result.summary).toContain('version-pinned artifacts');
  });
});

describe('release-runner — tests phase', () => {
  it('is a no-op success when the project has no test script', async () => {
    writeProject({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n' });
    const result = await runTestsPhase();
    expect(result.success).toBe(true);
    expect(result.summary).toContain('No test script');
  });
});

describe('release-runner — git phase', () => {
  it('refuses to fake a release when there is no remote', async () => {
    writeProject({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.1' }, null, 2) + '\n' });
    execSync('git init -q', { cwd: project });

    const result = await runGitPhase();

    expect(result.success).toBe(false);
    expect(result.summary).toContain('No git remote');
    // Nothing was tagged on the way to failing.
    const tags = execSync('git tag -l', { cwd: project, encoding: 'utf-8' }).trim();
    expect(tags).toBe('');
  });

  it('reports a missing version instead of tagging "v"', async () => {
    writeProject({ 'package.json': JSON.stringify({ name: 'demo' }, null, 2) + '\n' });
    const result = await runGitPhase();
    expect(result.success).toBe(false);
    expect(result.summary).toContain('without a version');
  });

  it('refuses to tag a release that stages a NESTED dependency manifest', async () => {
    // The root-manifest guard (dependencyDelta) only reads ./package.json, and
    // `git add -A` would carry a sub-package's manifest into the tag unseen.
    // Same supply-chain rule, one level down (issue #14).
    writeProject({ 'package.json': JSON.stringify({ name: 'demo', version: '1.0.1' }, null, 2) + '\n' });
    execSync('git init -q', { cwd: project });
    execSync('git config user.email t@t', { cwd: project });
    execSync('git config user.name t', { cwd: project });
    execSync('git add -A && git commit -qm init', { cwd: project, shell: '/bin/bash' });
    execSync('git remote add origin https://example.invalid/demo.git', { cwd: project });

    writeProject({ 'packages/web/package.json': JSON.stringify({ name: 'web', version: '1.0.0' }, null, 2) + '\n' });

    const result = await runGitPhase();

    expect(result.success).toBe(false);
    expect(result.summary).toContain('nested dependency manifest');
    expect(result.error).toContain('packages/web/package.json');
    // Nothing was tagged on the way to refusing.
    expect(execSync('git tag -l', { cwd: project, encoding: 'utf-8' }).trim()).toBe('');
  });

  it('stages, commits, tags and pushes — and NAMES what it staged', async () => {
    // The live incident was one `git add -A` from committing two undeclared
    // packages, and "21 files changed" said nothing about them. The success path
    // therefore reports the staged paths, not only a count.
    const remoteDir = mkdtempSync(join(tmpdir(), 'nuvira-release-remote-'));
    try {
      execSync('git init -q --bare', { cwd: remoteDir });
      writeProject({
        'package.json': JSON.stringify({ name: 'demo', version: '1.0.1' }, null, 2) + '\n',
        'CHANGELOG.md': '# Changelog\n\n## v1.0.1 — a headline a human wrote\n\nProse.\n',
      });
      execSync('git init -q', { cwd: project });
      execSync('git config user.email t@t', { cwd: project });
      execSync('git config user.name t', { cwd: project });
      execSync('git add -A && git commit -qm init', { cwd: project, shell: '/bin/bash' });
      execSync(`git remote add origin "${remoteDir}"`, { cwd: project });

      writeProject({ 'src/new-file.ts': 'export const x = 1;\n' });

      const result = await runGitPhase();

      expect(result.success).toBe(true);
      expect(result.summary).toContain('tagged v1.0.1');
      expect(result.summary).toContain('staging');
      expect(result.summary).toContain('src/new-file.ts');
      expect(execSync('git tag -l', { cwd: project, encoding: 'utf-8' }).trim()).toBe('v1.0.1');
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});

// ─── Guard: the real repo is never touched by these tests ───────────────────

describe('release-runner — test hygiene', () => {
  it('left the working directory where it found it', () => {
    expect(existsSync(join(originalCwd, 'package.json'))).toBe(true);
  });
});
