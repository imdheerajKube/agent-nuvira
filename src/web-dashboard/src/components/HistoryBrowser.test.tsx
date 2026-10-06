/**
 * HistoryBrowser — now reachable at `/history`.
 *
 * Like MemoryPanel, this was built and never routed: the server has always
 * computed `readHistoryData()` (recent sessions with provider, model, message
 * count and tags) and no page displayed it, so the user could not see what the
 * agent had done in past sessions even though the record existed on disk.
 *
 * These tests pin the panel so the new `/history` route keeps working.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { dashboardAPI } from '../api';
import HistoryBrowser from './HistoryBrowser';
import type { DashboardData } from '../types';

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

function makeData(overrides: Partial<DashboardData['history']> = {}): DashboardData {
  return {
    history: {
      total: 42,
      recent: [
        {
          id: 's1',
          summary: 'Fix the slugify whitespace bug',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          messageCount: 12,
          tags: ['coding', 'bugfix'],
          startedAt: Date.UTC(2026, 8, 18, 10, 30),
        },
      ],
      ...overrides,
    },
  } as unknown as DashboardData;
}

describe('HistoryBrowser', () => {
  it('shows a loading state before data arrives', () => {
    render(<HistoryBrowser data={null} />);
    expect(screen.getByText(/loading history/i)).toBeTruthy();
  });

  it('lists past sessions with the metadata needed to recognise them', () => {
    render(<HistoryBrowser data={makeData()} />);

    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('Fix the slugify whitespace bug')).toBeTruthy();
    expect(screen.getByText(/12 msgs/)).toBeTruthy();
    expect(screen.getByText(/gemini/)).toBeTruthy();
    // Tags make a session findable by topic.
    expect(screen.getByText('coding')).toBeTruthy();
    expect(screen.getByText('bugfix')).toBeTruthy();
  });

  it('falls back to a placeholder for an untitled session', () => {
    render(<HistoryBrowser data={makeData({ recent: [{ ...makeData().history.recent[0], summary: '' }] })} />);
    expect(screen.getByText('Untitled')).toBeTruthy();
  });

  it('renders an empty state rather than a blank panel', () => {
    render(<HistoryBrowser data={makeData({ total: 0, recent: [] })} />);
    expect(screen.getByText(/no conversations recorded yet/i)).toBeTruthy();
  });

  // ── Cleanup (the page used to be read-only) ──────────────────────────────

  it('deletes ONE conversation by id and re-reads the list', async () => {
    const clear = vi.spyOn(dashboardAPI, 'clearHistory').mockResolvedValue({ ok: true, removed: 1 });
    vi.spyOn(dashboardAPI, 'fetchHistory').mockResolvedValue({ total: 41, recent: [] } as never);
    render(<HistoryBrowser data={makeData()} />);

    fireEvent.click(screen.getByLabelText('Forget conversation Fix the slugify whitespace bug'));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('session', { id: 's1' }));
    // The re-read wins over the streamed props, so the panel cannot claim a
    // deletion that the server refused.
    await waitFor(() => expect(screen.getByText('41')).toBeTruthy());
  });

  it('sweeps only conversations older than a week', async () => {
    const clear = vi.spyOn(dashboardAPI, 'clearHistory').mockResolvedValue({ ok: true, removed: 3 });
    vi.spyOn(dashboardAPI, 'fetchHistory').mockResolvedValue({ total: 39, recent: [] } as never);
    render(<HistoryBrowser data={makeData()} />);

    fireEvent.click(screen.getByText(/Forget older than a week/));
    await waitFor(() =>
      expect(clear).toHaveBeenCalledWith('older', { olderThanMs: 7 * 24 * 60 * 60 * 1000 }),
    );
  });

  it('clears all history only after the confirm is accepted', async () => {
    const clear = vi.spyOn(dashboardAPI, 'clearHistory').mockResolvedValue({ ok: true, removed: 42 });
    vi.spyOn(dashboardAPI, 'fetchHistory').mockResolvedValue({ total: 0, recent: [] } as never);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<HistoryBrowser data={makeData()} />);

    fireEvent.click(screen.getByText(/Clear all history/));
    expect(clear).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText(/Clear all history/));
    await waitFor(() => expect(clear).toHaveBeenCalledWith('all', {}));
  });

  it('reports a refusal instead of pretending the delete worked', async () => {
    vi.spyOn(dashboardAPI, 'clearHistory').mockResolvedValue({ ok: false, error: 'Access denied.' });
    render(<HistoryBrowser data={makeData()} />);

    fireEvent.click(screen.getByLabelText('Forget conversation Fix the slugify whitespace bug'));
    await waitFor(() => expect(screen.getByText(/Access denied\./)).toBeTruthy());
  });
});
