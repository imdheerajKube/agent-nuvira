/**
 * The skill-secret boundary + inventory.
 *
 * What this pins: the dashboard's env-var editor draws a line — provider
 * credentials are shown but not editable, and platform credentials are not its
 * business. Before this, that line was drawn only in React: the write endpoint
 * accepted ANY `[A-Z][A-Z0-9_]+` key, so a "blocked" row could be saved through
 * the API, and nothing ever produced the row list the panel expected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('skill-secret credential boundary', () => {
  let testDir: string;
  let envPath: string;
  let origEnvFile: string | undefined;
  let origEnvVars: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'skill-env-boundary-'));
    envPath = join(testDir, '.env');
    origEnvFile = process.env.NUVIRA_ENV_FILE;
    process.env.NUVIRA_ENV_FILE = envPath;
    origEnvVars = {};
    for (const key of ['MY_SKILL_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      origEnvVars[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (origEnvFile === undefined) delete process.env.NUVIRA_ENV_FILE;
    else process.env.NUVIRA_ENV_FILE = origEnvFile;
    for (const [key, value] of Object.entries(origEnvVars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('stores an ordinary skill secret', async () => {
    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('MY_SKILL_KEY', 'abc123');
    expect(result.success).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain('MY_SKILL_KEY=abc123');
  });

  it('REFUSES a provider credential through the skill path', async () => {
    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('OPENAI_API_KEY', 'sk-live-should-not-be-here');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('provider-credential');
    // Nothing was written — the point of the refusal.
    expect(() => readFileSync(envPath, 'utf-8')).toThrow();
  });

  it('allows a provider credential only when a caller explicitly opts in', async () => {
    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('OPENAI_API_KEY', 'sk-ok', { allowProviderCredential: true });
    expect(result.success).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain('OPENAI_API_KEY=sk-ok');
  });

  it('refuses an invalid name', async () => {
    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('not-a-var', 'x');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid-name');
  });
});

describe('deleteEnvValue', () => {
  let testDir: string;
  let envPath: string;
  let origEnvFile: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'skill-env-delete-'));
    envPath = join(testDir, '.env');
    origEnvFile = process.env.NUVIRA_ENV_FILE;
    process.env.NUVIRA_ENV_FILE = envPath;
  });

  afterEach(() => {
    if (origEnvFile === undefined) delete process.env.NUVIRA_ENV_FILE;
    else process.env.NUVIRA_ENV_FILE = origEnvFile;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('removes the target and preserves comments, blanks and ordering', async () => {
    writeFileSync(
      envPath,
      [
        '# my secrets',
        'KEEP_ME=one',
        '',
        'DELETE_ME=two',
        'export ALSO_KEEP=three',
        'ANOTHER=four',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { deleteEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = deleteEnvValue('DELETE_ME');

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);
    const after = readFileSync(envPath, 'utf-8');
    expect(after).not.toContain('DELETE_ME');
    expect(after).toContain('# my secrets');
    expect(after).toContain('KEEP_ME=one');
    expect(after).toContain('export ALSO_KEEP=three');
    expect(after).toContain('ANOTHER=four');
    // The blank line between KEEP_ME and DELETE_ME survives: the file is not
    // reshuffled by a delete.
    expect(after.split('\n')[2]).toBe('');
  });

  it('treats an absent key as success (the intent already holds)', async () => {
    writeFileSync(envPath, 'SOMETHING=else\n', 'utf-8');
    const { deleteEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = deleteEnvValue('NEVER_WAS');
    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
    expect(readFileSync(envPath, 'utf-8')).toBe('SOMETHING=else\n');
  });

  it('treats a missing file as success', async () => {
    const { deleteEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = deleteEnvValue('ANYTHING');
    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
  });

  it('leaves no dangling blank line when the last var is deleted', async () => {
    writeFileSync(envPath, 'FIRST=1\nLAST=2\n', 'utf-8');
    const { deleteEnvValue } = await import('../../src/skills/secret-capture.js');
    expect(deleteEnvValue('LAST').removed).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe('FIRST=1\n');
  });
});

describe('readSkillEnvInventory', () => {
  let testDir: string;
  let envPath: string;
  let homeDir: string;
  let projectDir: string;
  let origEnvFile: string | undefined;
  let origEnvVars: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'skill-env-inventory-'));
    envPath = join(testDir, 'creds.env');
    homeDir = join(testDir, 'home');
    projectDir = join(testDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    origEnvFile = process.env.NUVIRA_ENV_FILE;
    process.env.NUVIRA_ENV_FILE = envPath;
    origEnvVars = {};
    for (const key of ['WANTED_KEY', 'HAVE_KEY', 'HAND_SET']) {
      origEnvVars[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    if (origEnvFile === undefined) delete process.env.NUVIRA_ENV_FILE;
    else process.env.NUVIRA_ENV_FILE = origEnvFile;
    for (const [key, value] of Object.entries(origEnvVars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  /** A hub skill declaring WANTED_KEY (unset) and HAVE_KEY (set). */
  function writeSkill(): void {
    const dir = join(projectDir, '.agents', 'skills', 'demo-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: demo-skill',
        'description: A demo skill for the inventory test.',
        'required_environment_variables: [WANTED_KEY, HAVE_KEY]',
        '---',
        '',
        '# Demo',
      ].join('\n'),
      'utf-8',
    );
  }

  it('reports declared vars with their skill attribution and set state', async () => {
    writeSkill();
    writeFileSync(envPath, 'HAVE_KEY=present\n', 'utf-8');

    const { readSkillEnvInventory } = await import('../../src/skills/skill-env-inventory.js');
    const rows = readSkillEnvInventory({ projectRoot: projectDir, home: homeDir });

    const wanted = rows.find((r) => r.name === 'WANTED_KEY');
    expect(wanted).toBeDefined();
    expect(wanted!.isSet).toBe(false);
    expect(wanted!.requiredBy).toBe('demo-skill');
    expect(wanted!.value).toBe('');

    const have = rows.find((r) => r.name === 'HAVE_KEY');
    expect(have!.isSet).toBe(true);
    expect(have!.requiredBy).toBe('demo-skill');
    expect(have!.value).not.toContain('present');
  });

  it('masks the value instead of returning it', async () => {
    writeSkill();
    writeFileSync(envPath, 'HAVE_KEY=super-secret-value\n', 'utf-8');

    const { readSkillEnvInventory } = await import('../../src/skills/skill-env-inventory.js');
    const rows = readSkillEnvInventory({ projectRoot: projectDir, home: homeDir });
    const have = rows.find((r) => r.name === 'HAVE_KEY')!;
    expect(have.value).not.toContain('secret');
    expect(have.value).toMatch(/•/);
  });

  it('includes hand-set secrets so they are reviewable, and flags provider credentials', async () => {
    writeFileSync(envPath, 'HAND_SET=mine\nOPENAI_API_KEY=prov\n', 'utf-8');

    const { readSkillEnvInventory } = await import('../../src/skills/skill-env-inventory.js');
    const rows = readSkillEnvInventory({ projectRoot: projectDir, home: homeDir });

    const hand = rows.find((r) => r.name === 'HAND_SET');
    expect(hand).toBeDefined();
    expect(hand!.isSet).toBe(true);
    expect(hand!.requiredBy).toBeUndefined();

    const prov = rows.find((r) => r.name === 'OPENAI_API_KEY');
    expect(prov).toBeDefined();
    expect(prov!.isProviderCredential).toBe(true);
  });

  it('excludes platform-owned vars (owned by the Platforms page)', async () => {
    writeFileSync(envPath, 'TWILIO_AUTH_TOKEN=platform-owned\nHAND_SET=mine\n', 'utf-8');

    const { readSkillEnvInventory } = await import('../../src/skills/skill-env-inventory.js');
    const rows = readSkillEnvInventory({ projectRoot: projectDir, home: homeDir });
    expect(rows.find((r) => r.name === 'TWILIO_AUTH_TOKEN')).toBeUndefined();
    expect(rows.find((r) => r.name === 'HAND_SET')).toBeDefined();
  });

  it('never throws on a missing skills root', async () => {
    const { readSkillEnvInventory } = await import('../../src/skills/skill-env-inventory.js');
    expect(() => readSkillEnvInventory({ projectRoot: join(testDir, 'nope'), home: homeDir })).not.toThrow();
  });
});

