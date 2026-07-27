/**
 * Unit tests for DefaultPlanModule — goal decomposition, LLM response parsing,
 * step normalization, and EventBus integration.
 *
 * Coverage goals:
 * - plan() — happy path with callLLM, fallback without callLLM
 * - parsePlan() — direct JSON, code block, array extraction, malformed responses
 * - normalizeSteps() — numeric IDs, null dependsOn, mixed formats
 * - EventBus emissions — PLAN_STARTED, PLAN_STEP_CREATED, PLAN_COMPLETED
 * - Edge cases — empty response, invalid JSON, empty steps
 * - Constructor — default and with custom event bus
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DefaultPlanModule } from '../../src/agents/plan-module.js';
import type { PlanParams } from '../../src/agents/plan-module.js';
import { EventBus } from '../../src/observability/event-bus.js';

// ─── Mock Helpers ───────────────────────────────────────────────────────────

/** A mock LLMCallFn that returns a JSON array of task steps */
function mockLLMSuccess(stepsJson: string): () => Promise<string> {
  return vi.fn().mockResolvedValue(stepsJson);
}

/** A mock LLMCallFn that rejects with an error */
function mockLLMFailure(): () => Promise<string> {
  return vi.fn().mockRejectedValue(new Error('LLM API error'));
}

