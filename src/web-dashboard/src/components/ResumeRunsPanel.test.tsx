/**
 * The Resume panel's contract: it lists OPEN turns by their own id, continues
 * exactly the row the user clicked, and offers "all until done" only explicitly.
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ResumeRunsPanel', () => {
  it('lists unfinished runs and continues the ONE whose id was clicked', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(RUNS);
    const start = vi.spyOn(dashboardAPI, 'startResume').mockResolvedValue({
      ok: true,
      pid: 4242,
      log: '/tmp/resume.log',
    });

    render(<ResumeRunsPanel />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(1\)/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Continue build the checkout flow'));
    // The stored id travels with the request — the server never picks a turn by
    // "most recent" when the user clicked a specific one.
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ id: 'cp-1', deadlineMinutes: 24 * 60 }),
    );
  });

  it('continues ALL open turns only through the explicit button, with the deadline', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(RUNS);
    const start = vi.spyOn(dashboardAPI, 'startResume').mockResolvedValue({ ok: true, pid: 1 });

    render(<ResumeRunsPanel />);
    await waitFor(() => expect(screen.getByText(/Unfinished work \(1\)/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Deadline in hours'), { target: { value: '8' } });
    fireEvent.click(screen.getByText(/Continue all until done/));

    await waitFor(() => expect(start).toHaveBeenCalledWith({ all: true, deadlineMinutes: 480 }));
  });

  it('renders nothing when there is no unfinished work', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue([]);
    const { container } = render(<ResumeRunsPanel />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing when the server has no resume endpoint', async () => {
    vi.spyOn(dashboardAPI, 'fetchResumableRuns').mockResolvedValue(null);
    const { container } = render(<ResumeRunsPanel />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
