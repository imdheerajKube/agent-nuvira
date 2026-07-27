/**
 * PlanModule — Decomposes user goals into structured, dependency-aware execution
 * plans. Phase 7 of the architecture migration: extract from PlannerAgent into
 * a pluggable module with EventBus integration.
 *
 * @see ARCHITECTURE.md §3.1 — Plan Module specification
 */

import { getEventBus, EventNames } from '../observability/event-bus.js';
import type { EventBus } from '../observability/event-bus.js';
import type { LLMCallFn, TaskStep } from './agent.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = [
  'You are a senior software architect. Your job is to decompose a user\'s goal into a detailed, ordered execution plan.',
  '',
  'For each step, specify:',
  '- id: A short unique identifier (e.g., "step-01-gather-context")',
  '- description: What needs to be done in clear language',
  '- agentType: One of "context-gatherer", "writer", "reviewer", "tester", "debugger", "runner", "security", "mcp"',
  '- dependsOn: Array of step IDs that must complete before this one (empty array for first steps)',
  '',
  'Rules:',
  '1. Start with a "context-gatherer" step to understand the codebase (if files exist)',
  '2. Add one or more "writer" steps to implement changes (max 2-3 files per step)',
  '3. If the project is EMPTY or the goal is to CREATE something from scratch,',
  '   skip the context-gatherer step and go straight to writer steps.',
  '4. For goals that require running something (like "create a Python script and run it"),',
  '   add a "runner" step AFTER the writer step(s).',
  '   Use the description to specify the command: "Run: python hello.py" or "Run `node index.js`"',
  '   IMPORTANT: Only suggest "npm test" if the project already has a "test" script in its package.json!',
  '5. End with a "reviewer" step to validate the work',
  '6. Set dependsOn correctly so steps run in the right order',
  '7. Keep steps granular — each step should change at most 2-3 files',
  '8. Maximum 12 steps total',
  '',
  'Return ONLY a valid JSON array. No markdown, no explanations.',
  '',
  'Example (modifying existing project):',
  '[',
  '  {',
  '    "id": "step-01-understand",',
  '    "description": "Scan the codebase to understand the current project structure and identify files related to authentication",',
  '    "agentType": "context-gatherer",',
  '    "dependsOn": []',
  '  },',
  '  {',
  '    "id": "step-02-add-routes",',
  '    "description": "Create JWT authentication routes in src/routes/auth.ts with login, register, and refresh endpoints",',
  '    "agentType": "writer",',
  '    "dependsOn": ["step-01-understand"]',
  '  },',
  '  {',
  '    "id": "step-03-add-middleware",',
  '    "description": "Add JWT verification middleware in src/middleware/auth.ts",',
  '    "agentType": "writer",',
  '    "dependsOn": ["step-01-understand"]',
  '  },',
  '  {',
  '    "id": "step-04-review",',
  '    "description": "Review all changes for security vulnerabilities, correctness, and code quality",',
  '    "agentType": "reviewer",',
  '    "dependsOn": ["step-02-add-routes", "step-03-add-middleware"]',
  '  }',
  ']',
  '',
  'Example (creating from scratch + running):',
  '[',
  '  {',
  '    "id": "step-01-create-script",',
  '    "description": "Create a Python script hello.py that prints Hello, World!",',
  '    "agentType": "writer",',
  '    "dependsOn": []',
  '  },',
  '  {',
  '    "id": "step-02-run-script",',
  '    "description": "Run: python hello.py"',
  '    "agentType": "runner",',
  '    "dependsOn": ["step-01-create-script"]',
  '  },',
  '  {',
  '    "id": "step-03-review",',
  '    "description": "Verify the output is correct",',
  '    "agentType": "reviewer",',
  '    "dependsOn": ["step-02-run-script"]',
  '  }',
  ']',
].join('\n');

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parameters for the PlanModule.plan() method */
export interface PlanParams {
  /** The user's goal / task description */
  goal: string;
  /** Working directory of the project */
  workingDirectory: string;
  /** Optional LLM call function for generating the plan */
  callLLM?: LLMCallFn;
  /** Optional project file tree text (injected by caller) */
  projectFileTree?: string;
  /** Optional memory/few-shot context for the LLM */
  memoryContext?: string;
  /** Optional task descriptions to constrain the plan */
  taskDescriptions?: string[];
}

/** Output of the planning phase */
export interface PlanOutput {
  /** Ordered list of task steps */
  steps: TaskStep[];
  /** Human-readable summary of the plan */
  summary: string;
  /** How many steps were generated */
  stepCount: number;
}

// ─── PlanModule Interface ───────────────────────────────────────────────────

/**
 * PlanModule — Decompose user goals into structured execution plans.
 *
 * @example
 * ```typescript
 * const module = new DefaultPlanModule();
 * const plan = await module.plan({
 *   goal: 'Add JWT auth',
 *   workingDirectory: '/project',
 *   callLLM,
 * });
 * console.log(`Created ${plan.stepCount} steps`);
 * ```
 */
export interface PlanModule {
  /**
   * Generate an execution plan from a goal and project context.
   */
  plan(params: PlanParams): Promise<PlanOutput>;
}

// ─── Default PlanModule ─────────────────────────────────────────────────────