/** A mock LLMCallFn that returns invalid (non-JSON) text */
function mockLLMInvalidResponse(): () => Promise<string> {
  return vi.fn().mockResolvedValue('I think the plan should be to implement auth first, then tests.');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<PlanParams> = {}): PlanParams {
  return {
    goal: 'Implement JWT authentication',
    workingDirectory: '/test/project',
    callLLM: mockLLMSuccess(JSON.stringify([
      {
        id: 'step-01-gather-context',
        description: 'Understand the codebase for auth',
        agentType: 'context-gatherer',
        dependsOn: [],
      },
      {
        id: 'step-02-auth-routes',
        description: 'Create JWT auth routes',
        agentType: 'writer',
        dependsOn: ['step-01-gather-context'],
      },
      {
        id: 'step-03-review',
        description: 'Review auth changes',
        agentType: 'reviewer',
        dependsOn: ['step-02-auth-routes'],
      },
    ])),
    projectFileTree: '📄 src/index.ts\n📄 src/auth.ts',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DefaultPlanModule', () => {
  let module: DefaultPlanModule;

  beforeEach(() => {
    module = new DefaultPlanModule();
  });

  // ── plan() — with callLLM ────────────────────────────────────────────

  describe('plan() — with callLLM', () => {
    it('should produce steps from LLM response', async () => {
      const result = await module.plan(makeParams());

      expect(result.stepCount).toBe(3);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].agentType).toBe('context-gatherer');
      expect(result.steps[1].agentType).toBe('writer');
      expect(result.steps[2].agentType).toBe('reviewer');
    });

    it('should include correct step metadata', async () => {
      const result = await module.plan(makeParams());

      expect(result.steps[0].id).toBe('step-01-gather-context');
      expect(result.steps[0].description).toContain('Understand the codebase');
      expect(result.steps[0].dependsOn).toEqual([]);
      expect(result.steps[0].status).toBe('pending');
    });

    it('should respect dependency order', async () => {
      const result = await module.plan(makeParams());

      expect(result.steps[1].dependsOn).toContain('step-01-gather-context');
      expect(result.steps[2].dependsOn).toContain('step-02-auth-routes');
    });

    it('should return a human-readable summary', async () => {
      const result = await module.plan(makeParams());

      expect(result.summary).toContain('Created 3 task steps');
    });

    it('should pass the goal into the LLM prompt', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify([]));
      await module.plan(makeParams({ callLLM }));

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('Implement JWT authentication');
    });

    it('should pass the project file tree into the LLM prompt', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify([]));
      await module.plan(makeParams({ callLLM, projectFileTree: '📄 src/routes.ts\n📄 src/middleware.ts' }));

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('src/routes.ts');
      expect(prompt).toContain('src/middleware.ts');
    });

    it('should pass memory context into the LLM prompt', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify([]));
      await module.plan(makeParams({ callLLM, memoryContext: 'Previous session: added npm packages' }));

      const prompt = callLLM.mock.calls[0][0] as string;
      expect(prompt).toContain('Previous session:');
    });

    it('should use low temperature for structured output', async () => {
      const callLLM = vi.fn().mockResolvedValue(JSON.stringify([]));
      await module.plan(makeParams({ callLLM }));

      const options = callLLM.mock.calls[0][1] as Record<string, unknown>;
      expect(options.temperature).toBe(0.3);
    });

    it('should handle LLM returning empty array gracefully', async () => {
      const callLLM = mockLLMSuccess('[]');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(0);
      expect(result.steps).toHaveLength(0);
      expect(result.summary).toContain('empty');
    });
  });

  // ── plan() — without callLLM (fallback) ──────────────────────────────

  describe('plan() — without callLLM', () => {
    it('should return a fallback plan with a single writer step', async () => {
      const result = await module.plan({
        goal: 'Add input validation',
        workingDirectory: '/test',
        callLLM: undefined,
      });

      expect(result.stepCount).toBe(1);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].agentType).toBe('writer');
      expect(result.steps[0].description).toBe('Add input validation');
    });

    it('should set the fallback step as pending', async () => {
      const result = await module.plan({
        goal: 'Fix bug',
        workingDirectory: '/test',
      });

      expect(result.steps[0].status).toBe('pending');
    });
  });

  // ── parsePlan — Direct JSON ──────────────────────────────────────────

  describe('parsePlan (via plan() - direct JSON)', () => {
    it('should parse valid JSON array directly', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 'step-01', description: 'Do something', agentType: 'writer', dependsOn: [] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
      expect(result.steps[0].id).toBe('step-01');
    });

    it('should parse JSON arrays with extra whitespace', async () => {
      const callLLM = mockLLMSuccess('  \n\n[\n  {\n    "id": "step-01",\n    "description": "Write code",\n    "agentType": "writer",\n    "dependsOn": []\n  }\n]\n\n  ');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
    });
  });

  // ── parsePlan — Code block extraction ────────────────────────────────

  describe('parsePlan (via plan() - code block)', () => {
    it('should extract JSON from markdown code block (```json)', async () => {
      const callLLM = mockLLMSuccess('```json\n[\n  {"id": "s1", "description": "Code", "agentType": "writer", "dependsOn": []}\n]\n```');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
      expect(result.steps[0].id).toBe('s1');
    });

    it('should extract JSON from bare code block (```)', async () => {
      const callLLM = mockLLMSuccess('```\n[{"id": "s1", "description": "Code", "agentType": "writer", "dependsOn": []}]\n```');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
    });

    it('should extract JSON from code block with extra text', async () => {
      const callLLM = mockLLMSuccess('Here is my plan:\n```json\n[{"id": "s1", "description": "Code", "agentType": "writer", "dependsOn": []}]\n```\nLet me know if you need changes.');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
    });
  });

  // ── parsePlan — Array extraction fallback ────────────────────────────

  describe('parsePlan (via plan() - array extraction)', () => {
    it('should extract JSON array from text without code block', async () => {
      const callLLM = mockLLMSuccess('The relevant files are: [{"id": "s1", "description": "Do it", "agentType": "writer", "dependsOn": []}]');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
    });

    it('should handle array extraction with explanatory text before and after', async () => {
      const callLLM = mockLLMSuccess('Based on the requirements, I suggest:\n[{"id": "s1", "description": "Implement", "agentType": "writer", "dependsOn": []}]\nThis should address the issue.');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
    });
  });

  // ── parsePlan — Malformed responses ──────────────────────────────────

  describe('parsePlan (via plan() - malformed)', () => {
    it('should return empty steps for non-JSON response', async () => {
      const callLLM = mockLLMInvalidResponse();
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(0);
      expect(result.steps).toHaveLength(0);
    });

    it('should handle LLM API failure gracefully', async () => {
      const callLLM = mockLLMFailure();
      // Without a try-catch in the module, the error propagates
      await expect(module.plan(makeParams({ callLLM }))).rejects.toThrow('LLM API error');
    });

    it('should return empty for incomplete JSON (missing closing bracket)', async () => {
      const callLLM = mockLLMSuccess('[{"id": "s1", "description": "X", "agentType": "writer", "dependsOn": []}');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(0);
    });

    it('should handle response that is just a number (not array)', async () => {
      const callLLM = mockLLMSuccess('42');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(0);
    });

    it('should handle response that is null', async () => {
      const callLLM = mockLLMSuccess('null');
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(0);
    });
  });

  // ── normalizeSteps — LLM quirks ─────────────────────────────────────

  describe('normalizeSteps (via plan() - LLM quirks)', () => {
    it('should convert numeric step IDs to strings', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 1, description: 'Step 1', agentType: 'writer', dependsOn: [] },
        { id: 2, description: 'Step 2', agentType: 'reviewer', dependsOn: [1] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.steps[0].id).toBe('1'); // Number → String
      expect(result.steps[1].dependsOn).toEqual(['1']);
    });

    it('should handle null dependsOn', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Step 1', agentType: 'writer', dependsOn: null },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.steps[0].dependsOn).toEqual([]);
    });

    it('should handle missing dependsOn field', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Step 1', agentType: 'writer' },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.steps[0].dependsOn).toEqual([]);
    });

    it('should handle dependsOn as single string', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'First', agentType: 'writer', dependsOn: [] },
        { id: 's2', description: 'Second', agentType: 'reviewer', dependsOn: 's1' },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(Array.isArray(result.steps[1].dependsOn)).toBe(true);
      expect(result.steps[1].dependsOn).toEqual(['s1']);
    });

    it('should handle missing id field by generating one', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { description: 'Do something', agentType: 'writer', dependsOn: [] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.steps[0].id).toBeTruthy();
      expect(result.steps[0].id).toContain('step-');
    });

    it('should skip steps missing required fields', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Valid step', agentType: 'writer', dependsOn: [] },
        { id: 's2', description: 'Missing agent type' },
        { id: 's3', agentType: 'writer', dependsOn: [] }, // missing description
        { id: 's4', description: 'Another valid', agentType: 'reviewer', dependsOn: [] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(2);
      expect(result.steps[0].id).toBe('s1');
      expect(result.steps[1].id).toBe('s4');
    });

    it('should handle empty dependsOn arrays', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'First', agentType: 'writer', dependsOn: [] },
        { id: 's2', description: 'Second', agentType: 'reviewer', dependsOn: [] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.steps[0].dependsOn).toEqual([]);
      expect(result.steps[1].dependsOn).toEqual([]);
    });

    it('should handle null step entries in array', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        null,
        { id: 's1', description: 'Valid', agentType: 'writer', dependsOn: [] },
        undefined,
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      expect(result.stepCount).toBe(1);
      expect(result.steps[0].id).toBe('s1');
    });

    it('should handle mix of valid and invalid agent types', async () => {
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] },
        { id: 's2', description: 'Write code', agentType: 'writer', dependsOn: ['s1'] },
        { id: 's3', description: 'Deploy', agentType: 'deployer', dependsOn: ['s2'] },
      ]));
      const result = await module.plan(makeParams({ callLLM }));

      // All should be accepted (no validation on agentType values in normalizeSteps)
      expect(result.stepCount).toBe(3);
    });
  });

  // ── Constructor ─────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create an instance without event bus', () => {
      expect(new DefaultPlanModule()).toBeInstanceOf(DefaultPlanModule);
    });

    it('should accept undefined event bus', () => {
      expect(new DefaultPlanModule(undefined)).toBeInstanceOf(DefaultPlanModule);
    });

    it('should accept a custom event bus', () => {
      const bus = new EventBus();
      const mod = new DefaultPlanModule(bus);
      expect(mod).toBeInstanceOf(DefaultPlanModule);
    });
  });

  // ── Event Bus Emissions ─────────────────────────────────────────────

  describe('event bus emissions — plan()', () => {
    it('should emit PLAN_STARTED event when planning starts', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Do it', agentType: 'writer', dependsOn: [] },
      ]));

      await mod.plan(makeParams({ callLLM }));

      const startedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'plan:started');
      expect(startedEvents.length).toBeGreaterThanOrEqual(1);
      const payload = startedEvents[0][1] as Record<string, unknown>;
      expect(payload.goal).toBe('Implement JWT authentication');
    });

    it('should emit PLAN_COMPLETED event when planning finishes', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Do it', agentType: 'writer', dependsOn: [] },
      ]));

      await mod.plan(makeParams({ callLLM }));

      const completedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'plan:completed');
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      const payload = completedEvents[0][1] as Record<string, unknown>;
      expect(payload.stepCount).toBe(1);
    });

    it('should emit PLAN_STEP_CREATED for each step', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'First', agentType: 'writer', dependsOn: [] },
        { id: 's2', description: 'Second', agentType: 'reviewer', dependsOn: ['s1'] },
      ]));

      await mod.plan(makeParams({ callLLM }));

      const stepEvents = emitSpy.mock.calls.filter((c) => c[0] === 'plan:step-created');
      expect(stepEvents.length).toBe(2);
      const payload1 = stepEvents[0][1] as Record<string, unknown>;
      expect(payload1.id).toBe('s1');
      const payload2 = stepEvents[1][1] as Record<string, unknown>;
      expect(payload2.id).toBe('s2');
    });

    it('should use source "plan-module" for all emitted events', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);
      const callLLM = mockLLMSuccess(JSON.stringify([
        { id: 's1', description: 'Do it', agentType: 'writer', dependsOn: [] },
      ]));

      await mod.plan(makeParams({ callLLM }));

      for (const call of emitSpy.mock.calls) {
        if (['plan:started', 'plan:step-created', 'plan:completed'].includes(call[0] as string)) {
          expect(call[2]).toBe('plan-module');
        }
      }
    });

    it('should emit PLAN_COMPLETED with method "fallback" when no callLLM', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);

      await mod.plan({ goal: 'Test', workingDirectory: '/test' });

      const completedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'plan:completed');
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      const payload = completedEvents[0][1] as Record<string, unknown>;
      expect(payload.method).toBe('fallback');
      expect(payload.stepCount).toBe(1);
    });

    it('should emit PLAN_COMPLETED with method "parsed-empty" when LLM returns empty', async () => {
      const bus = new EventBus();
      const emitSpy = vi.spyOn(bus, 'emit');
      const mod = new DefaultPlanModule(bus);
      const callLLM = mockLLMSuccess('[]');

      await mod.plan(makeParams({ callLLM }));

      const completedEvents = emitSpy.mock.calls.filter((c) => c[0] === 'plan:completed');
      const emptyEvent = completedEvents.find((c) => (c[1] as Record<string, unknown>).method === 'parsed-empty');
      expect(emptyEvent).toBeDefined();
    });
  });
});
