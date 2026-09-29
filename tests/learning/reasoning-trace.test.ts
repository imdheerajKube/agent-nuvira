/**
 * Tests for the reasoning-trace store (assessment P0) — per-step LLM capture
 * for `nuvira trace replay` and the dashboard TracePanel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Hermetic memory dir (set BEFORE importing the module) ─────────────────

const testDir = mkdtempSync(join(tmpdir(), 'buff-trace-test-'));
process.env.NUVIRA_MEMORY_DIR = join(testDir, '.nuvira', 'memory');

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
  recordTraceFindings,
  MAX_TRACES,
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

  it('G10: an EMPTY response is recorded as a failure, never a success', async () => {
    // Live evidence: the story session's writer step was recorded with
    // `success: true`, `responseLength: 0`, `outputTokens: 0`. A green step for
    // a call that returned nothing hid the failure behind a passing checkmark.
    for (const empty of ['', '   ', '\n\n']) {
      const id = beginTrace({ goal: 'empty-response probe', source: 'orchestrator' });
      // A provider that returns the empty string verbatim (fakeLLM appends a
      // suffix, which would not be empty).
      const traced = withTraceCapture(async () => empty, { traceId: id, agentType: 'writer' });
      await traced('write the chapter');

      const step = getTrace(id)!.steps[0];
      expect(step.responseLength).toBe(empty.length);
      expect(step.success).toBe(false);
      expect(step.error).toMatch(/empty response/);
    }
  });

  it('G10: a non-empty response still records success', async () => {
    const id = beginTrace({ goal: 'ok-response probe', source: 'orchestrator' });
    const traced = withTraceCapture(fakeLLM('real content'), { traceId: id, agentType: 'writer' });
    await traced('write the chapter');
    expect(getTrace(id)!.steps[0].success).toBe(true);
    expect(getTrace(id)!.steps[0].error).toBeUndefined();
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
    // MAX_TRACES = 60 (chat turns now trace too, so the cap was raised from
    // 20) — create 65 and verify only the last 60 survive. NOTE: listTraces
    // defaults to a 20-item page, so pass the full cap explicitly.
    const ids: string[] = [];
    for (let i = 0; i < MAX_TRACES + 5; i++) {
      ids.push(beginTrace({ goal: `goal-${i}`, source: 'orchestrator' }));
    }
    const traces = listTraces(MAX_TRACES);
    expect(traces).toHaveLength(MAX_TRACES);
    expect(traces[0].goal).toBe(`goal-${MAX_TRACES + 4}`);
    expect(traces[MAX_TRACES - 1].goal).toBe('goal-5');
    expect(getTrace(ids[0])).toBeNull();
    expect(getTrace(ids[MAX_TRACES + 4])).not.toBeNull();
  });
});

// ─── WS1 (#23) — findings persisted on the trace ────────────────────────────

describe('reasoning-trace — recorded findings (WS1)', () => {
  beforeEach(() => clearTraces());
  afterEach(() => clearTraces());

  const confirmed = {
    claim: 'the harness can drive every surface',
    verdict: 'CONFIRMED' as const,
    outcome: 'checked by running the harness',
    evidence: [{ kind: 'observation' as const, ref: 'all five surfaces agreed' }],
    source: 'agent',
  };
  const plausible = {
    claim: 'this claim was never checked',
    verdict: 'PLAUSIBLE' as const,
    outcome: 'reported as a guess — no usable evidence',
    evidence: [],
    source: 'agent',
  };

  it('attaches the findings to the trace, in order, with the verdicts intact', () => {
    // The point of the whole row: a verdict that only lived in the turn's return
    // value cannot be audited after the turn, so the Trace tab would show the
    // tool calls and the honesty flags but not that the run ASSERTED something.
    const id = beginTrace({ goal: 'verify the harness', source: 'chat' });
    recordTraceFindings(id, [confirmed, plausible]);

    const trace = getTrace(id)!;
    expect(trace.findings).toEqual([confirmed, plausible]);
  });

  it('records a decision event per finding, so the timeline reads in order', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordTraceFindings(id, [confirmed]);

    const events = getTrace(id)!.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('decision');
    expect(events[0].seq).toBe(1);
    // The summary is the ONE shared wording (`describeFinding`), not a second
    // phrasing that could disagree with the CLI's.
    expect(events[0].summary).toContain('the harness can drive every surface');
    // `describeFinding` prints the ✅ for a confirmed verdict and the evidence
    // that earned it — the same line the CLI prints, never a second phrasing.
    expect(events[0].summary).toContain('✅');
    expect(events[0].summary).toContain('all five surfaces agreed');
  });

  it('normalises a Finding through toWire so the volatile `at` never lands', () => {
    // `WireFinding` excludes `at` on purpose: it differs every invocation, so
    // persisting it would make two identical runs compare unequal.
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordTraceFindings(id, [{ ...confirmed, at: 1_700_000_000_000 }]);
    const [stored] = getTrace(id)!.findings!;
    expect(stored).toEqual(confirmed);
    expect('at' in stored).toBe(false);
  });

  it('is a best-effort no-op for an empty list or an unknown trace', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    expect(() => recordTraceFindings(id, [])).not.toThrow();
    expect(getTrace(id)!.findings).toBeUndefined();
    expect(() => recordTraceFindings('trace-nope', [confirmed])).not.toThrow();
  });

  it('attaches to the run IN PROGRESS when no id is passed', () => {
    // Same contract as `recordTraceEvent`: a recorder deep in the stack that
    // never held the id still lands on the trace that is open right now.
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordTraceFindings(undefined, [confirmed]);
    expect(getTrace(id)!.findings).toEqual([confirmed]);
  });
});

// ─── Session 3 — layered prompt tracing ─────────────────────────────────────

describe('reasoning-trace — layered prompt tracing', () => {
  beforeEach(() => clearTraces());
  afterEach(() => clearTraces());

  const base = {
    agentType: 'chat',
    provider: 'gemini',
    model: 'm',
    promptDigest: 'd',
    promptPreview: 'p',
    responsePreview: 'r',
    responseLength: 1,
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    success: true,
  };

  it('records per-layer digests derived from the FULL prompt', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordStep(id, { ...base, promptFull: '[System]\nYou are Nuvira.\n\n[User]\nadd auth' });
    const step = getTrace(id)!.steps[0];
    expect(step.layers).toBeDefined();
    expect(step.layers!.systemChars).toBeGreaterThan(0);
    expect(step.layers!.systemDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(step.layers!.volatileChars).toBeGreaterThan(0);
  });

  it('captures the FULL stable layer ONCE per trace', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordStep(id, { ...base, promptFull: '[System]\nYou are Nuvira, the agent.\n\n[User]\nfirst' });
    recordStep(id, { ...base, promptFull: '[System]\nYou are Nuvira, the agent.\n\n[User]\nsecond' });
    const trace = getTrace(id)!;
    expect(trace.systemPrompt).toContain('You are Nuvira, the agent.');
    expect(trace.systemPromptChars).toBe(trace.systemPrompt!.length);
    // Both steps share the same stable-layer digest (prompt-cacheable).
    expect(trace.steps[0].layers!.systemDigest).toBe(trace.steps[1].layers!.systemDigest);
  });

  it('does not store the raw prompt (only the digests + the stable layer)', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordStep(id, {
      ...base,
      promptFull: '[System]\nSYS\n\n[User]\nSECRET-USER-TEXT',
    });
    const step = getTrace(id)!.steps[0] as Record<string, unknown>;
    expect(step.promptFull).toBeUndefined();
    expect(JSON.stringify(getTrace(id))).not.toContain('SECRET-USER-TEXT');
  });

  it('leaves layers undefined when no full prompt is supplied (back-compat)', () => {
    const id = beginTrace({ goal: 'g', source: 'chat' });
    recordStep(id, { ...base });
    expect(getTrace(id)!.steps[0].layers).toBeUndefined();
  });
});
