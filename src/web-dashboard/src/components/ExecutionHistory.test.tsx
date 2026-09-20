/**
 * ExecutionHistory — now reachable at `/executions`.
 *
 * This component was fully built but had no route AND no backend: it takes
 * `onFetch`/`onClear`/`onExport` props and no endpoint existed, so skill runs
 * left no inspectable record in the dashboard. Its natural backend,
 * `src/skills/execution-audit.ts`, was also complete and referenced nowhere —
 * and was not even being WRITTEN to. That pair was a missing capability
 * (skill-execution observability), not a missing wire.
 *
 * The full chain now exists: `runSkillExecute` logs every execution →
 * `/api/executions` serves it → this panel renders it.
 *
 * These tests pin the component contract so the wiring cannot silently regress.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ExecutionHistory, type ExecutionEntry } from './ExecutionHistory';

function makeEntry(overrides: Partial<ExecutionEntry> = {}): ExecutionEntry {
  return {
    id: 'exec-1',
    skillName: 'deploy-check',
    skillSource: 'local',
    runtime: 'node',
    status: 'success',
    timestamp: 1_760_000_000_000,
    sessionId: 'sess-1',
    durationMs: 120,
    exitCode: 0,
    ...overrides,
  };
}

describe('ExecutionHistory', () => {
  it('fetches on mount — the wiring this panel was missing', async () => {
    const onFetch = vi.fn().mockResolvedValue([makeEntry()]);

    render(<ExecutionHistory onFetch={onFetch} />);

    await waitFor(() => expect(onFetch).toHaveBeenCalledTimes(1));
    // The panel asks for a bounded, newest-first page rather than the whole log.
    expect(onFetch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, skillName: undefined, status: undefined }),
    );
  });

  it('renders a logged execution, including its skill name and runtime', async () => {
    const onFetch = vi.fn().mockResolvedValue([makeEntry({ skillName: 'lint-all', runtime: 'shell' })]);

    render(<ExecutionHistory onFetch={onFetch} />);

    expect(await screen.findByText('lint-all')).toBeTruthy();
    expect(screen.getByText(/shell/i)).toBeTruthy();
  });

  it('derives per-page stats (total / success / failure / avg duration)', async () => {
    const onFetch = vi.fn().mockResolvedValue([
      makeEntry({ id: 'a', status: 'success', durationMs: 100 }),
      makeEntry({ id: 'b', status: 'success', durationMs: 200 }),
      makeEntry({ id: 'c', status: 'failure', durationMs: 300 }),
    ]);

    render(<ExecutionHistory onFetch={onFetch} />);

    // total = 3, successes = 2, avg = (100+200+300)/3 = 200ms
    expect(await screen.findByText('3')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    // Scoped by LABEL: an individual entry also renders a "200ms" duration,
    // and Total/Success/Failed are separate tiles, so a bare text query is
    // ambiguous. Read the tile whose label says "Avg Duration".
    const avgTile = [...document.querySelectorAll('.stat-item')].find(
      (item) => item.querySelector('.stat-label')?.textContent === 'Avg Duration',
    );
    expect(avgTile?.querySelector('.stat-value')?.textContent).toBe('200ms');
  });

  it('survives a failing fetch instead of blanking the panel', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onFetch = vi.fn().mockRejectedValue(new Error('dashboard offline'));

    render(<ExecutionHistory onFetch={onFetch} />);

    await waitFor(() => expect(onFetch).toHaveBeenCalled());
    // A backend error is reported, not thrown into the render tree.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('treats an empty audit trail as a valid state, not an error', async () => {
    const onFetch = vi.fn().mockResolvedValue([]);

    render(<ExecutionHistory onFetch={onFetch} />);

    await waitFor(() => expect(onFetch).toHaveBeenCalled());
    expect(screen.queryByText(/deploy-check/)).toBeNull();
  });

  it('does not require the optional export/clear callbacks to render', async () => {
    // Read-only wiring (onFetch only) must be a complete, usable panel — the
    // guards inside the component are what make that true.
    const onFetch = vi.fn().mockResolvedValue([]);
    expect(() => render(<ExecutionHistory onFetch={onFetch} />)).not.toThrow();
    // Settle the mount fetch so the state update lands inside act().
    await waitFor(() => expect(onFetch).toHaveBeenCalled());
  });
});
