/**
 * CostDashboard — the cost-basis split.
 *
 * The dashboard must show spend by how it was KNOWN: measured token counts,
 * length-based estimates, and — separately — the exact figure a provider
 * reported. That last one is a subset of measured spend and is what makes a
 * free/subscription call's true $0 visible instead of a generic rate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import CostDashboard from './CostDashboard';
import type { DashboardData, CostData } from '../types';

function cost(overrides: Partial<CostData> = {}): CostData {
  return {
    totalRequests: 2,
    totalCost: 0.02,
    totalTokens: 4900,
    byProvider: { openrouter: 0, anthropic: 0.02 },
    byModel: { 'claude-3.5-sonnet': 0.02 },
    byProviderMeasured: { anthropic: 0.02 },
    byProviderReported: { openrouter: 0 },
    measuredCalls: 2,
    estimatedCalls: 0,
    measuredCost: 0.02,
    estimatedCost: 0,
    reportedCalls: 1,
    reportedCost: 0,
    recent: [
      { provider: 'anthropic', model: 'claude-3.5-sonnet', costUsd: 0.02, totalTokens: 4000, timestamp: Date.now(), measured: true, reported: false },
      { provider: 'openrouter', model: 'llama-3.3-70b-instruct:free', costUsd: 0, totalTokens: 900, timestamp: Date.now(), measured: true, reported: true },
    ],
    ...overrides,
  };
}

function data(c: CostData): DashboardData {
  return { cost: c } as unknown as DashboardData;
}

describe('CostDashboard', () => {
  afterEach(cleanup);

  it('shows the provider-reported split as a subset of measured spend', () => {
    render(<CostDashboard data={data(cost())} />);

    expect(screen.getByText('📏 Measured (exact wire tokens)')).toBeTruthy();
    expect(screen.getByText('📐 Estimated (length-based)')).toBeTruthy();
    expect(screen.getByText('🧾 of which provider-reported (exact billed)')).toBeTruthy();
    // One reported call, and it is a true $0 (the free model).
    expect(screen.getByText('1 calls')).toBeTruthy();
  });

  it('marks only provider-reported recent rows with the 🧾 badge', () => {
    render(<CostDashboard data={data(cost())} />);

    // The free OpenRouter row: reported, $0, badged.
    expect(screen.getByText(/🧾 \$0\.00/)).toBeTruthy();
    // The anthropic row is locally priced, not reported — no badge.
    expect(screen.queryByText(/🧾 \$0\.02/)).toBeNull();
  });
});
