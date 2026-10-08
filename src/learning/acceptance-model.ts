/**
 * Acceptance model — fit `P(accepted | features)` to the labels the harness now
 * collects, and report it READ-ONLY.
 *
 * THE POINT OF THE WHOLE `userVerdict` WORK. Bundles 27–30 made it possible for a
 * turn to carry a LABEL: the user accepted it, rejected it, or said nothing. This
 * module is the first consumer — it fits a probability of acceptance to the
 * harness's OWN features (did the turn verify, was it flagged, did it deliver),
 * which is the thing a "quality score" was always supposed to be and could never
 * be built from derived signals alone.
 *
 * WHAT IT REFUSES TO DO.
 *  - It never routes. Nothing in the router reads this file; `model explain`
 *    prints it and that is the only caller. A fitted number that moved a routing
 *    decision would be the exact defect the programme removes, one layer up.
 *  - It never fits below the sample floor. With too few labelled turns, or with
 *    only one class, it returns a NAMED reason and no model — an underfit
 *    probability printed as if it were evidence is worse than printing nothing.
 *  - It never invents an acceptance. Only rows with a real verdict are used;
 *    `verdict: null` rows are excluded, because silence is not a positive.
 *
 * THE FEATURES are the ones the harness already records per turn, each of them
 * evidence the run produced rather than the model's account of itself:
 *   verified    — the turn's own check passed (`verified` / `delivered-and-read-back`)
 *   unverified  — the turn ran but nothing verified it
 *   flag        — an honesty flag fired (a defect the turn disclosed)
 *   delivered   — the turn produced an authored artifact
 *
 * Training is deterministic (zero initial weights, fixed iterations), so the same
 * corpus always yields the same coefficients and a report cannot drift run to run.
 */

import { listTraces } from './reasoning-trace.js';
import { readDeliverableCandidates } from './deliverable-corpus.js';
import type { TurnReport } from './turn-report.js';

/** The features a fit sees. Binary by construction — measured flags, not magnitudes. */
export const ACCEPTANCE_FEATURES = ['verified', 'unverified', 'flag', 'delivered'] as const;
export type AcceptanceFeature = (typeof ACCEPTANCE_FEATURES)[number];

export type AcceptanceFeatures = Record<AcceptanceFeature, number>;

/** Below this many labelled turns a fit is noise. */
export const MIN_LABELS_FOR_FIT = 20;
/** …and below this many of EITHER class it can only learn the base rate. */
export const MIN_PER_CLASS = 5;

const LEARNING_RATE = 0.3;
const ITERATIONS = 500;
const L2 = 0.01;

/** One labelled turn: what the harness saw, and whether the user accepted it. */
export interface LabelledTurn {
  traceId?: string;
  provider?: string;
  model?: string;
  at: number;
  accepted: boolean;
  /** Where the label came from: `cli` / `dashboard` / `derived` (see `turn-feedback.ts`). */
  source: string;
  features: AcceptanceFeatures;
}

export interface AcceptanceModel {
  weights: number[];
  bias: number;
  featureNames: AcceptanceFeature[];
  n: number;
  positives: number;
  negatives: number;
  trainedAt: number;
}

export type AcceptanceFit =
  | { ok: true; model: AcceptanceModel }
  | { ok: false; reason: string; n: number; positives: number; negatives: number };

const emptyFeatures = (): AcceptanceFeatures => ({ verified: 0, unverified: 0, flag: 0, delivered: 0 });

function anyFlag(report: TurnReport | undefined): boolean {
  const f = report?.flags;
  if (!f) return false;
  return Boolean(
    f.unverifiedActionClaim ||
      f.unverifiedEdit ||
      f.unverifiedEditClaim ||
      f.unverifiedBuildClaim ||
      f.undeliveredArtifact ||
      f.unfulfilledPromise ||
      f.noActionTaken ||
      f.incompleteArtifactClaim ||
      f.unverifiedFileClaim ||
      f.artifactShortfall,
  );
}

/**
 * Collect every LABELLED turn the harness has: the trace verdicts (the reliable
 * source, carrying the features) plus any corpus rows whose verdict has no trace
 * counterpart (a delivery labelled without a trace to attach it to).
 */
export function collectLabelledTurns(): LabelledTurn[] {
  const out: LabelledTurn[] = [];
  const seen = new Set<string>();

  let traces: import('./reasoning-trace.js').ReasoningTrace[] = [];
  try {
    traces = listTraces(1000);
  } catch {
    traces = [];
  }
  const corpus = (() => {
    try {
      return readDeliverableCandidates();
    } catch {
      return [];
    }
  })();

  for (const t of traces) {
    const v = t.userVerdict;
    if (!v) continue;
    const report = t.turnReport;
    const features = emptyFeatures();
    const verification = report?.verification;
    if (verification === 'verified' || verification === 'delivered-and-read-back') features.verified = 1;
    else if (verification === 'unverified') features.unverified = 1;
    if (anyFlag(report)) features.flag = 1;
    const row = corpus.find((r) => r.traceId === t.id);
    if (row || verification === 'delivered-and-read-back') features.delivered = 1;
    out.push({
      traceId: t.id,
      ...(t.provider ? { provider: t.provider } : {}),
      ...(t.model ? { model: t.model } : {}),
      at: v.at,
      accepted: v.verdict === 'accepted',
      source: v.source,
      features,
    });
    seen.add(t.id);
  }

  for (const row of corpus) {
    if (row.verdict === null) continue;
    if (row.traceId && seen.has(row.traceId)) continue;
    const features = emptyFeatures();
    if (row.verification === 'verified' || row.verification === 'delivered-and-read-back') features.verified = 1;
    else if (row.verification === 'unverified') features.unverified = 1;
    features.delivered = 1;
    out.push({
      ...(row.traceId ? { traceId: row.traceId } : {}),
      at: row.verdictAt ?? row.ts,
      accepted: row.verdict === 'accepted',
      source: 'derived',
      features,
    });
  }

  return out.sort((a, b) => a.at - b.at);
}

