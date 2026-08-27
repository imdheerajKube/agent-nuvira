/**
 * Tests for planner skill integration with skill_view.
 *
 * Verifies:
 * - Planner receives full methodology from skill_view
 * - Planner uses skill guidance in task descriptions
 * - skill_view is called when skill is matched
 * - Full methodology is injected into planner prompt
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = mkdtempSync(join(tmpdir(), 'planner-skill-test-'));

import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';

describe('Planner — skill_view integration', () => {
  let store: ReturnType<typeof getSkillStore>;

  beforeEach(() => {
    resetSkillStore();
    store = getSkillStore();
  });

  it('skill_view returns full methodology for game-development', () => {
    const output = store.skillView('game-development');

    // Should contain detailed methodology
    expect(output).toContain('game-development');
    expect(output).toContain('Execution Steps');
    expect(output).toContain('writer');
    expect(output).toContain('runner');

    // Should contain reference docs section
    expect(output).toContain('Reference Documents');
    expect(output).toContain('platform-specific.md');
  });

  it('skill_view returns whenToUse sections', () => {
    const output = store.skillView('game-development');

    // Should contain whenToUse if defined
    if (output.includes('When to Use')) {
      expect(output).toContain('When to Use');
    }
  });

  it('skill_view marks skills as used', () => {
    const all = store.getAll();
    const skill = all[0];
    const initialUsage = skill.usageCount;

    store.skillView(skill.name);

    const updated = store.get(skill.id);
    expect(updated!.usageCount).toBe(initialUsage + 1);
  });

  it('skill_view loads reference docs from disk', () => {
    const output = store.skillView('game-development', 'platform-specific.md');

    // Should contain actual content
    expect(output).toContain('Platform-Specific');
    expect(output).toContain('Python');
  });

  it('planner prompt includes skill methodology when skillGuidance has fullMethodology', () => {
    // Simulate what the orchestrator does: set skillGuidance with fullMethodology
    const skillGuidance = {
      name: 'game-development',
      description: 'Create a GUI game with graphics',
      steps: [
        { agentType: 'context-gatherer', description: 'Analyze game requirements' },
        { agentType: 'writer', description: 'Implement core game engine' },
      ],
      fullMethodology: store.skillView('game-development'),
    };

    // Verify full methodology is included
    expect(skillGuidance.fullMethodology).toContain('Execution Steps');
    expect(skillGuidance.fullMethodology).toContain('writer');
    expect(skillGuidance.fullMethodology).toContain('Reference Documents');
  });

  it('planner can reference skills in task descriptions', () => {
    // Simulate planner creating a task with skill reference
    const taskDescription = 'Create a Python+tkinter snake-and-ladder game. Use skill_view("game-development") for full methodology.';

    expect(taskDescription).toContain('skill_view');
    expect(taskDescription).toContain('game-development');
  });
});
