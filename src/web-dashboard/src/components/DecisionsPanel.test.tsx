/**
 * DecisionsPanel — the dashboard view of the project's must-ask decisions, and
 * the one write it offers (revise). Tests that the record is SHOWN, that the
 * search calls the server's read-back, and that revising sends the right call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { dashboardAPI } from '../api';
import DecisionsPanel from './DecisionsPanel';
import type { DecisionsData, DecisionRecord } from '../types';

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'dec-1',
    at: Date.now() - 60_000,
    question: 'Which database should the service use?',
    answer: 'SQLite',
    choices: ['Postgres', 'SQLite'],
    source: 'ask_user',
    status: 'decided',
    ...overrides,
  };
}

function makeData(overrides: Partial<DecisionsData> = {}): DecisionsData {
  return {
    ok: true,
    dir: '/home/u/proj',
    relevant: false,
    decisions: [record(), record({ id: 'dec-2', question: 'Which port?', answer: '3000', choices: undefined })],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(dashboardAPI, 'listProjects').mockResolvedValue([
    { path: '/home/u/proj', name: 'proj', kind: 'cwd' },
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DecisionsPanel', () => {
  it('shows the recorded decisions for the workspace', async () => {
    vi.spyOn(dashboardAPI, 'fetchDecisions').mockResolvedValue(makeData());
    render(<DecisionsPanel />);

    await waitFor(() => expect(screen.getByText(/Recorded decisions \(2\)/)).toBeTruthy());
    expect(screen.getByText(/Which database should the service use\?/)).toBeTruthy();
    expect(screen.getAllByText(/→ SQLite/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Which port\?/)).toBeTruthy();
  });

  it('says so honestly when there is no decision yet', async () => {
    vi.spyOn(dashboardAPI, 'fetchDecisions').mockResolvedValue(makeData({ decisions: [] }));
    render(<DecisionsPanel />);

    await waitFor(() => expect(screen.getByText(/None yet/)).toBeTruthy());
  });

  it('searches for decisions relevant to an ask (the server read-back)', async () => {
    const fetchDecisions = vi
      .spyOn(dashboardAPI, 'fetchDecisions')
      .mockResolvedValue(makeData());
    render(<DecisionsPanel />);
    await waitFor(() => expect(screen.getByText(/Recorded decisions \(2\)/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Search decisions relevant to an ask'), {
      target: { value: 'migrate the service database' },
    });
    fireEvent.click(screen.getByText(/🔎 Search/));

    await waitFor(() =>
      expect(fetchDecisions).toHaveBeenCalledWith('/home/u/proj', 'migrate the service database'),
    );
  });

  it('revises a decision and keeps the previous answer’s history on the server', async () => {
    vi.spyOn(dashboardAPI, 'fetchDecisions').mockResolvedValue(makeData());
    const revise = vi
      .spyOn(dashboardAPI, 'reviseDecision')
      .mockResolvedValue(record({ answer: 'Postgres', status: 'revised', revisions: [{ at: Date.now(), answer: 'Postgres' }] }));
    render(<DecisionsPanel />);
    await waitFor(() => expect(screen.getByText(/Recorded decisions \(2\)/)).toBeTruthy());

    fireEvent.click(screen.getAllByText(/✏️ Revise/)[0]);
    const input = screen.getByLabelText('New answer for Which database should the service use?');
    fireEvent.change(input, { target: { value: 'Postgres' } });
    fireEvent.click(screen.getByText(/💾 Save/));

    await waitFor(() => expect(revise).toHaveBeenCalledWith('/home/u/proj', 'dec-1', 'Postgres', undefined));
    await waitFor(() => expect(screen.getByText(/Revised dec-1/)).toBeTruthy());
  });
});
