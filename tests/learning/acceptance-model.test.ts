/**
 * Bundle 31 — the acceptance model.
 *
 * It must refuse to fit below the sample floor (a probability printed from three
 * rows is the plausible-looking number this programme exists to remove), fit a
 * real model once the floor is cleared, and never touch the routing path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptanceByPair,
  acceptanceSummary,
  collectLabelledTurns,
  explainTraceLabel,
  featuresFromTrace,
  featuresFromReport,
  cachedAcceptanceFit,
  invalidateAcceptanceFit,
  FIT_CACHE_TTL_MS,
  flagNames,
  formatAcceptanceSummary,
  predictAcceptance,
  trainAcceptanceModel,
  serializeLabelledTurns,
  CORPUS_CSV_COLUMNS,
  MIN_LABELS_FOR_FIT,
} from '../../src/learning/acceptance-model.js';
import { beginTrace, clearTraces, recordTraceVerdict, recordTurnReport } from '../../src/learning/reasoning-trace.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

function report(verification: string, flags: Record<string, boolean> = {}): TurnReport {
  return {
    goal: 'x',
    planned: false,
    steps: [],
    stepCounts: { done: 0, blocked: 0, pending: 0, running: 0, total: 0 },
    toolCalls: [],
    successfulToolCalls: [],
    failedToolCalls: [],
    mutations: 0,
    changedPaths: [],
    verification,
    flags,
    assumptions: [],
    summary: null,
  } as unknown as TurnReport;
}

describe('acceptance model', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-acceptance-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    clearTraces();
  });

  afterEach(() => {
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function addTurn(opts: {
    accepted: boolean;
    verification: string;
    flags?: Record<string, boolean>;
    provider?: string;
    model?: string;
  }): string {
    const id = beginTrace({
      goal: 'a turn',
      source: 'chat',
      provider: opts.provider ?? 'groq',
      model: opts.model ?? 'mock-model',
    });
    recordTurnReport(id, report(opts.verification, opts.flags));
    recordTraceVerdict(id, opts.accepted ? 'accepted' : 'rejected', 'cli');
    return id;
  }

  it('refuses to fit with too few labelled turns, and names why', () => {
    addTurn({ accepted: true, verification: 'verified' });
    addTurn({ accepted: false, verification: 'unverified' });
    const fit = trainAcceptanceModel();
    expect(fit.ok).toBe(false);
    if (fit.ok) throw new Error('unreachable');
    expect(fit.n).toBe(2);
    expect(fit.reason).toMatch(/labelled turn/);
  });

  it('refuses to fit with only one class present', () => {
    for (let i = 0; i < MIN_LABELS_FOR_FIT + 2; i++) {
      addTurn({ accepted: true, verification: 'verified' });
    }
    const fit = trainAcceptanceModel();
    expect(fit.ok).toBe(false);
    if (fit.ok) throw new Error('unreachable');
    expect(fit.negatives).toBe(0);
    expect(fit.reason).toMatch(/each class/);
  });

  it('fits a real model once both classes clear the floor, and ranks verified work higher', () => {
    for (let i = 0; i < 12; i++) addTurn({ accepted: true, verification: 'verified' });
    for (let i = 0; i < 12; i++) addTurn({ accepted: false, verification: 'unverified', flags: { unverifiedActionClaim: true } });

    const fit = trainAcceptanceModel();
    expect(fit.ok).toBe(true);
    if (!fit.ok) throw new Error('unreachable');
    expect(fit.model.n).toBe(24);
    expect(fit.model.positives).toBe(12);
    expect(fit.model.negatives).toBe(12);

    const good = predictAcceptance(fit.model, { verified: 1, unverified: 0, flag: 0, delivered: 1 });
    const bad = predictAcceptance(fit.model, { verified: 0, unverified: 1, flag: 1, delivered: 0 });
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeGreaterThan(0.5);
    expect(bad).toBeLessThan(0.5);
    // Deterministic: the same corpus yields the same coefficients.
    const again = trainAcceptanceModel();
    if (!again.ok) throw new Error('unreachable');
    expect(again.model.weights).toEqual(fit.model.weights);
  });

  it('excludes unrated turns from collection (silence is not a label)', () => {
    const id = beginTrace({ goal: 'x', source: 'chat' });
    recordTurnReport(id, report('verified'));
    // no recordTraceVerdict
    expect(collectLabelledTurns()).toHaveLength(0);
  });

  it('groups rated turns by pair for the per-pair acceptance line', () => {
    addTurn({ accepted: true, verification: 'verified', provider: 'groq', model: 'm1' });
    addTurn({ accepted: false, verification: 'unverified', provider: 'groq', model: 'm1' });
    addTurn({ accepted: true, verification: 'verified', provider: 'gemini', model: 'm2' });
    const pairs = acceptanceByPair();
    expect(pairs['groq/m1']).toEqual({ accepted: 1, rejected: 1 });
    expect(pairs['gemini/m2']).toEqual({ accepted: 1, rejected: 0 });
  });

  it('summarises with an honest untrained line below the floor', () => {
    addTurn({ accepted: true, verification: 'verified' });
    const s = acceptanceSummary();
    expect(s.labelled).toBe(1);
    expect(s.accepted).toBe(1);
    expect(s.fit.ok).toBe(false);
    const text = formatAcceptanceSummary(s).join('\n');
    expect(text).toMatch(/labelled turns: 1/);
    expect(text).toMatch(/NOT trained/);
    // The fit now feeds the bandit's qualityScore ABOVE the floor; below it, the
    // summary states the honest opposite rather than claiming a read-only stance
    // the router no longer has.
    expect(text).toMatch(/nothing routes on this until the fit clears the sample floor/);
  });

  it('focuses a pair in the shared summary without a second formatter', () => {
    addTurn({ accepted: true, verification: 'verified', provider: 'groq', model: 'm1' });
    addTurn({ accepted: false, verification: 'unverified', provider: 'gemini', model: 'm2' });
    const lines = formatAcceptanceSummary(acceptanceSummary(), 'groq/m1').join('\n');
    expect(lines).toMatch(/groq\/m1: 👍 1 \/ 👎 0.*←/);
    // A pair with no labels is shown as n/a rather than hidden.
    const missing = formatAcceptanceSummary(acceptanceSummary(), 'nope/none').join('\n');
    expect(missing).toMatch(/nope\/none: n\/a/);
  });

  it('serializes the labelled corpus to JSON and CSV for offline fitting', () => {
    addTurn({ accepted: true, verification: 'verified', provider: 'groq', model: 'm1' });
    addTurn({ accepted: false, verification: 'unverified', provider: 'gemini', model: 'm2' });
    const rows = collectLabelledTurns();

    const json = JSON.parse(serializeLabelledTurns(rows, 'json', 123)) as {
      version: number;
      exportedAt: number;
      count: number;
      turns: Array<{ accepted: boolean; features: Record<string, number> }>;
    };
    expect(json.version).toBe(1);
    expect(json.exportedAt).toBe(123);
    expect(json.count).toBe(2);
    expect(json.turns).toHaveLength(2);
    expect(typeof json.turns[0].features.verified).toBe('number');

    const csv = serializeLabelledTurns(rows, 'csv');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(CORPUS_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    // accepted is 0/1 in the flat form; provider/model survive.
    const cols = lines[0].split(',');
    const acceptedIdx = cols.indexOf('accepted');
    const providerIdx = cols.indexOf('provider');
    expect(['0', '1']).toContain(lines[1].split(',')[acceptedIdx]);
    expect(lines.map((l) => l.split(',')[providerIdx])).toContain('groq');
  });

  it('explains an unrated turn honestly — silence is not acceptance', () => {
    const id = beginTrace({ goal: 'a guided turn', source: 'chat', provider: 'groq', model: 'm1' });
    recordTurnReport(id, report('unverified', { unverifiedEdit: true }));

    const e = explainTraceLabel(id);
    expect(e).not.toBeNull();
    if (!e) throw new Error('unreachable');
    expect(e.label).toBeNull();
    expect(e.source).toBeNull();
    expect(e.probability).toBeNull();
    expect(e.fitReady).toBe(false);
    expect(e.verification).toBe('unverified');
    expect(e.flags).toContain('unverifiedEdit');
    expect(e.features).toEqual({ verified: 0, unverified: 1, flag: 1, delivered: 0 });
  });

  it('explains a rated turn with the fitted probability when the model has trained', () => {
    for (let i = 0; i < 12; i++) addTurn({ accepted: true, verification: 'verified' });
    for (let i = 0; i < 12; i++) addTurn({ accepted: false, verification: 'unverified' });
    const id = addTurn({ accepted: true, verification: 'verified', provider: 'groq', model: 'm1' });

    const e = explainTraceLabel(id);
    expect(e).not.toBeNull();
    if (!e) throw new Error('unreachable');
    expect(e.fitReady).toBe(true);
    expect(e.label).toBe(true);
    expect(e.source).toBe('cli');
    const fit = trainAcceptanceModel();
    if (!fit.ok) throw new Error('unreachable');
    expect(e.probability).toBeCloseTo(predictAcceptance(fit.model, e.features), 10);
    expect(e.probability).toBeGreaterThan(0.5);
  });

  it('returns null for a trace it cannot find, and reports flag names directly', () => {
    expect(explainTraceLabel('trace-does-not-exist')).toBeNull();
    expect(flagNames(report('verified', { unverifiedActionClaim: true, noActionTaken: true }))).toEqual([
      'unverifiedActionClaim',
      'noActionTaken',
    ]);
    expect(featuresFromTrace({ turnReport: report('verified') }, true)).toEqual({
      verified: 1,
      unverified: 0,
      flag: 0,
      delivered: 1,
    });
  });
});

describe('the LIVE-turn read path (qualityScore for the router bandit)', () => {
  it('derives a live turn’s features the SAME way a stored trace’s are derived', () => {
    // The score a turn gets while it runs must not disagree with the rows the fit
    // trained on, so both go through the same rules.
    expect(featuresFromReport(report('verified'))).toEqual({ verified: 1, unverified: 0, flag: 0, delivered: 0 });
    expect(featuresFromReport(report('unverified', { unverifiedEdit: true }))).toEqual({
      verified: 0,
      unverified: 1,
      flag: 1,
      delivered: 0,
    });
    // A delivered-and-read-back authored turn counts as both verified and delivered.
    expect(featuresFromReport(report('delivered-and-read-back'))).toEqual({
      verified: 1,
      unverified: 0,
      flag: 0,
      delivered: 1,
    });
  });

  it('memoizes the fit and refits after the TTL or an explicit invalidation', () => {
    // Fitting re-reads the corpus and runs 500 iterations; the live path must not
    // pay that on every turn.
    invalidateAcceptanceFit();
    const a = cachedAcceptanceFit(1_000);
    const b = cachedAcceptanceFit(2_000);
    expect(b).toBe(a);
    const afterTtl = cachedAcceptanceFit(1_000 + FIT_CACHE_TTL_MS + 1);
    expect(afterTtl).not.toBe(a);
    invalidateAcceptanceFit();
    expect(cachedAcceptanceFit(5_000)).not.toBe(afterTtl);
  });
});
