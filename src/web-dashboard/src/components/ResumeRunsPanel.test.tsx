/**
 * The Resume panel's contract: it lists OPEN turns by their own id, Continue
 * loads exactly the row the user clicked INTO THE CHAT (never a detached run),
 * Done/Clear all forget the snapshots, and "all until done" stays explicit.
 * It must render NOTHING for an empty store or an older server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import ResumeRunsPanel from './ResumeRunsPanel';
import { dashboardAPI } from '../api';
import type { ResumableRun } from '../types';

const RUNS: ResumableRun[] = [
  {
    id: 'cp-1',
    goal: 'build the checkout flow',
    cwd: '/tmp/shop',
    savedAt: Date.now() - 5 * 60_000,
    steps: 12,
    mutatedPaths: 3,
    preview: 'build the checkout flow',
  },
];

const TWO: ResumableRun[] = [
  RUNS[0],
  {
    id: 'cp-2',
    goal: 'fix the range off-by-one',
    cwd: '/tmp/shop',
    savedAt: Date.now() - 32 * 24 * 60 * 60_000,
    steps: 1,
    mutatedPaths: 0,
    preview: 'fix the range off-by-one',
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ResumeRunsPanel', () => {
  it('continues the ONE row clicked IN CHAT, never as a detached run', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(RUNS);
    const start = vi.spyOn(dashboardAPI, 'startResume').mockResolvedValue({ ok: true, pid: 4242 });
    const onContinue = vi.fn().mockResolvedValue(undefined);

    render(<ResumeRunsPanel onContinue={onContinue} />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(1\)/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Continue build the checkout flow'));

    // The stored row — id, goal and the folder it was working in — is what the
    // page continues. A background process would leave the chat empty, which is
    // the failure this asserts against.
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith(RUNS[0]));
    expect(start).not.toHaveBeenCalled();
  });

  it('clears ONE row when the user marks it done', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns')
      .mockResolvedValueOnce(RUNS)
      .mockResolvedValue([]);
    const clear = vi.spyOn(dashboardAPI, 'clearContinuity').mockResolvedValue({ ok: true, removed: 1 });

    render(<ResumeRunsPanel onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(1\)/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Mark build the checkout flow as done'));

    await waitFor(() => expect(clear).toHaveBeenCalledWith('session', 'cp-1'));
    // The row is gone once the store no longer lists it.
    await waitFor(() => expect(screen.queryByText(/Unfinished work/)).toBeNull());
  });

  it('clears EVERY listed row through Clear all', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns')
      .mockResolvedValueOnce(TWO)
      .mockResolvedValue([]);
    const clear = vi.spyOn(dashboardAPI, 'clearContinuity').mockResolvedValue({ ok: true, removed: 1 });

    render(<ResumeRunsPanel onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(2\)/)).toBeTruthy());

    fireEvent.click(screen.getByText(/Clear all/));

    await waitFor(() => expect(clear).toHaveBeenCalledWith('session', 'cp-1'));
    expect(clear).toHaveBeenCalledWith('session', 'cp-2');
    await waitFor(() => expect(screen.queryByText(/Unfinished work/)).toBeNull());
  });

  it('continues ALL open turns only through the explicit button, with the deadline', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(RUNS);
    const start = vi.spyOn(dashboardAPI, 'startResume').mockResolvedValue({ ok: true, pid: 1 });

    render(<ResumeRunsPanel onContinue={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(1\)/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Deadline in hours'), { target: { value: '8' } });
    fireEvent.click(screen.getByText(/Continue all until done/));

    await waitFor(() => expect(start).toHaveBeenCalledWith({ all: true, deadlineMinutes: 480 }));
  });

  it('renders nothing when there is no unfinished work', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue([]);
    const { container } = render(<ResumeRunsPanel onContinue={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing when the server has no resume endpoint', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(null);
    const { container } = render(<ResumeRunsPanel onContinue={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
