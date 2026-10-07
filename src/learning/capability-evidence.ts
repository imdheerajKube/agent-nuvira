/**
 * CAPABILITY BY MEASUREMENT (Bundle 3, B1–B4) — the scorecard.
 *
 * THE DEFECT THIS REPLACES. `AutoModelRouter.getModelCapabilities()` judges a
 * model from its NAME: `mini`/`tiny`/`flash`/`lite` each SUBTRACT 0.1 from
 * reasoning (so `gemini-3.1-flash-lite` loses 0.2 for two words), `pro`/`large`/
 * `opus` add, a `70b` in the id adds 0.45, and a frontier-family keyword adds
 * 0.2. Nothing in the system had ever measured whether a model is any good, so
 * max mode's reasoning floor was a NAME threshold, and this programme's own
 * investigation fell into the trap it was reporting: it called DeepSeek V4.1
 * Flash weak *because of the word "flash"* while that model served an 82-step
 * build.
 *
 * THE REPLACEMENT. One record per provider × model holding five named
 * parameters, each 0–100 with its own sample count, fed from what the harness
 * OBSERVES while doing real work:
 *
 *   accuracy     did the work actually verify          (TurnReport.verification)
 *   performance  how fast it answered, per call        (registry latency EMA)
 *   cost         what the work cost                    (measured tokens × price)
 *   robustness   does it hold up across many calls     (errorRate / partialRate)
 *   ecosystem    what the pair can do besides answer   (tool-calling, window)
 *
 * THE PRIOR RULE (§3.2), and the one thing to read before changing anything:
 * **0 samples returns the declared prior, byte-for-byte.** Measurement replaces
 * the prior as samples accumulate (`PRIOR_FULL_SAMPLES`) — a wrong prior can
 * outrank evidence for a while, but never after the record has real samples.
 * The id-substring terms are REMOVED, not capped: a capped name hint is still a
 * name judgement, and "the name contributes nothing" is the whole acceptance.
 *
 * WHAT THIS MODULE DOES NOT DO. It is pure — no registry, no I/O — so the
 * arithmetic is testable in isolation and the storage layer decides when to call
 * it. It never invents a sample: a turn that verified nothing contributes
 * NOTHING (not a neutral 50), because a run that never checks its work has no
 * accuracy evidence, and a fabricated neutral sample would dilute the real ones.
 */

/** The five named parameters, in the order `model explain` prints them. */
export type CapabilityParameter = 'accuracy' | 'performance' | 'cost' | 'robustness' | 'ecosystem';

/** How many observations a parameter needs before it is reported as MEASURED. */
export const MIN_SAMPLES_FOR_EVIDENCE = 5;

/**
 * Samples at which the prior's weight reaches zero. Between 0 and here the prior
 * decays LINEARLY (`priorWeight = 1 - samples / PRIOR_FULL_SAMPLES`), so a single
 * lucky or unlucky turn cannot swing a ranking, and a model with a real track
 * record is judged by it. Stated here rather than inline because §7 of the design
 * calls the decay rate a calibration decision, not a constant to bury.
 */
export const PRIOR_FULL_SAMPLES = 2 * MIN_SAMPLES_FOR_EVIDENCE;

/** EMA weight for one observation. Matches the registry's latency/token EMAs. */
export const EVIDENCE_ALPHA = 0.3;

/** Where a reported value came from. Printed beside every number. */
export type EvidenceSource = 'measured' | 'prior';

/** One parameter: the measured value (0–100), how many samples, and its source. */
export interface ParameterScore {
  /** Measured value 0–100. Meaningless on its own — always pair it with `samples`. */
  measured: number;
  /** Observations folded in. 0 = nothing measured yet. */
  samples: number;
}

/**
 * The scorecard for one provider × model. Every parameter is optional: absent
 * means "nothing measured", which reports as the prior rather than as a zero.
 */
export interface CapabilityRecord {
  accuracy?: ParameterScore;
  performance?: ParameterScore;
  cost?: ParameterScore;
  robustness?: ParameterScore;
  ecosystem?: ParameterScore;
  /** Epoch ms of the last fold. */
  updatedAt: number;
}

