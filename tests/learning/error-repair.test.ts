/**
 * Unit tests for ErrorRepairModule — error classification, repair strategies,
 * budget tracking, and the full repair loop.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  isRepairable,
  selectStrategy,
  needsApproval,
  RepairBudget,
  ErrorRepairEngine,
  formatRepairSummary,
} from '../../src/learning/error-repair.js';
import type { AgentContext, AgentResult, LLMCallFn } from '../../src/agents/agent.js';

// ─── Mock agent context ─────────────────────────────────────────────────────

function createMockContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'Test goal',
    workingDirectory: '/tmp/test',
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

// ─── Error Classification ───────────────────────────────────────────────────

describe('ErrorRepair — classifyError()', () => {
  it('classifies injection-blocked errors', () => {
    expect(classifyError('Prompt injection detected')).toBe('injection-blocked');
    expect(classifyError('Injection guardrail blocked LLM call')).toBe('injection-blocked');
    expect(classifyError('Blocked by security scanner')).toBe('injection-blocked');
  });

  it('classifies provider errors (rate limit, timeout, server)', () => {
    expect(classifyError('Rate limit exceeded for provider')).toBe('provider-error');
    expect(classifyError('429 Too Many Requests')).toBe('provider-error');
    expect(classifyError('502 Bad Gateway')).toBe('provider-error');
    expect(classifyError('503 Service Unavailable')).toBe('provider-error');
    expect(classifyError('The operation timed out after 30000ms')).toBe('provider-error');
    expect(classifyError('Connection refused')).toBe('provider-error');
    expect(classifyError('socket hang up')).toBe('provider-error');
    expect(classifyError('ECONNRESET')).toBe('provider-error');
  });

  it('classifies context-limit errors', () => {
    expect(classifyError('Context length exceeded')).toBe('context-limit');
    expect(classifyError('Max tokens exceeded for this model')).toBe('context-limit');
    expect(classifyError('This model has a maximum context window of 128K')).toBe('context-limit');
    expect(classifyError('Prompt too long')).toBe('context-limit');
  });

  it('classifies process errors', () => {
    expect(classifyError('Command failed with exit code 1')).toBe('process-error');
    expect(classifyError('Non-zero exit code')).toBe('process-error');
    expect(classifyError('ENOENT: no such file or directory')).toBe('process-error');
    expect(classifyError('EACCES: permission denied')).toBe('process-error');
  });

  it('classifies LLM output errors', () => {
    expect(classifyError('JSON parse error: Unexpected token')).toBe('llm-error');
    expect(classifyError('Invalid JSON response from model')).toBe('llm-error');
    expect(classifyError('Malformed response: unterminated string')).toBe('llm-error');
    expect(classifyError('SyntaxError: Unexpected identifier')).toBe('llm-error');
  });

  it('classifies unknown errors', () => {
    expect(classifyError('Something completely unexpected happened')).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});

// ─── Repairability ──────────────────────────────────────────────────────────

describe('ErrorRepair — isRepairable()', () => {
  it('reports llm-error as repairable', () => {
    expect(isRepairable('llm-error')).toBe(true);
  });

  it('reports provider-error as repairable', () => {
    expect(isRepairable('provider-error')).toBe(true);
  });

  it('reports context-limit as repairable', () => {
    expect(isRepairable('context-limit')).toBe(true);
  });

  it('reports process-error as repairable', () => {
    expect(isRepairable('process-error')).toBe(true);
  });

  it('reports injection-blocked as non-repairable', () => {
    expect(isRepairable('injection-blocked')).toBe(false);
  });

  it('reports budget-exhausted as non-repairable', () => {
    expect(isRepairable('budget-exhausted')).toBe(false);
  });

  it('reports unknown as repairable (generic fallback)', () => {
    expect(isRepairable('unknown')).toBe(true);
  });
});

// ─── Strategy Selection ─────────────────────────────────────────────────────

describe('ErrorRepair — selectStrategy()', () => {
  const baseOpts = { maxRepairs: 3, repairMode: 'auto' as const };

  it('selects re-prompt for first LLM error', () => {
    expect(selectStrategy('llm-error', 1, baseOpts)).toBe('re-prompt');
  });

  it('selects switch-model for second LLM error with fallbacks', () => {
    expect(selectStrategy('llm-error', 2, { ...baseOpts, fallbackModels: ['model2'] })).toBe('switch-model');
  });

  it('selects adjust-temperature for second LLM error without fallbacks', () => {
    expect(selectStrategy('llm-error', 2, baseOpts)).toBe('adjust-temperature');
  });

  it('selects switch-model for first provider error with fallbacks', () => {
    expect(selectStrategy('provider-error', 1, { ...baseOpts, fallbackModels: ['model2'] })).toBe('switch-model');
  });

  it('selects retry-tool for second provider error', () => {
    expect(selectStrategy('provider-error', 2, baseOpts)).toBe('retry-tool');
  });

  it('selects skip-step when exhausted', () => {
    expect(selectStrategy('llm-error', 3, { ...baseOpts, fallbackModels: ['m2'] })).toBe('skip-step');
    expect(selectStrategy('injection-blocked', 1, baseOpts)).toBe('skip-step');
    expect(selectStrategy('budget-exhausted', 1, baseOpts)).toBe('skip-step');
  });
});

// ─── Human-Approval Gate ────────────────────────────────────────────────────

describe('ErrorRepair — needsApproval()', () => {
  it('returns false for auto mode on non-destructive strategies', () => {
    expect(needsApproval('re-prompt', 'auto')).toBe(false);
    expect(needsApproval('retry-tool', 'auto')).toBe(false);
    expect(needsApproval('adjust-temperature', 'auto')).toBe(false);
    expect(needsApproval('switch-model', 'auto')).toBe(false);
  });

  it('returns false for skip-step in auto mode (auto-skip without approval)', () => {
    expect(needsApproval('skip-step', 'auto')).toBe(false);
  });

  it('returns true for most strategies in prompt mode', () => {
    expect(needsApproval('re-prompt', 'prompt')).toBe(true);
    expect(needsApproval('switch-model', 'prompt')).toBe(true);
    expect(needsApproval('skip-step', 'prompt')).toBe(true);
  });

  it('returns false for trivial strategies in prompt mode', () => {
    expect(needsApproval('retry-tool', 'prompt')).toBe(false);
    expect(needsApproval('adjust-temperature', 'prompt')).toBe(false);
  });

  it('returns false when repair mode is off', () => {
    expect(needsApproval('switch-model', 'off')).toBe(false);
    expect(needsApproval('skip-step', 'off')).toBe(false);
  });
});

// ─── RepairBudget ───────────────────────────────────────────────────────────

describe('ErrorRepair — RepairBudget', () => {
  it('starts with full budget', () => {
    const budget = new RepairBudget(3, 'auto');
    expect(budget.hasBudget('task-1')).toBe(true);
    expect(budget.getAttempts('task-1')).toBe(0);
    expect(budget.totalAttempts).toBe(0);
  });

  it('consumes budget on each attempt', () => {
    const budget = new RepairBudget(2, 'auto');
    budget.consume('task-1');
    expect(budget.getAttempts('task-1')).toBe(1);
    expect(budget.totalAttempts).toBe(1);
    expect(budget.hasBudget('task-1')).toBe(true);

    budget.consume('task-1');
    expect(budget.getAttempts('task-1')).toBe(2);
    expect(budget.hasBudget('task-1')).toBe(false);
  });

  it('tracks per-task budgets independently', () => {
    const budget = new RepairBudget(2, 'auto');
    budget.consume('task-1');
    budget.consume('task-2');
    budget.consume('task-2');
    expect(budget.getAttempts('task-1')).toBe(1);
    expect(budget.getAttempts('task-2')).toBe(2);
    expect(budget.hasBudget('task-1')).toBe(true);
    expect(budget.hasBudget('task-2')).toBe(false);
  });

  it('returns false for all tasks when mode is off', () => {
    const budget = new RepairBudget(3, 'off');
    expect(budget.hasBudget('any-task')).toBe(false);
  });

  it('resets correctly', () => {
    const budget = new RepairBudget(2, 'auto');
    budget.consume('task-1');
    budget.consume('task-1');
    budget.reset();
    expect(budget.getAttempts('task-1')).toBe(0);
    expect(budget.totalAttempts).toBe(0);
    expect(budget.hasBudget('task-1')).toBe(true);
  });

  it('getSummary returns formatted string', () => {
    const budget = new RepairBudget(3, 'auto');
    budget.consume('task-1');
    expect(budget.getSummary('task-1')).toBe('1/3 attempts used');
  });
});

// ─── ErrorRepairEngine ──────────────────────────────────────────────────────

describe('ErrorRepair — ErrorRepairEngine', () => {
  it('passes through successful agent results without repair', async () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'auto' });
    const mockExecute = vi.fn().mockResolvedValue({ success: true, summary: 'All good' });

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      vi.fn() as unknown as LLMCallFn,
      'Some error',
      mockExecute,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('retries on LLM error and succeeds on second attempt (re-prompt)', async () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'auto', verbose: true });
    let callCount = 0;
    const mockExecute = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { success: false, summary: 'Failed', error: 'JSON parse error: Unexpected token' };
      }
      return { success: true, summary: 'Succeeded on retry' };
    });

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      vi.fn() as unknown as LLMCallFn,
      'JSON parse error: Unexpected token',
      mockExecute,
    );

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Succeeded on retry');
    expect(callCount).toBe(2);
    expect(engine.budget.getAttempts('task-1')).toBe(2);
  });

  it('exhausts budget and returns failure when repairs all fail', async () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 2, repairMode: 'auto' });
    const mockExecute = vi.fn().mockResolvedValue({
      success: false,
      summary: 'Still failing',
      error: 'JSON parse error',
    });

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      vi.fn() as unknown as LLMCallFn,
      'JSON parse error',
      mockExecute,
    );

    expect(result.success).toBe(false);
    expect(result.summary).toContain('exhausted');
    expect(engine.budget.getAttempts('task-1')).toBe(2);
  });

  it('does not repair non-repairable errors (injection-blocked)', async () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'auto' });
    const mockExecute = vi.fn();

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      vi.fn() as unknown as LLMCallFn,
      'Prompt injection detected — call blocked',
      mockExecute,
    );

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Non-repairable');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('honors repair mode off — does not repair', async () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'off' });
    const mockExecute = vi.fn().mockResolvedValue({ success: false, summary: 'Failed' });

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      vi.fn() as unknown as LLMCallFn,
      'Some error',
      mockExecute,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('uses fallback model on switch-model strategy', async () => {
    const engine = new ErrorRepairEngine({
      maxRepairs: 3,
      repairMode: 'auto',
      fallbackModels: ['groq/llama3'],
      verbose: true,
    });
    let callCount = 0;
    const mockLLM = vi.fn().mockResolvedValue('response');
    const mockExecute = vi.fn().mockImplementation(async (_ctx: any, llm: any) => {
      callCount++;
      if (callCount === 1) {
        return { success: false, summary: 'Failed', error: 'Rate limit exceeded' };
      }
      // Second call should use the LLM with fallback model
      const result = await llm('test prompt');
      return { success: true, summary: `Succeeded with: ${result}` };
    });

    const result = await engine.repair(
      'task-1',
      createMockContext(),
      mockLLM as unknown as LLMCallFn,
      'Rate limit exceeded for provider',
      mockExecute,
    );

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it('reset clears budget', () => {
    const engine = new ErrorRepairEngine({ maxRepairs: 3, repairMode: 'auto' });
    engine.budget.consume('task-1');
    engine.budget.consume('task-1');
    expect(engine.budget.totalAttempts).toBe(2);
    engine.reset();
    expect(engine.budget.totalAttempts).toBe(0);
  });
});

// ─── formatRepairSummary ───────────────────────────────────────────────────

describe('ErrorRepair — formatRepairSummary()', () => {
  it('formats a successful repair summary', () => {
    const budget = new RepairBudget(3, 'auto');
    budget.consume('task-1');
    const result: AgentResult = { success: true, summary: 'All fixed' };
    const output = formatRepairSummary('task-1', 'llm-error', result, budget);
    expect(output).toContain('✅');
    expect(output).toContain('[task-1]');
    expect(output).toContain('llm-error');
    expect(output).toContain('1 repair attempt');
  });

  it('formats a failed repair summary', () => {
    const budget = new RepairBudget(3, 'auto');
    budget.consume('task-1');
    budget.consume('task-1');
    const result: AgentResult = { success: false, summary: 'Still broken', error: 'Fail' };
    const output = formatRepairSummary('task-1', 'provider-error', result, budget);
    expect(output).toContain('❌');
    expect(output).toContain('[task-1]');
    expect(output).toContain('provider-error');
    expect(output).toContain('2 repair attempt');
  });
});
