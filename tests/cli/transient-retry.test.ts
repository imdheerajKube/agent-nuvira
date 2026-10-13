/**
 * Same-provider transient retry.
 *
 * Verified live: a 4-step task hit `503 ... currently experiencing high demand`
 * from Gemini. `isRetryableError` only means "worth trying a DIFFERENT provider",
 * and this machine has ONE provider configured — so there was no retry at all,
 * the circuit breaker parked the provider for 120s, the context-gatherer fell
 * back to "0 relevant files", and the writer edited blind. One capacity spike at a
 * shared endpoint turned into a wrong answer.
 *
 * These tests pin the contract: transient → retried on the same provider with a
 * bounded backoff; everything else → fail immediately.
 *
 * And the SPLIT policy on top of it, which keeps `empty-response` out of that
 * blanket: an empty reply is retried on the same pair ONLY when that pair has
 * already delivered real work this turn (the "4 good steps, then nothing"
 * case), and never more than the bounded patience schedule.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  generateWithTransientRetry,
  threadHasDeliveredWork,
  transientRetryDelaysMs,
  TRANSIENT_RETRY_DELAYS_MS,
  EMPTY_RESPONSE_PATIENCE_MS,
} from '../../src/cli/chat.js';
import { isTransientForRetry } from '../../src/learning/provider-fallback.js';

const GEMINI_503 = 'Gemini API error (503): {"error":{"code":503,"message":"This model is currently experiencing high demand."}}';

describe('isTransientForRetry', () => {
  it('is true for the classes a retry can actually fix', () => {
    expect(isTransientForRetry(new Error(GEMINI_503))).toBe(true);
    expect(isTransientForRetry(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isTransientForRetry(new Error('Request timed out'))).toBe(true);
  });

  it('is false where a retry cannot help (and would only mask the cause)', () => {
    expect(isTransientForRetry(new Error('401 Unauthorized — invalid API key'))).toBe(false);
    expect(isTransientForRetry(new Error('429 Too Many Requests'))).toBe(false);
    expect(isTransientForRetry(new Error('404 model not found'))).toBe(false);
    // A harness fault is deterministic: retrying it would burn the same 400 twice.
    expect(isTransientForRetry(new Error('400: Function call is missing a thought_signature'))).toBe(false);
  });
});

describe('generateWithTransientRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient 503 on the SAME provider and returns the success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error(GEMINI_503);
      return 'the answer';
    });

    const pending = generateWithTransientRetry(attempt);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe('the answer');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient error — it fails immediately', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('401 Unauthorized — invalid API key');
    });

    await expect(generateWithTransientRetry(attempt)).rejects.toThrow('401');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after the backoff schedule is exhausted', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => {
      throw new Error('503 server error');
    });

    const pending = generateWithTransientRetry(attempt);
    const assertion = expect(pending).rejects.toThrow('503');
    await vi.runAllTimersAsync();
    await assertion;

    // The original attempt plus one per scheduled delay — bounded, never a loop.
    expect(attempt).toHaveBeenCalledTimes(TRANSIENT_RETRY_DELAYS_MS.length + 1);
  });

  it('never retries a cancelled turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => {
      throw new Error(GEMINI_503);
    });

    await expect(generateWithTransientRetry(attempt, controller.signal)).rejects.toThrow('503');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports each retry so the user sees the wait rather than a frozen screen', async () => {
    vi.useFakeTimers();
    const retries: number[] = [];
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls < 2) throw new Error(GEMINI_503);
      return 'ok';
    };

    const pending = generateWithTransientRetry(attempt, undefined, (n) => retries.push(n));
    await vi.runAllTimersAsync();
    await pending;

    expect(retries).toEqual([1]);
  });

  it('is patient for tens of seconds, not a formality (the 503 spike it exists for)', () => {
    // A shared endpoint's spike outlives [1s, 3s]: the schedule must span a
    // real window before the walk declares the provider dead.
    expect(TRANSIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
    expect(TRANSIENT_RETRY_DELAYS_MS.length).toBeGreaterThanOrEqual(4);
  });
});

describe('empty-response patience — the "final verse" case', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Our own wording (`response-usability.ts`) — the classifier keys off it.
  const EMPTY = new Error(
    'Unusable model response from gemini/gemma-4-26b-a4b-it: the reply carried no text and no tool call',
  );

  it('is NOT retried by default (the measured 5-empty-responses loop stays impossible)', async () => {
    const attempt = vi.fn(async () => {
      throw EMPTY;
    });

    await expect(generateWithTransientRetry(attempt)).rejects.toThrow('Unusable');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('recovers when the blip clears after an empty reply', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls < 2) throw EMPTY;
      return 'the closing verse';
    };

    const pending = generateWithTransientRetry(attempt, undefined, undefined, {
      emptyResponseDelaysMs: EMPTY_RESPONSE_PATIENCE_MS,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe('the closing verse');
  });

  it('gives up after the bounded patience is spent, never looping', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => {
      throw EMPTY;
    });

    const pending = generateWithTransientRetry(attempt, undefined, undefined, {
      emptyResponseDelaysMs: EMPTY_RESPONSE_PATIENCE_MS,
    });
    const assertion = expect(pending).rejects.toThrow('Unusable');
    await vi.runAllTimersAsync();
    await assertion;

    expect(attempt).toHaveBeenCalledTimes(EMPTY_RESPONSE_PATIENCE_MS.length + 1);
  });

  it('does not make a DEFINITIVE failure retryable', async () => {
    // Patience is scoped to empty responses: a rejected credential must still
    // fail immediately, however much patience the caller granted.
    const attempt = vi.fn(async () => {
      throw new Error('401 Unauthorized — invalid API key');
    });

    await expect(
      generateWithTransientRetry(attempt, undefined, undefined, {
        emptyResponseDelaysMs: EMPTY_RESPONSE_PATIENCE_MS,
      }),
    ).rejects.toThrow('401');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('transientRetryDelaysMs — the wait is configuration, not a build property', () => {
  it('defaults to the shipped schedule when nothing overrides it', () => {
    expect(transientRetryDelaysMs({} as NodeJS.ProcessEnv)).toEqual([...TRANSIENT_RETRY_DELAYS_MS]);
    // A blank value is "not set", not "wait zero seconds".
    expect(transientRetryDelaysMs({ NUVIRA_TRANSIENT_RETRY_DELAYS_MS: '  ' } as NodeJS.ProcessEnv)).toEqual([
      ...TRANSIENT_RETRY_DELAYS_MS,
    ]);
  });

  it('honours an explicit list, including zero (no backoff)', () => {
    expect(transientRetryDelaysMs({ NUVIRA_TRANSIENT_RETRY_DELAYS_MS: '500,1000' } as NodeJS.ProcessEnv)).toEqual([
      500, 1_000,
    ]);
    expect(transientRetryDelaysMs({ NUVIRA_TRANSIENT_RETRY_DELAYS_MS: '0' } as NodeJS.ProcessEnv)).toEqual([0]);
  });

  it('ignores nonsense rather than disarming the retry', () => {
    expect(transientRetryDelaysMs({ NUVIRA_TRANSIENT_RETRY_DELAYS_MS: 'soon,-5' } as NodeJS.ProcessEnv)).toEqual([
      ...TRANSIENT_RETRY_DELAYS_MS,
    ]);
  });
});

describe('abortable backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting the moment the turn is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      throw new Error(GEMINI_503);
    });

    const pending = generateWithTransientRetry(attempt, controller.signal);
    const assertion = expect(pending).rejects.toThrow('503');
    // One attempt in, the first 5s backoff is pending — cancel the turn.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;

    // A cancelled turn does not pay for another attempt (nor wait out the 5s).
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('threadHasDeliveredWork — the evidence that gates empty-response patience', () => {
  it('is false before any tool has completed', () => {
    expect(threadHasDeliveredWork([{ role: 'system' }, { role: 'user' }])).toBe(false);
    // ASKING for a tool is not work; the RESULT coming back is.
    expect(
      threadHasDeliveredWork([{ role: 'user' }, { role: 'assistant', toolCalls: [{ id: 'c1' }] }]),
    ).toBe(false);
  });

  it('is true once a tool call has completed', () => {
    expect(
      threadHasDeliveredWork([
        { role: 'system' },
        { role: 'user' },
        { role: 'assistant', toolCalls: [{ id: 'c1' }] },
        { role: 'tool' },
      ]),
    ).toBe(true);
  });
});
