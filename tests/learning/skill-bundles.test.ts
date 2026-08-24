/**
 * P6b — Skill bundle tests.
 *
 * Cross-skill composition: a bundle groups N skills under one id so the chat
 * loads several methodologies in ONE turn (Hermes YAML-bundle parity). Two
 * layers:
 *   1. The bundle store (skill-bundles.ts) — create/list/show/delete against
 *      `~/.buff/skill-bundles/<slug>.yaml`, missing members skipped not fatal.
 *   2. The skill tool's bundle action — one call loads every member skill's
 *      methodology; unknown bundles list the catalog.
 *
 * Hermetic: the temp HOME (os.homedir mock) isolates the real ~/.buff, and
 * the store's dir is injectable per call for extra isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testHome = '';
let testProject = '';

const holder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { home: mkdtempSync(join(base, 'buff-bundle-home-')), project: mkdtempSync(join(base, 'buff-bundle-proj-')) };
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
  listBundles,
  getBundle,
  writeBundle,
  deleteBundle,
  parseBundleYaml,
  serializeBundle,
} from '../../src/learning/skill-bundles.js';

/** A temp bundles dir per test — the store's dir param keeps tests isolated. */
function tempBundlesDir(): string {
  const dir = mkdtempSync(join(testHome, 'bundles-'));
  return dir;
}

