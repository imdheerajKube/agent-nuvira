/**
 * CAPABILITY BY MEASUREMENT — the scorecard (Bundle 3b, B1–B4).
 *
 * What these tests defend, in order of importance:
 *
 *   1. **0 samples = the prior, exactly.** That is what makes the switch from
 *      name-based judgement to measured judgement safe to land: nothing that has
 *      never been measured changes behaviour, so no model is newly excluded or
 *      admitted by a rounding difference.
 *   2. **A turn that verified nothing contributes NO sample** (not a neutral 50).
 *      A run that never checks its work has no accuracy evidence, and a
 *      fabricated neutral sample would dilute the real ones.
 *   3. **The prior decays as evidence arrives** and the value is then the
 *      MEASUREMENT, whatever the id says.
 *   4. **The record survives availability writes.** An auth failure or a
 *      catalogue re-list says nothing about how well the model answered, so a
 *      wipe there would silently reset every sample the harness collected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCURACY_BY_VERDICT,
  MIN_SAMPLES_FOR_EVIDENCE,
  PRIOR_FULL_SAMPLES,
  capabilityLines,
  deriveTier,
  effectiveParameter,
  emptyCapabilityRecord,
  foldCallOutcome,
  foldLatency,
  foldVerification,
} from '../../src/learning/capability-evidence.js';
import { getModelRegistry, resetModelRegistry } from '../../src/learning/model-registry.js';

const NOW = 1_800_000_000_000;

describe('the prior rule — nothing measured behaves exactly as before', () => {
  it('returns the prior verbatim with no samples', () => {
    expect(effectiveParameter(undefined, 'accuracy', 0.55)).toEqual({
      value: 0.55,
      samples: 0,
      source: 'prior',
    });
    expect(effectiveParameter(emptyCapabilityRecord(NOW), 'accuracy', 0.55).value).toBe(0.55);
  });

  it('clamps the prior into 0..1 rather than trusting the caller', () => {
    expect(effectiveParameter(undefined, 'accuracy', 1.4).value).toBe(1);
    expect(effectiveParameter(undefined, 'accuracy', -3).value).toBe(0);
  });
});

describe('folding observations', () => {
  it('scores a verified turn at 100 and an unverified turn at 40 — never 0', () => {
    const verified = foldVerification(emptyCapabilityRecord(NOW), 'verified', NOW);
    const unverified = foldVerification(emptyCapabilityRecord(NOW), 'unverified', NOW);
    expect(verified.accuracy).toEqual({ measured: ACCURACY_BY_VERDICT.verified, samples: 1 });
    expect(unverified.accuracy).toEqual({ measured: ACCURACY_BY_VERDICT.unverified, samples: 1 });
    // An unverified turn is weaker evidence than a verified one, but it is not a
    // failure: the reward model already carries that penalty (`verificationPassed:
    // false`), and scoring it 0 here would count the same event twice.
    expect(ACCURACY_BY_VERDICT.unverified).toBeGreaterThan(0);
  });

  it('records NOTHING for a blocked or not-applicable turn — the honest limit', () => {
    const base = emptyCapabilityRecord(NOW);
    for (const verdict of ['blocked', 'not-applicable', undefined, null] as const) {
      expect(foldVerification(base, verdict, NOW)).toBe(base);
    }
    // The consequence, stated as an acceptance: a run that never verifies
    // anything gets NO accuracy samples rather than good ones.
    const record = foldVerification(emptyCapabilityRecord(NOW), 'not-applicable', NOW);
    expect(effectiveParameter(record, 'accuracy', 0.9).source).toBe('prior');
  });

  it('decays the prior as samples accumulate, so evidence eventually wins', () => {
    let record = emptyCapabilityRecord(NOW);
    for (let i = 0; i < PRIOR_FULL_SAMPLES; i++) record = foldVerification(record, 'unverified', NOW);
    const view = effectiveParameter(record, 'accuracy', 0.9);
    // Prior weight reaches zero at PRIOR_FULL_SAMPLES: the value IS the measurement.
    expect(view.value).toBeCloseTo(ACCURACY_BY_VERDICT.unverified / 100, 5);
    expect(view.samples).toBe(PRIOR_FULL_SAMPLES);
    expect(view.source).toBe('measured');
    // …and it is BELOW the prior, which is the point: measurement can demote.
    expect(view.value).toBeLessThan(0.9);
  });

  it('reports `prior` until the minimum sample count is reached', () => {
    let record = emptyCapabilityRecord(NOW);
    for (let i = 0; i < MIN_SAMPLES_FOR_EVIDENCE - 1; i++) record = foldVerification(record, 'verified', NOW);
    expect(effectiveParameter(record, 'accuracy', 0.5).source).toBe('prior');
    expect(effectiveParameter(record, 'accuracy', 0.5).samples).toBe(MIN_SAMPLES_FOR_EVIDENCE - 1);
    record = foldVerification(record, 'verified', NOW);
    expect(effectiveParameter(record, 'accuracy', 0.5).source).toBe('measured');
  });

  it('folds call outcomes into robustness and latency into performance', () => {
    let record = emptyCapabilityRecord(NOW);
    record = foldCallOutcome(record, true, NOW);
    record = foldCallOutcome(record, false, NOW);
    record = foldCallOutcome(record, false, NOW);
    // EMA(α=0.3) over 100, 0, 0 → 49. Asserted on the MEASURED value: the blended
    // figure still carries 70% of the prior at 3 samples, which is the prior
    // rule working, not the EMA failing.
    expect(record.robustness?.samples).toBe(3);
    expect(record.robustness?.measured).toBeCloseTo(49, 0);
    expect(effectiveParameter(record, 'robustness', 0.5).source).toBe('prior');

    // The scale is stated, not inferred: 800 ms or faster is 100, 10 s is 0.
    expect(foldLatency(emptyCapabilityRecord(NOW), 400, NOW).performance?.measured).toBe(100);
    expect(foldLatency(emptyCapabilityRecord(NOW), 10_000, NOW).performance?.measured).toBe(0);
    expect(foldLatency(emptyCapabilityRecord(NOW), 5400, NOW).performance?.measured).toBeCloseTo(50, 0);
    // No measurement is not a slow measurement.
    expect(foldLatency(emptyCapabilityRecord(NOW), undefined, NOW)).toEqual(emptyCapabilityRecord(NOW));
    expect(foldLatency(emptyCapabilityRecord(NOW), 0, NOW)).toEqual(emptyCapabilityRecord(NOW));
  });

  it('keeps a parameter with no observations out of the way entirely', () => {
    const record = foldVerification(emptyCapabilityRecord(NOW), 'verified', NOW);
    expect(effectiveParameter(record, 'cost', 0.5).samples).toBe(0);
    expect(effectiveParameter(record, 'cost', 0.5).value).toBe(0.5);
  });
});

describe('the tier is derived from the parameters, never parsed from the id', () => {
  it('is Utility when accuracy or robustness is poor', () => {
    expect(deriveTier({ accuracy: { value: 0.4, samples: 9 }, robustness: { value: 1, samples: 0 }, ecosystem: { value: 1, samples: 0 } })).toBe('Utility');
    expect(deriveTier({ accuracy: { value: 1, samples: 9 }, robustness: { value: 0.4, samples: 9 }, ecosystem: { value: 1, samples: 0 } })).toBe('Utility');
  });

  it('is Frontier only when accuracy AND ecosystem are strong', () => {
    expect(deriveTier({ accuracy: { value: 0.9, samples: 9 }, robustness: { value: 0.9, samples: 9 }, ecosystem: { value: 0.8, samples: 0 } })).toBe('Frontier');
    // A strong answerer that cannot call tools is not a frontier AGENT model.
    expect(deriveTier({ accuracy: { value: 0.9, samples: 9 }, robustness: { value: 0.9, samples: 9 }, ecosystem: { value: 0.3, samples: 0 } })).toBe('Balanced');
  });
});

describe('capabilityLines — a number always carries its basis', () => {
  it('labels a prior as a prior and a measurement with its sample count', () => {
    const lines = capabilityLines(undefined, { accuracy: 0.78 });
    expect(lines[0]).toBe('accuracy 78 (prior)');
    expect(lines.join(' ')).not.toContain('n=');
  });

  it('prints n= once there are samples to count', () => {
    let record = emptyCapabilityRecord(NOW);
    record = foldVerification(record, 'verified', NOW);
    record = foldVerification(record, 'verified', NOW);
    const lines = capabilityLines(record, { accuracy: 0.5 });
    expect(lines[0]).toMatch(/^accuracy \d+ \(prior, n=2\)$/);
    // Never a bare score: a reader must be able to weigh it.
    expect(lines[0]).toContain('n=2');
  });
});

// ─── Storage: the record lives on the pair and outlives availability writes ──

let tempDir: string;
const ORIG_CONFIG_DIR = process.env.NUVIRA_CONFIG_DIR;
const ORIG_MEMORY_DIR = process.env.NUVIRA_MEMORY_DIR;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'buff-capability-'));
  process.env.NUVIRA_CONFIG_DIR = tempDir;
  process.env.NUVIRA_MEMORY_DIR = join(tempDir, 'memory');
  resetModelRegistry();
});

afterEach(() => {
  resetModelRegistry();
  if (ORIG_CONFIG_DIR === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG_CONFIG_DIR;
  if (ORIG_MEMORY_DIR === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('the registry stores and keeps the scorecard', () => {
  it('folds a turn verdict on the pair that served it', () => {
    const registry = getModelRegistry();
    registry.markListed('groq', ['openai/gpt-oss-120b']);
    registry.recordCapabilityEvidence('groq', 'openai/gpt-oss-120b', 'verified');
    registry.recordCapabilityEvidence('groq', 'openai/gpt-oss-120b', 'unverified');
    expect(registry.getCapability('groq', 'openai/gpt-oss-120b')?.accuracy?.samples).toBe(2);
  });

  it('ignores a verdict about a pair the registry does not track', () => {
    // Inventing a row from a turn would claim the pair exists; the scorecard
    // hangs off evidence the registry already has.
    getModelRegistry().recordCapabilityEvidence('groq', 'never-seen', 'verified');
    expect(getModelRegistry().getCapability('groq', 'never-seen')).toBeUndefined();
  });

  it('survives a verification, a catalogue re-list, and an availability flip', () => {
    const registry = getModelRegistry();
    registry.markListed('groq', ['openai/gpt-oss-120b']);
    registry.recordCapabilityEvidence('groq', 'openai/gpt-oss-120b', 'verified');
    const samples = () => registry.getCapability('groq', 'openai/gpt-oss-120b')?.accuracy?.samples;

    registry.markVerified('groq', 'openai/gpt-oss-120b', 'telemetry', 300);
    expect(samples()).toBe(1);
    registry.markListed('groq', ['openai/gpt-oss-120b']);
    expect(samples()).toBe(1);
    registry.recordCall('groq', 'openai/gpt-oss-120b', false, 'auth', 'chat');
    expect(samples()).toBe(1);
    registry.markUnavailable('groq', 'openai/gpt-oss-120b', 'rate-limit', 'telemetry');
    expect(samples()).toBe(1);
  });

  it('feeds robustness and performance from a real call, without touching status', () => {
    const registry = getModelRegistry();
    registry.markVerified('groq', 'openai/gpt-oss-120b', 'spot-check', 300);
    registry.recordCall('groq', 'openai/gpt-oss-120b', true, undefined, 'chat', 500);
    const record = registry.getCapability('groq', 'openai/gpt-oss-120b');
    expect(record?.robustness?.samples).toBe(1);
    expect(record?.performance?.samples).toBe(1);
    // Availability is a different question — a capability fold never sets it.
    expect(registry.getEntry('groq', 'openai/gpt-oss-120b')?.status).toBe('verified');
  });
});
