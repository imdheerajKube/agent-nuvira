/**
 * Bundle 34 — the export → import round trip.
 *
 * A corpus exported on one machine must import on another unchanged: same labels,
 * same features, same provenance. Re-importing must be idempotent (no duplicated
 * rows), and a LOCAL trace must win over an imported row for the same trace id,
 * because the local record carries the features we measured ourselves.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectLabelledTurns,
  detectCorpusFormat,
  mergeImportedLabels,
  parseCorpusText,
  serializeLabelledTurns,
  type LabelledTurn,
} from '../../src/learning/acceptance-model.js';
import { beginTrace, clearTraces, recordTraceVerdict, recordTurnReport } from '../../src/learning/reasoning-trace.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

function report(verification: string, flags: Record<string, boolean> = {}): TurnReport {
  return {
    goal: 'x', planned: false, steps: [], stepCounts: { done: 0, blocked: 0, pending: 0, running: 0, total: 0 },
    toolCalls: [], successfulToolCalls: [], failedToolCalls: [], mutations: 0, changedPaths: [],
    verification, flags, assumptions: [], summary: null,
  } as unknown as TurnReport;
}

function seed(accepted: boolean, verification: string, provider: string, model: string, flags: Record<string, boolean> = {}): string {
  const id = beginTrace({ goal: 'a turn', source: 'chat', provider, model });
  recordTurnReport(id, report(verification, flags));
  recordTraceVerdict(id, accepted ? 'accepted' : 'rejected', 'cli');
  return id;
}

const key = (t: LabelledTurn): string => t.traceId ?? `${t.at}`;
const shape = (rows: LabelledTurn[]) =>
  [...rows]
    .sort((a, b) => key(a).localeCompare(key(b)))
    .map((t) => ({ id: key(t), accepted: t.accepted, source: t.source, features: t.features }));

describe('acceptance corpus export → import round trip', () => {
  let dirA: string;
  let dirB: string;
  let dirC: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  const useDir = (dir: string): void => {
    process.env.NUVIRA_MEMORY_DIR = dir;
    process.env.NUVIRA_CONFIG_DIR = join(dir, 'config');
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    dirA = mkdtempSync(join(tmpdir(), 'buff-acc-A-'));
    dirB = mkdtempSync(join(tmpdir(), 'buff-acc-B-'));
    dirC = mkdtempSync(join(tmpdir(), 'buff-acc-C-'));
  });

  afterEach(() => {
    if (origMemory === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = origMemory;
    if (origConfig === undefined) delete process.env.NUVIRA_CONFIG_DIR;
    else process.env.NUVIRA_CONFIG_DIR = origConfig;
    for (const d of [dirA, dirB, dirC]) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('JSON and CSV both round-trip labels and features unchanged', () => {
    useDir(dirA);
    clearTraces();
    seed(true, 'verified', 'groq', 'm1');
    seed(false, 'unverified', 'groq', 'm1', { unverifiedActionClaim: true });
    seed(true, 'delivered-and-read-back', 'gemini', 'm2');
    const original = collectLabelledTurns();
    expect(original).toHaveLength(3);

    const json = serializeLabelledTurns(original, 'json');
    const csv = serializeLabelledTurns(original, 'csv');

    // JSON sniffing: no extension → content decides.
    expect(detectCorpusFormat(undefined, json)).toBe('json');
    expect(detectCorpusFormat(undefined, csv)).toBe('csv');
    expect(detectCorpusFormat('x.csv', json)).toBe('csv');

    expect(shape(parseCorpusText(json, 'json'))).toEqual(shape(original));
    expect(shape(parseCorpusText(csv, 'csv'))).toEqual(shape(original));

    // Import into a FRESH store: the labels must survive as first-class rows.
    useDir(dirB);
    const res = mergeImportedLabels(parseCorpusText(json, 'json'));
    expect(res.added).toBe(3);
    expect(res.updated).toBe(0);
    const imported = collectLabelledTurns();
    expect(shape(imported)).toEqual(shape(original));

    // Re-import is idempotent: no duplicates, updated counted.
    const again = mergeImportedLabels(parseCorpusText(json, 'json'));
    expect(again.added).toBe(0);
    expect(again.updated).toBe(3);
    expect(again.total).toBe(3);
    expect(collectLabelledTurns()).toHaveLength(3);

    // CSV into a third store yields the same rows.
    useDir(dirC);
    mergeImportedLabels(parseCorpusText(csv, 'csv'));
    expect(shape(collectLabelledTurns())).toEqual(shape(original));
  });

  it('a LOCAL trace wins over an imported row for the same trace id', () => {
    useDir(dirA);
    clearTraces();
    const id = seed(true, 'verified', 'groq', 'm1');
    const local = collectLabelledTurns();

    useDir(dirB);
    // Import the same row, then add a LOCAL trace with the same id but a different verdict.
    mergeImportedLabels(local);
    expect(collectLabelledTurns()).toHaveLength(1);

    // Now the receiving store also has its own trace with that id (rejected).
    beginTrace({ goal: 'local', source: 'chat', provider: 'groq', model: 'm1' });
    clearTraces();
    const id2 = beginTrace({ goal: 'local', source: 'chat', provider: 'groq', model: 'm1' });
    recordTurnReport(id2, report('unverified'));
    recordTraceVerdict(id2, 'rejected', 'dashboard');
    // The imported row (id, accepted) and the local row (id2, rejected) differ in id,
    // so BOTH survive; but if an imported row shares a local id, the local wins.
    mergeImportedLabels([
      { traceId: id2, at: 5, accepted: true, source: 'cli', features: { verified: 1, unverified: 0, flag: 0, delivered: 0 } },
    ]);
    const rows = collectLabelledTurns().filter((t) => t.traceId === id2);
    expect(rows).toHaveLength(1);
    expect(rows[0].accepted).toBe(false);
    expect(rows[0].source).toBe('dashboard');
    expect(id).toBeTruthy();
  });
});
