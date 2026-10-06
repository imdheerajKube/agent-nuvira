/**
 * ContinuitySection — the view of what "on by default" stores on disk, plus the
 * ability to forget it. Tests the two things that matter: the data is SHOWN
 * (open vs closed sessions, recall entries, effective switch state), and each
 * Forget control calls the right clear target.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { dashboardAPI } from '../api';
import ContinuitySection from './ContinuitySection';
import type { ContinuityData } from '../types';

function makeData(overrides: Partial<ContinuityData> = {}): ContinuityData {
  return {
    sessions: [
      {
        id: 'cp-1',
        goal: 'fix the hotkey',
        cwd: '/home/u/proj',
        savedAt: Date.now() - 60_000,
        open: true,
        steps: 3,
        successfulTools: 2,
        mutatedPaths: ['a.ts'],
        messages: 5,
      },
      {
        id: 'cp-2',
        goal: 'write the readme',
        cwd: '/home/u/proj',
        savedAt: Date.now() - 3_600_000,
        open: false,
        steps: 1,
        successfulTools: 1,
        mutatedPaths: [],
        messages: 3,
      },
    ],
    recall: [{ id: 'r-1', projectPath: '/home/u/proj', goal: 'plan a trip', outcome: 'acted', savedAt: Date.now() }],
    toggles: { sessionStore: true, sessionRecall: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContinuitySection', () => {
  it('shows stored sessions (open vs closed), recall entries, and switch state', async () => {
    vi.spyOn(dashboardAPI, 'fetchContinuity').mockResolvedValue(makeData());
    render(<ContinuitySection />);

    await waitFor(() => expect(screen.getByText(/Stored sessions \(2\)/)).toBeTruthy());
    expect(screen.getByText(/↩️ OPEN · fix the hotkey/)).toBeTruthy();
    expect(screen.getByText(/✓ closed · write the readme/)).toBeTruthy();
    expect(screen.getByText(/Recalled past asks \(1\)/)).toBeTruthy();
    // Effective switch state: store ON, recall OFF.
    expect(screen.getByText('ON')).toBeTruthy();
    expect(screen.getByText('OFF')).toBeTruthy();
  });

  it('forgets ONE session by id', async () => {
    vi.spyOn(dashboardAPI, 'fetchContinuity').mockResolvedValue(makeData());
    const clear = vi.spyOn(dashboardAPI, 'clearContinuity').mockResolvedValue({ ok: true, removed: 1 });
    render(<ContinuitySection />);

    await waitFor(() => expect(screen.getByText(/Stored sessions \(2\)/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Forget session fix the hotkey'));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('session', 'cp-1', undefined));
  });

  it('forgets all sessions', async () => {
    vi.spyOn(dashboardAPI, 'fetchContinuity').mockResolvedValue(makeData());
    const clear = vi.spyOn(dashboardAPI, 'clearContinuity').mockResolvedValue({ ok: true, removed: 2 });
    render(<ContinuitySection />);

    await waitFor(() => expect(screen.getByText(/Stored sessions \(2\)/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Forget all sessions/));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('sessions', undefined, undefined));
  });

  it('forgets only entries older than a week (time-based bulk)', async () => {
    vi.spyOn(dashboardAPI, 'fetchContinuity').mockResolvedValue(makeData());
    const clear = vi.spyOn(dashboardAPI, 'clearContinuity').mockResolvedValue({ ok: true, removed: 1 });
    render(<ContinuitySection />);

    await waitFor(() => expect(screen.getByText(/Stored sessions \(2\)/)).toBeTruthy());
    // The first "Forget older than a week" is the sessions one; the store grows
    // on every run, so per-line forgetting is the wrong tool for cleanup.
    fireEvent.click(screen.getAllByText(/Forget older than a week/)[0]);
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith('sessions', undefined, 7 * 24 * 60 * 60 * 1000),
    );
  });

  it('says so quietly when the server has no continuity endpoint', async () => {
    vi.spyOn(dashboardAPI, 'fetchContinuity').mockResolvedValue(null);
    render(<ContinuitySection />);
    await waitFor(() => expect(screen.getByText(/unavailable/)).toBeTruthy());
  });
});
