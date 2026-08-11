/**
 * HTTP error context attachment — unit tests.
 *
 * Pins the contract that adapter-thrown errors carry the raw HTTP status +
 * headers so the shared extractRetryAfterMs() (learning/provider-fallback)
 * can read rate-limit reset hints (Retry-After / x-ratelimit-reset-*) and
 * park providers for their ACTUAL reset time.
 */

import { describe, it, expect } from 'vitest';
import { attachHttpContext } from '../../src/inference/http-error.js';
import { extractRetryAfterMs } from '../../src/learning/provider-fallback.js';

describe('attachHttpContext', () => {
  it('attaches status + headers without changing the message', () => {
    const headers = new Headers({ 'retry-after': '16' });
    const err = attachHttpContext(new Error('Groq API error (429): rate limit'), 429, headers);

    expect(err.message).toBe('Groq API error (429): rate limit');
    expect((err as any).status).toBe(429);
    expect((err as any).headers).toBe(headers);
  });

  it('lets extractRetryAfterMs read the attached Retry-After header (body-less 429)', () => {
    const headers = new Headers({ 'retry-after': '16' });
    const err = attachHttpContext(new Error('Groq API error (429): '), 429, headers);

    expect(extractRetryAfterMs(err)).toBe(16_000);
  });

  it('lets extractRetryAfterMs read x-ratelimit-reset-* seconds (OpenAI/Groq style)', () => {
    const headers = new Headers({ 'x-ratelimit-reset-requests': '12' });
    const err = attachHttpContext(new Error('Groq API error (429): '), 429, headers);

    expect(extractRetryAfterMs(err)).toBe(12_000);
  });

  it('no headers → extractRetryAfterMs falls back to the message hint', () => {
    const err = attachHttpContext(new Error('Gemini API error (429): try again in 8s'), 429);
    expect(extractRetryAfterMs(err)).toBe(8000);
  });
});
