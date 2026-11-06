/**
 * Pinned skills (`src/learning/skill-pin.ts`).
 *
 * A pin is the USER naming a skill. These tests hold the two properties that
 * make it worth having: the name resolves through the same resolver the `skill`
 * tool uses (so a pin and a load cannot disagree), and an unknown or disabled
 * name is REPORTED rather than silently becoming a load or being dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPinnedSkillsBlock,
  buildPinnedSkillsForTurn,
  describePinnedResolution,
  parsePinnedSkillNames,
  resolvePinnedSkills,
} from '../../src/learning/skill-pin.js';
import { evaluateObligations } from '../../src/learning/skill-obligations.js';
import { resetSkillStore } from '../../src/learning/skill-store.js';

function skillMd(name: string, description: string, body: string, extraFrontmatter = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n${body}\n`;
}

let projectDir = '';
let homeDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'buff-pin-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'buff-pin-home-'));
  mkdirSync(join(projectDir, '.agents', 'skills', 'pin-test-deploy'), { recursive: true });
  writeFileSync(
    join(projectDir, '.agents', 'skills', 'pin-test-deploy', 'SKILL.md'),
    skillMd(
      'pin-test-deploy',
      'Publish a static site to the pin-test host',
      '# Deploy\n\nRun the deploy script, then verify the URL answers 200.',
      'obligations:\n  must_run: [scripts/deploy.sh]\n',
    ),
    'utf-8',
  );
  mkdirSync(join(projectDir, '.agents', 'skills', 'pin-test-deploy', 'scripts'), { recursive: true });
  writeFileSync(join(projectDir, '.agents', 'skills', 'pin-test-deploy', 'scripts', 'deploy.sh'), 'echo deploy\n', 'utf-8');
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('parsePinnedSkillNames', () => {
  it('accepts the shapes the surfaces produce — array, comma, or space separated', () => {
    expect(parsePinnedSkillNames(['api-design', 'api-testing'])).toEqual(['api-design', 'api-testing']);
    expect(parsePinnedSkillNames('api-design, api-testing')).toEqual(['api-design', 'api-testing']);
    expect(parsePinnedSkillNames('api-design api-testing')).toEqual(['api-design', 'api-testing']);
  });

  it('lowercases, dedupes, and drops anything that is not a skill id', () => {
    expect(parsePinnedSkillNames(['API-Design', 'api-design', '../etc/passwd', '', 'a/b'])).toEqual(['api-design']);
  });

  it('treats absence as no pins', () => {
    expect(parsePinnedSkillNames(undefined)).toEqual([]);
    expect(parsePinnedSkillNames(null)).toEqual([]);
    expect(parsePinnedSkillNames(42)).toEqual([]);
  });
});

describe('resolvePinnedSkills', () => {
  it('resolves an installed skill against the TURN workspace, with its methodology + obligations', async () => {
    const r = await resolvePinnedSkills(['pin-test-deploy'], { cwd: projectDir, home: homeDir });
    expect(r.unknown).toEqual([]);
    expect(r.disabled).toEqual([]);
    expect(r.pins).toHaveLength(1);
    const pin = r.pins[0]!;
    expect(pin.name).toBe('pin-test-deploy');
    expect(pin.methodology).toContain('Run the deploy script');
    expect(pin.dir).toContain(join('.agents', 'skills', 'pin-test-deploy'));
    expect(pin.files).toEqual(expect.arrayContaining(['SKILL.md']));
    expect(pin.obligations?.mustRun).toEqual(['scripts/deploy.sh']);
  });

  it('reports an unknown name instead of inventing a load', async () => {
    const r = await resolvePinnedSkills(['pin-test-nonexistent'], { cwd: projectDir, home: homeDir });
    expect(r.pins).toEqual([]);
    expect(r.unknown).toEqual(['pin-test-nonexistent']);
  });

  it('reports a disabled name instead of loading it (the gate is not a pin-able shortcut)', async () => {
    const r = await resolvePinnedSkills(['pin-test-deploy'], {
      cwd: projectDir,
      home: homeDir,
      disabled: ['pin-test-deploy'],
    });
    expect(r.pins).toEqual([]);
    expect(r.disabled).toEqual(['pin-test-deploy']);
  });

  it('does not pin from the developer machine when a workspace is given', async () => {
    // A name that exists only in this temp project must not resolve from
    // `~/.nuvira/skills` (or the repo's own `.agents/skills`).
    const r = await resolvePinnedSkills(['pin-test-deploy'], { cwd: homeDir, home: homeDir });
    expect(r.pins).toEqual([]);
  });
});

describe('buildPinnedSkillsBlock', () => {
  it('says the skill is an instruction, carries the methodology, and names its obligations', async () => {
    const { pins } = await resolvePinnedSkills(['pin-test-deploy'], { cwd: projectDir, home: homeDir });
    const block = buildPinnedSkillsBlock(pins);
    expect(block).toContain('PINNED by the user');
    expect(block).toContain('instruction, not a suggestion');
    expect(block).toContain('do not force');
    expect(block).toContain('would not add value');
    expect(block).toContain('Run the deploy script');
    expect(block).toContain('must run: scripts/deploy.sh');
    expect(block).toContain('Skill root:');
  });

  it('is empty when nothing was pinned — no pin means the turn is unchanged', () => {
    expect(buildPinnedSkillsBlock([])).toBe('');
  });

  it('caps a hostile oversized methodology so one skill cannot own the prompt', () => {
    const block = buildPinnedSkillsBlock([
      {
        id: 'huge',
        name: 'huge',
        description: 'huge',
        methodology: 'x'.repeat(200_000),
      },
    ]);
    expect(block.length).toBeLessThan(30_000);
    expect(block).toContain('### huge');
  });
});

describe('buildPinnedSkillsForTurn', () => {
  it('loads the pin into the obligation ledger, exactly as the skill tool would', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'buff-pin-mem-'));
    const backup = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = memDir;
    resetSkillStore();
    try {
      const r = await buildPinnedSkillsForTurn(['pin-test-deploy'], { cwd: projectDir, home: homeDir });
      expect(r.block).toContain('pin-test-deploy');
      // The evidence store is the same one the finish gate reads: a pinned skill
      // must be visible to the obligation report, not just to the prompt.
      const report = evaluateObligations();
      expect(report.skills).toContain('pin-test-deploy');
      expect(report.unmet.join(' ')).toContain('scripts/deploy.sh');
    } finally {
      if (backup === undefined) delete process.env.NUVIRA_MEMORY_DIR;
      else process.env.NUVIRA_MEMORY_DIR = backup;
      resetSkillStore();
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it('describes what happened, so a surface can say it out loud', async () => {
    const r = await resolvePinnedSkills(['pin-test-deploy', 'nope-not-here'], { cwd: projectDir, home: homeDir });
    const line = describePinnedResolution(r);
    expect(line).toContain('pinned pin-test-deploy');
    expect(line).toContain('not found nope-not-here');
  });
});
