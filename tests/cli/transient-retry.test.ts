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
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { generateWithTransientRetry, TRANSIENT_RETRY_DELAYS_MS } from '../../src/cli/chat.js';
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
});
