/**
 * The honest failure report — "what did you TRY, and what was PARKED?"
 *
 * The defect this pins: a task that failed produced "the language model was
 * unavailable", which names no cause and offers no next step. A user cannot
 * tell from that line whether the pool was genuinely empty, whether one
 * provider happened to rate-limit, or whether three providers were sitting
 * parked on quota the whole time.
 *
 * Two halves, both under test here:
 *   - `describeRoutingExclusions` (pre-existing) answers "why is this provider
 *     being SKIPPED?" — a snapshot of records.
 *   - the attempt log answers "what did you actually CALL?" — an event stream.
 *
 * Invariants:
 *   - attempts are scoped by a mark, so concurrent/older walks never leak in;
 *   - the log is bounded (telemetry cannot grow without limit);
 *   - recording can never throw into the routing path;
 *   - the rendered report names each tried model with a reason, each parked
 *     model with a reason AND when it frees, and always offers the retry.
 */
import { describe, it, expect } from 'vitest';

import {
  markFailoverAttempts,
  recordFailoverAttempt,
  attemptsSince,
  failureKindPhrase,
  formatWait,
  modelBreadthReport,
  renderModelBreadthReport,
} from '../../src/learning/resilient-call.js';

const attempt = (provider: string, model: string, kind = 'rate-limit', skipped = false) => ({
  provider,
  model,
  kind,
  skipped,
  reason: skipped ? 'ruled out' : failureKindPhrase(kind),
});

describe('failover attempt log', () => {
  it('scopes attempts to a mark so an older walk cannot leak into a newer report', () => {
    const before = markFailoverAttempts();
    recordFailoverAttempt(attempt('gemini', 'gemini-3.1-flash-lite', 'rate-limit'));
    const afterFirst = attemptsSince(before);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ provider: 'gemini', kind: 'rate-limit' });

    // A second mark sees ONLY what came after it.
    const second = markFailoverAttempts();
    recordFailoverAttempt(attempt('groq', 'llama-3.3-70b', 'context-window'));
    const fromSecond = attemptsSince(second);
    expect(fromSecond).toHaveLength(1);
    expect(fromSecond[0]!.provider).toBe('groq');
    // …and the first mark now sees both, in order.
    expect(attemptsSince(before).map((a) => a.provider)).toEqual(['gemini', 'groq']);
  });

  it('is bounded — telemetry cannot grow without limit', () => {
    const mark = markFailoverAttempts();
    for (let i = 0; i < 500; i++) recordFailoverAttempt(attempt('p', `m${i}`));
    const seen = attemptsSince(mark);
    expect(seen.length).toBeLessThanOrEqual(200);
    // The NEWEST survive, which is the half a failure report needs.
    expect(seen[seen.length - 1]!.model).toBe('m499');
  });

  it('never throws into the routing path', () => {
    expect(() => recordFailoverAttempt({} as never)).not.toThrow();
  });
});

describe('failureKindPhrase', () => {
  it('turns a classification into something a user can act on', () => {
    expect(failureKindPhrase('rate-limit')).toMatch(/quota/);
    expect(failureKindPhrase('auth')).toMatch(/credential/);
    expect(failureKindPhrase('context-window')).toMatch(/too large/);
    expect(failureKindPhrase('timeout')).toBe('timed out');
    expect(failureKindPhrase('something-new')).toBe('failed');
  });
});

describe('formatWait', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatWait(5_000)).toBe('5s');
    expect(formatWait(90_000)).toBe('2m');
    expect(formatWait(55 * 60_000)).toBe('55m');
    expect(formatWait(3 * 3_600_000)).toBe('3h');
  });
});

describe('renderModelBreadthReport', () => {
  it('names each tried model with a reason and each parked model with a reason and a wait', () => {
    const text = renderModelBreadthReport({
      tried: [
        attempt('gemini', 'gemini-3.1-flash-lite', 'rate-limit'),
        attempt('groq', 'llama-3.3-70b', 'context-window'),
      ],
      parked: [
        {
          provider: 'deepinfra',
          kind: 'auth' as never,
          scope: 'provider' as never,
          recordedAt: Date.now(),
          expiresAt: Date.now() + 55 * 60_000,
          active: true,
          source: 'routing-failures' as never,
        },
      ],
      nextFreeInMs: 55 * 60_000,
    })!;

    expect(text).toMatch(/couldn't finish/);
    expect(text).toContain('I tried 2 models');
    expect(text).toContain('gemini/gemini-3.1-flash-lite — rate limited (quota)');
    expect(text).toContain('groq/llama-3.3-70b — the prompt was too large for its window');
    expect(text).toContain('deepinfra — rejected its credential — free in ~55m');
    // The offer is what turns a dead end into a next step.
    expect(text).toMatch(/keep checking/i);
    expect(text).toMatch(/Reply \*yes\*/i);
  });

  it('offers to keep checking even when nothing will free up soon', () => {
    const text = renderModelBreadthReport({ tried: [attempt('a', 'b', 'timeout')], parked: [] })!;
    expect(text).toMatch(/No suitable model is available right now/);
    expect(text).toMatch(/keep checking in the background/);
  });

  it('returns undefined when there is nothing concrete to report', () => {
    // Callers keep their existing error line rather than printing an empty report.
    expect(renderModelBreadthReport({ tried: [], parked: [] })).toBeUndefined();
  });

  it('separates SKIPPED candidates from CALLED ones', () => {
    const text = renderModelBreadthReport({
      tried: [attempt('called', 'm1', 'timeout'), attempt('never-called', 'm2', 'skipped', true)],
      parked: [],
    })!;
    expect(text).toContain('I tried 1 model:');
    expect(text).toContain('called/m1');
    // A skipped candidate was never called, so it must not be listed as tried.
    expect(text).not.toContain('never-called/m2 — failed');
    expect(text).not.toContain('I tried 2');
  });
});

describe('modelBreadthReport', () => {
  it('collects the attempts since a mark and never throws without a config', () => {
    const mark = markFailoverAttempts();
    recordFailoverAttempt(attempt('local', 'gpt-oss:120b-cloud', 'timeout'));
    const report = modelBreadthReport(mark);
    expect(report.tried.map((a) => a.provider)).toContain('local');
    expect(Array.isArray(report.parked)).toBe(true);
  });
});
