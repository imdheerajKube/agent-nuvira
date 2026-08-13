/**
 * P2/P3 — GatewayPage tests (gateway ops in the GUI).
 *
 * The page mounts the shared TaskConsole with `buff gateway` presets. Its own
 * surface is thin (page title + presets); the console mechanics live in
 * TaskConsole.test.tsx.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import GatewayPage from './GatewayPage';
import { dashboardAPI, setAdminToken } from '../api';
import type { TaskRecord } from '../types';

const TASK: TaskRecord = {
  id: 'task-1',
  command: 'gateway status',
  args: ['gateway', 'status'],
  cwd: '/tmp',
  status: 'running',
  exitCode: null,
  startedAt: Date.now(),
  finishedAt: null,
  durationMs: null,
  timeoutMs: 300000,
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

describe('GatewayPage', () => {
  it('gates ops behind the admin session', async () => {
    mockAuthed(false);
    render(<GatewayPage />);
    await waitFor(() => expect(screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Gateway status/ })).toBeNull();
  });

  it('preset buttons run the real gateway CLI commands', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<GatewayPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Gateway status/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['gateway', 'status'], 300_000));
  });

  it('the custom input runs an arbitrary gateway/admin command', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<GatewayPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/admin cron run/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/admin cron run/), { target: { value: 'admin cron run nightly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['admin', 'cron', 'run', 'nightly'], 300_000));
  });
});
