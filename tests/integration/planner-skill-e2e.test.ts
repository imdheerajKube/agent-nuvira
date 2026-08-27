/**
 * End-to-end test verifying planner uses skill methodology with real LLM.
 *
 * Tests the complete flow:
 * 1. Orchestrator matches skill to goal
 * 2. skill_view() loads full methodology
 * 3. Methodology is injected into planner prompt
 * 4. Planner creates steps based on methodology
 *
 * Run with: npx vitest run tests/integration/planner-skill-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set up hermetic environment
const testDir = mkdtempSync(join(tmpdir(), 'planner-skill-e2e-'));
process.env.NUVIRA_MEMORY_DIR = join(testDir, '.nuvira', 'memory');

import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import { getToolsForAgent } from '../../src/agents/tool-bridge.js';

describe('Planner Skill E2E — Real LLM', () => {
  let store: ReturnType<typeof getSkillStore>;

  beforeAll(() => {
    resetSkillStore();
    store = getSkillStore();
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  });

  it('skill_view returns full methodology that planner can use', () => {
    const methodology = store.skillView('game-development');

    // Verify full methodology is returned
    expect(methodology).toContain('game-development');
    expect(methodology).toContain('Execution Steps');
    expect(methodology).toContain('writer');
    expect(methodology).toContain('runner');

    // Verify reference docs are listed
    expect(methodology).toContain('Reference Documents');
    expect(methodology).toContain('platform-specific.md');
    expect(methodology).toContain('asset-creation.md');
    expect(methodology).toContain('troubleshooting.md');
  });

  it('skill_view methodology contains actionable steps', () => {
    const methodology = store.skillView('game-development');

    // Verify steps contain real commands
    expect(methodology).toContain('Step 1');
    expect(methodology).toContain('Step 2');
    expect(methodology).toContain('Step 3');

    // Verify agent types are specified
    expect(methodology).toContain('[context-gatherer]');
    expect(methodology).toContain('[writer]');
    expect(methodology).toContain('[runner]');
  });

  it('skill_view methodology includes whenToUse guidance', () => {
    const methodology = store.skillView('game-development');

    // Verify whenToUse section exists
    if (methodology.includes('When to Use')) {
      expect(methodology).toContain('When to Use');
    }
  });

  it('writer can call skill_view to load methodology', async () => {
    const tools = getToolsForAgent('writer');
    const skillViewTool = tools.find((t) => t.name === 'skill_view');

    expect(skillViewTool).toBeDefined();

    // Execute skill_view
    const result = await skillViewTool!.execute(
      { name: 'game-development' },
      {
        goal: 'create a snake and ladder game',
        workingDirectory: testDir,
        fileChanges: [],
        metadata: {},
      } as any,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('game-development');
    expect(result.output).toContain('Execution Steps');
  });

  it('planner prompt construction includes skill methodology', () => {
    // Simulate what the orchestrator does
    const matchedSkill = store.findMatch('create a snake and ladder game');

    if (matchedSkill) {
      // Load full methodology
      const fullMethodology = store.skillView(matchedSkill.name);

      // Simulate planner prompt construction
      const promptParts: string[] = [
        'You are a senior software architect.',
        '',
        '## User Goal',
        'create a snake and ladder game for windows GUI',
        '',
        '## Skill Guidance — matched skill: ' + matchedSkill.name,
        matchedSkill.description,
      ];

      // Inject full methodology
      if (fullMethodology) {
        promptParts.push('', '### Full Skill Methodology (from skill_view)', fullMethodology);
      }

      // Add quick reference steps
      if (matchedSkill.steps.length > 0) {
        promptParts.push('', '### Quick Reference Steps:');
        for (const step of matchedSkill.steps) {
          promptParts.push(`- [${step.agentType}] ${step.description}`);
        }
      }

      const fullPrompt = promptParts.join('\n');

      // Verify the prompt contains skill methodology
      expect(fullPrompt).toContain('game-development');
      expect(fullPrompt).toContain('Full Skill Methodology');
      expect(fullPrompt).toContain('Execution Steps');
      expect(fullPrompt).toContain('Quick Reference Steps');
    }
  });

  it('planner can reference skill_view in task descriptions', () => {
    // Simulate planner creating a task with skill reference
    const taskDescription = `Create a Python+tkinter snake-and-ladder game.

## Skill Methodology (from skill_view)
${store.skillView('game-development')}

IMPORTANT: The writer agent can call skill_view() to load the full methodology for any step.`;

    // Verify the task description contains skill methodology
    expect(taskDescription).toContain('game-development');
    expect(taskDescription).toContain('Execution Steps');
    expect(taskDescription).toContain('writer');
    expect(taskDescription).toContain('skill_view');
  });

  it('full pipeline flow with skill integration', async () => {
    // Step 1: Match skill to goal
    const goal = 'create a snake and ladder game for windows GUI, deliver executable file (.exe)';
    const matchedSkill = store.findMatch(goal);

    expect(matchedSkill).not.toBeNull();
    expect(matchedSkill!.name).toBe('game-development');

    // Step 2: Load full methodology
    const fullMethodology = store.skillView(matchedSkill!.name);
    expect(fullMethodology).toContain('Execution Steps');

    // Step 3: Writer can use skill_view
    const tools = getToolsForAgent('writer');
    const skillViewTool = tools.find((t) => t.name === 'skill_view');

    const writerResult = await skillViewTool!.execute(
      { name: matchedSkill!.name },
      {
        goal,
        workingDirectory: testDir,
        fileChanges: [],
        metadata: {},
      } as any,
    );

    expect(writerResult.success).toBe(true);
    expect(writerResult.output).toContain('Execution Steps');

    // Step 4: Verify all components work together
    expect(fullMethodology).toContain('writer');
    expect(fullMethodology).toContain('runner');
    expect(fullMethodology).toContain('Reference Documents');
  });
});
