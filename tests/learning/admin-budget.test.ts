/**
 * ADMIN BUDGET GATE (pinned path).
 *
 * The user's request (2026-10-06): an explicit model selection must still run
 * the model they chose, but it must ALSO honor the cost / token controls they
 * set in the dashboard's 💰 Daily Budget panel. Before this gate the pinned
 * path bypassed `autoRouter.resolve`, where `routing.quota` and `maxCostUsd`
 * are enforced — so a pin was the one way to spend past the declared budget.
 *
 * These tests pin the three behaviours that matter:
 *   1. no budget configured  → permissive (byte-for-byte unchanged setups);
 *   2. declared window spent → refused, naming the quota control;
 *   3. cost cap exceeded     → refused, naming the cost control.
 * …plus the deliberate NON-behaviour: a transient rate-limit park is NOT a
 * budget, so it must never refuse a pin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { adminBudgetVerdict } from '../../src/learning/auto-router.js';
import { getQuotaLedger } from '../../src/learning/quota-ledger.js';
import type { ConfigManager } from '../../src/config/manager.js';

function cfg(routing: Record<string, unknown> | undefined): ConfigManager {
  return { getAll: () => ({ routing }) } as unknown as ConfigManager;
}

describe('adminBudgetVerdict (pinned run)', () => {
  beforeEach(() => {
    getQuotaLedger().reset();
  });

  it('is permissive when no budget is configured (unchanged setups)', () => {
    expect(adminBudgetVerdict(cfg(undefined), 'gemini').allowed).toBe(true);
    expect(adminBudgetVerdict(cfg({}), 'gemini').allowed).toBe(true);
    expect(adminBudgetVerdict(undefined, 'gemini').allowed).toBe(true);
  });

  it('refuses a pin once the declared token window is spent', () => {
    getQuotaLedger().recordUsage('gemini', 'gemini-x', 60, 60);
    const verdict = adminBudgetVerdict(
      cfg({ quota: { gemini: { tokensPerWindow: 100 } } }),
      'gemini',
      { model: 'gemini-x' },
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.control).toBe('quota');
    expect(verdict.reason).toMatch(/budget/i);
  });

  it('allows a pin while the declared window still has room', () => {
    getQuotaLedger().recordUsage('gemini', 'gemini-x', 10, 10);
    expect(
      adminBudgetVerdict(cfg({ quota: { gemini: { tokensPerWindow: 100 } } }), 'gemini').allowed,
    ).toBe(true);
  });

  it('does NOT refuse a pin for a transient park (a 429 is not a budget)', () => {
    // Provider-wide cooldown with NO configured limit → not an admin control.
    getQuotaLedger().parkProvider('gemini', Date.now() + 60_000, 'rate-limit');
    expect(adminBudgetVerdict(cfg({}), 'gemini').allowed).toBe(true);
    // …and even WITH a limit configured, the park alone must not trip the gate.
    expect(
      adminBudgetVerdict(cfg({ quota: { gemini: { tokensPerWindow: 10_000 } } }), 'gemini').allowed,
    ).toBe(true);
  });

  it('refuses a pin whose typical call exceeds the admin cost cap', () => {
    // openrouter's list pricing gives a ~$0.01 typical call.
    const verdict = adminBudgetVerdict(cfg({ maxCostUsd: 0.001 }), 'openrouter');
    expect(verdict.allowed).toBe(false);
    expect(verdict.control).toBe('cost');
    expect(verdict.reason).toMatch(/cap/i);
  });

  it('uses the STRICTER of routing.maxCostUsd and governance.maxCostUsd', () => {
    const strict = adminBudgetVerdict(
      cfg({ maxCostUsd: 1, governance: { maxCostUsd: 0.001 } }),
      'openrouter',
    );
    expect(strict.allowed).toBe(false);
    // A generous cap on either side does not weaken the stricter one.
    const generous = adminBudgetVerdict(
      cfg({ maxCostUsd: 0.001, governance: { maxCostUsd: 1 } }),
      'openrouter',
    );
    expect(generous.allowed).toBe(false);
  });

  it('allows a pin when the cost cap is comfortably above the typical call', () => {
    expect(adminBudgetVerdict(cfg({ maxCostUsd: 5 }), 'openrouter').allowed).toBe(true);
  });
});
