/**
 * BenchmarkCharts — what a benchmark's cost IS.
 *
 * `Result.costUsd` is documented as an ESTIMATE ("Estimated cost in USD",
 * `learning/benchmark.ts`): token counts × list price, never a provider's
 * statement. The page used to print it under a bare "Cost" label and render
 * `$0.00` for a run that recorded none, so a guess read as a bill and "nobody
 * priced this" read as "it was free".
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BenchmarkCharts from './BenchmarkCharts';
import type { DashboardData } from '../types';

/** recharts' ResponsiveContainer measures itself with a ResizeObserver. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
afterEach(cleanup);

function run(over: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    provider: 'groq',
    model: 'llama-3.3-70b',
    startedAt: 1_700_000_000_000,
    summary: {
      totalTasks: 4,
      tasksPassed: 3,
      tasksFailed: 1,
      avgQualityScore: 0.7,
      medianLatencyMs: 1200,
      totalCostUsd: 0.012,
      totalTokens: 4000,
    },
    ...over,
  };
}

function data(latest: ReturnType<typeof run>, runs: Array<ReturnType<typeof run>>): DashboardData {
  return {
    benchmarks: { totalRuns: runs.length, latest, runs },
    evals: { totalRuns: 0, latest: null, runs: [] },
  } as unknown as DashboardData;
}

describe('BenchmarkCharts — cost basis', () => {
  it('labels the benchmark cost as an estimate, everywhere it prints one', () => {
    const first = run();
    const second = run({ id: 'run-2', model: 'gemini-2.0-flash' });
    render(<BenchmarkCharts data={data(first, [first, second])} />);

    // The tile names the claim…
    expect(screen.getByText('Cost (est.)')).toBeTruthy();
    expect(screen.getByText('$0.0120')).toBeTruthy();
    // …and so does the chart, rather than a bare "Cost".
    expect(screen.getByText('Cost by Model (est.)')).toBeTruthy();
    expect(screen.queryByText('Cost by Model')).toBeNull();
  });

  it('renders a dash for a run that recorded no cost — never $0.00', () => {
    const unpriced = run({
      summary: { ...run().summary, totalCostUsd: undefined },
    });
    render(<BenchmarkCharts data={data(unpriced, [unpriced])} />);

    expect(screen.getByText('Cost (est.)')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });
});
