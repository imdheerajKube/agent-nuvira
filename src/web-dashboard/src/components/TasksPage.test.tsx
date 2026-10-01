/**
 * TasksPage — command console tests (P1).
 *
 * - Unauthenticated users see the login gate (running commands is a write
 *   action, like the Agent Hub toggles).
 * - Authenticated users get the run form + history table.
 * - Typing a command and hitting Run calls startTask with the parsed argv and
 *   subscribes to the task's SSE stream.
 * - The Run button is disabled while the command is empty / while starting.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TasksPage from './TasksPage';
import { dashboardAPI, setAdminToken } from '../api';
import type { TaskRecord } from '../types';

const TASK: TaskRecord = {
  id: 't1',
  command: 'eval run --task smoke',
  args: ['eval', 'run', '--task', 'smoke'],
  cwd: '/workspace',
  status: 'done',
  exitCode: 0,
  startedAt: Date.now() - 5000,
  finishedAt: Date.now(),
  durationMs: 5000,
  timeoutMs: 300000,
  logs: [{ stream: 'stdout', text: 'hello from fixture', at: Date.now() }],
};

function mockAuthed(): void {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated: true,
    user: 'admin',
    role: 'admin',
  });
  vi.spyOn(dashboardAPI, 'listTasks').mockResolvedValue({ status: 200, tasks: [TASK] });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

function renderPage(): void {
  render(
    <MemoryRouter>
      <TasksPage />
    </MemoryRouter>,
  );
}

describe('TasksPage', () => {
  it('shows the login gate when unauthenticated', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
      configured: true,
      authenticated: false,
      user: null,
      role: null,
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/Log in to run tasks/)).toBeTruthy());
  });

  it('renders the run form and history when authed', async () => {
    mockAuthed();
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText(/eval run --task smoke-test/)).toBeTruthy());
    // History table row shows the finished task.
    await waitFor(() => expect(screen.getByText('eval run --task smoke')).toBeTruthy());
    expect(screen.getByText(/✅ done/)).toBeTruthy();
  });

  it('disables Run while the command is empty', async () => {
    mockAuthed();
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText(/eval run --task smoke-test/)).toBeTruthy());
    expect((screen.getByRole('button', { name: /▶ Run/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts a task from the typed command and subscribes to its stream', async () => {
    mockAuthed();
    const startMock = vi.spyOn(dashboardAPI, 'startTask').mockResolvedValue({
      ok: true,
      task: { ...TASK, id: 't2', command: 'memory stats', args: ['memory', 'stats'], status: 'running', logs: [] },
    });
    const subMock = vi.spyOn(dashboardAPI, 'subscribeTask').mockReturnValue(() => {});

    renderPage();
    const input = await screen.findByPlaceholderText(/eval run --task smoke-test/);
    fireEvent.change(input, { target: { value: 'memory stats' } });
    fireEvent.click(screen.getByRole('button', { name: /▶ Run/ }));

    await waitFor(() => expect(startMock).toHaveBeenCalledWith(['memory', 'stats'], 300000));
    await waitFor(() => expect(subMock).toHaveBeenCalledWith('t2', expect.any(Object)));
    // The console header shows the running command. Scoped to the console on
    // purpose: the command browser below the form also lists `memory stats`, so
    // a bare getByText matches two elements and would pass for the wrong reason
    // the moment either one is removed.
    await waitFor(() =>
      expect(document.querySelector('.task-console-cmd')?.textContent).toBe('memory stats'),
    );
  });

  it('fills the run box from a browsed command, ready to run', async () => {
    mockAuthed();
    renderPage();
    const input = await screen.findByPlaceholderText(/eval run --task smoke-test/);

    fireEvent.change(screen.getByLabelText(/filter commands/i), { target: { value: 'eval run' } });
    const row = [...document.querySelectorAll<HTMLButtonElement>('.command-use')].find(
      (candidate) => candidate.querySelector('.command-item-name')?.textContent === 'eval run',
    );
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLButtonElement);

    // A trailing space, so the next keystroke starts the ARGUMENT rather than
    // completing the command name.
    expect((input as HTMLInputElement).value).toBe('eval run ');
    // Focus follows the insert, so typing continues where the user is looking.
    expect(document.activeElement).toBe(input);
  });

  it('shows a friendly error when start fails', async () => {
    mockAuthed();
    vi.spyOn(dashboardAPI, 'startTask').mockResolvedValue({ ok: false, error: 'Missing command args.' });
    renderPage();
    const input = await screen.findByPlaceholderText(/eval run --task smoke-test/);
    fireEvent.change(input, { target: { value: 'eval run' } });
    fireEvent.click(screen.getByRole('button', { name: /▶ Run/ }));
    await waitFor(() => expect(screen.getByText(/Missing command args/)).toBeTruthy());
  });
});
