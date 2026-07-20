/**
 * SkillRunnerAgent Unit Tests
 *
 * Covers:
 * 1. parseSkillReference — extracting skill name and params from task description
 * 2. resolveParameters — merging defaults, overrides, and required checks
 * 3. execute — discovering skills, injecting steps into task plan
 * 4. Edge cases — missing skills, missing params, malformed references
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillRunnerAgent } from '../../../src/agents/agents/skill-runner.js';
import type { AgentContext, LLMCallFn } from '../../../src/agents/agent.js';
import { getSkillStore, resetSkillStore } from '../../../src/learning/skill-store.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000;

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'test goal',
    workingDirectory: '/tmp',
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

/** Seed a test skill into the store */
function seedTestSkill(overrides: Record<string, unknown> = {}): void {
  const store = getSkillStore();
  store.save({
    id: 'skill-add-cli-command-abc123',
    name: 'Add CLI Command',
    description: 'Adds a new command to an existing CLI application',
    version: '1.0.0',
    goalPattern: 'Add a new CLI command to a project',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Scan codebase for CLI framework',
        promptTemplate: 'Find the CLI registration file format',
        dependsOn: [],
        expectedOutput: 'Context about CLI structure',
      },
      {
        agentType: 'writer',
        description: 'Create the new command file',
        promptTemplate: 'Create a {{commandName}} command with description: {{description}}',
        dependsOn: ['step-0'],
        expectedOutput: 'New command file created',
      },
      {
        agentType: 'reviewer',
        description: 'Review the implementation',
        dependsOn: ['step-1'],
        expectedOutput: 'Reviewed and approved',
      },
    ],
    parameters: [
      { name: 'commandName', description: 'The command name', type: 'string', required: true },
      { name: 'description', description: 'Command description', type: 'string', required: false, defaultValue: 'New command' },
    ],
    tags: ['cli', 'typescript'],
    sourceTrajectoryIds: ['traj-1', 'traj-2'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: NOW,
    lastUsedAt: NOW,
    ...overrides,
  } as any);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SkillRunnerAgent', () => {
  let runner: SkillRunnerAgent;
  let llmCallCount: number;

  beforeEach(() => {
    resetSkillStore();
    runner = new SkillRunnerAgent();
    llmCallCount = 0;
    getSkillStore().clear();
  });

  afterEach(() => {
    getSkillStore().clear();
    resetSkillStore();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(runner.name).toBe('SkillRunner');
    });

    it('should have correct description', () => {
      expect(runner.description).toContain('compiled skill');
    });
  });

  describe('parseSkillReference (private method via prototype)', () => {
    function parseRef(description: string) {
      return (runner as any).parseSkillReference.call(runner, description);
    }

    it('should parse simple skill reference', () => {
      const ref = parseRef('Run skill: my-skill');
      expect(ref).not.toBeNull();
      expect(ref!.skillName).toBe('my-skill');
      expect(ref!.params).toEqual({});
    });

    it('should parse skill reference with parameters', () => {
      const ref = parseRef('Run skill: AddCLI --commandName=deploy --description="Deploy command"');
      expect(ref).not.toBeNull();
      expect(ref!.skillName).toBe('AddCLI');
      expect(ref!.params.commandName).toBe('deploy');
      expect(ref!.params.description).toBe('Deploy command');
    });

    it('should parse skill reference with boolean flags (no value)', () => {
      const ref = parseRef('Run skill: test --verbose --force');
      expect(ref).not.toBeNull();
      expect(ref!.params.verbose).toBe('true');
      expect(ref!.params.force).toBe('true');
    });

    it('should parse case-insensitive "Run skill:" prefix', () => {
      const ref = parseRef('run SKILL: deploy-thing --env=prod');
      expect(ref).not.toBeNull();
      expect(ref!.skillName).toBe('deploy-thing');
      expect(ref!.params.env).toBe('prod');
    });

    it('should handle "Run:" without "skill:" as non-match', () => {
      const ref = parseRef('Run: echo hello');
      expect(ref).toBeNull();
    });

    it('should return null for description without skill reference', () => {
      const ref = parseRef('Just a normal task description');
      expect(ref).toBeNull();
    });

    it('should return null for empty string', () => {
      const ref = parseRef('');
      expect(ref).toBeNull();
    });

    it('should handle parameters with numeric values', () => {
      const ref = parseRef('Run skill: test --count=5 --port=8080');
      expect(ref).not.toBeNull();
      expect(ref!.params.count).toBe('5');
      expect(ref!.params.port).toBe('8080');
    });

    it('should handle quoted parameter values with spaces', () => {
      const ref = parseRef('Run skill: test --message="hello world" --name=simple');
      expect(ref).not.toBeNull();
      expect(ref!.params.message).toBe('hello world');
      expect(ref!.params.name).toBe('simple');
    });
  });

  describe('resolveParameters (private method via prototype)', () => {
    function resolve(skillOverrides: Record<string, unknown>, overrides: Record<string, string>) {
      const store = getSkillStore();
      store.clear();
      seedTestSkill(skillOverrides);
      const skill = store.getAll()[0];
      return (runner as any).resolveParameters.call(runner, skill, overrides);
    }

    it('should use provided values over defaults', () => {
      const params = resolve({}, { commandName: 'deploy' });
      expect(params.commandName).toBe('deploy');
    });

    it('should use defaults when values not provided', () => {
      const params = resolve({}, { commandName: 'deploy' });
      // description has defaultValue: 'New command'
      expect(params.description).toBe('New command');
    });

    it('should return empty string for required params without value or default', () => {
      const params = resolve({}, {});
      // commandName is required and has no default, so it should be ''
      expect(params.commandName).toBe('');
    });

    it('should handle empty overrides with all defaults', () => {
      const params = resolve({}, {});
      expect(params.description).toBe('New command'); // Has default
      expect(params.commandName).toBe(''); // Required, no default
    });

    it('should respect override over default', () => {
      const params = resolve({}, { commandName: 'custom', description: 'Custom description' });
      expect(params.commandName).toBe('custom');
      expect(params.description).toBe('Custom description');
    });
  });

  describe('execute', () => {
    const mockLLM: LLMCallFn = async () => {
      // Should not be called in normal flow — skill runner parses description
      throw new Error('Unexpected LLM call');
    };

    it('should inject skill steps into task plan on success', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command --commandName=deploy --description="Deploy to prod"',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Loaded skill');
      expect(result.summary).toContain('3 steps');

      // Should have injected 3 steps at the beginning of taskPlan
      expect(context.taskPlan).toHaveLength(3);
      expect(context.taskPlan[0].agentType).toBe('context-gatherer');
      expect(context.taskPlan[1].agentType).toBe('writer');
      expect(context.taskPlan[2].agentType).toBe('reviewer');

      // Step IDs should be prefixed with 'skill-step-'
      expect(context.taskPlan[0].id).toBe('skill-step-0');
      expect(context.taskPlan[1].id).toBe('skill-step-1');
    });

    it('should resolve parameter placeholders in prompt templates', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command --commandName=deploy --description="Deploy to prod"',
      });

      await runner.execute(context, mockLLM);

      // The writer step's promptTemplate has {{commandName}} and {{description}}
      const writerStep = context.taskPlan[1];
      expect(writerStep.description).toContain('deploy');
      expect(writerStep.description).toContain('Deploy to prod');
      // Should NOT contain the raw template placeholders
      expect(writerStep.description).not.toContain('{{commandName}}');
    });

    it('should set correct dependsOn for skill steps', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command --commandName=build',
      });

      await runner.execute(context, mockLLM);

      expect(context.taskPlan[0].dependsOn).toEqual([]); // First step has no deps
      expect(context.taskPlan[1].dependsOn).toEqual(['skill-step-0']); // Depends on step-0
      expect(context.taskPlan[2].dependsOn).toEqual(['skill-step-1']); // Depends on step-1
    });

    it('should mark skill as used in store', async () => {
      seedTestSkill();
      const before = getSkillStore().getAll()[0];
      expect(before.usageCount).toBe(0);

      const context = makeContext({
        goal: 'Run skill: Add CLI Command --commandName=test',
      });
      await runner.execute(context, mockLLM);

      const after = getSkillStore().getAll()[0];
      expect(after.usageCount).toBe(1);
    });

    it('should return failure when skill is not found', async () => {
      const context = makeContext({
        goal: 'Run skill: NonexistentSkill',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('not found');
      expect(result.error).toContain('NonexistentSkill');
    });

    it('should return failure when no skill reference found in description', async () => {
      const context = makeContext({
        goal: 'Just a normal task without a skill reference',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('No skill reference');
    });

    it('should return failure when required parameters are missing', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command', // No --commandName provided
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Missing required parameters');
      expect(result.error).toContain('commandName');
    });

    it('should find skill by name search when exact ID fails', async () => {
      seedTestSkill();
      // Use partial name match instead of exact ID
      const context = makeContext({
        goal: 'Run skill: Add CLI --commandName=deploy',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Add CLI Command');
    });

    it('should include parameter values in result details', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command --commandName=test --description="Testing"',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.details).toContain('commandName=test');
      expect(result.details).toContain('description=Testing');
      expect(result.details).toContain('Steps: 3');
    });

    it('should not modify task plan when failing due to missing params', async () => {
      seedTestSkill();
      const context = makeContext({
        goal: 'Run skill: Add CLI Command', // Missing required --commandName
        taskPlan: [{ id: 'existing-step', description: 'Existing', agentType: 'writer', dependsOn: [], status: 'pending' }],
      });

      await runner.execute(context, mockLLM);

      // Original task plan should be preserved
      expect(context.taskPlan).toHaveLength(1);
      expect(context.taskPlan[0].id).toBe('existing-step');
    });

    it('should return failure description in result', async () => {
      const context = makeContext({
        goal: 'Run skill: NonExistentSkill --param=value',
      });

      const result = await runner.execute(context, mockLLM);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });
});
