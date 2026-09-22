import { describe, it, expect, beforeEach } from 'vitest';

import {
  parseMaxTokensLimit,
  rememberMaxTokensLimit,
  knownMaxTokensLimit,
  clampMaxTokens,
  learnMaxTokensLimitFromError,
  resetLearnedMaxTokensLimits,
} from '../../src/learning/provider-limits.js';

/**
 * G15 — a provider that names its output cap must not be able to fail every
 * step of an unattended run. These are the EXACT error strings from the live
 * runs (Groq 512-cap) plus the other providers' phrasings.
 */
describe('parseMaxTokensLimit', () => {
  const GROQ_512 =
    'Groq API error (400): {"error":{"message":"`max_tokens` must be less than or equal to `512`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error","param":"max_tokens"}}';

  it('reads the limit from the live Groq rejection that killed 6 batches of prose', () => {
    expect(parseMaxTokensLimit(new Error(GROQ_512))).toBe(512);
  });

  it('returns the SMALLEST named limit when a message contains several numbers', () => {
    // A retry that is too small still succeeds; one that is too large wastes
    // another call, which is the entire failure mode being fixed.
    const msg = 'max_tokens must be less than or equal to 512 (context_window 8192)';
    expect(parseMaxTokensLimit(new Error(msg))).toBe(512);
  });

  it('reads Anthropic-style "maximum allowed number of output tokens"', () => {
    const msg =
      'max_tokens: 8192 > 4096, which is the maximum allowed number of output tokens for claude-3-haiku-20240307';
    expect(parseMaxTokensLimit(new Error(msg))).toBe(4096);
  });

  it('reads camelCase maxOutputTokens (Gemini)', () => {
    expect(parseMaxTokensLimit(new Error('maxOutputTokens must be <= 2048'))).toBe(2048);
  });

  it('reads a nested provider body under cause', () => {
    const err = new Error('call failed', {
      cause: new Error('{"error":{"message":"`max_tokens` must be no more than `256`"}}'),
    });
    expect(parseMaxTokensLimit(err)).toBe(256);
  });

  it('accepts a raw string, not just an Error', () => {
    expect(parseMaxTokensLimit('max_tokens must be at most 128')).toBe(128);
  });

  it('is null for unrelated provider errors', () => {
    expect(parseMaxTokensLimit(new Error('Groq API error (429): rate limit exceeded'))).toBeNull();
    expect(parseMaxTokensLimit(new Error('429 Too Many Requests'))).toBeNull();
    expect(parseMaxTokensLimit(undefined)).toBeNull();
    expect(parseMaxTokensLimit(null)).toBeNull();
  });

  it('is null when max_tokens is mentioned without a named limit', () => {
    // Must not invent a number from our own prompt echo.
    expect(
      parseMaxTokensLimit(new Error("'max_tokens' is not supported with this model")),
    ).toBeNull();
  });

  it('is null when the named field is not an output cap', () => {
    expect(parseMaxTokensLimit(new Error('`temperature` must be less than or equal to `2`'))).toBeNull();
  });
});

describe('learned limits', () => {
  beforeEach(() => resetLearnedMaxTokensLimits());

  it('remembers a limit per provider x model', () => {
    rememberMaxTokensLimit('groq', 'default', 512);
    expect(knownMaxTokensLimit('groq', 'default')).toBe(512);
    // Case/space-insensitive on both halves.
    expect(knownMaxTokensLimit('GROQ', ' Default ')).toBe(512);
    // A different pair is unaffected.
    expect(knownMaxTokensLimit('groq', 'llama-3.3-70b')).toBeUndefined();
  });

  it('never raises a learned limit', () => {
    rememberMaxTokensLimit('groq', 'default', 512);
    rememberMaxTokensLimit('groq', 'default', 8192);
    expect(knownMaxTokensLimit('groq', 'default')).toBe(512);
  });

  it('ignores an incomplete key or an invalid limit', () => {
    rememberMaxTokensLimit(undefined, 'default', 512);
    rememberMaxTokensLimit('groq', undefined, 512);
    rememberMaxTokensLimit('groq', 'default', 0);
    rememberMaxTokensLimit('groq', 'default', Number.NaN);
    expect(knownMaxTokensLimit('groq', 'default')).toBeUndefined();
  });

  it('clamps only downwards and only when a limit is known', () => {
    expect(clampMaxTokens(8192, 'groq', 'default')).toBe(8192); // nothing learned yet
    rememberMaxTokensLimit('groq', 'default', 512);
    expect(clampMaxTokens(8192, 'groq', 'default')).toBe(512);
    expect(clampMaxTokens(256, 'groq', 'default')).toBe(256); // caller asked for less
    expect(clampMaxTokens(undefined, 'groq', 'default')).toBe(512);
  });

  it('learns from an error and returns the limit to retry with', () => {
    const err = new Error('Groq API error (400): `max_tokens` must be less than or equal to `512`');
    expect(learnMaxTokensLimitFromError(err, 'groq', 'default')).toBe(512);
    expect(knownMaxTokensLimit('groq', 'default')).toBe(512);
  });

  it('returns null and learns nothing for a non-cap error', () => {
    const err = new Error('Groq API error (429): rate limit');
    expect(learnMaxTokensLimitFromError(err, 'groq', 'default')).toBeNull();
    expect(knownMaxTokensLimit('groq', 'default')).toBeUndefined();
  });
});
