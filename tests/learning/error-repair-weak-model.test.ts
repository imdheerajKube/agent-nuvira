/**
 * WEAK-MODEL CLOSE-THE-LOOP LADDER.
 *
 * The user's ask (2026-10-06): when a task can only run on a weak model and it
 * fails despite repeated reminders, agent-nuvira must "close that loop and get
 * progress moving forward" instead of re-running the same failure until the
 * budget dies. The mechanism: `weakModel: true` swaps the per-category repair
 * ladder for a bounded, non-repeating one whose second step asks for LESS
 * (`shrink-scope`). These tests pin that ladder and the narrowed ask.
 */

import { describe, it, expect } from 'vitest';
import {
  selectStrategy,
  shrinkScopeGoal,
  ErrorRepairEngine,
  type ErrorRepairOptions,
} from '../../src/learning/error-repair.js';
import type { AgentContext, AgentResult } from '../../src/agents/agent.js';

const opts = (weakModel: boolean): ErrorRepairOptions =>
  ({ maxRepairs: 2, repairMode: 'auto', weakModel }) as ErrorRepairOptions;

describe('selectStrategy — weak-model ladder', () => {
  it('is a bounded, NON-repeating sequence: re-prompt → shrink-scope → skip', () => {
    const o = opts(true);
    expect(selectStrategy('llm-error', 1, o)).toBe('re-prompt');
    expect(selectStrategy('llm-error', 2, o)).toBe('shrink-scope');
    expect(selectStrategy('llm-error', 3, o)).toBe('skip-step');
    // Same ladder regardless of category — the weak path never pretends a
    // stronger model exists to `switch-model` to.
    expect(selectStrategy('provider-error', 2, o)).toBe('shrink-scope');
    expect(selectStrategy('process-error', 2, o)).toBe('shrink-scope');
  });

  it('leaves the ordinary per-category ladder untouched when off', () => {
    const o = opts(false);
    expect(selectStrategy('llm-error', 1, o)).toBe('re-prompt');
    // NOT shrink-scope — a healthy pipeline keeps its own strategies.
    expect(selectStrategy('llm-error', 2, o)).not.toBe('shrink-scope');
  });
});

describe('shrinkScopeGoal', () => {
  it('names the FIRST declared artifact concretely', () => {
    const ctx = {
      goal: 'build the whole retry library',
      metadata: { expectedFiles: ['src/index.js', 'src/api.js'] },
    } as unknown as AgentContext;
    const goal = shrinkScopeGoal(ctx);
    expect(goal).toContain('SCOPE REDUCTION');
    expect(goal).toContain('src/index.js');
    expect(goal).not.toContain('src/api.js');
    // The original ask is preserved above the reduction notice.
    expect(goal.startsWith('build the whole retry library')).toBe(true);
  });

  it('never invents a filename when none was declared', () => {
    const ctx = { goal: 'write docs', metadata: {} } as unknown as AgentContext;
    const goal = shrinkScopeGoal(ctx);
    expect(goal).toContain('one file (or one function) only');
    expect(goal).not.toMatch(/src\/|\.\/|\.js\b/);
  });
});

describe('ErrorRepairEngine.repair — weak-model path moves forward', () => {
  it('runs re-prompt then a SMALLER ask (not a repeat of the same goal)', async () => {
    const context = {
      goal: 'build the whole retry library',
      metadata: { expectedFiles: ['src/index.js', 'src/api.js'] },
    } as unknown as AgentContext;
    const llm = (async () => ({ content: '', model: 'weak' })) as never;
    const goals: string[] = [];

    const engine = new ErrorRepairEngine({ maxRepairs: 2, repairMode: 'auto', weakModel: true });
    const result = await engine.repair('t1', context, llm, 'invalid json', async (ctx) => {
      goals.push(ctx.goal);
      return { success: false, summary: 'still failing', error: 'invalid json' } as AgentResult;
    });

    expect(result.success).toBe(false);
    expect(engine.budget.getAttempts('t1')).toBe(2);
    expect(goals).toHaveLength(2);
    // Attempt 1 = the same ask + failure context; attempt 2 = the SMALLER ask.
    expect(goals[1]).toContain('SCOPE REDUCTION');
    expect(goals[1]).toContain('src/index.js');
  });
});
