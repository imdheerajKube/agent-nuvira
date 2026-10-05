/**
 * Regression test for `src/tools/skills-hub.ts` (SkillsHubManager).
 *
 * The bug: `install()` regenerated SKILL.md from frontmatter only, discarding
 * the body — so an installed skill loaded as an empty shell (name + description,
 * no methodology). These tests pin the fix: the FULL source SKILL.md must be
 * written verbatim, body included.
 *
 * Isolation: the manager resolves its hub dir off `resolveNuviraHome()`, which
 * is `homedir()/.nuvira` — so `node:os` is mocked to a temp home (same pattern
 * as tests/learning/skills-hub.test.ts). A LocalSource keeps this off the
 * network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const homeHolder = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'nuvira-skills-hub-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => homeHolder.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import { SkillsHubManager, LocalSource, resetSkillsHubManager } from '../../src/tools/skills-hub.js';

const BODY = '# merged-pr-guard\n\nSteps to do the thing.\n\n1. Fetch the PR.\n2. Run the guard.\n';

function skillMarkdown(name: string): string {
  return `---\nname: ${name}\nversion: 2.1.0\ndescription: test skill\n---\n\n${BODY}`;
}

let sourceDir = '';
let targetDir = '';

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'nuvira-skills-src-'));
  targetDir = mkdtempSync(join(tmpdir(), 'nuvira-skills-target-'));
  mkdirSync(join(sourceDir, 'merged-pr-guard'), { recursive: true });
  writeFileSync(join(sourceDir, 'merged-pr-guard', 'SKILL.md'), skillMarkdown('merged-pr-guard'), 'utf-8');
  // Fresh hub dir per test (the mocked home is shared across the file).
  rmSync(join(homeHolder.value, '.nuvira', 'skills'), { recursive: true, force: true });
  resetSkillsHubManager();
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
});

describe('SkillsHubManager.install — preserves the SKILL.md body', () => {
  it('writes the full source (frontmatter + body), not just frontmatter', async () => {
    const mgr = new SkillsHubManager();
    mgr.registerSource(new LocalSource(sourceDir));

    const manifest = await mgr.install('local', 'merged-pr-guard', targetDir);

    const installedPath = join(targetDir, manifest.name, 'SKILL.md');
    expect(existsSync(installedPath)).toBe(true);

    const written = readFileSync(installedPath, 'utf-8');
    // The body — the actual methodology — must survive the install.
    expect(written).toContain('# merged-pr-guard');
    expect(written).toContain('Steps to do the thing.');
    expect(written).toContain('1. Fetch the PR.');
    // Frontmatter metadata is still present.
    expect(written).toContain('name: merged-pr-guard');
  });

  it('records a content hash covering the body (so tampering is detectable)', async () => {
    const mgr = new SkillsHubManager();
    mgr.registerSource(new LocalSource(sourceDir));

    const manifest = await mgr.install('local', 'merged-pr-guard', targetDir);
    expect(manifest.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
