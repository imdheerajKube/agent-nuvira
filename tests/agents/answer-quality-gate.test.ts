/**
 * AGENT answer-quality gate — the orchestrator's agents do not go through the
 * loop engine, so the generation-time gate that protects chat and `nuvira
 * execute` never saw them. A traced reply became the task's summary and was
 * rendered as `• ✅ Reasoner: The user wants a project plan … I should use the
 * `plan_todo` tool…` (observed live 2026-09-21).
 *
 * The gate retries such a reply ONCE with a corrective instruction, and is
 * strictly additive: a normal reply costs one call and is returned untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  withAgentAnswerQualityGate,
  ANSWER_QUALITY_CORRECTION,
} from '../../src/agents/answer-quality-gate.js';
import { logger } from '../../src/utils/logger.js';
import type { LLMCallFn } from '../../src/agents/agent.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Verbatim shape from the live agent summary. */
const REASONING_REPLY = [
  'The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support.',
  '',
  'I should use the `plan_todo` tool to create a structured plan.',
].join('\n');

/** Thinking PREFIXED onto a real deliverable — the salvageable shape. */
const REASONING_THEN_RESULT = [
  'The user is asking for a calculator plan.',
  '',
  '**Calculator plan**',
  '1. Core engine — expression parser + conversion tables.',
].join('\n');

const GOOD = '**Calculator plan**\n1. Core engine\n2. GUI\n3. Packaging';

describe('withAgentAnswerQualityGate', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes a normal reply through with exactly ONE call (no extra cost)', async () => {
    const callLLM = vi.fn<LLMCallFn>().mockResolvedValue(GOOD);
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'writer', taskId: 't1' });

    await expect(gated('write the code')).resolves.toBe(GOOD);
    expect(callLLM).toHaveBeenCalledTimes(1);
    // The prompt is untouched on the happy path — no correction reaches the model.
    expect(callLLM.mock.calls[0]?.[0]).toBe('write the code');
  });

  it('retries a traced reply ONCE with the corrective instruction and uses the result', async () => {
    const callLLM = vi
      .fn<LLMCallFn>()
      .mockResolvedValueOnce(REASONING_REPLY)
      .mockResolvedValueOnce(GOOD);
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'Reasoner', taskId: 't2' });

    await expect(gated('plan the calculator', { model: 'm' })).resolves.toBe(GOOD);
    expect(callLLM).toHaveBeenCalledTimes(2);
    // The retry carries the correction AND the original task, so the model can
    // actually do the work the second time.
    const retryPrompt = callLLM.mock.calls[1]?.[0] ?? '';
    expect(retryPrompt).toContain('plan the calculator');
    expect(retryPrompt).toContain(ANSWER_QUALITY_CORRECTION);
    // Inference options are forwarded unchanged (same model, same limits).
    expect(callLLM.mock.calls[1]?.[1]).toEqual({ model: 'm' });
  });

  it('retries contract meta-talk on this path too', async () => {
    const callLLM = vi
      .fn<LLMCallFn>()
      .mockResolvedValueOnce(
        "I'm sorry, but the provided example call to suggest_followups is incomplete. Could you please provide more context?",
      )
      .mockResolvedValueOnce(GOOD);
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'planner' });

    await expect(gated('plan it')).resolves.toBe(GOOD);
    expect(callLLM).toHaveBeenCalledTimes(2);
  });

  it('keeps the ORIGINAL reply when the corrective retry narrates again (never invents text)', async () => {
    const callLLM = vi.fn<LLMCallFn>().mockResolvedValue(REASONING_REPLY);
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'writer' });

    await expect(gated('write it')).resolves.toBe(REASONING_REPLY);
    expect(callLLM).toHaveBeenCalledTimes(2);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/its own reasoning instead of the result/);
    expect(warned).toMatch(/narrated again on the corrective retry/);
  });

  it('salvages the deliverable behind a trace when neither attempt is clean', async () => {
    const callLLM = vi.fn<LLMCallFn>().mockResolvedValue(REASONING_THEN_RESULT);
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'Reasoner' });

    const out = await gated('plan it');
    expect(out).toContain('**Calculator plan**');
    expect(out).not.toContain('The user is asking');
  });

  it('a retry that THROWS never turns the task into an exception', async () => {
    const callLLM = vi
      .fn<LLMCallFn>()
      .mockResolvedValueOnce(REASONING_REPLY)
      .mockRejectedValueOnce(new Error('provider blew up\nwith a second line'));
    const gated = withAgentAnswerQualityGate(callLLM, { agent: 'writer' });

    await expect(gated('write it')).resolves.toBe(REASONING_REPLY);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/corrective retry failed: provider blew up/);
    // Only the first line of a multi-line provider error is logged.
    expect(warned).not.toContain('with a second line');
  });
});

/**
 * WIRING CONTRACT. The gate is only worth its tests if the orchestrator
 * actually applies it — and the two places it must be applied are easy to lose
 * in a 3,600-line module: the per-TASK agent function (writer/tester/debugger
 * and every repair path) and `runAgent` (the reasoner/planner path, which is
 * handed its own LLM). A source-level assertion is the honest way to pin that,
 * the same way `tests/nlu/contract.test.ts` pins its surface.
 */
describe('orchestrator wiring', () => {
  const src = readFileSync(join(here, '..', '..', 'src', 'agents', 'orchestrator.ts'), 'utf8');

  it('imports the gate and wraps BOTH agent LLM paths', () => {
    expect(src).toContain("import { withAgentAnswerQualityGate } from './answer-quality-gate.js'");
    // Per-task path: the routed/resilient function the agents are handed.
    expect(src).toMatch(/withAgentAnswerQualityGate\(routedAgentCallLLM,\s*\{/);
    // runAgent path: the reasoner/planner.
    expect(src).toMatch(/withAgentAnswerQualityGate\(callLLM,\s*\{ agent: agent\.name/);
  });

  it('never gates the orchestrator\'s housekeeping calls (file finding, memory)', () => {
    // `createFileFinderLLM` returns its own function and must stay outside the
    // gate: its output is parsed file paths, not prose for the reader.
    const finder = src.slice(src.indexOf('private createFileFinderLLM'));
    expect(finder.slice(0, 1500)).not.toContain('withAgentAnswerQualityGate');
  });
});