/**
 * Accuracy weights per turn verdict. `verified` is the strongest evidence the
 * harness can produce (a change was made AND observed). `unverified` is real but
 * weak evidence: the model answered, and its work could not be confirmed — so it
 * pulls the score down without being scored as an outright failure, which would
 * double-count the same event (`applyReward`'s `verificationPassed: false`
 * already carries that penalty).
 *
 * A `blocked` turn is NOT here on purpose: a wall the run hit is not a verdict
 * about the model.
 */
export const ACCURACY_BY_VERDICT = {
  verified: 100,
  unverified: 40,
} as const;

/** A fresh record: nothing measured. */
export function emptyCapabilityRecord(now: number = Date.now()): CapabilityRecord {
  return { updatedAt: now };
}

/** Fold one 0–100 observation into a parameter's EMA (α = `EVIDENCE_ALPHA`). */
function foldEMA(score: ParameterScore | undefined, observation: number): ParameterScore {
  const obs = Math.max(0, Math.min(100, observation));
  if (!score || score.samples <= 0) return { measured: obs, samples: 1 };
  return {
    measured: EVIDENCE_ALPHA * obs + (1 - EVIDENCE_ALPHA) * score.measured,
    samples: score.samples + 1,
  };
}

/**
 * Fold a turn's verification verdict into `accuracy`. `blocked`/
 * `not-applicable`/absent contribute nothing at all (see the header).
 */
export function foldVerification(
  record: CapabilityRecord,
  verification: 'verified' | 'unverified' | 'blocked' | 'not-applicable' | undefined | null,
  now: number = Date.now(),
): CapabilityRecord {
  if (verification !== 'verified' && verification !== 'unverified') return record;
  return {
    ...record,
    accuracy: foldEMA(record.accuracy, ACCURACY_BY_VERDICT[verification]),
    updatedAt: now,
  };
}

/** Fold one measured call's outcome into `robustness` (0–100 per call). */
export function foldCallOutcome(
  record: CapabilityRecord,
  ok: boolean,
  now: number = Date.now(),
): CapabilityRecord {
  return {
    ...record,
    robustness: foldEMA(record.robustness, ok ? 100 : 0),
    updatedAt: now,
  };
}

/** Fold a measured latency into `performance` (a call under 800 ms scores 100). */
export function foldLatency(
  record: CapabilityRecord,
  latencyMs: number | undefined,
  now: number = Date.now(),
): CapabilityRecord {
  if (!latencyMs || latencyMs <= 0) return record;
  // 800 ms or faster = 100; 10 s or slower = 0; linear between. The scale is
  // stated, not inferred, so `model explain` can explain a number it prints.
  const scaled = Math.max(0, Math.min(100, 100 * (1 - (latencyMs - 800) / (10_000 - 800))));
  return {
    ...record,
    performance: foldEMA(record.performance, scaled),
    updatedAt: now,
  };
}

/**
 * The value to USE for a parameter, and whether it is measured or borrowed.
 *
 * THE ONE RULE THAT DECIDES EVERYTHING: with no samples the answer is exactly the
 * prior passed in. That is what makes this change safe to land before the record
 * has any data — behaviour on a cold start is unchanged — and it is what makes
 * the acceptance test "two ids differing only by a tier word score identically"
 * true, since the prior is provider-level and cannot see the id.
 */
export function effectiveParameter(
  record: CapabilityRecord | undefined,
  parameter: CapabilityParameter,
  priorFraction: number,
): { value: number; samples: number; source: EvidenceSource } {
  const prior = Math.max(0, Math.min(1, priorFraction));
  const score = record?.[parameter];
  const samples = score?.samples ?? 0;
  if (!score || samples <= 0) return { value: prior, samples: 0, source: 'prior' };
  const priorWeight = Math.max(0, 1 - samples / PRIOR_FULL_SAMPLES);
  // Stored 0–100 (see `foldEMA`), reported 0–1 like every other capability scalar.
  const measured = Math.max(0, Math.min(100, score.measured)) / 100;
  const value = priorWeight * prior + (1 - priorWeight) * measured;
  return {
    value: Math.max(0, Math.min(1, value)),
    samples,
    source: samples >= MIN_SAMPLES_FOR_EVIDENCE ? 'measured' : 'prior',
  };
}

