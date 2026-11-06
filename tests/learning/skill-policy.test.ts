/**
 * Per-project skill policy (`readSkillPolicy` in hub-skill-catalog.ts).
 *
 * WHY. `skills.disabled[]` is machine-wide, so "this repo must not use the
 * deploy skill" could only be expressed by not installing it — which is a
 * decision about the MACHINE, and one other projects silently inherited. A
 * project now carries its own list in `.nuviraconfig.json`:
 *
 *   - `disabled[]` ADDS to the global list (both scopes can exclude);
 *   - `enabled[]` is an ALLOWLIST (non-empty ⇒ everything else is excluded here);
 *
 * and the Agent Hub toggle still writes only the GLOBAL list, so pressing it in
 * one repo never folds that repo's exclusions into everyone else's config.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listMatchableHubSkills,
  readSkillPolicy,
  skillPolicyAllows,
  setSkillEnabled,
  readDisabledSkills,
} from '../../src/learning/hub-skill-catalog.js';
import { ConfigManager } from '../../src/config/manager.js';
import { resetSkillStore } from '../../src/learning/skill-store.js';

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nMethodology.\n`;
}

function install(projectDir: string, name: string, description: string): void {
  mkdirSync(join(projectDir, '.agents', 'skills', name), { recursive: true });
  writeFileSync(join(projectDir, '.agents', 'skills', name, 'SKILL.md'), skillMd(name, description), 'utf-8');
}

let projectDir = '';
let homeDir = '';
let configDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'buff-pol-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'buff-pol-home-'));
  configDir = mkdtempSync(join(tmpdir(), 'buff-pol-cfg-'));
  install(projectDir, 'policy-deploy', 'Publish a site to the policy host');
  install(projectDir, 'policy-lint', 'Lint the project');
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

describe('readSkillPolicy', () => {
  it('is permissive with no config at all', () => {
    const policy = readSkillPolicy(undefined, projectDir);
    expect(policy).toEqual({ disabled: [], enabled: [] });
    expect(skillPolicyAllows('anything', policy)).toBe(true);
  });

  it("ADDS the project's disabled list to the machine-wide one", () => {
    const cm = new ConfigManager(configDir);
    cm.save({ skills: { disabled: ['global-one'] } });
    writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { disabled: ['policy-deploy'] } }));

    const policy = readSkillPolicy(cm, projectDir);
    expect(policy.disabled).toEqual(expect.arrayContaining(['global-one', 'policy-deploy']));
    expect(skillPolicyAllows('policy-deploy', policy)).toBe(false);
    expect(skillPolicyAllows('policy-lint', policy)).toBe(true);
  });

  it('treats a project enabled[] as an ALLOWLIST for that project only', () => {
    writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { enabled: ['policy-lint'] } }));
    const policy = readSkillPolicy(new ConfigManager(configDir), projectDir);
    expect(skillPolicyAllows('policy-lint', policy)).toBe(true);
    expect(skillPolicyAllows('policy-deploy', policy)).toBe(false);
  });

  it('exclusion wins: an id both allowed and disabled is disabled', () => {
    writeFileSync(
      join(projectDir, '.nuviraconfig.json'),
      JSON.stringify({ skills: { enabled: ['policy-deploy'], disabled: ['policy-deploy'] } }),
    );
    const policy = readSkillPolicy(undefined, projectDir);
    expect(skillPolicyAllows('policy-deploy', policy)).toBe(false);
  });

  it('checks both id spellings, because a compiled id is `skill-<name>`', () => {
    writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { disabled: ['api-design'] } }));
    const policy = readSkillPolicy(undefined, projectDir);
    expect(skillPolicyAllows('skill-api-design', policy)).toBe(false);
    expect(skillPolicyAllows('api-design', policy)).toBe(false);
  });

  it('survives a corrupt project config instead of gating everything', () => {
    writeFileSync(join(projectDir, '.nuviraconfig.json'), '{not json');
    const policy = readSkillPolicy(undefined, projectDir);
    expect(policy).toEqual({ disabled: [], enabled: [] });
    expect(skillPolicyAllows('policy-deploy', policy)).toBe(true);
  });
});

describe('the runtime gates read the project policy', () => {
  it('excludes a project-disabled skill from the hub catalog (and includes it again without the config)', () => {
    const cm = new ConfigManager(configDir);
    expect(listMatchableHubSkills(cm, projectDir, homeDir).map((s) => s.id).sort()).toEqual(['policy-deploy', 'policy-lint']);

    writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { disabled: ['policy-deploy'] } }));
    expect(listMatchableHubSkills(cm, projectDir, homeDir).map((s) => s.id)).toEqual(['policy-lint']);
  });

  it('honours an allowlist at the same gate', () => {
    writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { enabled: ['policy-deploy'] } }));
    expect(listMatchableHubSkills(undefined, projectDir, homeDir).map((s) => s.id)).toEqual(['policy-deploy']);
  });
});

describe('the Agent Hub toggle writes the GLOBAL list only', () => {
  it('never folds a project exclusion into the machine-wide config', () => {
    const memDir = mkdtempSync(join(tmpdir(), 'buff-pol-mem-'));
    const backup = process.env.NUVIRA_MEMORY_DIR;
    process.env.NUVIRA_MEMORY_DIR = memDir;
    resetSkillStore();
    try {
      const cm = new ConfigManager(configDir);
      cm.save({ skills: { disabled: ['global-one'] } });
      writeFileSync(join(projectDir, '.nuviraconfig.json'), JSON.stringify({ skills: { disabled: ['policy-lint'] } }));

      // The merged view sees both...
      expect(readDisabledSkills(cm, projectDir)).toEqual(expect.arrayContaining(['global-one', 'policy-lint']));

      // ...but the toggle writes only what it owns.
      setSkillEnabled('policy-deploy', false, cm, projectDir, homeDir);
      const saved = cm.getAll() as { skills?: { disabled?: string[] } };
      expect(saved.skills?.disabled).toEqual(expect.arrayContaining(['global-one', 'policy-deploy']));
      expect(saved.skills?.disabled).not.toContain('policy-lint');
    } finally {
      if (backup === undefined) delete process.env.NUVIRA_MEMORY_DIR;
      else process.env.NUVIRA_MEMORY_DIR = backup;
      resetSkillStore();
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});
