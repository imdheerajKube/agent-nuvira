/**
 * Tests for the reasoning-trace store (assessment P0) — per-step LLM capture
 * for `buff trace replay` and the dashboard TracePanel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Hermetic memory dir (set BEFORE importing the module) ─────────────────

const testDir = mkdtempSync(join(tmpdir(), 'buff-trace-test-'));
process.env.BUFF_MEMORY_DIR = join(testDir, '.buff', 'memory');

const {
  beginTrace,
  recordStep,
  endTrace,
  getTrace,
  listTraces,
  clearTraces,
  getTraceStats,
  deleteTrace,
  withTraceCapture,
} = await import('../../src/learning/reasoning-trace.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function fakeLLM(response: string, opts?: { throwOn?: string }): (prompt: string, options?: { model?: string }) => Promise<string> {
  return async (prompt: string, options?: { model?: string }) => {
    if (opts?.throwOn && prompt.includes(opts.throwOn)) {
      throw new Error(`boom: ${opts.throwOn}`);
    }
    return `${response} (echo of ${options?.model || 'default'})`;
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('reasoning-trace store', () => {
  beforeEach(() => clearTraces());
  afterEach(() => {
    clearTraces();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('beginTrace creates an open trace and recordStep appends sequenced steps', () => {
    const id = beginTrace({ goal: 'Add auth to API', source: 'orchestrator' });
    expect(id).toMatch(/^trace-/);

    recordStep(id, {
      agentType: 'planner',
      provider: 'groq',
      model: 'llama-3.3-70b',
      promptDigest: 'abc123',
      promptPreview: 'Plan this',
      responsePreview: '1. Add routes',
      responseLength: 20,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1200,
      success: true,
    });
    recordStep(id, {
      agentType: 'writer',
      provider: 'groq',
      model: 'llama-3.3-70b',
      promptDigest: 'def456',
      promptPreview: 'Write the code',
      responsePreview: '```ts\nconst x = 1;\n```',
      responseLength: 30,
      inputTokens: 200,
      outputTokens: 80,
      latencyMs: 2400,
      success: true,
    });

    const trace = getTrace(id)!;
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0].seq).toBe(1);
    expect(trace.steps[1].seq).toBe(2);
    expect(trace.steps[1].agentType).toBe('writer');
  });

  it('endTrace sets endedAt, durationMs and success; is idempotent', () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    recordStep(id, {
      agentType: 'planner', provider: 'local', model: 'gemma4:e4b',
      promptDigest: 'a', promptPreview: '', responsePreview: '', responseLength: 0,
      inputTokens: 1, outputTokens: 1, latencyMs: 10, success: true,
    });
    const startedAt = getTrace(id)!.startedAt;

    endTrace(id, true);
    const ended = getTrace(id)!;
    expect(ended.success).toBe(true);
    expect(ended.endedAt).toBeGreaterThanOrEqual(startedAt);
    expect(ended.durationMs).toBeGreaterThanOrEqual(0);

    // Second endTrace is a no-op (does not overwrite success/duration).
    endTrace(id, false);
    const after = getTrace(id)!;
    expect(after.success).toBe(true);
    expect(after.durationMs).toBe(ended.durationMs);
  });

  it('recordStep on an unknown trace is a silent no-op', () => {
    expect(() => {
      recordStep('trace-nope', {
        agentType: 'planner', provider: 'x', model: 'y',
        promptDigest: 'a', promptPreview: '', responsePreview: '', responseLength: 0,
        inputTokens: 0, outputTokens: 0, latencyMs: 0, success: true,
      });
    }).not.toThrow();
  });

  it('withTraceCapture records tokens, latency, digest, response, and routing snapshot', async () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    const traced = withTraceCapture(fakeLLM('hello world'), {
      traceId: id,
      agentType: 'writer',
      taskId: 'step-1',
      description: 'Write the module',
      routing: {
        provider: 'groq',
        model: 'llama-3.3-70b',
        score: 0.92,
        complexity: 'moderate',
        explanation: 'best available',
      },
    });

    const result = await traced('Write a test', { model: 'llama-3.3-70b' });

    expect(result).toContain('hello world');
    const step = getTrace(id)!.steps[0];
    expect(step.agentType).toBe('writer');
    expect(step.taskId).toBe('step-1');
    expect(step.provider).toBe('groq');
    expect(step.model).toBe('llama-3.3-70b');
    expect(step.promptDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(step.responseLength).toBeGreaterThan(0);
    expect(step.latencyMs).toBeGreaterThanOrEqual(0);
    expect(step.inputTokens).toBeGreaterThan(0);
    expect(step.success).toBe(true);
    expect(step.routing?.provider).toBe('groq');
    expect(step.routing?.score).toBe(0.92);
  });

  it('withTraceCapture records the escalated marker for model-escalated repair steps (v1.60.4)', async () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    const traced = withTraceCapture(fakeLLM('escalated response'), {
      traceId: id,
      agentType: 'writer',
      taskId: 'step-1',
      description: 'Write the module (repair attempt)',
      escalated: true,
      routing: {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        score: 0.95,
        complexity: 'complex',
        explanation: 'escalated — next complexity level',
      },
    });

    await traced('Try again with a stronger model');

    const trace = getTrace(id);
    const step = trace?.steps[0];
    expect(step?.escalated).toBe(true);
    expect(step?.routing?.complexity).toBe('complex');
  });

  it('withTraceCapture leaves escalated unset (undefined) for normal calls', async () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    const traced = withTraceCapture(fakeLLM('normal response'), {
      traceId: id,
      agentType: 'planner',
      description: 'Plan',
    });

    await traced('Plan the work');

    const trace = getTrace(id);
    expect(trace?.steps[0]?.escalated).toBeUndefined();
  });

  it('withTraceCapture records failed calls with the error and re-throws', async () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    const traced = withTraceCapture(fakeLLM('ok', { throwOn: 'boom' }), {
      traceId: id,
      agentType: 'tester',
      provider: 'local',
      model: 'gemma4:e4b',
    });

    await expect(traced('trigger boom')).rejects.toThrow('boom:');
    const step = getTrace(id)!.steps[0];
    expect(step.success).toBe(false);
    expect(step.error).toContain('boom');
    expect(step.agentType).toBe('tester');
  });

  it('withTraceCapture never breaks a call when the trace id is stale (best-effort)', async () => {
    const traced = withTraceCapture(fakeLLM('still works'), {
      traceId: 'trace-gone',
      agentType: 'planner',
    });
    await expect(traced('any prompt')).resolves.toContain('still works');
  });

  it('listTraces returns most-recent-first; deleteTrace and clearTraces work', () => {
    const a = beginTrace({ goal: 'first', source: 'orchestrator' });
    const b = beginTrace({ goal: 'second', source: 'orchestrator' });
    const c = beginTrace({ goal: 'third', source: 'orchestrator' });

    const all = listTraces();
    expect(all.map((t) => t.id)).toEqual([c, b, a]);

    expect(deleteTrace(b)).toBe(true);
    expect(deleteTrace(b)).toBe(false);
    expect(getTrace(b)).toBeNull();
    expect(listTraces()).toHaveLength(2);

    clearTraces();
    expect(listTraces()).toHaveLength(0);
  });

  it('getTraceStats aggregates steps across traces', () => {
    const id = beginTrace({ goal: 'g', source: 'orchestrator' });
    recordStep(id, {
      agentType: 'writer', provider: 'groq', model: 'm1',
      promptDigest: 'a', promptPreview: '', responsePreview: '', responseLength: 0,
      inputTokens: 100, outputTokens: 50, latencyMs: 1000, success: true,
    });
    recordStep(id, {
      agentType: 'writer', provider: 'groq', model: 'm1',
      promptDigest: 'b', promptPreview: '', responsePreview: '', responseLength: 0,
      inputTokens: 200, outputTokens: 50, latencyMs: 2000, success: false,
    });
    endTrace(id, false);

    const stats = getTraceStats();
    expect(stats.total).toBe(1);
    expect(stats.totalSteps).toBe(2);
    expect(stats.avgLatencyMs).toBe(1500);
    expect(stats.totalTokens).toBe(400);
    expect(stats.byAgentType.writer).toBe(2);
    expect(stats.byModel.m1).toBe(2);
  });

  it('caps traces at the store maximum (keeps most recent)', () => {
    // MAX_TRACES = 20 — create 25 and verify only the last 20 survive.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(beginTrace({ goal: `goal-${i}`, source: 'orchestrator' }));
    }
    const traces = listTraces();
    expect(traces).toHaveLength(20);
    expect(traces[0].goal).toBe('goal-24');
    expect(traces[19].goal).toBe('goal-5');
    expect(getTrace(ids[0])).toBeNull();
    expect(getTrace(ids[24])).not.toBeNull();
  });
});
