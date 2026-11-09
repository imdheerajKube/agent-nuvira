/**
 * CommandPolicyPage — the dashboard face of the user-owned command policy.
 *
 * Pins the two promises the page makes: what is in the file is shown (all three
 * lists, the floor, the path), and Save sends the edited lists as arrays —
 * one prefix per line, blanks dropped — to the same endpoint the CLI writes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { dashboardAPI } from '../api';
import CommandPolicyPage from './CommandPolicyPage';
import type { CommandPolicyView } from '../types';

function view(overrides: Partial<CommandPolicyView> = {}): CommandPolicyView {
  return {
    ok: true,
    file: '/home/u/.nuvira/command-policy.json',
    exists: true,
    writable: true,
    policy: { allow: ['kill'], approve: ['git push'], deny: [] },
    builtIn: [{ rule: 'privilege escalation', example: 'sudo ls' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated: true,
    role: 'admin',
    user: 'd',
    mustChangePassword: false,
  });
});

afterEach(() => vi.restoreAllMocks());

describe('CommandPolicyPage', () => {
  it('shows the file, the three lists and the built-in floor', async () => {
    vi.spyOn(dashboardAPI, 'fetchCommandPolicy').mockResolvedValue(view());
    render(<CommandPolicyPage />);

    await waitFor(() => expect(screen.getByDisplayValue('kill')).toBeTruthy());
    expect(screen.getByDisplayValue('git push')).toBeTruthy();
    expect(screen.getByText('/home/u/.nuvira/command-policy.json')).toBeTruthy();
    expect(screen.getByText('sudo ls')).toBeTruthy();
  });

  it('saves one prefix per line as arrays', async () => {
    vi.spyOn(dashboardAPI, 'fetchCommandPolicy').mockResolvedValue(view());
    const save = vi.spyOn(dashboardAPI, 'saveCommandPolicy').mockResolvedValue(
      view({ policy: { allow: ['kill'], approve: ['git push'], deny: ['rm -rf build', 'rm -rf /'] } }),
    );
    render(<CommandPolicyPage />);

    const deny = await screen.findByLabelText('Deny — never run — one command prefix per line');
    fireEvent.change(deny, { target: { value: 'rm -rf build\n\n  rm -rf /  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toEqual({
      allow: ['kill'],
      approve: ['git push'],
      deny: ['rm -rf build', 'rm -rf /'],
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/next command/i));
  });

  it('renders read-only when the role cannot write', async () => {
    vi.spyOn(dashboardAPI, 'fetchCommandPolicy').mockResolvedValue(view({ writable: false }));
    render(<CommandPolicyPage />);

    await waitFor(() => expect(screen.getByDisplayValue('kill')).toBeTruthy());
    expect((screen.getByRole('button', { name: /save policy/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/requires an admin session/i)).toBeTruthy();
  });
});
