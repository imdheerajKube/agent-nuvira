/**
 * BatchEconomy tests (G27 — per-batch cost & latency on the dashboard).
 *
 * The rule under test is the honesty rule the CLI table already enforces: an
 * unmeasured column renders as "—", never as 0, so an unmetered batch cannot
 * read as "free". A failed batch also keeps its row — it still spent tokens.
 *
 * The cost column has a second rule since `spend` landed: a dollar is never
 * printed without saying WHAT it is. `$0.00412` is provider-stated, `~$0.004120?`
 * is a list price on an undeclared tier (possibly real money, possibly free), and
 * a legacy row with no provenance keeps its figure but takes the `?`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BatchEconomy from './BatchEconomy';
import type { SpendBreakdown, UnattendedJobView } from '../types';

/** A window the provider itself billed — the one figure that IS the amount owed. */
function exactSpend(tokens: number, usd: number): SpendBreakdown {
  return {
    tokens,
    calls: 3,
    reportedCalls: 3,
    exactUsd: usd,
    listedCalls: 0,
    estimatedUsd: 0,
    unverifiedCalls: 0,
    unverifiedUsd: 0,
    unverifiedProviders: [],
    freeCalls: 0,
    freeValueUsd: 0,
    unpricedCalls: 0,
  };
}

/** A list price on a provider whose billing tier was never declared. */
function unverifiedSpend(tokens: number, usd: number): SpendBreakdown {
  return {
    ...exactSpend(tokens, 0),
    reportedCalls: 0,
    unverifiedCalls: 2,
    unverifiedUsd: usd,
    unverifiedProviders: ['deepseek'],
  };
}

function job(overrides: Partial<UnattendedJobView> = {}): UnattendedJobView {
  return {
    id: 'job-1',
    kind: 'long-form',
    status: 'running',
    goal: 'write a 100 page book to /tmp/book.md',
    progress: 24,
    progressLine: 'chapter 10/39',
    batches: 2,
    spend: exactSpend(12_345, 0.00412),
    tokens: 12_345,
    updatedAt: 1,
    batchStats: [
      { index: 1, progress: 12, spend: exactSpend(12_345, 0.00412), tokens: 12_345, durationMs: 61_000 },
      { index: 2, progress: 24, error: 'provider 429 rate limited' },
    ],
    ...overrides,
  };
}

describe('BatchEconomy', () => {
  afterEach(cleanup);

  it('renders nothing when no run recorded batches', () => {
    const { container } = render(
      <BatchEconomy jobs={[job({ batchStats: [], batches: 0 })]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per batch with the measured cost, tokens and time', () => {
    render(<BatchEconomy jobs={[job()]} />);

    expect(screen.getByTestId('batch-economy')).toBeTruthy();
    expect(screen.getByText('📊 Per-batch cost & latency')).toBeTruthy();
    // Provider-stated money: no `~`, no `?` — the legend is not printed at all.
    expect(screen.getAllByText('$0.004120').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId('batch-economy-spend-legend')).toBeNull();
    expect(screen.getAllByText('12,345').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('1m 01s')).toBeTruthy();
    // The failed batch keeps its row and its reason.
    expect(screen.getByText(/provider 429 rate limited/)).toBeTruthy();
  });

  it('renders an unmeasured column as a dash, never as 0', () => {
    render(<BatchEconomy jobs={[job()]} />);
    // Second batch measured nothing: every economy cell is a dash.
    expect(screen.queryByText('$0.00000')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('marks an undeclared-tier list price as an estimate that may not be spend', () => {
    render(
      <BatchEconomy
        jobs={[
          job({
            spend: unverifiedSpend(12_345, 0.00412),
            batchStats: [
              { index: 1, progress: 12, spend: unverifiedSpend(12_345, 0.00412), tokens: 12_345, durationMs: 61_000 },
            ],
          }),
        ]}
      />,
    );

    // `~` = list price (an estimate), `?` = priced but not provably charged.
    expect(screen.getAllByText('~$0.004120?').length).toBeGreaterThanOrEqual(2);
    // The legend appears exactly when a mark was used, and names the remedy.
    expect(screen.getByTestId('batch-economy-spend-legend').textContent).toContain(
      'declare providers.<id>.billingTier',
    );
  });

  it('keeps a legacy row figure but marks it as unprovenanced', () => {
    render(
      <BatchEconomy
        jobs={[
          job({
            spend: undefined,
            costUsd: 0.00412,
            batchStats: [{ index: 1, progress: 12, costUsd: 0.00412, tokens: 12_345, durationMs: 61_000 }],
          }),
        ]}
      />,
    );
    expect(screen.getAllByText('$0.00412?').length).toBeGreaterThanOrEqual(2);
  });

  it('lets you switch between unattended runs', () => {
    // The server sorts most-recently-updated first; the component renders that
    // order and selects the first run.
    const newest = job({
      id: 'job-2',
      progress: 100,
      progressLine: 'book 39/39',
      spend: exactSpend(93_995, 0.03),
      tokens: 93_995,
      status: 'done',
      updatedAt: 2,
      batchStats: [
        { index: 1, progress: 100, spend: exactSpend(93_995, 0.03), tokens: 93_995, durationMs: 1680_000 },
      ],
    });
    render(<BatchEconomy jobs={[newest, job()]} />);

    // The newest run is shown first…
    expect(screen.getAllByText('93,995').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('~28m 00s avg')).toBeTruthy();

    // …and switching to the earlier run swaps the rows and totals.
    fireEvent.click(screen.getByText('chapter 10/39'));
    expect(screen.getAllByText('$0.004120').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('1m 01s')).toBeTruthy();
  });
});
