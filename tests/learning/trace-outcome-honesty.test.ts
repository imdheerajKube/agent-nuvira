/**
 * A3 — honest outcomes.
 *
 * The live Aukat_check traces reported `success: true` for turns whose outcome
 * was `cancelled`, so nothing downstream treated an unfinished run as
 * unfinished. These tests pin the rule: `cancelled`, `failed` and `incomplete`
 * are NEVER successes, and a turn that claimed work it did not do is
 * `incomplete`, not `acted`.
 */

import { describe, it, expect } from 'vitest';
import { buildTraceOutcome, traceOutcomeSucceeded } from '../../src/learning/reasoning-trace.js';

describe('buildTraceOutcome — kinds', () => {
  it('records cancelled for a cancelled turn', () => {
    expect(buildTraceOutcome({ cancelled: true, tools: ['edit_file'] }).kind).toBe('cancelled');
  });

  it('records failed for a generation failure', () => {
    expect(buildTraceOutcome({ generationFailed: true }).kind).toBe('failed');
  });

  it('records acted when tools ran and nothing is outstanding', () => {
    const o = buildTraceOutcome({ tools: ['read_file', 'edit_file'] });
    expect(o.kind).toBe('acted');
    expect(o.tools).toEqual(['read_file', 'edit_file']);
  });

  it('records answered when no tool ran', () => {
    expect(buildTraceOutcome({ tools: [] }).kind).toBe('answered');
  });

  it('records incomplete when a claimed action was never performed', () => {
    const o = buildTraceOutcome({ tools: ['read_file'], unverifiedActionClaim: true });
    expect(o.kind).toBe('incomplete');
    expect(o.unverifiedClaim).toBe(true);
  });

  it('records incomplete when a promised deliverable was not produced', () => {
    expect(buildTraceOutcome({ tools: [], unfulfilledPromise: true }).kind).toBe('incomplete');
    // §6.5 — a DEGRADED turn is never a success, and the flag must survive the
    // builder: `traceOutcomeSucceeded` reads the outcome the CALLER built, so an
    // input this function dropped would be invisible to the very check that
    // honours it (found by re-running the builder against the live trace data).
    const degraded = buildTraceOutcome({
      tools: ['read_file', 'suggest_followups'],
      degradedBy: [{ provider: 'local', model: 'qwen2.5:0.5b' }],
    });
    expect(degraded.degradedBy).toEqual([{ provider: 'local', model: 'qwen2.5:0.5b' }]);
    expect(traceOutcomeSucceeded(degraded)).toBe(false);
    expect(buildTraceOutcome({ tools: [], undeliveredArtifact: true }).kind).toBe('incomplete');
  });

  it('records incomplete when a build failed but the answer claimed success', () => {
    // A3 Part 2: the run holds its OWN counter-evidence, so `acted` would be a
    // lie even though a tool really did run.
    const o = buildTraceOutcome({ tools: ['run_terminal'], unverifiedBuildClaim: true });
    expect(o.kind).toBe('incomplete');
    expect(o.unverifiedBuildClaim).toBe(true);
    expect(traceOutcomeSucceeded(o)).toBe(false);
  });

  it('cancelled outranks incomplete', () => {
    expect(buildTraceOutcome({ cancelled: true, unverifiedActionClaim: true }).kind).toBe('cancelled');
  });
});

describe('traceOutcomeSucceeded — nothing unfinished is a success', () => {
  it('rejects cancelled, failed and incomplete', () => {
    expect(traceOutcomeSucceeded({ kind: 'cancelled' })).toBe(false);
    expect(traceOutcomeSucceeded({ kind: 'failed' })).toBe(false);
    expect(traceOutcomeSucceeded({ kind: 'incomplete' })).toBe(false);
  });

  it('accepts answered and acted', () => {
    expect(traceOutcomeSucceeded({ kind: 'answered' })).toBe(true);
    expect(traceOutcomeSucceeded({ kind: 'acted', tools: ['edit_file'] })).toBe(true);
  });

  it('treats a missing outcome as success (legacy callers)', () => {
    expect(traceOutcomeSucceeded(undefined)).toBe(true);
  });

  it('is the inverse of the old `!generationFailed` for a cancelled turn', () => {
    // The bug: generationFailed was false on a cancelled turn, so success was true.
    const outcome = buildTraceOutcome({ cancelled: true });
    expect(traceOutcomeSucceeded(outcome)).toBe(false);
  });
});
