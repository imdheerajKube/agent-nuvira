/**
 * The step bound is a SETTING, and the budget reads the same facts the close-out
 * gate does.
 *
 * Measured 2026-11-06 (the RAG benchmark): the patched arm stopped at 50 steps and
 * told the user "2 requirement(s) the ask named are still unmet". Both halves of
 * that were defects: `chat` pinned `maxSteps: 16` (so no caller could size a long
 * build), and the budget asked only the requirement ledger, while the close-out
 * gate also counted files the ask named and report sections. The turn therefore
 * ended while the loop itself could name work that remained.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STEP_BUDGET_DEFAULT_BASE,
  STEP_BUDGET_DEFAULT_TOTAL,
  resolveStepBudget,
} from '../../src/learning/turn-budget.js';
import { outstandingCloseoutFacts } from '../../src/learning/completion-contract.js';
import { ConfigManager } from '../../src/config/manager.js';

const cm = (turn?: unknown) => ({ getAll: () => ({ turn }) });

describe('resolveStepBudget — the bound is a setting, not a literal', () => {
  it('defaults to the documented first slice and absolute guard', () => {
    const budget = resolveStepBudget(cm());
    expect(budget.maxSteps).toBe(STEP_BUDGET_DEFAULT_BASE);
    expect(budget.maxTotalSteps).toBe(STEP_BUDGET_DEFAULT_TOTAL);
    expect(budget.source).toBe('default');
  });

  it('honours a configured slice and guard, so a multi-day build can be sized', () => {
    const budget = resolveStepBudget(cm({ maxSteps: 64, maxTotalSteps: 20_000 }));
    expect(budget).toEqual({ maxSteps: 64, maxTotalSteps: 20_000, source: 'config' });
  });

  it('never lets the guard sit below the first slice', () => {
    const budget = resolveStepBudget(cm({ maxSteps: 500, maxTotalSteps: 100 }));
    expect(budget.maxTotalSteps).toBe(500);
  });

  it('falls back per field instead of ending a turn at zero', () => {
    const budget = resolveStepBudget(cm({ maxSteps: 0, maxTotalSteps: 'lots' }));
    expect(budget.maxSteps).toBe(STEP_BUDGET_DEFAULT_BASE);
    expect(budget.maxTotalSteps).toBe(STEP_BUDGET_DEFAULT_TOTAL);
  });

  it('reads a broken config as the defaults rather than removing the guard', () => {
    const budget = resolveStepBudget({
      getAll: () => {
        throw new Error('bad config');
      },
    });
    expect(budget.source).toBe('default');
    expect(budget.maxTotalSteps).toBe(STEP_BUDGET_DEFAULT_TOTAL);
  });
});

describe('outstandingCloseoutFacts — what the budget must be able to see', () => {
  it('counts a named file and a live red check the requirement ledger does not', () => {
    const facts = outstandingCloseoutFacts({
      unmet: ['tests pass'],
      redChecks: [
        { command: 'pytest', stale: true },
        { command: 'npm test', stale: false, preExisting: true },
      ],
      namedDeliverables: [
        { path: 'LIMITATIONS.md', exists: false },
        { path: 'README.md', exists: true },
      ],
    });
    // 1 unmet row + 1 live red (the pre-existing one is not this turn's work)
    // + 1 named file that is not on disk.
    expect(facts).toBe(3);
  });

  it('is zero when the ask is closed and the only red predates the turn', () => {
    expect(
      outstandingCloseoutFacts({
        unmet: [],
        redChecks: [{ command: 'npm test', stale: false, preExisting: true }],
        namedDeliverables: [{ path: 'README.md', exists: true }],
      }),
    ).toBe(0);
  });
});

/**
 * The setting has to survive a RESTART, and setting one field must not erase the
 * other — the config loader merges section by section, so a value that only works
 * in-process is a setting the user believes they configured and a turn never sees.
 */
describe('the step budget through the real config manager', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('survives a restart and keeps maxMinutes when maxSteps is set', () => {
    dir = mkdtempSync(join(tmpdir(), 'step-budget-config-'));
    const cm = new ConfigManager(dir);
    cm.save({ turn: { maxMinutes: 30, maxSteps: 48 } });

    const reloaded = resolveStepBudget(new ConfigManager(dir));
    expect(reloaded).toEqual({ maxSteps: 48, maxTotalSteps: STEP_BUDGET_DEFAULT_TOTAL, source: 'config' });
    // The sibling field survives the write and the reload.
    expect((new ConfigManager(dir).getAll().turn as { maxMinutes?: number }).maxMinutes).toBe(30);
  });
});