describe('P6b — skill bundle store', () => {
  beforeEach(() => {
    testHome = holder.home;
    testProject = holder.project;
    resetSkillStore();
  });

  afterEach(() => {
    resetSkillStore();
  });

  it('writeBundle creates a YAML file that round-trips through getBundle', () => {
    const dir = tempBundlesDir();
    const result = writeBundle(
      { slug: 'backend-dev', name: 'Backend Dev', description: 'Full backend workflow', skills: ['code-review', 'tdd', 'pr-workflow'] },
      dir,
    );
    expect(result.ok).toBe(true);

    const bundle = getBundle('backend-dev', dir);
    expect(bundle).not.toBeNull();
    expect(bundle?.name).toBe('Backend Dev');
    expect(bundle?.description).toBe('Full backend workflow');
    expect(bundle?.skills).toEqual(['code-review', 'tdd', 'pr-workflow']);
    // On-disk shape is the strict YAML subset (Hermes ~/.hermes/skill-bundles parity).
    const raw = readFileSync(join(dir, 'backend-dev.yaml'), 'utf-8');
    expect(raw).toContain('name: Backend Dev');
    expect(raw).toContain('skills:');
    expect(raw).toContain('  - code-review');
  });

  it('create → list → show → delete round-trip', () => {
    const dir = tempBundlesDir();
    writeBundle({ slug: 'backend-dev', skills: ['code-review', 'tdd'] }, dir);
    writeBundle({ slug: 'data-pipeline', skills: ['etl', 'schema-check'] }, dir);

    const all = listBundles(dir);
    expect(all.map((b) => b.slug).sort()).toEqual(['backend-dev', 'data-pipeline']);

    const shown = getBundle('data-pipeline', dir);
    expect(shown?.skills).toEqual(['etl', 'schema-check']);

    expect(deleteBundle('data-pipeline', dir)).toBe(true);
    expect(deleteBundle('data-pipeline', dir)).toBe(false); // already gone
    expect(getBundle('data-pipeline', dir)).toBeNull();
    expect(listBundles(dir).map((b) => b.slug)).toEqual(['backend-dev']);
  });

  it('rejects a sandboxed-invalid slug (no traversal, no spaces)', () => {
    const dir = tempBundlesDir();
    expect(writeBundle({ slug: '../evil', skills: ['a'] }, dir).ok).toBe(false);
    expect(writeBundle({ slug: 'has space', skills: ['a'] }, dir).ok).toBe(false);
    expect(writeBundle({ slug: 'ok-slug', skills: [] }, dir).ok).toBe(false); // needs ≥1 member
    expect(listBundles(dir)).toHaveLength(0);
  });

  it('missing member skills are SKIPPED not fatal (Hermes parity)', async () => {
    const store = getSkillStore();
    store.save({
      id: 'skill-s3-upload',
      name: 's3-upload',
      description: 'Upload artifacts to S3.',
      version: '1.0.0',
      goalPattern: 'upload artifacts to s3',
      steps: [{ agentType: 'runner', description: 'Sync the build dir to the bucket.', dependsOn: [] }],
      parameters: [],
      tags: ['upload'],
      sourceTrajectoryIds: ['bundled'],
      qualityScore: 0.9,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    // 'queue-worker' does not exist — the bundle load must still deliver s3-upload.
    // The tool reads the default root (~/.buff/skill-bundles under the mocked home).
    writeBundle({ slug: 'dev', skills: ['s3-upload', 'queue-worker'] }, join(testHome, '.buff', 'skill-bundles'));

    const out = await runSkillTool({ bundle: 'dev' }, { configManager: {} });
    expect(out).toContain('s3-upload');
    expect(out).toContain('Sync the build dir to the bucket.');
    expect(out).toContain('Skipped (not installed): queue-worker');
  });

  it('parseBundleYaml handles quoted values and extra whitespace', () => {
    const parsed = parseBundleYaml('x', [
      'name: "Backend Dev"',
      'description: "Deploy: full workflow"',
      'skills:',
      '  - code-review',
      '  - tdd',
      '',
    ].join('\n'));
    expect(parsed?.name).toBe('Backend Dev');
    expect(parsed?.description).toBe('Deploy: full workflow');
    expect(parsed?.skills).toEqual(['code-review', 'tdd']);
  });

  it('serializeBundle escapes YAML-significant characters in member names', () => {
    const raw = serializeBundle({ slug: 's', name: 'S', description: 'd', skills: ['a:b', '-weird', 'plain'] });
    expect(raw).toContain('  - "a:b"');
    expect(raw).toContain('  - "-weird"');
    expect(raw).toContain('  - plain');
  });
});

describe('P6b — skill tool bundle action', () => {
  beforeEach(() => {
    testHome = holder.home;
    testProject = holder.project;
    resetSkillStore();
    // Bundles persist on disk under the shared mocked home — a fresh dir per
    // test keeps the "no bundles yet" path honest.
    rmSync(join(testHome, '.buff', 'skill-bundles'), { recursive: true, force: true });
  });

  afterEach(() => {
    resetSkillStore();
  });

  /** The tool reads the DEFAULT store root (~/.buff/skill-bundles — the mocked home). */
  function defaultBundlesDir(): string {
    return join(testHome, '.buff', 'skill-bundles');
  }

  it('bundle:list enumerates bundles; bundle:"<slug>" loads every member', async () => {
    const store = getSkillStore();
    store.save({
      id: 'skill-s3-upload',
      name: 's3-upload',
      description: 'Upload artifacts to S3.',
      version: '1.0.0',
      goalPattern: 'upload artifacts to s3',
      steps: [{ agentType: 'runner', description: 'Sync the build dir to the bucket.', dependsOn: [] }],
      parameters: [],
      tags: ['upload'],
      sourceTrajectoryIds: ['bundled'],
      qualityScore: 0.9,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    store.save({
      id: 'skill-schema-check',
      name: 'schema-check',
      description: 'Validate DB schema drift.',
      version: '1.0.0',
      goalPattern: 'validate schema drift',
      steps: [{ agentType: 'reviewer', description: 'Diff the schema against migrations.', dependsOn: [] }],
      parameters: [],
      tags: ['schema'],
      sourceTrajectoryIds: ['bundled'],
      qualityScore: 0.9,
      usageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    writeBundle({ slug: 'backend-dev', name: 'Backend Dev', description: 'Full workflow', skills: ['s3-upload', 'schema-check'] }, defaultBundlesDir());

    const list = await runSkillTool({ bundle: 'list' }, { configManager: {} });
    expect(list).toContain('backend-dev');

    const out = await runSkillTool({ bundle: 'backend-dev' }, { configManager: {} });
    expect(out).toContain('🧩 Bundle: Backend Dev (backend-dev)');
    expect(out).toContain('s3-upload');
    expect(out).toContain('Sync the build dir to the bucket.');
    expect(out).toContain('schema-check');
    expect(out).toContain('Diff the schema against migrations.');
    // Both members marked used.
    expect(store.get('skill-s3-upload')?.usageCount).toBe(1);
    expect(store.get('skill-schema-check')?.usageCount).toBe(1);
  });

  it('unknown bundle lists the available bundle catalog (never errors)', async () => {
    writeBundle({ slug: 'backend-dev', skills: ['s3-upload'] }, defaultBundlesDir());
    const out = await runSkillTool({ bundle: 'nope' }, { configManager: {} });
    expect(out).toContain("Bundle 'nope' not found");
    expect(out).toContain('backend-dev');
  });

  it('no bundles yet → helpful create hint', async () => {
    const out = await runSkillTool({ bundle: 'anything' }, { configManager: {} });
    expect(out).toContain('no bundles exist');
    expect(out).toMatch(/skills bundle create/);
  });

  it('a bundle whose members are all missing reports loadable members = 0', async () => {
    writeBundle({ slug: 'ghost', skills: ['nope-1', 'nope-2'] }, defaultBundlesDir());
    const out = await runSkillTool({ bundle: 'ghost' }, { configManager: {} });
    expect(out).toContain('has no loadable members');
    expect(out).toContain('nope-1, nope-2');
  });
});
