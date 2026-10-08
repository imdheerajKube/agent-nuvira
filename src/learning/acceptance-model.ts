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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listTraces, recordTraceVerdict } from './reasoning-trace.js';
import { readDeliverableCandidates, labelDeliverableByTrace } from './deliverable-corpus.js';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
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

/** Imported labels kept on disk, oldest drop first — a dataset, not an unbounded log. */
export const MAX_IMPORTED_LABELS = 5000;

function memoryDir(): string {
  return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}

/**
 * Where an imported corpus's labels live. Kept separate from the traces because an
 * imported row has no local trace to attach a `userVerdict` to — a fit simply READS
 * these alongside the local labels, so a corpus collected elsewhere joins without
 * the harness inventing a trace or rewriting one it does not own.
 */
export function importedLabelsPath(): string {
  return join(memoryDir(), 'acceptance-labels.jsonl');
}

function isTruthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** One row from a shipped corpus → a `LabelledTurn`, or null when it is malformed. */
function coerceTurn(raw: unknown): LabelledTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!('accepted' in r) || !('at' in r)) return null;
  const at = Number(r.at);
  if (!Number.isFinite(at)) return null;
  const features = emptyFeatures();
  const featSrc =
    r.features && typeof r.features === 'object'
      ? (r.features as Record<string, unknown>)
      : r;
  for (const f of ACCEPTANCE_FEATURES) features[f] = isTruthy(featSrc[f]) ? 1 : 0;
  return {
    ...(typeof r.traceId === 'string' && r.traceId ? { traceId: r.traceId } : {}),
    ...(typeof r.provider === 'string' && r.provider ? { provider: r.provider } : {}),
    ...(typeof r.model === 'string' && r.model ? { model: r.model } : {}),
    at,
    accepted: isTruthy(r.accepted),
    source: typeof r.source === 'string' && r.source ? r.source : 'imported',
    features,
  };
}

/** Quote-aware split of one CSV line (RFC-4180: doubled quotes, embedded commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCorpusCsv(text: string): LabelledTurn[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: LabelledTurn[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const obj: Record<string, unknown> = {};
    header.forEach((h, j) => { obj[h] = cells[j]; });
    const t = coerceTurn(obj);
    if (t) out.push(t);
  }
  return out;
}

function parseCorpusJson(text: string): LabelledTurn[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { turns?: unknown }).turns)
      ? (parsed as { turns: unknown[] }).turns
      : [];
  const out: LabelledTurn[] = [];
  for (const raw of rows) {
    const t = coerceTurn(raw);
    if (t) out.push(t);
  }
  return out;
}

/** Best-effort format detection: by extension, else by the first non-space character. */
export function detectCorpusFormat(path: string | undefined, text: string): CorpusFormat {
  if (path && path.toLowerCase().endsWith('.csv')) return 'csv';
  if (path && path.toLowerCase().endsWith('.json')) return 'json';
  const first = text.trimStart()[0];
  return first === '{' || first === '[' ? 'json' : 'csv';
}

/** Parse a shipped corpus in either format into labelled turns (malformed rows dropped). */
export function parseCorpusText(text: string, format: CorpusFormat): LabelledTurn[] {
  return format === 'csv' ? parseCorpusCsv(text) : parseCorpusJson(text);
}

