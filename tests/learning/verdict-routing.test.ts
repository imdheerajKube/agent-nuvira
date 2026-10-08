/**
 * Bundle 36 — `applyVerdictToRouter` (the explicit-verdict → router bridge).
 *
 * Proves the gap is closed: an explicit `nuvira rate bad` (and the dashboard's 👎,
 * which shares `rateTurn`) moves the bandit arm that served the turn — exactly as
 * the derived correction would — and moves it ONCE, even though the user can rate
 * the same turn repeatedly and the derived signal may already have fired.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyVerdictToRouter } from '../../src/learning/verdict-routing.js';
import { getRouterBandit, resetRouterBandit, USER_REJECTION_DELTA } from '../../src/learning/router-bandit.js';
import {
  beginTrace,
  clearTraces,
  recordTraceEvent,
  recordTurnReport,
} from '../../src/learning/reasoning-trace.js';
import { ConfigManager } from '../../src/config/manager.js';
import type { TurnReport } from '../../src/learning/turn-report.js';

function report(verification: string): TurnReport {
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
    flags: {},
    assumptions: [],
    summary: null,
  } as unknown as TurnReport;
}

/** A turn that was auto-routed to groq / llama, bucketed 'coding:moderate'. */
function addRoutedTurn(): string {
  const id = beginTrace({ goal: 'implement a login form', source: 'chat', provider: 'auto', model: 'auto' });
  recordTurnReport(id, report('verified'));
  recordTraceEvent(id, {
    kind: 'decision',
    gate: 'routing',
    summary: 'routed to groq/llama-3.3-70b-versatile (complexity moderate)',
    routing: {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      score: 0.9,
      complexity: 'moderate',
      explanation: 'test',
      taskIntent: 'coding',
    },
  });
  return id;
}

describe('applyVerdictToRouter', () => {
  let tempDir: string;
  let origMemory: string | undefined;
  let origConfig: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'buff-verdict-routing-'));
    origMemory = process.env.NUVIRA_MEMORY_DIR;
    origConfig = process.env.NUVIRA_CONFIG_DIR;
    process.env.NUVIRA_MEMORY_DIR = tempDir;
    process.env.NUVIRA_CONFIG_DIR = join(tempDir, 'config');
    resetRouterBandit();
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

  it('corrects the arm that served the turn, exactly once', () => {
    const id = addRoutedTurn();
    // The turn's measured outcome, recorded the way the chat path records it.
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...getRouterBandit().getPrior('groq', 'moderate' as never, 'coding') };

    const first = applyVerdictToRouter(id, 'rejected');
    expect(first.applied).toBe(true);
    expect(first.moved).toBe(1);
    expect(first.provider).toBe('groq');

    const after = getRouterBandit().getPrior('groq', 'moderate' as never, 'coding');
    expect(after.alpha).toBeCloseTo(before.alpha - USER_REJECTION_DELTA, 10);
    expect(after.beta).toBeCloseTo(before.beta + USER_REJECTION_DELTA, 10);

    // Re-rating the SAME trace (a user can) must not move it again.
    const second = applyVerdictToRouter(id, 'rejected');
    expect(second.applied).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(getRouterBandit().getPrior('groq', 'moderate' as never, 'coding')).toEqual(after);
  });

  it('records nothing for an acceptance — a 👍 adds no new observation to routing', () => {
    const id = addRoutedTurn();
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...getRouterBandit().getPrior('groq', 'moderate' as never, 'coding') };

    const res = applyVerdictToRouter(id, 'accepted');
    expect(res.applied).toBe(false);
    expect(res.moved).toBe(0);
    expect(getRouterBandit().getPrior('groq', 'moderate' as never, 'coding')).toEqual(before);
  });

  it('applies nothing when router learning is switched off', () => {
    const id = addRoutedTurn();
    getRouterBandit().recordOutcome('groq', 'implement a login form', 'success', 1.0, undefined, 'coding');
    const before = { ...getRouterBandit().getPrior('groq', 'moderate' as never, 'coding') };
    new ConfigManager().save({ routing: { bandit: false } });

    const res = applyVerdictToRouter(id, 'rejected');
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/switched off/);
    expect(getRouterBandit().getPrior('groq', 'moderate' as never, 'coding')).toEqual(before);
  });

  it('reports honestly when the trace is unknown', () => {
    const res = applyVerdictToRouter('trace-does-not-exist', 'rejected');
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/not found/);
  });
});
