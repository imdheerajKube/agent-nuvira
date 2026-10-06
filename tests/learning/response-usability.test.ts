/**
 * fix_model_routing P1 — "an empty response is a failure, not a success".
 *
 * The bug this pins: a provider that resolved HTTP 200 with NOTHING was recorded
 * as a success by the failover walk, so it kept `verified` status and
 * `errorRate 0`, the walk never advanced, and a real turn retried the same dead
 * model five times before dying with zero tool calls. These tests fix the
 * definition (what "usable" means), the error that carries it, the failure
 * classification the report and ledger read, and the registry treatment that
 * stops the pair being re-picked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyModelResponse,
  assertUsableModelResponse,
  isUnusableModelResponseError,
  UnusableModelResponseError,
  EMPTY_RESPONSE_FAILURE_KIND,
} from '../../src/learning/response-usability.js';
import {
  classifyFallbackError,
  isRetryableError,
  isTransientForRetry,
} from '../../src/learning/provider-fallback.js';
import { getModelRegistry, resetModelRegistry, EMPTY_RESPONSE_PARK_MS } from '../../src/learning/model-registry.js';

describe('classifyModelResponse — the single definition of "usable"', () => {
  it('treats a blank or whitespace-only completion as EMPTY', () => {
    expect(classifyModelResponse('').kind).toBe('empty');
    expect(classifyModelResponse('   \n\t ').kind).toBe('empty');
    expect(classifyModelResponse('').usable).toBe(false);
  });

  it('accepts real text, including a think-only reply', () => {
    expect(classifyModelResponse('Here is the plan.').usable).toBe(true);
    // DELIBERATE: reasoning is not emptiness. Folding think-only replies into the
    // empty path would swap models mid-thought on every reasoning model.
    expect(classifyModelResponse(' thinkingweighing options</think>').usable).toBe(true);
  });

  it('accepts a step response carrying text or tool calls', () => {
    expect(classifyModelResponse({ content: 'answer', toolCalls: [] }).usable).toBe(true);
    expect(classifyModelResponse({ content: '', toolCalls: [{ id: '1' }] }).usable).toBe(true);
  });

  it('calls a well-formed but contentless step response EMPTY', () => {
    const verdict = classifyModelResponse({ content: '', toolCalls: [] });
    expect(verdict.usable).toBe(false);
    expect(verdict.kind).toBe('empty');
  });

  it('calls a broken shape MALFORMED (a different repair from empty)', () => {
    expect(classifyModelResponse(null).kind).toBe('malformed');
    expect(classifyModelResponse(undefined).kind).toBe('malformed');
    expect(classifyModelResponse(42).kind).toBe('malformed');
    expect(classifyModelResponse({}).kind).toBe('malformed');
    expect(classifyModelResponse({ content: 7, toolCalls: 'nope' }).kind).toBe('malformed');
  });
});

describe('assertUsableModelResponse', () => {
  it('passes a usable response through unchanged', () => {
    expect(assertUsableModelResponse('ok')).toBe('ok');
    expect(assertUsableModelResponse({ content: 'x', toolCalls: [] })).toEqual({ content: 'x', toolCalls: [] });
  });

  it('throws a typed, classifiable error for an unusable one', () => {
    expect(() => assertUsableModelResponse('')).toThrow(UnusableModelResponseError);
    try {
      assertUsableModelResponse('');
    } catch (err) {
      expect(isUnusableModelResponseError(err)).toBe(true);
      expect((err as UnusableModelResponseError).kind).toBe('empty');
      expect((err as UnusableModelResponseError).failureKind).toBe(EMPTY_RESPONSE_FAILURE_KIND);
      // The message carries the marker the classifier keys on.
      expect(String((err as Error).message)).toContain('unusable model response');
    }
  });

  it('recognises a lookalike by name (survives duplicate module instances)', () => {
    const lookalike = Object.assign(new Error('unusable model response (empty): nothing'), {
      name: 'UnusableModelResponseError',
    });
    expect(isUnusableModelResponseError(lookalike)).toBe(true);
    expect(isUnusableModelResponseError(new Error('nope'))).toBe(false);
    expect(isUnusableModelResponseError(null)).toBe(false);
  });
});

describe('failure classification — an empty response is its own class', () => {
  const err = () => new UnusableModelResponseError('empty', 'the provider returned no text');

  it('classifies it as `empty-response`, never `unknown`', () => {
    expect(classifyFallbackError(err())).toBe('empty-response');
  });

  it('is retryable on a DIFFERENT provider but not by re-hitting the SAME one', () => {
    // Fail over — yes (that is the whole point of P1/P2).
    expect(isRetryableError('empty-response')).toBe(true);
    // Same-provider retry — no: that re-runs the model that just returned nothing,
    // which is precisely the loop that killed the real turn.
    expect(isTransientForRetry(err())).toBe(false);
  });
});

describe('registry telemetry — the pair stops looking healthy', () => {
  let dir = '';
  const realMemoryDir = process.env.NUVIRA_MEMORY_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-empty-response-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
    resetModelRegistry();
  });

  afterEach(() => {
    if (realMemoryDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = realMemoryDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('bumps errorRate and parks the MODEL without touching the provider sibling', () => {
    const registry = getModelRegistry();
    registry.markVerified('gemini', 'gemini-3.1-flash-lite', 'telemetry', 400);
    registry.markVerified('gemini', 'gemma-4-26b-a4b-it', 'telemetry', 400);

    registry.recordCall('gemini', 'gemma-4-26b-a4b-it', false, 'empty-response', 'chat');

    const broken = registry.getEntry('gemini', 'gemma-4-26b-a4b-it');
    expect(broken?.errorRate).toBeGreaterThan(0);
    expect(broken?.lastError).toContain('empty-response');
    expect(broken?.quotaParkedUntil ?? 0).toBeGreaterThan(Date.now());
    expect(broken?.quotaParkedUntil ?? 0).toBeLessThanOrEqual(Date.now() + EMPTY_RESPONSE_PARK_MS + 1_000);
    // The provider's OTHER model is untouched — a model-scoped park, not a
    // provider park (which is what used to take healthy siblings down).
    expect(registry.getEntry('gemini', 'gemini-3.1-flash-lite')?.quotaParkedUntil ?? 0).toBe(0);
    expect(registry.getEntry('gemini', 'gemini-3.1-flash-lite')?.errorRate ?? 0).toBe(0);
  });
});
