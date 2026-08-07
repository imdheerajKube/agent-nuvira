import { describe, it, expect } from 'vitest';
import { PlannerAgent } from '../../../src/agents/agents/planner.js';

describe('PlannerAgent', () => {
  let planner: PlannerAgent;

  beforeEach(() => {
    planner = new PlannerAgent();
  });

  describe('parsePlan (private method access via prototype)', () => {
    const parse = (response: string) =>
      (planner as any).parsePlan.call(planner, response);

    // ─── Direct JSON ────────────────────────────────────────────────────

    it('should parse direct JSON array', () => {
      const json = JSON.stringify([
        { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] },
        { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'] },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('step-1');
      expect(result[1].dependsOn).toEqual(['step-1']);
    });

    it('should parse JSON with numeric IDs', () => {
      const json = JSON.stringify([
        { id: 1, description: 'First step', agentType: 'context-gatherer', dependsOn: [] },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1); // Raw parse — normalization happens in execute() 
    });

    it('should parse JSON with null dependsOn', () => {
      const json = JSON.stringify([
        { id: 'step-1', description: 'First', agentType: 'writer', dependsOn: null },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(1);
      expect(result[0].dependsOn).toBeNull(); // Raw parse preserves null
    });

    it('should parse JSON with empty array', () => {
      const result = parse('[]');
      expect(result).toEqual([]);
    });

    // ─── Code Block JSON ────────────────────────────────────────────────

    it('should parse JSON from ```json code block', () => {
      const response = 'Some text\n\n```json\n[\n  { "id": "step-1", "description": "Gather", "agentType": "context-gatherer", "dependsOn": [] }\n]\n```\n\nMore text';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('step-1');
    });

    it('should parse JSON from ``` code block without language', () => {
      const response = '```\n[{"id": "s1", "description": "Desc", "agentType": "writer", "dependsOn": []}]\n```';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('Desc');
    });

    // ─── Fallback Array ─────────────────────────────────────────────────

    it('should find JSON array anywhere in the response', () => {
      const response = 'Here is the plan:\n[{"id":"s1","description":"Do thing","agentType":"writer","dependsOn":[]}]\nThat is all.';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s1');
    });

    // ─── Edge Cases ─────────────────────────────────────────────────────

    it('should return empty array for completely invalid response', () => {
      const result = parse('This is not JSON at all. No arrays here.');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      const result = parse('{"key": "value"}');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty string', () => {
      const result = parse('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only string', () => {
      const result = parse('   \n\n   ');
      expect(result).toEqual([]);
    });

    it('should return empty array for single-quoted invalid JSON', () => {
      // Some LLMs return single quotes instead of double quotes, which JSON.parse rejects.
      // The fallback strategies should still return an empty array (not throw).
      const response = "[{id: 's1', description: 'Desc', agentType: 'writer', dependsOn: []}]";
      const result = parse(response);
      expect(result).toEqual([]);
    });
  });

  describe('execute response normalization (via test agent behavior)', () => {
    it('should normalize numeric IDs to strings', async () => {
      const context = {
        goal: 'test goal',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      // Mock LLM to return JSON with numeric id and null dependsOn
      const mockLLM = async () => JSON.stringify([
        { id: 1, description: 'Step one', agentType: 'context-gatherer', dependsOn: null },
      ]);

      const result = await planner.execute(context, mockLLM as any);

      expect(result.success).toBe(true);
      // After normalization in execute(), the plan should have string IDs and empty dependsOn
      expect(context.taskPlan).toHaveLength(1);
      expect(context.taskPlan[0].id).toBe('1'); // Numeric normalized to string
      expect(context.taskPlan[0].dependsOn).toEqual([]); // null normalized to []
    });

    it('should normalize single string dependsOn to array', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 's1', description: 'Do', agentType: 'writer', dependsOn: 'parent-step' },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan[0].dependsOn).toEqual(['parent-step']);
    });

    it('should filter out steps missing required fields', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { description: 'Missing id and agentType' }, // Missing id and agentType
        { id: 'valid', description: 'Valid step', agentType: 'writer', dependsOn: [] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan).toHaveLength(1);
      expect(context.taskPlan[0].id).toBe('valid');
    });

    it('should return failure when no valid steps remain after filtering', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => '["invalid", "data"]';

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.summary).toContain('empty or invalid');
      expect(context.taskPlan).toHaveLength(0);
    });

    it('should handle LLM throwing an error', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => { throw new Error('API timeout'); };

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('API timeout');
    });

    // ─── Goal-fidelity guard (assessment P0) ────────────────────────────
    // These reproduce the observed NVDA-addon failure: the model regurgitated
    // the few-shot example (JWT/sync routes) for an unrelated goal and the
    // pipeline "succeeded" while building the wrong thing. The guard must
    // reject plans that share no significant goal token.

    it('should REJECT a plan that copies the example for an unrelated goal (NVDA addon case)', async () => {
      const context = {
        goal: 'create an NVDA addon compatible with NVDA 2026.1 that says Hello Anuj when the user presses NVDA key+alt+1 and build it',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      // The exact verbatim example-copy that the real model returned:
      // JWT auth steps for an NVDA addon goal.
      const mockLLM = async () => JSON.stringify([
        { id: 'step-01-understand', description: 'Scan the codebase to understand the current project structure and identify files related to the inventory sync feature', agentType: 'context-gatherer', dependsOn: [] },
        { id: 'step-02-add-routes', description: 'Create the inventory sync endpoint in src/sync/inventory.ts that reads the local catalog and reconciles it with the remote store', agentType: 'writer', dependsOn: ['step-01-understand'] },
        { id: 'step-04-security-scan', description: 'Scan the new sync code for PII and injection vulnerabilities', agentType: 'security', dependsOn: ['step-02-add-routes'] },
        { id: 'step-05-review', description: 'Review all changes for correctness, security, and code quality', agentType: 'reviewer', dependsOn: ['step-02-add-routes'] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('unrelated');
      expect(result.error).toContain('nvda');
      expect(context.taskPlan).toHaveLength(0); // nothing scheduled
    });

    it('should REJECT a plan that ignores the goal domain entirely', async () => {
      const context = {
        goal: 'add a dark mode toggle to the settings page',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 's1', description: 'Set up database connection pool', agentType: 'writer', dependsOn: [] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('unrelated');
      expect(context.taskPlan).toHaveLength(0);
    });

    it('should ACCEPT a faithful plan that references the goal domain (NVDA addon case)', async () => {
      const context = {
        goal: 'create an NVDA addon compatible with NVDA 2026.1 that says Hello Anuj when the user presses NVDA key+alt+1 and build it',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 'step-01-create-manifest', description: 'Create manifest.ini declaring the NVDA addon metadata for NVDA 2026.1', agentType: 'writer', dependsOn: [] },
        { id: 'step-02-create-addon-script', description: 'Create the addon Python script with a global plugin that speaks Hello Anuj when NVDA key+alt+1 is pressed', agentType: 'writer', dependsOn: ['step-01-create-manifest'] },
        { id: 'step-03-review', description: 'Review the addon for NVDA 2026.1 compatibility', agentType: 'reviewer', dependsOn: ['step-02-create-addon-script'] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan).toHaveLength(3);
    });

    it('should REJECT an example-copy plan even for a SHORT 1-token goal (run-2 NVDA case)', async () => {
      // The user's second run: goal was literally "create the addon" (1
      // significant token: "addon") and the model regurgitated the JWT/sync
      // example verbatim. The example-copy marker check must catch it.
      const context = {
        goal: 'create the addon',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 'step-01-understand', description: 'Scan the codebase to understand the current project structure and identify files related to the inventory sync feature', agentType: 'context-gatherer', dependsOn: [] },
        { id: 'step-02-add-routes', description: 'Create the inventory sync endpoint in src/sync/inventory.ts', agentType: 'writer', dependsOn: ['step-01-understand'] },
        { id: 'step-04-security-scan', description: 'Scan the new sync code for PII and injection vulnerabilities', agentType: 'security', dependsOn: ['step-02-add-routes'] },
        { id: 'step-05-review', description: 'Review all changes for correctness, security, and code quality', agentType: 'reviewer', dependsOn: ['step-02-add-routes'] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('unrelated');
      expect(context.taskPlan).toHaveLength(0);
    });

    it('should ACCEPT a faithful 1-token-goal plan that is NOT an example copy', async () => {
      const context = {
        goal: 'create the addon',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 's1', description: 'Create manifest.ini for the NVDA addon', agentType: 'writer', dependsOn: [] },
        { id: 's2', description: 'Write the addon plugin script with the greeting speech', agentType: 'writer', dependsOn: ['s1'] },
        { id: 's3', description: 'Review the addon files', agentType: 'reviewer', dependsOn: ['s2'] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan).toHaveLength(3);
    });

    it('should NOT block a plan when the goal has no significant tokens (vague goal)', async () => {
      const context = {
        goal: 'help me make it work',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 's1', description: 'Investigate the current behavior', agentType: 'context-gatherer', dependsOn: [] },
        { id: 's2', description: 'Apply the fix and verify', agentType: 'writer', dependsOn: ['s1'] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan).toHaveLength(2);
    });

    it('should include memory context when present in metadata', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: { memoryContext: '## Similar Past Task\nGoal: similar task\nPlan:\n[{"id":"prev","description":"Previous","agentType":"writer","dependsOn":[]}]\n' },
      } as any;

      let capturedPrompt = '';
      const mockLLM = async (prompt: string) => {
        capturedPrompt = prompt;
        return JSON.stringify([
          { id: 's1', description: 'New step', agentType: 'writer', dependsOn: [] },
        ]);
      };

      await planner.execute(context, mockLLM as any);
      expect(capturedPrompt).toContain('Similar Past Task');
      expect(capturedPrompt).toContain('senior software architect');
    });

    it('should instruct the model to emit parallel-friendly plans (independent steps run concurrently)', async () => {
      const context = {
        goal: 'add auth',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      let capturedPrompt = '';
      const mockLLM = async (prompt: string) => {
        capturedPrompt = prompt;
        return JSON.stringify([
          { id: 's1', description: 'Write', agentType: 'writer', dependsOn: [] },
        ]);
      };

      await planner.execute(context, mockLLM as any);
      expect(capturedPrompt).toContain('PARALLELISM');
      expect(capturedPrompt).toContain('independent steps run CONCURRENTLY');
      expect(capturedPrompt).toContain('run at the same');
      // The example plan must show the parallel pattern (multiple writers +
      // a shared review/security pass depending on all of them).
      expect(capturedPrompt).toContain('step-04-security-scan');
      expect(capturedPrompt).toContain('so the engine runs them in');
      expect(capturedPrompt).toContain('PARALLEL;');
    });

    it('should inject the pre-flight inspection digest when present in metadata', async () => {
      const context = {
        goal: 'add auth',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {
          projectInspection: 'Project type: Node.js\n42 source files · 8 test files found',
        },
      } as any;

      let capturedPrompt = '';
      const mockLLM = async (prompt: string) => {
        capturedPrompt = prompt;
        return JSON.stringify([
          { id: 's1', description: 'Write', agentType: 'writer', dependsOn: [] },
        ]);
      };

      await planner.execute(context, mockLLM as any);
      expect(capturedPrompt).toContain('Pre-flight Project Inspection');
      expect(capturedPrompt).toContain('42 source files · 8 test files found');
    });

    it('should inject routing guidance into the prompt when verification intent is detected', async () => {
      const context = {
        goal: 'verify a bug fix',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {
          routingContext: {
            taskProfile: {
              intent: 'verification',
              requiresVerification: true,
              notes: ['Validate the result carefully'],
            },
            explanation: 'Verification-heavy task should include an explicit validation step.',
            escalationApplied: true,
          },
        },
      } as any;

      let capturedPrompt = '';
      const mockLLM = async (prompt: string) => {
        capturedPrompt = prompt;
        return JSON.stringify([
          { id: 's1', description: 'Implement the fix', agentType: 'writer', dependsOn: [] },
        ]);
      };

      await planner.execute(context, mockLLM as any);

      expect(capturedPrompt).toContain('verification');
      expect(capturedPrompt).toContain('validation step');
      expect(capturedPrompt).toContain('reviewer');
    });
  });

  describe('metadata', () => {
    it('should have correct name and description', () => {
      expect(planner.name).toBe('Planner');
      expect(planner.description).toContain('execution plans');
    });
  });
});
