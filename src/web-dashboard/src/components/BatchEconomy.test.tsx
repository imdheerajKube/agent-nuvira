/**
 * BatchEconomy tests (G27 — per-batch cost & latency on the dashboard).
 *
 * The rule under test is the honesty rule the CLI table already enforces: an
 * unmeasured column renders as "—", never as 0, so an unmetered batch cannot
 * read as "free". A failed batch also keeps its row — it still spent tokens.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BatchEconomy from './BatchEconomy';
import type { UnattendedJobView } from '../types';

function job(overrides: Partial<UnattendedJobView> = {}): UnattendedJobView {
  return {
    id: 'job-1',
    kind: 'long-form',
    status: 'running',
    goal: 'write a 100 page book to /tmp/book.md',
    progress: 24,
    progressLine: 'chapter 10/39',
    batches: 2,
    costUsd: 0.00412,
    tokens: 12_345,
    updatedAt: 1,
    batchStats: [
      { index: 1, progress: 12, costUsd: 0.00412, tokens: 12_345, durationMs: 61_000 },
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
    // Measured row (the value also appears in the run chip and the total row,
    // which is the point — the row agrees with the totals).
    expect(screen.getAllByText('$0.00412').length).toBeGreaterThanOrEqual(2);
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

  it('lets you switch between unattended runs', () => {
    // The server sorts most-recently-updated first; the component renders that
    // order and selects the first run.
    const newest = job({
      id: 'job-2',
      progress: 100,
      progressLine: 'book 39/39',
      costUsd: 0.03,
      tokens: 93_995,
      status: 'done',
      updatedAt: 2,
      batchStats: [{ index: 1, progress: 100, costUsd: 0.03, tokens: 93_995, durationMs: 1680_000 }],
    });
    render(<BatchEconomy jobs={[newest, job()]} />);

    // The newest run is shown first…
    expect(screen.getAllByText('93,995').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('~28m 00s avg')).toBeTruthy();

    // …and switching to the earlier run swaps the rows and totals.
    fireEvent.click(screen.getByText('chapter 10/39'));
    expect(screen.getAllByText('$0.00412').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('1m 01s')).toBeTruthy();
  });
});
