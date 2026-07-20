import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillCompiler, getSkillCompiler, resetSkillCompiler } from '../../src/learning/skill-compiler.js';
import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import type { Trajectory } from '../../src/memory/trajectory-store.js';
import type { LLMCallFn } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = 1_000_000_000_000;

function makeTrajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    id: 'traj-test-1',
    goal: 'test goal',
    projectFingerprint: 'typescript, node',
    taskPlan: [
      { id: 's1', description: 'Gather context', agentType: 'context-gatherer' },
      { id: 's2', description: 'Write code', agentType: 'writer' },
      { id: 's3', description: 'Review changes', agentType: 'reviewer' },
    ],
    contextFiles: ['src/index.ts'],
    fileChanges: [
      { path: 'src/index.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'created' },
    ],
    tasksCompleted: 3,
    tasksTotal: 3,
    score: 0.85,
    timestamp: NOW,
    ...overrides,
  };
}

/** A valid LLM response that returns a skill definition */
const VALID_COMPILATION_RESPONSE = JSON.stringify([
  {
    name: 'Add CLI Command',
    description: 'Adds a new command to an existing CLI application',
    version: '1.0.0',
    goalPattern: 'Add a new CLI command to a project using commander',
    tags: ['cli', 'typescript', 'node'],
    parameters: [
      {
        name: 'commandName',
        description: 'The name of the command',
        type: 'string',
        required: true,
      },
      {
        name: 'description',
        description: 'Short description',
        type: 'string',
        required: true,
        defaultValue: 'New command',
      },
    ],
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Scan the codebase to understand CLI framework',
        promptTemplate: 'Find the CLI registration file for {{commandName}}',
        dependsOn: [],
        expectedOutput: 'Context about CLI structure',
      },
      {
        agentType: 'writer',
        description: 'Create the new command',
        promptTemplate: 'Add {{commandName}} with description {{description}}',
        dependsOn: ['step-0'],
        expectedOutput: 'New command file created',
      },
    ],
  },
]);

/** LLM response with multiple skills */
const MULTI_SKILL_RESPONSE = JSON.stringify([
  {
    name: 'Add CLI Command',
    description: 'Adds CLI command',
    version: '1.0.0',
    goalPattern: 'Add CLI command',
    tags: ['cli'],
    parameters: [{ name: 'name', description: 'Command name', type: 'string', required: true }],
    steps: [{ agentType: 'writer', description: 'Write code', dependsOn: [] }],
  },
  {
    name: 'Create API Route',
    description: 'Creates API endpoint',
    version: '1.0.0',
    goalPattern: 'Create REST API',
    tags: ['api'],
    parameters: [{ name: 'route', description: 'Route path', type: 'string', required: true }],
    steps: [
      { agentType: 'writer', description: 'Create route', dependsOn: [] },
      { agentType: 'reviewer', description: 'Review route', dependsOn: ['step-0'] },
    ],
  },
]);

