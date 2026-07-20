import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillStore, getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import type { Skill } from '../../src/learning/skill-types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function now(): number {
  return Date.now();
}

function daysAgo(days: number): number {
  return now() - days * DAY_MS;
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-test-skill-abc123',
    name: 'Test Skill',
    description: 'A test skill for unit testing',
    version: '1.0.0',
    goalPattern: 'Do a specific task in a project',
    steps: [
      { agentType: 'writer', description: 'Write the code', promptTemplate: 'Write code for {{featureName}}', dependsOn: [] },
      { agentType: 'reviewer', description: 'Review the changes', dependsOn: ['step-0'] },
    ],
    parameters: [{ name: 'featureName', description: 'Name of the feature', type: 'string', required: true }],
    tags: ['test', 'typescript'],
    sourceTrajectoryIds: ['traj-1', 'traj-2'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: now(),
    lastUsedAt: now(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SkillStore', () => {
  let store: SkillStore;

  beforeEach(() => {
    resetSkillStore();
    store = new SkillStore();
    store.clear();
  });

  afterEach(() => {
    store.clear();
    resetSkillStore();
  });

  describe('save', () => {
    it('should save a skill and persist it', () => {
      const skill = makeSkill();
      store.save(skill);

      const loaded = store.get(skill.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(skill.id);
      expect(loaded!.name).toBe('Test Skill');
      expect(loaded!.version).toBe('1.0.0');
    });

    it('should update existing skill when saved again', () => {
      const skill = makeSkill({ usageCount: 0 });
      store.save(skill);

      const updated = { ...skill, usageCount: 5, version: '2.0.0' };
      store.save(updated);

      const loaded = store.get(skill.id);
      expect(loaded!.usageCount).toBe(5);
      expect(loaded!.version).toBe('2.0.0');
    });

    it('should update the index entry', () => {
      store.save(makeSkill());
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Test Skill');
    });
  });

  describe('get', () => {
    it('should return null for non-existent ID', () => {
      expect(store.get('nonexistent-id')).toBeNull();
    });

    it('should retrieve a saved skill', () => {
      const skill = makeSkill();
      store.save(skill);
      expect(store.get(skill.id)).not.toBeNull();
    });

    it('should return full skill data (not just index entry)', () => {
      const skill = makeSkill({
        steps: [
          { agentType: 'writer', description: 'Step 1', promptTemplate: 'Do {{thing}}', dependsOn: [] },
          { agentType: 'reviewer', description: 'Step 2', dependsOn: ['step-0'] },
          { agentType: 'runner', description: 'Step 3', promptTemplate: 'Run: npm test', dependsOn: ['step-1'] },
        ],
      });
      store.save(skill);
      expect(store.get(skill.id)!.steps).toHaveLength(3);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no skills exist', () => {
      expect(store.getAll()).toEqual([]);
    });

    it('should return all skills sorted by quality score (descending)', () => {
      store.save(makeSkill({ id: 's1', name: 'Low', qualityScore: 0.3 }));
      store.save(makeSkill({ id: 's2', name: 'High', qualityScore: 0.95 }));
      store.save(makeSkill({ id: 's3', name: 'Mid', qualityScore: 0.6 }));

      const all = store.getAll();
      expect(all.map((s) => s.name)).toEqual(['High', 'Mid', 'Low']);
    });

    it('should filter by minimum quality score', () => {
      store.save(makeSkill({ id: 's1', name: 'Low', qualityScore: 0.3 }));
      store.save(makeSkill({ id: 's2', name: 'High', qualityScore: 0.7 }));

      const filtered = store.getAll(0.5);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('High');
    });
  });

  describe('search', () => {
    it('should find skills by name', () => {
      store.save(makeSkill({ id: 's1', name: 'Add CLI Command', tags: ['cli'] }));
      store.save(makeSkill({ id: 's2', name: 'Create API Route', tags: ['api'] }));

      const results = store.search('CLI');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Add CLI Command');
    });

    it('should find skills by tag', () => {
      store.save(makeSkill({ id: 's1', name: 'REST Endpoint', tags: ['api', 'express'] }));
      store.save(makeSkill({ id: 's2', name: 'Database Migration', tags: ['database', 'sql'] }));

      const results = store.search('api');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('REST Endpoint');
    });

    it('should find skills by description', () => {
      store.save(makeSkill({ id: 's1', name: 'Unit Test', description: 'Creates unit tests for a module' }));
      expect(store.search('unit tests')).toHaveLength(1);
    });

    it('should find skills by goalPattern', () => {
      store.save(makeSkill({ id: 's1', name: 'Auth Setup', goalPattern: 'Add authentication to a web application' }));
      expect(store.search('authentication')).toHaveLength(1);
    });

    it('should return empty array for no matches', () => {
      store.save(makeSkill({ id: 's1', name: 'Only Skill' }));
      expect(store.search('zzz_nonexistent_zzz')).toEqual([]);
    });

    it('should limit results to 10', () => {
      for (let i = 0; i < 15; i++) {
        store.save(makeSkill({ id: `s${i}`, name: `Skill ${i}`, tags: ['api'] }));
      }
      expect(store.search('api').length).toBeLessThanOrEqual(10);
    });
  });

  describe('findMatch', () => {
    it('should return the best matching skill for a goal', () => {
      store.save(makeSkill({ id: 's1', name: 'Add CLI Command', goalPattern: 'Add a new CLI command to a project', tags: ['cli'], qualityScore: 0.9 }));
      store.save(makeSkill({ id: 's2', name: 'Create API Route', goalPattern: 'Create a REST API endpoint', tags: ['api'], qualityScore: 0.8 }));

      const match = store.findMatch('I need to add a new CLI command for deployment');
      expect(match).not.toBeNull();
      expect(match!.name).toBe('Add CLI Command');
    });

    it('should return null when no goal matches with sufficient score', () => {
      store.save(makeSkill({ id: 's1', name: 'Only Skill', goalPattern: 'Do something very specific', tags: ['niche'] }));

      expect(store.findMatch('completely unrelated topic')).toBeNull();
    });

    it('should prefer higher quality skills', () => {
      store.save(makeSkill({ id: 's1', name: 'Low Quality CLI', goalPattern: 'Add a CLI command', tags: ['cli'], qualityScore: 0.3 }));
      store.save(makeSkill({ id: 's2', name: 'High Quality CLI', goalPattern: 'Add a CLI command to a Node.js project', tags: ['cli'], qualityScore: 0.95 }));

      expect(store.findMatch('add a CLI command')!.name).toBe('High Quality CLI');
    });
  });

  describe('markUsed', () => {
    it('should increment usage count', () => {
      const skill = makeSkill({ usageCount: 0 });
      store.save(skill);

      store.markUsed(skill.id);
      expect(store.get(skill.id)!.usageCount).toBe(1);

      store.markUsed(skill.id);
      store.markUsed(skill.id);
      expect(store.get(skill.id)!.usageCount).toBe(3);
    });

    it('should update lastUsedAt timestamp', () => {
      const skill = makeSkill({ lastUsedAt: 0 });
      store.save(skill);

      store.markUsed(skill.id);
      expect(store.get(skill.id)!.lastUsedAt).toBeGreaterThan(0);
    });

    it('should do nothing for non-existent ID', () => {
      expect(() => store.markUsed('nonexistent')).not.toThrow();
    });
  });

  describe('delete', () => {
    it('should remove a skill', () => {
      store.save(makeSkill());
      expect(store.get('skill-test-skill-abc123')).not.toBeNull();

      const removed = store.delete('skill-test-skill-abc123');
      expect(removed).toBe(true);
      expect(store.get('skill-test-skill-abc123')).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });

    it('should update the index', () => {
      store.save(makeSkill({ id: 's1', name: 'Skill A' }));
      store.save(makeSkill({ id: 's2', name: 'Skill B' }));

      store.delete('s1');
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].name).toBe('Skill B');
    });
  });

  describe('computeDecayScore', () => {
    it('should return 0 for expired skills (older than TTL)', () => {
      const oldSkill = makeSkill({ createdAt: daysAgo(130), lastUsedAt: daysAgo(130) });
      expect(store.computeDecayScore(oldSkill)).toBe(0);
    });

    it('should return close to 1 for brand new skills', () => {
      const fresh = makeSkill({ createdAt: now(), lastUsedAt: now() });
      expect(store.computeDecayScore(fresh)).toBeGreaterThan(0.9);
    });

    it('should give higher scores to frequently used skills', () => {
      const unused = makeSkill({ id: 'unused', name: 'Unused', usageCount: 0, createdAt: daysAgo(10), lastUsedAt: daysAgo(10) });
      const popular = makeSkill({ id: 'popular', name: 'Popular', usageCount: 20, createdAt: daysAgo(10), lastUsedAt: now() });

      expect(store.computeDecayScore(popular)).toBeGreaterThan(store.computeDecayScore(unused));
    });
  });

  describe('garbageCollect', () => {
    it('should remove low-quality skills', () => {
      store.save(makeSkill({ id: 'good', name: 'Good Skill', qualityScore: 0.9, createdAt: now(), lastUsedAt: now() }));
      store.save(makeSkill({ id: 'bad', name: 'Bad Skill', qualityScore: 0.05, usageCount: 0, createdAt: daysAgo(130), lastUsedAt: daysAgo(130) }));

      const removed = store.garbageCollect();
      expect(removed).toBeGreaterThanOrEqual(1);

      const remaining = store.getAll();
      expect(remaining.every((s) => s.name !== 'Bad Skill')).toBe(true);
    });

    it('should not remove good skills', () => {
      store.save(makeSkill({ id: 's1', name: 'Good Skill', qualityScore: 0.9, createdAt: now(), lastUsedAt: now() }));
      store.save(makeSkill({ id: 's2', name: 'Another Good', qualityScore: 0.85, createdAt: now(), lastUsedAt: now() }));

      expect(store.garbageCollect()).toBe(0);
      expect(store.getAll()).toHaveLength(2);
    });

    it('should handle empty store', () => {
      expect(() => store.garbageCollect()).not.toThrow();
      expect(store.garbageCollect()).toBe(0);
    });
  });

  describe('getSummary', () => {
    it('should return zero stats when empty', () => {
      const s = store.getSummary();
      expect(s.total).toBe(0);
      expect(s.totalUsage).toBe(0);
      expect(s.avgQualityScore).toBe(0);
      expect(s.oldestSkill).toBe('');
      expect(s.newestSkill).toBe('');
    });

    it('should compute summary correctly', () => {
      store.save(makeSkill({ id: 's1', name: 'Skill A', tags: ['cli'], usageCount: 3, qualityScore: 0.9, createdAt: now(), lastUsedAt: now() }));
      store.save(makeSkill({ id: 's2', name: 'Skill B', tags: ['api'], usageCount: 1, qualityScore: 0.7, createdAt: now() + 1, lastUsedAt: now() + 1 }));

      const s = store.getSummary();
      expect(s.total).toBe(2);
      expect(s.totalUsage).toBe(4);
      expect(s.avgQualityScore).toBeCloseTo(0.8, 1);
      expect(s.topTags.length).toBeGreaterThanOrEqual(2);
      expect(s.oldestSkill).toBe('Skill A');
      expect(s.newestSkill).toBe('Skill B');
    });
  });

  describe('getQualityReport', () => {
    it('should return report sorted by decay score (worst first)', () => {
      store.save(makeSkill({ id: 's1', name: 'Old Skill', usageCount: 0, createdAt: daysAgo(60), lastUsedAt: daysAgo(60) }));
      store.save(makeSkill({ id: 's2', name: 'Fresh Skill', usageCount: 0, createdAt: now(), lastUsedAt: now() }));

      const report = store.getQualityReport();
      expect(report).toHaveLength(2);
      expect(report[0].name).toBe('Old Skill');
      expect(report[1].name).toBe('Fresh Skill');
    });

    it('should return empty array when no skills', () => {
      expect(store.getQualityReport()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all skills', () => {
      store.save(makeSkill({ id: 's1', name: 'Skill A' }));
      store.save(makeSkill({ id: 's2', name: 'Skill B' }));
      store.clear();

      expect(store.getAll()).toHaveLength(0);
      expect(store.get('s1')).toBeNull();
    });

    it('should reset the index', () => {
      store.save(makeSkill({ id: 's1', name: 'Skill A' }));
      store.clear();
      expect(store.getSummary().total).toBe(0);
    });
  });
});