/**
 * DefaultPlanModule — Built-in plan module implementation.
 *
 * Builds a structured prompt from the goal, project file tree, and memory
 * context; calls the LLM; parses the response into TaskStep[]; normalizes
 * and validates each step.
 */
export class DefaultPlanModule implements PlanModule {
  /** The event bus for emitting observability events */
  private eventBus: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus ?? getEventBus();
  }

  /**
   * Generate an execution plan from a goal and project context.
   */
  async plan(params: PlanParams): Promise<PlanOutput> {
    const { goal, workingDirectory, callLLM, projectFileTree, memoryContext } = params;

    // ── Emit: plan started ──────────────────────────────────────────────
    this.eventBus.emit(EventNames.PLAN_STARTED, {
      goal,
    }, 'plan-module');

    // If no callLLM provided, return a minimal plan
    if (!callLLM) {
      const steps: TaskStep[] = [
        {
          id: 'step-01-code',
          description: goal,
          agentType: 'writer',
          dependsOn: [],
          status: 'pending',
        },
      ];

      this.eventBus.emit(EventNames.PLAN_COMPLETED, {
        stepCount: steps.length,
        method: 'fallback',
      }, 'plan-module');

      return { steps, summary: 'Created 1 fallback step', stepCount: 1 };
    }

    // Build the prompt
    const prompt = this.buildPrompt(goal, workingDirectory, projectFileTree, memoryContext);

    // Call the LLM
    const response = await callLLM(prompt, {
      temperature: 0.3, // Low temperature for structured output
      maxTokens: 4096,
    });

    // Parse and normalize the plan
    const rawSteps = this.parsePlan(response);
    const steps = this.normalizeSteps(rawSteps);

    if (steps.length === 0) {
      // Emit: plan completed (empty)
      this.eventBus.emit(EventNames.PLAN_COMPLETED, {
        stepCount: 0,
        method: 'parsed-empty',
      }, 'plan-module');

      return {
        steps: [],
        summary: 'Planner produced an empty or invalid plan',
        stepCount: 0,
      };
    }

    // Emit: each step created
    for (const step of steps) {
      this.eventBus.emit(EventNames.PLAN_STEP_CREATED, {
        id: step.id,
        agentType: step.agentType,
        description: step.description,
      }, 'plan-module');
    }

    // Emit: plan completed
    this.eventBus.emit(EventNames.PLAN_COMPLETED, {
      stepCount: steps.length,
      method: 'llm',
    }, 'plan-module');

    const summary = `Created ${steps.length} task step${steps.length !== 1 ? 's' : ''}`;

    return { steps, summary, stepCount: steps.length };
  }

  /**
   * Build the LLM prompt from the goal and project context.
   */
  private buildPrompt(
    goal: string,
    workingDirectory: string,
    projectFileTree?: string,
    memoryContext?: string,
  ): string {
    const promptParts: string[] = [
      PLAN_SYSTEM_PROMPT,
      '',
      '## User Goal',
      goal,
      '',
      '## Working Directory',
      workingDirectory,
    ];

    if (projectFileTree) {
      const treeLines = projectFileTree.split('\n').length;
      promptParts.push(
        '',
        '## Current Project Structure',
        projectFileTree || '(empty directory — no source files found)',
        treeLines > 1 ? `\n(${treeLines} files/directories visible)` : ' (empty)',
      );
    } else {
      promptParts.push(
        '',
        '## Current Project Structure',
        '(unknown — file tree not available)',
      );
    }

    if (memoryContext) {
      promptParts.push('', memoryContext);
    }

    promptParts.push('', 'Create an execution plan for this goal. Return ONLY a valid JSON array of task steps.');

    return promptParts.join('\n');
  }

  /**
   * Parse the LLM response into raw TaskStep arrays.
   * Tries JSON.parse first, then code blocks, then array extraction.
   */
  private parsePlan(response: string): Record<string, unknown>[] {
    const trimmed = response.trim();

    // Try direct JSON parse
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    } catch {
      // Not direct JSON — try extracting from code block
    }

    // Try extracting from ```json ... ``` block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      } catch {
        // Fall through
      }
    }

    // Try finding a JSON array anywhere in the response
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
      } catch {
        // Fall through
      }
    }

    return [];
  }

  /**
   * Normalize raw step objects into validated TaskStep arrays.
   * Handles LLM quirks: numeric IDs, null dependsOn, different formats.
   */
  private normalizeSteps(rawSteps: Record<string, unknown>[]): TaskStep[] {
    const steps: TaskStep[] = [];

    for (const step of rawSteps) {
      if (!step || typeof step !== 'object') continue;
      if (!step.description || !step.agentType) continue;

      const id = String(step.id ?? `step-${steps.length + 1}`);

      // Normalize dependsOn: can be null, undefined, single string, or array
      let dependsOn: string[] = [];
      if (Array.isArray(step.dependsOn)) {
        dependsOn = step.dependsOn.map((d: unknown) => String(d));
      } else if (typeof step.dependsOn === 'string' || typeof step.dependsOn === 'number') {
        dependsOn = [String(step.dependsOn)];
      }

      steps.push({
        id,
        description: String(step.description),
        agentType: String(step.agentType),
        dependsOn,
        status: 'pending',
      });
    }

    return steps;
  }
}