/** Invalid LLM responses */
const NON_JSON_RESPONSE = 'I analyzed the trajectories and here are my thoughts...';
const EMPTY_ARRAY_RESPONSE = '[]';
const MALFORMED_JSON = 'This is not valid JSON at all [[[';
const NON_ARRAY_JSON = '{"type": "not-an-array"}';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SkillCompiler', () => {
  let compiler: SkillCompiler;

  beforeEach(() => {
    resetSkillCompiler();
    resetSkillStore();
    compiler = new SkillCompiler();
    getSkillStore().clear();
  });

  afterEach(() => {
    getSkillStore().clear();
    resetSkillStore();
    resetSkillCompiler();
  });

  describe('compile', () => {
    it('should compile skills from valid trajectories and LLM response', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2', score: 0.9 })];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(1);
      expect(result.updatedSkills).toHaveLength(0);
      expect(result.sourceTrajectoryCount).toBe(2);
      expect(result.avgSourceScore).toBeCloseTo(0.875, 2);

      const skill = result.newSkills[0];
      expect(skill.name).toBe('Add CLI Command');
      expect(skill.version).toBe('1.0.0');
      expect(skill.steps).toHaveLength(2);
      expect(skill.parameters).toHaveLength(2);
      expect(skill.tags).toEqual(['cli', 'typescript', 'node']);
      expect(skill.qualityScore).toBeCloseTo(0.875, 2);
    });

    it('should update existing skills with matching names', async () => {
      // First compilation
      const mockLLM1: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;
      await compiler.compile([makeTrajectory(), makeTrajectory({ id: 'traj-2', score: 0.9 })], mockLLM1, false);

      // Second compilation with same skill name (different response)
      const updateResponse = JSON.stringify([
        {
          name: 'Add CLI Command',
          description: 'Updated description',
          version: '1.0.0',
          goalPattern: 'Updated goal pattern',
          tags: ['cli', 'node'],
          parameters: [{ name: 'name', description: 'Command name', type: 'string', required: true }],
          steps: [
            { agentType: 'writer', description: 'Write', dependsOn: [] },
            { agentType: 'reviewer', description: 'Review', dependsOn: ['step-0'] },
          ],
        },
      ]);
      const mockLLM2: LLMCallFn = async () => updateResponse;
      const result = await compiler.compile([makeTrajectory({ score: 0.8 }), makeTrajectory({ id: 'traj-3', score: 0.9 })], mockLLM2, false);

      // Should have updated, not created new
      expect(result.newSkills).toHaveLength(0);
      expect(result.updatedSkills).toHaveLength(1);
      expect(result.updatedSkills[0].name).toBe('Add CLI Command');
      expect(result.updatedSkills[0].description).toBe('Updated description');

      // Version should be bumped
      expect(result.updatedSkills[0].version).toBe('1.0.1');
    });

    it('should extract multiple skills in a single pass', async () => {
      const trajectories = [
        makeTrajectory({ goal: 'add CLI', projectFingerprint: 'node, cli', score: 0.9 }),
        makeTrajectory({ id: 'traj-api', goal: 'create REST API', projectFingerprint: 'node, api', score: 0.85 }),
      ];
      const mockLLM: LLMCallFn = async () => MULTI_SKILL_RESPONSE;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(2);
      const names = result.newSkills.map((s) => s.name);
      expect(names).toContain('Add CLI Command');
      expect(names).toContain('Create API Route');
    });

    it('should return empty result when trajectories are below score threshold', async () => {
      const lowScore = [makeTrajectory({ score: 0.3 }), makeTrajectory({ id: 'traj-low', score: 0.2 })];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(lowScore, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
      expect(result.sourceTrajectoryCount).toBe(0);
    });

    it('should return empty result when fewer than 2 trajectories', async () => {
      const single = [makeTrajectory()];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(single, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
    });

    it('should handle LLM returning non-JSON response gracefully', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => NON_JSON_RESPONSE;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
      expect(result.updatedSkills).toHaveLength(0);
      expect(result.avgSourceScore).toBe(0);
    });

    it('should handle LLM returning empty array', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => EMPTY_ARRAY_RESPONSE;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
    });

    it('should handle LLM returning malformed JSON', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => MALFORMED_JSON;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
    });

    it('should handle LLM returning non-array JSON', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => NON_ARRAY_JSON;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
    });

    it('should handle LLM throwing an error', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => { throw new Error('API error'); };

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(0);
      expect(result.sourceTrajectoryCount).toBe(0);
    });

    it('should handle JSON in code blocks', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const responseWithCodeBlock = '```json\n' + VALID_COMPILATION_RESPONSE + '\n```';
      const mockLLM: LLMCallFn = async () => responseWithCodeBlock;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(1);
      expect(result.newSkills[0].name).toBe('Add CLI Command');
    });

    it('should handle JSON in code blocks without language tag', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const response = '```\n' + VALID_COMPILATION_RESPONSE + '\n```';
      const mockLLM: LLMCallFn = async () => response;

      const result = await compiler.compile(trajectories, mockLLM, false);

      expect(result.newSkills).toHaveLength(1);
    });

    it('should persist compiled skills to SkillStore', async () => {
      const trajectories = [makeTrajectory(), makeTrajectory({ id: 'traj-2' })];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      await compiler.compile(trajectories, mockLLM, false);

      const store = getSkillStore();
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Add CLI Command');
    });

    it('should use only trajectories above quality threshold', async () => {
      const mixed = [
        makeTrajectory({ score: 0.9 }),
        makeTrajectory({ id: 'traj-2', score: 0.3 }), // Below threshold
        makeTrajectory({ id: 'traj-3', score: 0.85 }),
      ];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(mixed, mockLLM, false);

      // Should only use the two trajectories above threshold
      expect(result.sourceTrajectoryCount).toBe(2);
      // Should still succeed because 2 high-scoring >= MIN_TRAJECTORIES_FOR_COMPILATION (2)
      expect(result.newSkills).toHaveLength(1);
    });

    it('should respect max trajectories limit', async () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        makeTrajectory({ id: `traj-${i}`, score: 0.9 - i * 0.01 })
      );
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(many, mockLLM, false);

      // Should cap at MAX_TRAJECTORIES_FOR_COMPILATION (5)
      expect(result.sourceTrajectoryCount).toBeLessThanOrEqual(5);
    });

    it('should set sourceTrajectoryIds correctly', async () => {
      const trajectories = [
        makeTrajectory({ id: 'traj-source-1', score: 0.9 }),
        makeTrajectory({ id: 'traj-source-2', score: 0.8 }),
      ];
      const mockLLM: LLMCallFn = async () => VALID_COMPILATION_RESPONSE;

      const result = await compiler.compile(trajectories, mockLLM, false);

      const skill = result.newSkills[0];
      expect(skill.sourceTrajectoryIds).toContain('traj-source-1');
      expect(skill.sourceTrajectoryIds).toContain('traj-source-2');
    });

    it('should set reasonable defaults for missing steps dependsOn', async () => {
      const responseWithMissingDeps = JSON.stringify([
        {
          name: 'Simple Skill',
          description: 'Simple',
          version: '1.0.0',
          goalPattern: 'Simple task',
          tags: ['test'],
          parameters: [],
          steps: [
            { agentType: 'writer', description: 'Write code' }, // No dependsOn
            { agentType: 'reviewer', description: 'Review' },   // No dependsOn
          ],
        },
      ]);
      const mockLLM: LLMCallFn = async () => responseWithMissingDeps;

      const result = await compiler.compile(
        [makeTrajectory(), makeTrajectory({ id: 'traj-2' })],
        mockLLM,
        false,
      );

      expect(result.newSkills).toHaveLength(1);
      const skill = result.newSkills[0];
      expect(skill.steps[0].dependsOn).toEqual([]);
      expect(skill.steps[1].dependsOn).toEqual(['step-0']); // Auto-assigned
    });
  });

  describe('formatSkill', () => {
    it('should format a skill with basic info', () => {
      const skill = {
        id: 'test-1',
        name: 'Test Skill',
        description: 'A test skill',
        version: '1.0.0',
        goalPattern: 'Test things',
        tags: ['test'],
        parameters: [],
        steps: [{ agentType: 'writer', description: 'Write', dependsOn: [] }],
        sourceTrajectoryIds: ['traj-1'],
        qualityScore: 0.85,
        usageCount: 3,
        createdAt: NOW,
        lastUsedAt: NOW,
      };

      const formatted = SkillCompiler.formatSkill(skill);
      expect(formatted).toContain('Test Skill');
      expect(formatted).toContain('v1.0.0');
      expect(formatted).toContain('85%');
      expect(formatted).toContain('3x');
    });

    it('should include detailed info when detailed=true', () => {
      const skill = {
        id: 'test-1',
        name: 'Test Skill',
        description: 'A test',
        version: '1.0.0',
        goalPattern: 'Test',
        tags: ['test'],
        parameters: [
          { name: 'param1', description: 'First param', type: 'string', required: true },
          { name: 'param2', description: 'Second param', type: 'string', required: false, defaultValue: 'val' },
        ],
        steps: [
          { agentType: 'writer', description: 'Write code', promptTemplate: 'Write {{param1}}', dependsOn: [] },
          { agentType: 'reviewer', description: 'Review', dependsOn: ['step-0'] },
        ],
        sourceTrajectoryIds: ['traj-1'],
        qualityScore: 0.9,
        usageCount: 1,
        createdAt: NOW,
        lastUsedAt: NOW,
      };

      const formatted = SkillCompiler.formatSkill(skill, true);
      expect(formatted).toContain('Parameters:');
      expect(formatted).toContain('param1');
      expect(formatted).toContain('param2');
      expect(formatted).toContain('Steps:');
      expect(formatted).toContain('[writer]');
      expect(formatted).toContain('[reviewer]');
    });
  });

  describe('formatSkillList', () => {
    it('should return a formatted table of skills', () => {
      const skills = [
        {
          id: 's1', name: 'Skill One', description: 'First', version: '1.0', goalPattern: 'pattern1',
          tags: ['cli'], parameters: [], steps: [{ agentType: 'writer', description: 'Write', dependsOn: [] }],
          sourceTrajectoryIds: [], qualityScore: 0.9, usageCount: 5, createdAt: NOW, lastUsedAt: NOW,
        },
        {
          id: 's2', name: 'Skill Two', description: 'Second', version: '2.0', goalPattern: 'pattern2',
          tags: ['api'], parameters: [], steps: [{ agentType: 'writer', description: 'Do', dependsOn: [] }],
          sourceTrajectoryIds: [], qualityScore: 0.7, usageCount: 2, createdAt: NOW, lastUsedAt: NOW,
        },
      ];

      const formatted = SkillCompiler.formatSkillList(skills);
      expect(formatted).toContain('2 Skill(s)');
      expect(formatted).toContain('Skill One');
      expect(formatted).toContain('Skill Two');
      expect(formatted).toContain('90%');
      expect(formatted).toContain('70%');
      expect(formatted).toContain('buff skill show');
      expect(formatted).toContain('buff skill run');
    });

    it('should return empty message when list is empty', () => {
      const formatted = SkillCompiler.formatSkillList([]);
      expect(formatted).toContain('No skills compiled');
      expect(formatted).toContain('--use-memory');
    });
  });
});
