#!/usr/bin/env node
/**
 * Routing accuracy, measured — did the router's PICK survive to the wire, and
 * does the NAME-derived capability band agree with the scorecard?
 *
 * TWO QUESTIONS, both answered from stored facts only:
 *
 *   1. FIDELITY: of the steps that carry a router decision, how many were served
 *      by exactly the decided `provider/model`? Every stored trace step records
 *      the pair that ran plus its `routing` snapshot, so this is arithmetic, not
 *      a judgement.
 *
 *   2. ACCURACY, where a scorecard exists: the registry keeps a measured
 *      `accuracy` per provider × model, folded from the harness's own turn
 *      verdicts (`verified → 100`, `unverified → 40`). This prints it beside the
 *      band the model's NAME implies, plus every pair where the two disagree —
 *      which is the only way a name heuristic can ever be corrected from data
 *      instead of from opinion. Rows are ALWAYS printed with their sample count;
 *      a mean without support is not evidence.
 *
 * WHAT IT STILL REFUSES TO DO. It does not score "was that the right model for
 * this task" beyond that verdict, and it writes nothing back — a trace row can
 * never be rewritten to look better. Accuracy is also NOT fed into routing here
 * on purpose: measured on this machine it holds three pairs (n = 1, 4, 7), and
 * re-ranking on that would demote working models for reasons that may belong to
 * the harness rather than the model.
 *
 * Usage:
 *   npx tsx scripts/routing-accuracy.ts              # every stored trace
 *   npx tsx scripts/routing-accuracy.ts --limit 200  # newest 200 traces
 *   npx tsx scripts/routing-accuracy.ts --json       # machine-readable
 */
import { listTraces, routingFidelityFromTraces } from '../src/learning/reasoning-trace.js';
import { capabilityAccuracyCensus } from '../src/learning/capability-census.js';
import { getModelRegistry } from '../src/learning/model-registry.js';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const limitArg = argv[argv.indexOf('--limit') + 1];
const limit = argv.includes('--limit') && Number.isFinite(Number(limitArg)) ? Number(limitArg) : 100_000;

const traces = listTraces(limit).map((t) => ({
  id: t.id,
  steps: (t.steps ?? []).map((s) => ({
    provider: s.provider,
    model: s.model,
    routing: s.routing
      ? { provider: s.routing.provider, model: s.routing.model, substitutedFor: s.routing.substitutedFor }
      : undefined,
  })),
}));

const fidelity = routingFidelityFromTraces(traces);

// The registry is read through its public accessors; the census itself is pure.
const registry = getModelRegistry();
const rows = registry.getTrackedProviders().flatMap((provider) =>
  registry.getAllModelsForProvider(provider).map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    capability: entry.capability,
  })),
);
const accuracy = capabilityAccuracyCensus(rows);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const num = (n: number | undefined): string => (n === undefined ? 'n/a' : n.toFixed(1));

if (JSON_OUT) {
  console.log(JSON.stringify({ traces: traces.length, ...fidelity, accuracy }, null, 2));
} else {
  console.log('Routing fidelity (decided pair vs served pair)');
  console.log(`  traces scanned        ${traces.length}`);
  console.log(`  steps auto-routed     ${fidelity.decided}`);
  console.log(`  served as decided     ${fidelity.matched}`);
  console.log(`  substituted           ${fidelity.substituted}`);
  console.log(`  repaired in place     ${fidelity.repairedInPlace} (flagged, but the decided pair still ran)`);
  console.log(
    `  fidelity              ${fidelity.fidelity === undefined ? 'n/a (no auto-routed steps)' : pct(fidelity.fidelity)}`,
  );
  if (fidelity.substitutions.length > 0) {
    console.log('\nSubstitutions (decided -> served):');
    for (const s of fidelity.substitutions.slice(0, 15)) {
      console.log(`  ${s.steps.toString().padStart(4)}  ${s.decided} -> ${s.served}`);
    }
    if (fidelity.substitutions.length > 15) {
      console.log(`        …and ${fidelity.substitutions.length - 15} more distinct swaps`);
    }
  }

  console.log('\nCapability accuracy (measured, beside the band the NAME implies)');
  console.log(`  pairs tracked         ${accuracy.pairs}`);
  console.log(
    `  with accuracy samples ${accuracy.measured}  (${accuracy.totalSamples} observations)`,
  );
  console.log(
    `  evidence-grade rows   ${accuracy.evidence}  (>= 5 samples; mean ${num(accuracy.meanAccuracyEvidence)})`,
  );
  if (accuracy.measured > 0 && accuracy.evidence === 0) {
    console.log('  every row is below the evidence floor — no claim is made from it');
  }
  const agreement = accuracy.evidence - accuracy.disagreements.length;
  console.log(
    `  band agreement        ${accuracy.evidence === 0 ? 'n/a' : `${agreement}/${accuracy.evidence}`}`,
  );
  for (const band of ['high', 'medium', 'low'] as const) {
    const b = accuracy.byBand[band];
    if (b.pairs === 0) continue;
    console.log(
      `    name band ${band.padEnd(6)} ${String(b.pairs).padStart(3)} pair(s) · ${b.samples} sample(s) · mean ${num(b.mean)}`,
    );
  }
  if (accuracy.disagreements.length > 0) {
    console.log('\nName vs measurement (evidence-grade disagreements):');
    for (const d of accuracy.disagreements) {
      console.log(
        `  ${d.provider}/${d.model}  name ${d.nameBand} -> measured ${d.measuredBand}  ${d.accuracy.toFixed(1)} (n=${d.samples})`,
      );
    }
  } else if (accuracy.evidence > 0) {
    console.log('\nName vs measurement: every evidence-grade row agrees with its name-derived band.');
  }
}
