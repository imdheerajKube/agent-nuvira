/**
 * fix_model_routing P4 — the honest exhaustion report.
 *
 * The bar this text has to clear is the user's own: *"if user need to say retry
 * that we are failing"*, and *"a clear decent communication that I tried xyz
 * models, all have exhausted their capacity/budget — please recharge these
 * models, or should I wait? A capable model will be free at so-and-so time."*
 *
 * So these tests assert, in text: every model that was tried is NAMED with its
 * reason; every cooling target carries a WALL-CLOCK free time; the levers are
 * listed; and — the one that matters most — the report never asks the user to
 * trigger anything.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExhaustionReport,
  formatClockTime,
  formatWaitShort,
  renderExhaustionReport,
  type ExhaustionInput,
} from '../../src/learning/exhaustion-report.js';

const NOW = new Date('2026-10-06T18:30:00').getTime();

function input(over: Partial<ExhaustionInput> = {}): ExhaustionInput {
  return {
    task: 'build the knowledge base app',
    now: NOW,
    ...over,
  };
}

describe('exhaustion report — what was tried', () => {
  it('names every model that was reached, with the reason it did not answer', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [
          { provider: 'gemini', model: 'gemma-4-26b-a4b-it', kind: 'empty-response', reason: 'answered with nothing' },
          { provider: 'local', model: 'gpt-oss:120b-cloud', kind: 'empty-response', reason: 'answered with nothing' },
          { provider: 'groq', model: 'qwen3.8-27b', kind: 'rate-limit', reason: 'out of quota for now' },
        ],
      }),
    );

    expect(report.tried).toHaveLength(3);
    expect(report.text).toContain('Tried 3 models');
    expect(report.text).toContain('gemini/gemma-4-26b-a4b-it — answered with nothing');
    expect(report.text).toContain('local/gpt-oss:120b-cloud — answered with nothing');
    expect(report.text).toContain('groq/qwen3.8-27b — out of quota for now');
  });

  it('distinguishes "nothing could even be called" from "everything was tried and failed"', () => {
    const untried = buildExhaustionReport(
      input({
        attempts: [
          { provider: 'openai', model: 'gpt-5', kind: 'skipped', reason: 'no credential configured for it', skipped: true },
        ],
      }),
    );
    expect(untried.text).toContain('No model could even be called');
    expect(untried.tried).toHaveLength(0);
  });

  it('keeps a specific cause line instead of burying it', () => {
    const report = buildExhaustionReport(
      input({
        cause: 'the language model was unavailable',
        attempts: [{ provider: 'x', model: 'y', kind: 'network', reason: 'unreachable' }],
      }),
    );
    expect(report.text).toContain('Reason: the language model was unavailable');
  });

  it('falls back to a phrase for a kind with no reason supplied', () => {
    const report = buildExhaustionReport(
      input({ attempts: [{ provider: 'gemini', model: 'x', kind: 'empty-response', reason: '' }] }),
    );
    expect(report.text).toContain('answered with nothing (no text, no tool call)');
  });
});

describe('exhaustion report — when things come back', () => {
  it('prints an absolute free time, not just a wait length', () => {
    const freeAt = NOW + 12 * 60_000; // 18:42
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'answered with nothing' }],
        exclusions: [{ provider: 'groq', model: 'llama-3.3-70b-versatile', kind: 'rate-limit', expiresAt: freeAt }],
      }),
    );
    expect(report.text).toContain(`free at ${formatClockTime(freeAt)} (about 12m)`);
    expect(report.nextFreeAt).toBe(freeAt);
    expect(report.options.some((o) => o.code === 'wait' && o.text.includes(formatClockTime(freeAt)))).toBe(true);
  });

  it('takes the SOONEST window when several are cooling down', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'x' }],
        exclusions: [
          { provider: 'groq', kind: 'rate-limit', expiresAt: NOW + 30 * 60_000 },
          { provider: 'nim', kind: 'rate-limit', expiresAt: NOW + 4 * 60_000 },
        ],
      }),
    );
    expect(report.nextFreeAt).toBe(NOW + 4 * 60_000);
  });

  it('says plainly that a rejected credential needs a fix, not patience', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'deepseek', model: 'deepseek-chat', kind: 'auth', reason: 'rejected its credential' }],
        exclusions: [{ provider: 'deepseek', kind: 'auth' }],
      }),
    );
    expect(report.nextFreeAt).toBeUndefined();
    expect(report.text).toContain('no reset window — this one needs a fix, not patience');
    expect(report.options.some((o) => o.code === 'recharge' && /Recharge or replace/.test(o.text))).toBe(true);
    expect(report.text).toContain('Recharge or replace the credential for deepseek');
  });

  it('reports a retired pair as RULED OUT, never as something to wait for', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'x' }],
        exclusions: [{ provider: 'local', model: 'gemini-3.1-flash-lite', kind: 'model-not-found', source: 'registry' }],
      }),
    );
    expect(report.retired).toEqual(['local/gemini-3.1-flash-lite']);
    expect(report.text).toContain('Ruled out');
    expect(report.nextFreeAt).toBeUndefined();
  });
});

describe('exhaustion report — the honest verdict, and the levers', () => {
  it('calls a healthy-but-untried pool a ROUTING GAP, not a shortage', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'answered with nothing' }],
        poolSize: 538,
        poolProviders: 23,
      }),
    );
    expect(report.routingGap).toBe(true);
    expect(report.text).toContain('This was a routing gap, not a shortage');
    expect(report.text).toContain('only 1 of 538 eligible models were actually tried');
    // The system says what IT will do — the user is not handed a next action.
    expect(report.text).toContain('you do not need to trigger anything');
  });

  it('calls an empty pool what it is', () => {
    const report = buildExhaustionReport(
      input({ attempts: [{ provider: 'gemini', model: 'a', kind: 'skipped', reason: 'ruled out', skipped: true }], poolSize: 0, poolProviders: 0 }),
    );
    expect(report.text).toContain('the pool is empty');
  });

  it('NEVER asks the user to retry — the report is not a question', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'answered with nothing' }],
        exclusions: [{ provider: 'groq', kind: 'rate-limit', expiresAt: NOW + 60_000 }],
        poolSize: 40,
        poolProviders: 6,
      }),
    );
    expect(report.text).not.toMatch(/reply\s+\*?yes/i);
    expect(report.text).not.toMatch(/want me to (retry|keep trying)/i);
    expect(report.text).not.toMatch(/\?\s*$/m);
    expect(report.text).not.toContain('?');
  });

  it('always offers the levers only the user can pull', () => {
    const report = buildExhaustionReport(
      input({
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'answered with nothing' }],
        poolSize: 5,
        poolProviders: 2,
      }),
    );
    expect(report.options.map((o) => o.code)).toEqual(['weaker-model', 'narrow']);
    expect(report.text).toContain('weaker or cheaper model');
    expect(report.text).toContain('Narrow the ask');
  });

  it('is deterministic — the same measured state renders the same words', () => {
    const args = input({
      attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'x' }],
      exclusions: [{ provider: 'groq', kind: 'rate-limit', expiresAt: NOW + 4 * 60_000 }],
      poolSize: 9,
      poolProviders: 3,
    });
    expect(buildExhaustionReport(args).text).toBe(buildExhaustionReport(args).text);
  });
});

describe('renderExhaustionReport — silent when there is nothing to say', () => {
  it('returns undefined when no model was reached and nothing was excluded', () => {
    // A policy refusal, a bad pin or a caller bug: a healthy pool with zero
    // attempts is NOT exhaustion, and claiming it would be a new lie.
    expect(renderExhaustionReport({ task: 'x', now: NOW, poolSize: 538, poolProviders: 23 })).toBeUndefined();
  });

  it('renders as soon as there is a real attempt or exclusion', () => {
    expect(
      renderExhaustionReport({
        now: NOW,
        attempts: [{ provider: 'gemini', model: 'a', kind: 'empty-response', reason: 'answered with nothing' }],
      }),
    ).toContain('answered with nothing');
    expect(
      renderExhaustionReport({ now: NOW, exclusions: [{ provider: 'gemini', kind: 'auth' }] }),
    ).toContain('Unavailable right now');
  });
});

describe('formatting helpers', () => {
  it('formatClockTime is zero-padded wall-clock time', () => {
    expect(formatClockTime(new Date('2026-10-06T09:05:00').getTime())).toBe('09:05');
    expect(formatClockTime(new Date('2026-10-06T18:42:00').getTime())).toBe('18:42');
  });

  it('formatWaitShort reads like a person wrote it', () => {
    expect(formatWaitShort(45_000)).toBe('45s');
    expect(formatWaitShort(12 * 60_000)).toBe('12m');
    expect(formatWaitShort(3 * 3_600_000)).toBe('3h');
  });
});
