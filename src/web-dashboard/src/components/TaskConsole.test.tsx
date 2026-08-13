/**
 * P2/P3 — TaskConsole tests (the shared CLI-run console).
 *
 * Used by the Evals tab and the Gateway ops tab: preset buttons + a custom
 * command input start the REAL CLI through the mocked task API, and the live
 * SSE console (subscribeTask) streams output with cancel. The console is the
 * shared surface, so its mechanics are tested here once.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TaskConsole, { type TaskPreset } from './TaskConsole';
import { dashboardAPI, setAdminToken } from '../api';
import type { TaskRecord } from '../types';

const PRESETS: TaskPreset[] = [
  { label: '🌐 Gateway status', args: ['gateway', 'status'] },
  { label: '▶️ Start gateway (foreground)', args: ['gateway', 'start', '--no-events'] },
];

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

describe('TaskConsole', () => {
  it('gates running behind admin/operator roles', async () => {
    mockAuthed(false);
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" />);
    await waitFor(() => expect(screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());

    mockAuthed(true, 'viewer');
    cleanup();
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" />);
    await waitFor(() => expect(screen.getByText(/view but not run/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Gateway status/ })).toBeNull();
  });

  it('a preset button starts its args with the timeout', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" timeoutMs={123456} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Gateway status/ }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['gateway', 'status'], 123456));
  });

  it('the custom input splits the command line into args', async () => {
    mockAuthed();
    mockRunApi();
    const start = vi.mocked(dashboardAPI.startTask);
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" />);
    await waitFor(() => expect(screen.getByPlaceholderText('run something')).toBeTruthy());
    const input = screen.getByPlaceholderText('run something');
    fireEvent.change(input, { target: { value: 'admin cron run nightly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(['admin', 'cron', 'run', 'nightly'], 300_000));
  });

  it('streams the live console, offers cancel, and stops on completion', async () => {
    mockAuthed();
    mockRunApi();
    let onLog: ((l: { stream: string; text: string }) => void) | null = null;
    let onStatus: ((s: string) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeTask').mockImplementation((_id, handlers) => {
      onLog = handlers.onLog;
      onStatus = handlers.onStatus;
      return vi.fn();
    });
    vi.spyOn(dashboardAPI, 'getTask').mockResolvedValue({
      status: 200,
      task: { ...TASK, logs: [{ stream: 'stdout', text: 'gateway: channels loaded', at: Date.now() }] },
    });
    const cancel = vi.spyOn(dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Gateway status/ }));
    await waitFor(() => expect(screen.getByText('gateway: channels loaded')).toBeTruthy());

    // Live line streams in while running.
    onLog!({ stream: 'stdout', text: 'telegram: connected' });
    await waitFor(() => expect(screen.getByText('telegram: connected')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('task-1'));

    // Completion turns the console to done and drops the cancel button.
    onStatus!('done');
    await waitFor(() => expect(screen.getByText(/done/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  it('surfaces a start failure instead of streaming', async () => {
    mockAuthed();
    vi.spyOn(dashboardAPI, 'startTask').mockResolvedValue({ ok: false, error: 'CLI not found' });
    render(<TaskConsole presets={PRESETS} customPlaceholder="run something" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Gateway status/ }));
    await waitFor(() => expect(screen.getByText(/CLI not found/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });
});
