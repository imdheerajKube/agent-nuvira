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
  formatAcceptanceSummary,
  predictAcceptance,
  trainAcceptanceModel,
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
    expect(text).toMatch(/read-only: nothing routes on this/);
  });
});
