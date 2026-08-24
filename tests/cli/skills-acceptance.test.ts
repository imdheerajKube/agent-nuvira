/**
 * P5c #4 — Acceptance proof: the committed `.agents/skills/` registry works
 * end-to-end through the REAL CLI + the hub catalog (no mocks of the skill
 * machinery — only ora/console silenced and storage pointed at temp dirs).
 *
 * The default registry is the repo's own `.agents/skills/` dir. This test
 * points `BUFF_SKILLS_REGISTRY` at the COMMITTED files (exactly what GitHub
 * will serve after push — same layout, same frontmatter) and proves the
 * three surfaces agree:
 *   1. `buff skills search` finds each of the six bundled skills
 *   2. `buff skills install` lands the real SKILL.md in a project
 *   3. the hub catalog reads that installed skill and matches a goal to it
 *
 * Hermetic: BUFF_CONFIG_DIR → temp (no user registries/config), project +
 * config dirs under tmpdir(), ora + console silenced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BUNDLED_SKILLS } from '../../src/skills/bundled-skills.js';
import { readHubCatalog, findHubSkillMatch } from '../../src/learning/hub-skill-catalog.js';

// ora is the only spinner consumer in the CLI actions under test — silence it.
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMMITTED_REGISTRY = join(REPO_ROOT, '.agents', 'skills');

let configDir = '';
let projectDir = '';
let memoryDir = '';
let origConfigDir: string | undefined;
let origRegistry: string | undefined;
let origMemoryDir: string | undefined;

/** Run the real `buff skills` command, returning captured console + logger output. */
async function runSkills(args: string[]): Promise<string> {
  const { SkillsCommand } = await import('../../src/cli/skills.js');
  const logs: string[] = [];
  const spy = (level: 'log' | 'error' | 'info' | 'warn' | 'success') => (...a: unknown[]) =>
    logs.push(a.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(spy('log'));
  vi.spyOn(console, 'error').mockImplementation(spy('error'));
  const { logger } = await import('../../src/utils/logger.js');
  vi.spyOn(logger, 'info').mockImplementation(spy('info'));
  vi.spyOn(logger, 'warn').mockImplementation(spy('warn'));
  vi.spyOn(logger, 'error').mockImplementation(spy('error'));
  vi.spyOn(logger, 'success').mockImplementation(spy('success'));
  const cmd = new SkillsCommand().create();
  await cmd.parseAsync(['node', 'buff', ...args]);
  return logs.join('\n');
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-acc-cfg-'));
  projectDir = mkdtempSync(join(tmpdir(), 'buff-acc-proj-'));
  memoryDir = mkdtempSync(join(tmpdir(), 'buff-acc-mem-'));
  origConfigDir = process.env.BUFF_CONFIG_DIR;
  origRegistry = process.env.BUFF_SKILLS_REGISTRY;
  origMemoryDir = process.env.BUFF_MEMORY_DIR;
  process.env.BUFF_CONFIG_DIR = configDir; // hermetic — no user config/registries
  process.env.BUFF_SKILLS_REGISTRY = `file://${COMMITTED_REGISTRY}`;
  // Bundle store + drafts honor BUFF_MEMORY_DIR — keep ~/.buff untouched.
  process.env.BUFF_MEMORY_DIR = memoryDir;
});

afterEach(() => {
  process.chdir(REPO_ROOT);
  if (origConfigDir === undefined) delete process.env.BUFF_CONFIG_DIR;
  else process.env.BUFF_CONFIG_DIR = origConfigDir;
  if (origRegistry === undefined) delete process.env.BUFF_SKILLS_REGISTRY;
  else process.env.BUFF_SKILLS_REGISTRY = origRegistry;
  if (origMemoryDir === undefined) delete process.env.BUFF_MEMORY_DIR;
  else process.env.BUFF_MEMORY_DIR = origMemoryDir;
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(memoryDir, { recursive: true, force: true });
});