/** Capability tier, DERIVED from the parameters — never parsed from an id. */
export type CapabilityTier = 'Frontier' | 'Balanced' | 'Utility';

/**
 * Derive the tier. Deliberately coarse and stated in one place:
 *   - `Utility`  — accuracy is poor, or the pair is unreliable;
 *   - `Frontier` — strong accuracy AND a wide ecosystem;
 *   - `Balanced` — everything else, which is most things.
 * `ecosystem` participates because a strong answerer that cannot call tools is
 * not a frontier AGENT model, and this harness only cares about agent models.
 */
export function deriveTier(view: {
  accuracy: { value: number; samples: number };
  robustness: { value: number; samples: number };
  ecosystem: { value: number; samples: number };
}): CapabilityTier {
  if (view.accuracy.value < 0.5 || view.robustness.value < 0.5) return 'Utility';
  if (view.accuracy.value >= 0.8 && view.ecosystem.value >= 0.7) return 'Frontier';
  return 'Balanced';
}

/**
 * Declared priors for the parameters a cold start cannot supply.
 *
 * `accuracy` and `performance` are deliberately ABSENT: their priors are the
 * provider's own declared baseline, which only the router knows. `cost` is
 * absent too — pricing belongs to a provider ACCOUNT, so with no measurement the
 * honest answer is "no prior" rather than a number that reads as free:
 *
 *   - `robustness: 0.7` — most pairs answer most of the time; a prior, replaced
 *     by measurement as soon as calls are recorded;
 *   - `ecosystem: 0.5` — nothing is known about tool-calling until observed, and
 *     0.5 keeps a pair OUT of the `Frontier` gate (which needs ≥ 0.7). A pair we
 *     have never watched use a tool is not a frontier agent model.
 */
export const DEFAULT_PRIORS: Record<CapabilityParameter, number | undefined> = {
  accuracy: undefined,
  performance: undefined,
  cost: undefined,
  robustness: 0.7,
  ecosystem: 0.5,
};

/**
 * The whole scorecard as printable rows: `accuracy 78 (measured, n=14)`.
 *
 * The sample count is NOT optional — a score without one is exactly the
 * plausible-looking number this programme exists to remove — and a parameter with
 * neither a prior nor a sample prints `n/a` rather than a `0` that would read as
 * "free" or "broken".
 */
export function capabilityLines(
  record: CapabilityRecord | undefined,
  priors: Partial<Record<CapabilityParameter, number>> = {},
  priorLabels: Partial<Record<CapabilityParameter, { source: string; fetchedAt: number }>> = {},
): string[] {
  return (['accuracy', 'performance', 'cost', 'robustness', 'ecosystem'] as CapabilityParameter[]).map(
    (p) => {
      const prior = priors[p] ?? DEFAULT_PRIORS[p];
      if (prior === undefined) {
        const samples = record?.[p]?.samples ?? 0;
        return samples > 0
          ? `${p} ${Math.round((record?.[p]?.measured ?? 0))} (measured, n=${samples})`
          : `${p} n/a (no prior declared, nothing measured)`;
      }
      const { value, samples, source } = effectiveParameter(record, p, prior);
      const pct = Math.round(value * 100);
      // §6.2 rule 4: a borrowed number must say WHERE it was borrowed from, so a reader can tell an
      // observation from a prior. An unlabelled prior still prints the bare `prior` it always did —
      // the label is added, never substituted.
      const basis = source === 'measured' ? 'measured' : describePrior(p, priorLabels);
      return `${p} ${pct} (${basis}${samples > 0 ? `, n=${samples}` : ''})`;
    },
  );
}

/** `prior` alone, or `prior: <source>, <date>` when the prior came from somewhere nameable. */
function describePrior(
  p: CapabilityParameter,
  labels: Partial<Record<CapabilityParameter, { source: string; fetchedAt: number }>>,
): string {
  const label = labels[p];
  if (!label) return 'prior';
  const day = new Date(label.fetchedAt).toISOString().slice(0, 10);
  return `prior: ${label.source}, ${day}`;
}
