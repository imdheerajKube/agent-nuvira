/**
 * CAPABILITY ACCURACY CENSUS — does the name-based capability class agree with
 * what the scorecard actually measured?
 *
 * THE QUESTION. Routing's capability band comes from the model id (`flash`,
 * `lite`, `120b`, `pro` — see `model-capability.ts`). The registry separately
 * holds a MEASURED `accuracy` parameter per provider × model, folded from the
 * harness's own turn verdicts (`capability-evidence.ts`). Nobody had ever put the
 * two side by side, so the name heuristic could be wrong about a model forever
 * and no number would say so.
 *
 * WHAT "ACCURACY" MEANS HERE, precisely. It is not "was the answer good" — it is
 * how often the work VERIFIED, folded as `verified → 100`, `unverified → 40`,
 * with unverified deliberately discounted rather than failed. It is therefore
 * evidence about the PAIR and the harness around it, not a quality score for the
 * model in isolation. A pair whose tasks cannot be verified reads low whatever
 * the model can do, which is exactly why this module REPORTS and does not route:
 * measured on this machine, the two strongest verified pairs read 40 while a
 * one-sample 31B model reads 100. Feeding that into selection today would demote
 * working models on a handful of verdicts.
 *
 * So: read-only, sample-counted, and printed with its basis. It exists to make
 * the name-vs-measurement disagreement VISIBLE so the band table can be corrected
 * from data — not to silently re-rank the pool.
 */

import {
  MIN_SAMPLES_FOR_EVIDENCE,
  type CapabilityRecord,
} from './capability-evidence.js';
import {
  CAPABILITY_HIGH_MIN,
  CAPABILITY_MEDIUM_MIN,
  capabilityClassOf,
  type CapabilityBand,
} from './model-capability.js';

/** One registry row, reduced to what this census needs. */
export interface CapabilityRow {
  provider: string;
  model: string;
  capability?: CapabilityRecord;
}

/** Per-band totals, so a mean is never printed without its support. */
export interface BandAccuracy {
  pairs: number;
  samples: number;
  mean: number | undefined;
}

/** A pair whose measured accuracy sits in a different band than its name. */
export interface AccuracyDisagreement {
  provider: string;
  model: string;
  /** The band the model ID implies. */
  nameBand: CapabilityBand;
  /** The band the measurements imply, on the same cut points. */
  measuredBand: CapabilityBand;
  /** Measured accuracy 0–100. */
  accuracy: number;
  /** Observations behind it (always ≥ the census's `minSamples`). */
  samples: number;
}

export interface CapabilityAccuracyCensus {
  /** Rows examined. */
  pairs: number;
  /** Rows with at least one accuracy observation. */
  measured: number;
  /** Rows with enough observations to count as evidence. */
  evidence: number;
  totalSamples: number;
  /** Mean over every measured row (each row counted once). */
  meanAccuracy: number | undefined;
  /** Mean over rows at/above `minSamples` — the only one worth quoting. */
  meanAccuracyEvidence: number | undefined;
  byBand: Record<CapabilityBand, BandAccuracy>;
  /** Evidence-grade rows whose band disagrees with their name. */
  disagreements: AccuracyDisagreement[];
}

/**
 * The same band cut points `capabilityClassOf` uses, applied to a 0–100
 * measurement. Sharing the constants is the point: two taxonomies for one fact is
 * how a 0.5B and a 120B ended up in the same tier before.
 */
export function accuracyBand(score: number): CapabilityBand {
  if (score >= CAPABILITY_HIGH_MIN * 100) return 'high';
  if (score >= CAPABILITY_MEDIUM_MIN * 100) return 'medium';
  return 'low';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Census the name-vs-measurement agreement across registry rows.
 *
 * Pure: takes the rows, invents nothing. A row with no `accuracy` (or zero
 * samples) is counted as unmeasured and contributes to NO mean — the prior rule
 * from `capability-evidence.ts`, which exists so that "nothing measured" can
 * never be read as a bad score.
 */
export function capabilityAccuracyCensus(
  rows: readonly CapabilityRow[],
  opts: { minSamples?: number } = {},
): CapabilityAccuracyCensus {
  const minSamples = opts.minSamples ?? MIN_SAMPLES_FOR_EVIDENCE;
  const byBand: Record<CapabilityBand, BandAccuracy> = {
    high: { pairs: 0, samples: 0, mean: undefined },
    medium: { pairs: 0, samples: 0, mean: undefined },
    low: { pairs: 0, samples: 0, mean: undefined },
  };
  const bandSums: Record<CapabilityBand, number> = { high: 0, medium: 0, low: 0 };

  let measured = 0;
  let evidence = 0;
  let totalSamples = 0;
  let sum = 0;
  let evidenceSum = 0;
  const disagreements: AccuracyDisagreement[] = [];

  for (const row of rows) {
    const score = row.capability?.accuracy;
    const samples = score?.samples ?? 0;
    if (!score || samples <= 0 || !Number.isFinite(score.measured)) continue;

    const accuracy = Math.max(0, Math.min(100, score.measured));
    measured++;
    totalSamples += samples;
    sum += accuracy;

    const nameBand = capabilityClassOf(row.model);
    const band = byBand[nameBand];
    band.pairs++;
    band.samples += samples;
    bandSums[nameBand] += accuracy;

    if (samples < minSamples) continue;
    evidence++;
    evidenceSum += accuracy;

    const measuredBand = accuracyBand(accuracy);
    if (measuredBand !== nameBand) {
      disagreements.push({
        provider: row.provider,
        model: row.model,
        nameBand,
        measuredBand,
        accuracy: round1(accuracy),
        samples,
      });
    }
  }

  for (const band of ['high', 'medium', 'low'] as const) {
    const entry = byBand[band];
    entry.mean = entry.pairs > 0 ? round1(bandSums[band] / entry.pairs) : undefined;
  }

  // Worst-looking first, then the best-supported — a disagreement with 20
  // samples deserves the operator's attention before one with 5.
  disagreements.sort((a, b) => a.accuracy - b.accuracy || b.samples - a.samples);

  return {
    pairs: rows.length,
    measured,
    evidence,
    totalSamples,
    meanAccuracy: measured > 0 ? round1(sum / measured) : undefined,
    meanAccuracyEvidence: evidence > 0 ? round1(evidenceSum / evidence) : undefined,
    byBand,
    disagreements,
  };
}
