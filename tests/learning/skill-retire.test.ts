/**
 * Retiring skills the bundle no longer ships.
 *
 * The property: a merge that deletes a bundled skill has to take effect on
 * machines that already ran an older build. Measured before this test existed
 * (2026-11-03): the local store still held all 8 merged-away skills, so the
 * catalog listed both halves of every pair — 148 hub + 8 stale compiled — while
 * a fresh install was clean.
 *
 * The complement matters as much: retirement is for FIRST-PARTY skills only. A
 * learned skill, a hub-installed skill and a user-authored one must survive
 * whatever is deleted from the bundle, and the retired file must be an archive
 * (recoverable), not a deletion.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import type { Skill } from '../../src/learning/skill-types.js';

let dir: string;
const orig = process.env.NUVIRA_SKILLS_DIR;

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-ghost-setup',
    name: 'ghost-setup',
    description: 'A bundled skill that a merge later deleted',
    version: '1.0.0',
    goalPattern: 'ghost setup',
    steps: [{ agentType: 'analyst', description: 'do it', dependsOn: [] }],
    parameters: [],
    tags: ['ghost'],
    // This is what makes a skill eligible: it came from the bundle.
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.9,
    usageCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuvira-skill-retire-'));
  process.env.NUVIRA_SKILLS_DIR = dir;
  resetSkillStore();
});

afterEach(() => {
  if (orig === undefined) delete process.env.NUVIRA_SKILLS_DIR;
  else process.env.NUVIRA_SKILLS_DIR = orig;
  resetSkillStore();
  rmSync(dir, { recursive: true, force: true });
});

describe('retiring skills deleted from the bundle', () => {
  it('retires a bundled skill the bundle no longer ships, archiving the file', () => {
    const store = new SkillStore();
    store.save(skill());
    expect(store.get('skill-ghost-setup')).not.toBeNull();

    // A later launch (new store) seeds the current bundle and retires the ghost.
    const next = new SkillStore();
    expect(next.lastRetired).toContain('skill-ghost-setup');
    expect(next.get('skill-ghost-setup')).toBeNull();
    expect(next.getAll().some((s) => s.id === 'skill-ghost-setup')).toBe(false);
    // Archived, not destroyed — the user can mv it back.
    expect(existsSync(join(dir, '.retired', 'skill-ghost-setup.json'))).toBe(true);
  });

  it('never retires a LEARNED skill, whatever the bundle says', () => {
    const store = new SkillStore();
    store.save(
      skill({
        id: 'skill-learned-from-my-repo',
        name: 'learned-from-my-repo',
        sourceTrajectoryIds: ['traj-abc', 'traj-def'],
      }),
    );
    const next = new SkillStore();
    expect(next.lastRetired).not.toContain('skill-learned-from-my-repo');
    expect(next.get('skill-learned-from-my-repo')).not.toBeNull();
  });

  it('keeps every skill the bundle still ships', () => {
    const next = new SkillStore();
    expect(next.lastRetired).toEqual([]);
    expect(next.getAll().length).toBeGreaterThan(100);
  });
});
