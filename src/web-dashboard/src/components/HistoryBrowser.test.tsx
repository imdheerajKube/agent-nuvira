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

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import HistoryBrowser from './HistoryBrowser';
import type { DashboardData } from '../types';

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
});