/** Read the imported labels store (best-effort; a corrupt line is skipped). */
export function readImportedLabels(): LabelledTurn[] {
  try {
    if (!existsSync(importedLabelsPath())) return [];
    const out: LabelledTurn[] = [];
    for (const line of readFileSync(importedLabelsPath(), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = coerceTurn(JSON.parse(trimmed));
        if (row) out.push(row);
      } catch {
        // A corrupt line is skipped — a dataset store must not be a landmine.
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Dedupe key for an imported row: its trace when it has one, else its identity. */
function labelKey(t: LabelledTurn): string {
  return t.traceId ?? `p:${t.provider ?? ''}|m:${t.model ?? ''}|at:${t.at}|a:${t.accepted ? 1 : 0}`;
}

/**
 * Merge an imported corpus into the local store, deduped by trace (or identity).
 * Re-importing the same file is idempotent: rows already present are updated, not
 * duplicated. Returns the counts a caller reports, and never throws.
 */
export function mergeImportedLabels(incoming: LabelledTurn[]): { added: number; updated: number; total: number } {
  const byKey = new Map<string, LabelledTurn>();
  for (const t of readImportedLabels()) byKey.set(labelKey(t), t);
  let added = 0;
  let updated = 0;
  for (const t of incoming) {
    const k = labelKey(t);
    if (byKey.has(k)) updated++;
    else added++;
    byKey.set(k, t);
  }
  const merged = [...byKey.values()].sort((a, b) => a.at - b.at).slice(-MAX_IMPORTED_LABELS);
  try {
    if (!existsSync(memoryDir())) mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(importedLabelsPath(), merged.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  } catch {
    // Best-effort — an import must never break the caller.
  }
  return { added, updated, total: merged.length };
}

/**
 * The LOCAL labels: the trace verdicts (the reliable source, carrying the
 * features) plus any corpus rows whose verdict has no trace counterpart. Excludes
 * imported rows — a conflict merge must compare against what THIS machine recorded.
 */
function collectLocalTurns(): LabelledTurn[] {
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
 * Collect every LABELLED turn the harness has: the local labels plus the rows
 * imported from another corpus. A LOCAL label for the same trace wins — the local
 * record carries the features we measured ourselves.
 */
export function collectLabelledTurns(): LabelledTurn[] {
  const out = collectLocalTurns();
  const seen = new Set(out.map((t) => t.traceId).filter((id): id is string => Boolean(id)));
  for (const imp of readImportedLabels()) {
    if (imp.traceId && seen.has(imp.traceId)) continue;
    out.push(imp);
    if (imp.traceId) seen.add(imp.traceId);
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Fit the logistic model. Deterministic; returns a NAMED reason rather than a
 * model whenever the sample is too thin to mean anything.
 */
/** The outcome of reconciling an imported corpus against the local labels. */
export interface MergeResult {
  /** Rows in the incoming file. */
  incoming: number;
  /** Rows written to the imported store (no local label for their trace). */
  stored: number;
  /** Rows whose trace already carries a DIFFERENT local label. */
  conflicts: number;
  /** Conflicts the incoming label won (`--replace`). */
  replaced: number;
  /** Conflicts the local label won (the default). */
  keptLocal: number;
  /** Rows whose trace already carries the SAME label — nothing to reconcile. */
  matching: number;
  /** The imported store size after the merge. */
  total: number;
}

/**
 * Overwrite one LOCAL label with an imported verdict (corpus row and trace). Used
 * only by an EXPLICIT `--replace` — the default keeps the local label, because a
 * label this machine recorded is one a person or the behaviour here produced.
 */
export function replaceLocalLabel(
  traceId: string,
  accepted: boolean,
  source: string,
  now: number = Date.now(),
): boolean {
  const verdict: 'accepted' | 'rejected' = accepted ? 'accepted' : 'rejected';
  const src = source === 'cli' || source === 'dashboard' || source === 'derived' ? source : 'derived';
  let did = false;
  try {
    did = recordTraceVerdict(traceId, verdict, src, now) || did;
  } catch {
    // best-effort
  }
  try {
    did = labelDeliverableByTrace(traceId, verdict, now) || did;
  } catch {
    // best-effort
  }
  return did;
}

/**
 * Reconcile an incoming corpus against the LOCAL labels, explicitly.
 *
 * A conflict is a trace the local record already labels differently. The default
 * KEEPS the local label (it is this machine's own measurement) and reports the
 * count; `replace: true` lets the incoming label win. Rows with no local label are
 * simply stored. Deduped and idempotent like {@link mergeImportedLabels}.
 */
export function mergeLabelledCorpus(
  incoming: LabelledTurn[],
  opts: { replace?: boolean; now?: number } = {},
): MergeResult {
  const now = opts.now ?? Date.now();
  const localByTrace = new Map<string, boolean>();
  for (const t of collectLocalTurns()) {
    if (t.traceId) localByTrace.set(t.traceId, t.accepted);
  }

  const toStore: LabelledTurn[] = [];
  let conflicts = 0;
  let replaced = 0;
  let keptLocal = 0;
  let matching = 0;

  for (const t of incoming) {
    if (!t.traceId || !localByTrace.has(t.traceId)) {
      toStore.push(t);
      continue;
    }
    if (localByTrace.get(t.traceId) === t.accepted) {
      matching++;
      continue;
    }
    conflicts++;
    if (opts.replace) {
      replaceLocalLabel(t.traceId, t.accepted, t.source, now);
      replaced++;
    } else {
      keptLocal++;
    }
  }

  const merged = mergeImportedLabels(toStore);
  return {
    incoming: incoming.length,
    stored: toStore.length,
    conflicts,
    replaced,
    keptLocal,
    matching,
    total: merged.total,
  };
}

/**
 * Fit the SAME deterministic logistic model to an arbitrary set of rows. Split
 * out from {@link trainAcceptanceModel} so the offline fitter script can train on
 * an EXPORTED corpus without the live trace store — the model is identical by
 * construction, so a shipped corpus and this machine cannot disagree.
 */
export function fitLabelledTurns(rows: LabelledTurn[], now: number = Date.now()): AcceptanceFit {
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

/** Fit to the LIVE corpus the harness has collected (local traces + imports). */
export function trainAcceptanceModel(now: number = Date.now()): AcceptanceFit {
  return fitLabelledTurns(collectLabelledTurns(), now);
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
 * Render a summary as human lines — the SINGLE renderer every surface uses.
 *
 * `nuvira rate --stats`, `model explain` and any future surface call THIS, so they
 * cannot describe the same corpus two different ways. `focusPair` (optional) lists
 * that `provider/model` first, which is how `model explain` keeps the decision's own
 * pair at the top without a second formatter.
 */
export function formatAcceptanceSummary(s: AcceptanceSummary, focusPair?: string): string[] {
  const lines: string[] = [];
  lines.push(`labelled turns: ${s.labelled} (👍 ${s.accepted} / 👎 ${s.rejected})`);
  const sources = Object.entries(s.bySource);
  lines.push(
    sources.length > 0
      ? `by source: ${sources.map(([k, v]) => `${k} ${v}`).join(', ')}`
      : 'by source: (none yet)',
  );

  const pairLine = (key: string, v: { accepted: number; rejected: number }): string => {
    const n = v.accepted + v.rejected;
    return `${key}: 👍 ${v.accepted} / 👎 ${v.rejected} (${Math.round((100 * v.accepted) / n)}%, n=${n})`;
  };
  const pairs = Object.entries(s.byPair);
  if (pairs.length === 0 && !focusPair) {
    lines.push('by pair: (no rated turns yet)');
  } else {
    lines.push('by pair:');
    if (focusPair) {
      const v = s.byPair[focusPair];
      lines.push(v ? `   ${pairLine(focusPair, v)}  ←` : `   ${focusPair}: n/a (no rated turns yet)  ←`);
    }
    for (const [key, v] of pairs) {
      if (key === focusPair) continue;
      lines.push(`   ${pairLine(key, v)}`);
    }
  }

  if (s.fit.ok) {
    lines.push(
      `fit: TRAINED — P(accepted | features) n=${s.fit.model.n} (${s.fit.model.positives}👍/${s.fit.model.negatives}👎)`,
    );
    for (let j = 0; j < s.fit.model.featureNames.length; j++) {
      const w = s.fit.model.weights[j];
      lines.push(`     ${s.fit.model.featureNames[j].padEnd(10)} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`);
    }
    lines.push(`     ${'bias'.padEnd(10)} ${s.fit.model.bias >= 0 ? '+' : ''}${s.fit.model.bias.toFixed(2)}`);
  } else {
    lines.push(`fit: NOT trained — ${s.fit.reason}`);
    lines.push(`     (needs ${MIN_LABELS_FOR_FIT} labelled turns with ≥${MIN_PER_CLASS} of each class)`);
  }
  lines.push('read-only: nothing routes on this and no score is derived from it');
  return lines;
}

/** Export formats for the labelled corpus. */
export type CorpusFormat = 'json' | 'csv';

/** CSV column order (stable, so an offline reader can rely on it). */
export const CORPUS_CSV_COLUMNS = [
  'traceId',
  'provider',
  'model',
  'at',
  'accepted',
  'source',
  ...ACCEPTANCE_FEATURES,
] as const;

function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  // Quote only when needed, so a plain id stays readable and RFC-4180 holds.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize the labelled corpus for shipping and offline fitting — the SAME rows
 * a fit here would read, so nothing is lost in the hand-off.
 *
 * JSON carries the full structure (features nested, plus provenance); CSV is the
 * flat form for a spreadsheet, with one column per feature and `accepted` as 0/1.
 */
export function serializeLabelledTurns(
  rows: LabelledTurn[],
  format: CorpusFormat,
  now: number = Date.now(),
): string {
  if (format === 'csv') {
    const header = CORPUS_CSV_COLUMNS.join(',');
    const lines = rows.map((r) =>
      CORPUS_CSV_COLUMNS.map((c) => {
        if (c === 'accepted') return r.accepted ? '1' : '0';
        if (c === 'traceId') return csvCell(r.traceId);
        if (c === 'provider') return csvCell(r.provider);
        if (c === 'model') return csvCell(r.model);
        if (c === 'at') return csvCell(r.at);
        if (c === 'source') return csvCell(r.source);
        return csvCell(r.features[c]);
      }).join(','),
    );
    return `${header}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
  }
  return `${JSON.stringify({ version: 1, exportedAt: now, count: rows.length, turns: rows }, null, 2)}\n`;
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
