/**
 * P2 — EvalsPage tests (eval runner in the GUI).
 *
 * The page mounts the shared TaskConsole with the `buff eval run` presets and
 * renders past runs from the dashboard data feed. Page-specific behavior is
 * covered here; the console's run/stream/cancel mechanics live in
 * TaskConsole.test.tsx.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import EvalsPage from './EvalsPage';
import { dashboardAPI, setAdminToken } from '../api';
import type { DashboardData, TaskRecord } from '../types';

const DATA: DashboardData = {
  evals: {
    totalRuns: 2,
    latest: null,
    runs: [
      {
        id: 'r1',
        provider: 'groq',
        model: 'llama-3.3-70b',
        startedAt: 1700000000000,
        summary: {
          totalTasks: 4, tasksPassed: 3, completionRate: 0.75, testPassRate: 0.8,
          avgTimeToFixMs: 1000, avgEditAccuracy: 0.9, avgTokenEfficiency: 0.5,
          totalRollbacks: 1, dependencyInstallRate: 1, recoveryRate: 0.9,
          avgCompositeScore: 0.72, totalCostUsd: 0.012,
        },
      },
    ],
  },
  serverTime: 1,
} as unknown as DashboardData;

const TASK: TaskRecord = {
  id: 'task-1',
  command: 'eval run --tasks quick --format text',
  args: ['eval', 'run', '--tasks', 'quick', '--format', 'text'],
  cwd: '/tmp',
  status: 'running',
  exitCode: null,
  startedAt: Date.now(),
  finishedAt: null,
  durationMs: null,
  timeoutMs: 900000,
  logs: [],
};

function mockAuthed(authenticated = true, role = 'admin') {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated,
    user: authenticated ? 'admin' : null,
    role: authenticated ? role : null,
  });
}

function mockRunApi() {
  vi.spyOn(dashboardAPI, 'startTask').mockResolvedValue({ ok: true, task: TASK });
  vi.spyOn(dashboardAPI, 'getTask').mockResolvedValue({ status: 200, task: TASK });
  vi.spyOn(dashboardAPI, 'subscribeTask').mockReturnValue(() => {});
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('EvalsPage', () => {
  it('gates running behind the admin session', async () => {
    mockAuthed(false);
    render(<EvalsPage data={DATA} />);
    await waitFor(() => expect(screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Quick smoke/ })).toBeNull();
  });

  it('renders past runs from the data feed', async () => {
    mockAuthed();
    render(<EvalsPage data={DATA} />);
    await waitFor(() => expect(screen.getByText('groq')).toBeTruthy());
    expect(screen.getByText('llama-3.3-70b')).toBeTruthy();
    expect(screen.getByText('3/4')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
  });

  it('a preset button starts the right eval task with the eval timeout', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<EvalsPage data={DATA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Quick smoke/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Quick smoke/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['eval', 'run', '--tasks', 'quick', '--format', 'text'], 900_000));
  });

  it('the custom input runs a full eval command line', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<EvalsPage data={DATA} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/eval run/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/eval run/), { target: { value: 'eval run --tasks my-task --format text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['eval', 'run', '--tasks', 'my-task', '--format', 'text'], 900_000));
  });

  it('streams the live console and offers cancel while running', async () => {
    mockAuthed();
    mockRunApi();
    vi.spyOn(dashboardAPI, 'getTask').mockResolvedValue({
      status: 200,
      task: { ...TASK, logs: [{ stream: 'stdout', text: 'task 1/4 started', at: Date.now() }] },
    });
    const cancel = vi.spyOn(dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
    render(<EvalsPage data={DATA} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Quick smoke/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Quick smoke/ }));
    await waitFor(() => expect(screen.getByText('task 1/4 started')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('task-1'));
  });
});