/**
 * Fit the logistic model. Deterministic; returns a NAMED reason rather than a
 * model whenever the sample is too thin to mean anything.
 */
export function trainAcceptanceModel(now: number = Date.now()): AcceptanceFit {
  const rows = collectLabelledTurns();
  const positives = rows.filter((r) => r.accepted).length;
  const negatives = rows.length - positives;

  if (rows.length < MIN_LABELS_FOR_FIT) {
    return {
      ok: false,
      reason: `only ${rows.length} labelled turn(s) — need ${MIN_LABELS_FOR_FIT}`,
      n: rows.length,
      positives,
      negatives,
    };
  }
  if (positives < MIN_PER_CLASS || negatives < MIN_PER_CLASS) {
    return {
      ok: false,
      reason: `needs ≥${MIN_PER_CLASS} of each class (have ${positives}👍/${negatives}👎)`,
      n: rows.length,
      positives,
      negatives,
    };
  }

  const X = rows.map((r) => ACCEPTANCE_FEATURES.map((f) => r.features[f]));
  const y = rows.map((r) => (r.accepted ? 1 : 0));
  const dim = ACCEPTANCE_FEATURES.length;
  const weights = new Array<number>(dim).fill(0);
  let bias = 0;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const gradW = new Array<number>(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < X.length; i++) {
      const z = bias + X[i].reduce((s, xi, j) => s + xi * weights[j], 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < dim; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < dim; j++) {
      weights[j] -= LEARNING_RATE * (gradW[j] / X.length + L2 * weights[j]);
    }
    bias -= LEARNING_RATE * (gradB / X.length);
  }

  return {
    ok: true,
    model: {
      weights,
      bias,
      featureNames: [...ACCEPTANCE_FEATURES],
      n: rows.length,
      positives,
      negatives,
      trainedAt: now,
    },
  };
}

/** `P(accepted | features)` under a fitted model. */
export function predictAcceptance(model: AcceptanceModel, features: AcceptanceFeatures): number {
  const z = model.bias + model.featureNames.reduce((s, f, j) => s + (features[f] ?? 0) * model.weights[j], 0);
  return 1 / (1 + Math.exp(-z));
}

/** One review surface's worth of acceptance state, so CLI and dashboard agree. */
export interface AcceptanceSummary {
  labelled: number;
  accepted: number;
  rejected: number;
  /** Labels by provenance: `cli` / `dashboard` / `derived`. */
  bySource: Record<string, number>;
  byPair: Record<string, { accepted: number; rejected: number }>;
  fit: AcceptanceFit;
}

/** The whole acceptance picture in one call — the ONE source the surfaces render. */
export function acceptanceSummary(now: number = Date.now()): AcceptanceSummary {
  const turns = collectLabelledTurns();
  const bySource: Record<string, number> = {};
  for (const t of turns) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
  const accepted = turns.filter((t) => t.accepted).length;
  return {
    labelled: turns.length,
    accepted,
    rejected: turns.length - accepted,
    bySource,
    byPair: acceptanceByPair(),
    fit: trainAcceptanceModel(now),
  };
}

/**
 * Render a summary as human lines. Shared so `nuvira rate --stats` and any other
 * surface cannot describe the same corpus two different ways.
 */
export function formatAcceptanceSummary(s: AcceptanceSummary): string[] {
  const lines: string[] = [];
  lines.push(`labelled turns: ${s.labelled} (👍 ${s.accepted} / 👎 ${s.rejected})`);
  const sources = Object.entries(s.bySource);
  lines.push(
    sources.length > 0
      ? `by source: ${sources.map(([k, v]) => `${k} ${v}`).join(', ')}`
      : 'by source: (none yet)',
  );
  const pairs = Object.entries(s.byPair);
  if (pairs.length > 0) {
    lines.push('by pair:');
    for (const [key, v] of pairs) {
      const n = v.accepted + v.rejected;
      lines.push(`   ${key}: 👍 ${v.accepted} / 👎 ${v.rejected} (${Math.round((100 * v.accepted) / n)}%, n=${n})`);
    }
  } else {
    lines.push('by pair: (no rated turns yet)');
  }
  if (s.fit.ok) {
    lines.push(`fit: TRAINED — P(accepted | features) n=${s.fit.model.n} (${s.fit.model.positives}👍/${s.fit.model.negatives}👎)`);
  } else {
    lines.push(`fit: NOT trained — ${s.fit.reason}`);
    lines.push(`     (needs ${MIN_LABELS_FOR_FIT} labelled turns with ≥${MIN_PER_CLASS} of each class)`);
  }
  lines.push('read-only: nothing routes on this and no score is derived from it');
  return lines;
}

/** Rated turns per `provider/model`, for the per-pair acceptance line. */
export function acceptanceByPair(): Record<string, { accepted: number; rejected: number }> {
  const out: Record<string, { accepted: number; rejected: number }> = {};
  for (const t of collectLabelledTurns()) {
    if (!t.provider) continue;
    const key = `${t.provider}/${t.model ?? ''}`;
    out[key] = out[key] ?? { accepted: 0, rejected: 0 };
    if (t.accepted) out[key].accepted++;
    else out[key].rejected++;
  }
  return out;
}
