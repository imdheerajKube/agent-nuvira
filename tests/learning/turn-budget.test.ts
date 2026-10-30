/**
 * The wall clock a turn is given, and the fact that turning it off is explicit.
 *
 * The defect this replaces: every budget in the loop counted steps, so a turn could
 * spend its whole time on a broken tool and be stopped by an external `timeout` with
 * nothing written (measured 2026-10-27). The default exists so a fresh install gets
 * the protection; `0` exists so an embedding that sizes its own turn keeps it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTurnBudget,
  TURN_BUDGET_DEFAULT_MINUTES,
  TURN_BUDGET_MAX_MINUTES,
} from '../../src/learning/turn-budget.js';
import { ConfigManager } from '../../src/config/manager.js';

const cm = (turn?: unknown) => ({ getAll: () => ({ turn }) });

describe('resolveTurnBudget', () => {
  it('defaults to an hour when the config says nothing', () => {
    const budget = resolveTurnBudget(cm());
    expect(budget.enabled).toBe(true);
    expect(budget.minutes).toBe(TURN_BUDGET_DEFAULT_MINUTES);
    expect(budget.ms).toBe(TURN_BUDGET_DEFAULT_MINUTES * 60_000);
    expect(budget.source).toBe('default');
  });

  it('honours a configured number, in minutes', () => {
    const budget = resolveTurnBudget(cm({ maxMinutes: 30 }));
    expect(budget.ms).toBe(30 * 60_000);
    expect(budget.source).toBe('config');
  });

  it('treats 0 as an explicit OFF, not as a zero-length turn', () => {
    expect(resolveTurnBudget(cm({ maxMinutes: 0 }))).toEqual({ enabled: false, source: 'off' });
  });

  it('clamps nonsense instead of accepting it', () => {
    expect(resolveTurnBudget(cm({ maxMinutes: 0.2 })).minutes).toBe(1);
    expect(resolveTurnBudget(cm({ maxMinutes: 10_000 })).minutes).toBe(TURN_BUDGET_MAX_MINUTES);
    // A non-number is not an instruction: the default stands.
    expect(resolveTurnBudget(cm({ maxMinutes: 'soon' })).source).toBe('default');
  });

  it('falls back to the default when the config cannot be read at all', () => {
    expect(resolveTurnBudget({ getAll: () => { throw new Error('bad config'); } }).source).toBe('default');
    expect(resolveTurnBudget(undefined).source).toBe('default');
  });
});

/**
 * The setting has to survive a RESTART, not just a write.
 *
 * Found by driving the real `ConfigManager`: `save()` persisted `turn` and the value
 * read back correctly in the same process, while a fresh manager loaded the file and
 * dropped it — the config loader merges section by section, so an unregistered
 * section is silently discarded. That is the shape of a setting a user believes they
 * configured and a turn that never applies it, so it is pinned here with the real
 * manager rather than a mock.
 */
describe('turn.maxMinutes through the real config manager', () => {
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('survives a restart, and 0 stays 0 after reloading', () => {
    dir = mkdtempSync(join(tmpdir(), 'turn-budget-config-'));
    const cm = new ConfigManager(dir);
    cm.save({ turn: { maxMinutes: 30 } });
    expect(resolveTurnBudget(new ConfigManager(dir)).minutes).toBe(30);

    cm.save({ turn: { maxMinutes: 0 } });
    expect(resolveTurnBudget(new ConfigManager(dir))).toEqual({ enabled: false, source: 'off' });
  });
});