describe('P5c #4 — committed registry acceptance (search → install → catalog)', () => {
  it('the committed .agents/skills/ exists and lists every bundled skill', () => {
    expect(existsSync(join(COMMITTED_REGISTRY, 'index.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(COMMITTED_REGISTRY, 'index.json'), 'utf-8')) as {
      skills: Array<{ name: string }>;
    };
    expect(index.skills.map((s) => s.name).sort()).toEqual(BUNDLED_SKILLS.map((s) => s.name).sort());
  });

  it('skills search finds each bundled skill by a representative query', async () => {
    for (const skill of BUNDLED_SKILLS) {
      // A 3+ char word from the skill name (the search is substring-based).
      const query = skill.name.replace(/[-]/g, ' ').split(' ').find((w) => w.length > 3) ?? skill.name;
      const out = await runSkills(['search', query]);
      expect(out, `search '${query}' should find ${skill.name}`).toContain(skill.name);
    }
  });

  it('skills install lands the real SKILL.md with valid frontmatter', async () => {
    const out = await runSkills(['install', 'code-assessment', '--project', projectDir]);
    expect(out).toContain('Installed code-assessment');
    const installed = join(projectDir, '.agents', 'skills', 'code-assessment', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);
    const md = readFileSync(installed, 'utf-8');
    // Frontmatter sanity (the install path validates this too).
    expect(md.match(/^name:\s*([^\s]+)\s*$/m)?.[1]).toBe('code-assessment');
    expect(md).toContain('## Steps');
    expect(md).toContain('[context-gatherer]');
  });

  it('the hub catalog agrees: reads the installed skill and matches a goal to it', async () => {
    await runSkills(['install', 'test-strategy', '--project', projectDir]);
    const catalog = readHubCatalog(projectDir);
    const ts = catalog.find((s) => s.id === 'test-strategy');
    expect(ts).toBeTruthy();
    expect(ts!.name).toBe('test-strategy');
    expect(ts!.description).toContain('deep test pass');
    expect(ts!.body).toContain('## Steps');

    // A realistic dashboard-chat goal matches the installed skill.
    const match = findHubSkillMatch('run the tests and check for regressions', undefined, projectDir);
    expect(match).not.toBeNull();
    expect(match!.id).toBe('test-strategy');
  });

  it('an unreachable registry is EXPLICIT: install fails with a source hint, not a silent 404', async () => {
    process.env.BUFF_SKILLS_REGISTRY = 'file:///tmp/definitely-missing-registry';
    const out = await runSkills(['install', 'nope-skill', '--project', projectDir]);
    // The spinner.fail text goes to the mocked ora; the EXPLICIT part is the
    // logger surfaces: search tip + the unreachable-source hint with the fix.
    expect(out).toMatch(/Search available skills: \S+ skills search/);
    expect(out).toContain('missing-index');
    expect(out).toContain('BUFF_SKILLS_REGISTRY');
  });

  it('P6d — skills uninstall removes the dir and the skill is gone', async () => {
    await runSkills(['install', 'test-strategy', '--project', projectDir]);
    const installed = join(projectDir, '.agents', 'skills', 'test-strategy', 'SKILL.md');
    expect(existsSync(installed)).toBe(true);

    const out = await runSkills(['uninstall', 'test-strategy', '--project', projectDir]);
    expect(out).toContain('Uninstalled test-strategy');
    expect(existsSync(join(projectDir, '.agents', 'skills', 'test-strategy'))).toBe(false);
    // A second uninstall reports nothing to remove (no crash).
    const again = await runSkills(['uninstall', 'test-strategy', '--project', projectDir]);
    expect(again).toContain('not installed');
  });

  it('P6b — buff skills bundle create → list → show round-trip (Hermes YAML parity)', async () => {
    const out = await runSkills(['bundle', 'backend-dev', '--create', '--name', 'Backend Dev', '--description', 'Full workflow', '--skills', 'code-assessment,test-strategy']);
    expect(out).toContain("Bundle 'backend-dev' created");
    expect(out).toContain('code-assessment, test-strategy');

    const list = await runSkills(['bundle']);
    expect(list).toContain('backend-dev');
    expect(list).toContain('Backend Dev');

    const show = await runSkills(['bundle', 'backend-dev']);
    expect(show).toContain('code-assessment, test-strategy');

    const del = await runSkills(['bundle', 'backend-dev', '--delete']);
    expect(del).toContain('Deleted bundle');
    expect(await runSkills(['bundle'])).toContain('No bundles yet');
  });
});