describe('probeSkillEnvVar', () => {
  let testDir: string;
  let origEnvFile: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'skill-env-probe-'));
    origEnvFile = process.env.NUVIRA_ENV_FILE;
    process.env.NUVIRA_ENV_FILE = join(testDir, '.env');
  });

  afterEach(() => {
    if (origEnvFile === undefined) delete process.env.NUVIRA_ENV_FILE;
    else process.env.NUVIRA_ENV_FILE = origEnvFile;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('says a provider credential is not usable by skills, and why', async () => {
    const { probeSkillEnvVar } = await import('../../src/skills/skill-env-inventory.js');
    const probe = probeSkillEnvVar('ANTHROPIC_API_KEY');
    expect(probe.usable).toBe(false);
    expect(probe.detail).toMatch(/provider/i);
  });

  it('says a platform credential belongs to the Platforms page', async () => {
    const { probeSkillEnvVar } = await import('../../src/skills/skill-env-inventory.js');
    const probe = probeSkillEnvVar('TWILIO_AUTH_TOKEN');
    expect(probe.usable).toBe(false);
    expect(probe.detail).toMatch(/platform/i);
  });

  it('says an unset var is unset', async () => {
    const { probeSkillEnvVar } = await import('../../src/skills/skill-env-inventory.js');
    const probe = probeSkillEnvVar('DEFINITELY_NOT_SET_ANYWHERE');
    expect(probe.usable).toBe(false);
    expect(probe.detail).toMatch(/not set/i);
  });

  it('says a persisted skill secret is usable', async () => {
    writeFileSync(process.env.NUVIRA_ENV_FILE!, 'MY_SKILL_KEY=value\n', 'utf-8');
    const { probeSkillEnvVar } = await import('../../src/skills/skill-env-inventory.js');
    const probe = probeSkillEnvVar('MY_SKILL_KEY');
    expect(probe.usable).toBe(true);
  });
});
