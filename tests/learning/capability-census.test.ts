/**
 * Capability accuracy census — name-derived band vs measured accuracy.
 *
 * The census is REPORT-ONLY, so its tests are about honesty of the arithmetic:
 * no sample means no mean, a disagreement needs evidence-grade support, and the
 * band cut points are the same ones `capabilityClassOf` uses.
 */

import { describe, it, expect } from 'vitest';
import {
  capabilityAccuracyCensus,
  accuracyBand,
} from '../../src/learning/capability-census.js';
import { MIN_SAMPLES_FOR_EVIDENCE, type CapabilityRecord } from '../../src/learning/capability-evidence.js';

function record(accuracy: number, samples: number): CapabilityRecord {
  return { accuracy: { measured: accuracy, samples }, updatedAt: 0 };
}

describe('accuracyBand — the same cuts as the name band', () => {
  it('maps 0–100 onto high/medium/low at 70 and 45', () => {
    expect(accuracyBand(100)).toBe('high');
    expect(accuracyBand(70)).toBe('high');
    expect(accuracyBand(69.9)).toBe('medium');
    expect(accuracyBand(45)).toBe('medium');
    expect(accuracyBand(44.9)).toBe('low');
    expect(accuracyBand(0)).toBe('low');
  });
});

describe('capabilityAccuracyCensus', () => {
  it('makes no claim when nothing has been measured', () => {
    const c = capabilityAccuracyCensus([{ provider: 'groq', model: 'llama-3.3-70b' }]);
    expect(c.pairs).toBe(1);
    expect(c.measured).toBe(0);
    expect(c.evidence).toBe(0);
    expect(c.totalSamples).toBe(0);
    expect(c.meanAccuracy).toBeUndefined();
    expect(c.meanAccuracyEvidence).toBeUndefined();
    expect(c.disagreements).toEqual([]);
  });

  it('counts a zero-sample record as unmeasured, not as a bad score', () => {
    const c = capabilityAccuracyCensus([
      { provider: 'groq', model: 'llama-3.3-70b', capability: record(0, 0) },
    ]);
    expect(c.measured).toBe(0);
    expect(c.meanAccuracy).toBeUndefined();
  });

  it('reports agreement for an evidence-grade row whose measured band matches its name', () => {
    // gpt-oss-120b → high by name; 82 measured keeps it high.
    const c = capabilityAccuracyCensus([
      { provider: 'local', model: 'gpt-oss:120b-cloud', capability: record(82, 12) },
    ]);
    expect(c.evidence).toBe(1);
    expect(c.disagreements).toEqual([]);
    expect(c.byBand.high.pairs).toBe(1);
    expect(c.byBand.high.mean).toBe(82);
  });

  it('reports a disagreement only when the row is evidence-grade', () => {
    // `deepseek-flash` reads HIGH by name (a `flash` tier scores 0.75, and the
    // high band starts at 0.70); 40 measured says low.
    const thin = capabilityAccuracyCensus([
      { provider: 'deepseek', model: 'deepseek-flash', capability: record(40, 3) },
    ]);
    expect(thin.measured).toBe(1);
    expect(thin.evidence).toBe(0);
    expect(thin.disagreements).toEqual([]);
    expect(thin.meanAccuracy).toBe(40);

    const thick = capabilityAccuracyCensus(
      [{ provider: 'deepseek', model: 'deepseek-flash', capability: record(40, MIN_SAMPLES_FOR_EVIDENCE) }],
    );
    expect(thick.evidence).toBe(1);
    expect(thick.disagreements).toHaveLength(1);
    expect(thick.disagreements[0]).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-flash',
      nameBand: 'high',
      measuredBand: 'low',
      accuracy: 40,
      samples: MIN_SAMPLES_FOR_EVIDENCE,
    });
  });

  it('weights no row twice: the mean is over pairs, samples are reported separately', () => {
    const c = capabilityAccuracyCensus([
      { provider: 'a', model: 'gpt-oss-120b', capability: record(90, 40) },
      { provider: 'b', model: 'gpt-oss-20b', capability: record(10, 5) },
    ]);
    expect(c.measured).toBe(2);
    expect(c.totalSamples).toBe(45);
    // 90 and 10, not (90*40 + 10*5)/45 — a pair is one row, not its traffic.
    expect(c.meanAccuracy).toBe(50);
  });

  it('sorts disagreements worst-looking first', () => {
    const c = capabilityAccuracyCensus([
      { provider: 'a', model: 'gpt-oss-120b', capability: record(30, 10) },
      { provider: 'b', model: 'gpt-oss-120b', capability: record(10, 10) },
    ]);
    expect(c.disagreements.map((d) => d.accuracy)).toEqual([10, 30]);
  });
});
