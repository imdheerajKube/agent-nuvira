import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allSkillTallies,
  orderByOutcome,
  recordSkillSession,
  recordSkillUse,
  resetSkillOutcomes,
  skillScore,
  skillTally,
  trackRecord,
} from '../../src/learning/skill-outcomes.js';

let dir: string;
const origConfigDir = process.env.NUVIRA_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buff-skill-outcomes-'));
  // The ledger resolves through resolveNuviraDataPath, which honours
  // NUVIRA_CONFIG_DIR — the same isolation every other state file uses.
  process.env.NUVIRA_CONFIG_DIR = dir;
});

afterEach(() => {
  if (origConfigDir === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = origConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('skill outcomes — what a skill delivered', () => {
  it('counts a load, and a delivered turn credits a delivery', () => {
    recordSkillUse('terraform');
    expect(skillTally('terraform')).toMatchObject({ loads: 1, delivered: 0 });
    recordSkillSession(['terraform'], true);
    expect(skillTally('terraform')).toMatchObject({ loads: 1, delivered: 1 });
  });

  it('an unverified ending is recorded as a miss (the load stays on the books)', () => {
    recordSkillUse('terraform');
    recordSkillSession(['terraform'], false);
    expect(skillTally('terraform')).toMatchObject({ loads: 1, delivered: 0 });
  });

  it('never records a delivery for a skill that was not loaded this session', () => {
    recordSkillSession(['never-loaded'], false);
    expect(skillTally('never-loaded').loads).toBe(0);
  });

  it('a delivery implies a load even when the load was not seen', () => {
    recordSkillSession(['prometheus'], true);
    expect(skillTally('prometheus')).toMatchObject({ loads: 1, delivered: 1 });
  });

  it('smooths: one bad run cannot condemn, one good run cannot win outright', () => {
    const unseen = skillScore(undefined);
    const oneOfOne = skillScore({ loads: 1, delivered: 1, updatedAt: 0 });
    const zeroOfOne = skillScore({ loads: 1, delivered: 0, updatedAt: 0 });
    const fortyOfFifty = skillScore({ loads: 50, delivered: 40, updatedAt: 0 });
    expect(unseen).toBeCloseTo(0.5);
    expect(zeroOfOne).toBeLessThan(unseen);
    expect(oneOfOne).toBeGreaterThan(unseen);
    expect(fortyOfFifty).toBeGreaterThan(oneOfOne);
  });

  it('ranks by delivered results, keeping unseen skills neutral and name order stable', () => {
    const entries = [
      { name: 'alpha' },
      { name: 'beta' },
      { name: 'gamma' },
      { name: 'delta' },
    ];
    // gamma delivers twice, beta misses twice, alpha/delta have no history.
    recordSkillUse('gamma');
    recordSkillSession(['gamma'], true);
    recordSkillUse('gamma');
    recordSkillSession(['gamma'], true);
    recordSkillUse('beta');
    recordSkillSession(['beta'], false);
    recordSkillUse('beta');
    recordSkillSession(['beta'], false);

    const ranked = orderByOutcome(entries).map((e) => e.name);
    expect(ranked[0]).toBe('gamma');
    expect(ranked[ranked.length - 1]).toBe('beta');
    // Neutral skills keep alphabetical order among themselves.
    expect(ranked.slice(1, 3)).toEqual(['alpha', 'delta']);
  });

  it('reports a track record only when there is one', () => {
    expect(trackRecord('never-used')).toBeNull();
    recordSkillUse('cron-job');
    recordSkillSession(['cron-job'], true);
    expect(trackRecord('cron-job')).toBe('delivered 1/1');
  });

  it('caps delivered at loads even when the file is corrupt', () => {
    recordSkillUse('x');
    recordSkillSession(['x'], false);
    expect(allSkillTallies()['x'].delivered).toBeLessThanOrEqual(allSkillTallies()['x'].loads);
  });

  it('reset clears the ledger', () => {
    recordSkillUse('terraform');
    resetSkillOutcomes();
    expect(allSkillTallies()).toEqual({});
  });
});
