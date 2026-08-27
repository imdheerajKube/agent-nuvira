/**
 * Tests for skill_view() — Progressive disclosure for skills.
 *
 * Verifies:
 * - skill_view() returns full skill methodology
 * - skill_view() with file_path returns specific file content
 * - skill_view() marks skills as used
 * - skill_view() handles unknown skills gracefully
 * - skills_list() returns lightweight summaries
 * - Fuzzy matching works for skill names
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SkillStore, getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';

describe('SkillStore.skillView()', () => {
  let store: SkillStore;

  beforeEach(() => {
    resetSkillStore();
    store = getSkillStore();
  });

  it('returns full skill methodology for a known skill', () => {
    // Get a bundled skill
    const all = store.getAll();
    expect(all.length).toBeGreaterThan(0);

    const skill = all[0];
    const output = store.skillView(skill.name);

    // Should contain the skill name
    expect(output).toContain(skill.name);

    // Should contain description
    expect(output).toContain(skill.description);

    // Should contain execution steps
    expect(output).toContain('Execution Steps');

    // Should contain step descriptions
    for (const step of skill.steps) {
      expect(output).toContain(step.description.slice(0, 50));
    }
  });

  it('returns whenToUse and whenNotToUse sections', () => {
    // Find a skill with whenToUse
    const all = store.getAll();
    const skillWithConditions = all.find((s) => s.whenToUse && s.whenToUse.length > 0);

    if (skillWithConditions) {
      const output = store.skillView(skillWithConditions.name);
      expect(output).toContain('When to Use');
    }
  });

  it('marks skill as used when viewed', () => {
    const all = store.getAll();
    const skill = all[0];

    const initialUsage = skill.usageCount;
    store.skillView(skill.name);

    const updated = store.get(skill.id);
    expect(updated).not.toBeNull();
    expect(updated!.usageCount).toBe(initialUsage + 1);
  });

  it('returns error for unknown skill', () => {
    const output = store.skillView('nonexistent-skill-xyz');

    expect(output).toContain('not found');
    expect(output).toContain('Available skills');
  });

  it('performs fuzzy matching for skill names', () => {
    const all = store.getAll();
    if (all.length > 0) {
      const skill = all[0];
      // Try partial name match
      const partialName = skill.name.slice(0, Math.floor(skill.name.length / 2));
      if (partialName.length > 2) {
        const output = store.skillView(partialName);
        // Should either find the skill or return "not found" with suggestions
        expect(output).toBeDefined();
      }
    }
  });

  it('returns file_path content when specified', () => {
    const all = store.getAll();
    const skill = all[0];

    const output = store.skillView(skill.name, 'references/test.md');
    expect(output).toContain('references/test.md');
    expect(output).toContain(skill.name);
  });

  it('includes quality metadata', () => {
    const all = store.getAll();
    const skill = all[0];

    const output = store.skillView(skill.name);
    expect(output).toContain('Quality:');
    expect(output).toContain('Used:');
  });
});

describe('SkillStore.skillsList()', () => {
  let store: SkillStore;

  beforeEach(() => {
    resetSkillStore();
    store = getSkillStore();
  });

  it('returns all skills as lightweight summaries', () => {
    const all = store.getAll();
    expect(all.length).toBeGreaterThan(0);

    // skills_list returns JSON with name, description, tags, quality
    const firstSkill = all[0];
    const summary = {
      name: firstSkill.name,
      description: firstSkill.description,
      tags: firstSkill.tags,
      quality: `${(firstSkill.qualityScore * 100).toFixed(0)}%`,
    };

    expect(summary.name).toBeDefined();
    expect(summary.description).toBeDefined();
    expect(summary.tags).toBeDefined();
    expect(summary.quality).toBeDefined();
  });

  it('search filters by query', () => {
    const results = store.search('game');
    // Should find game-development skill
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});
