/**
 * Loop-arm eval METRICS honesty (`tests/learning/eval-loop-metrics.test.ts`).
 *
 * Three defects found by running `nuvira eval parity` live, pinned here:
 *   1. the loop arm reported 0 tokens / $0 — it has no orchestrator `stats`, so
 *      its usage must be read from the shared cost tracker;
 *   2. the loop arm credited the REQUESTED model even when a substitution had
 *      run a different one — so a parity report could claim it ran a model it
 *      never touched;
 *   3. `completed` was `!generationFailed`, so a turn that ran no tool at all
 *      scored as a completed turn (composite floored at 0.25 in every such run).
 *
 * The loop executor and the cost tracker are stubbed so these assertions are
 * about the METRICS wiring, not a provider run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ stub: {} as Record<string, unknown> }));

vi.mock('../../src/cli/loop-executor.js', () => ({
  runLoopExecutor: async () => h.stub,
}));

vi.mock('../../src/learning/cost-tracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/learning/cost-tracker.js')>();
  return { ...actual, costSince: () => ({ tokens: 4321, costUsd: 0.0123, requests: 3 }) };
});

import { runEvalTask, getEvalTask } from '../../src/learning/eval-framework.js';
import type { InferenceProvider } from '../../src/inference/interface.js';

const dummyProvider: InferenceProvider = {
  name: 'Dummy',
  async generate(): Promise<string> {
    return 'ok';
  },
};

function baseLoop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'done',
    generationFailed: false,
    bounded: false,
    toolCalls: [],
    erroredTools: [],
    toolOutcomes: [],
    successfulToolCalls: [],
    durationMs: 5,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    engineExplanation: '',
    ...overrides,
  };
}

describe('eval loop-arm metrics', () => {
  beforeEach(() => {
    h.stub = baseLoop();
  });

  it('records the SERVED model and the requested pin separately (substitution is visible)', async () => {
    h.stub = baseLoop({ model: 'allam-2-7b' });
    const task = getEvalTask('loop-autonomy-multistep');
    const result = await runEvalTask(task!, dummyProvider, 'groq', 'openai/gpt-oss-120b', { engine: 'loop' });
    expect(result.metrics.requestedModel).toBe('openai/gpt-oss-120b');
    expect(result.metrics.servedModel).toBe('allam-2-7b');
  });

  it('reads tokens and cost from the shared cost tracker (no orchestrator stats)', async () => {
    const task = getEvalTask('loop-autonomy-multistep');
    const result = await runEvalTask(task!, dummyProvider, 'groq', 'qwen/qwen3.8-27b', { engine: 'loop' });
    expect(result.metrics.totalTokens).toBe(4321);
    expect(result.metrics.costUsd).toBeCloseTo(0.0123, 6);
    expect(result.metrics.tokenEfficiency).toBeGreaterThan(0);
  });

  it('does NOT score a zero-action turn as completed', async () => {
    // No tool succeeded — the turn did nothing. The task has hidden tests, so it
    // asks for work: this is NOT a completion, however cleanly it ended.
    h.stub = baseLoop({ successfulToolCalls: [] });
    const task = getEvalTask('loop-autonomy-multistep');
    const result = await runEvalTask(task!, dummyProvider, 'groq', 'qwen/qwen3.8-27b', { engine: 'loop' });
    expect(result.metrics.actionless).toBe(true);
    expect(result.metrics.completed).toBe(false);
  });

  it('scores a turn that DID the work as completed', async () => {
    h.stub = baseLoop({ successfulToolCalls: ['edit_file', 'run_terminal'] });
    const task = getEvalTask('loop-autonomy-multistep');
    const result = await runEvalTask(task!, dummyProvider, 'groq', 'qwen/qwen3.8-27b', { engine: 'loop' });
    expect(result.metrics.actionless).toBe(false);
    expect(result.metrics.completed).toBe(true);
  });
});
