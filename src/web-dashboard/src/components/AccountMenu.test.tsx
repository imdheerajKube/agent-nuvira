/**
 * AccountMenu — the top-right sign-in control in the shell.
 *
 * The shell had no account affordance at all: the login form lived inside
 * whichever page gated a write, and a signed-in operator had nowhere to see who
 * they were signed in as. These tests pin the three states the control exists
 * for — signed out (login), signed out on first run (setup), and signed in (the
 * account name + role with a log out).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import AccountMenu from './AccountMenu';
import { dashboardAPI } from '../api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SIGNED_OUT = { configured: true, authenticated: false, user: null, role: null } as const;

describe('AccountMenu', () => {
  it('signs in from the top bar and then shows the account + role', async () => {
    let status: typeof SIGNED_OUT | { configured: true; authenticated: true; user: string; role: string } = SIGNED_OUT;
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockImplementation(async () => ({ ...status }));
    const login = vi.spyOn(dashboardAPI, 'adminLogin').mockResolvedValue({ ok: true, user: 'dheeraj', role: 'admin', token: 't' });

    render(<AccountMenu />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'dheeraj' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'hunter2hunter2' } });
    status = { configured: true, authenticated: true, user: 'dheeraj', role: 'admin' };
    // The form's submit, not the trigger (both read "Sign in").
    fireEvent.click(screen.getByRole('button', { name: /🔐 Sign in/ }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('dheeraj', 'hunter2hunter2'));
    // The trigger now names the signed-in account and the role.
    await waitFor(() => expect(screen.getByRole('button', { name: /dheeraj · admin/ })).toBeTruthy());
  });

  it('offers the first-run setup when no admin exists yet', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null, role: null });
    const setup = vi.spyOn(dashboardAPI, 'adminSetup').mockResolvedValue({ ok: true, user: 'admin', role: 'admin', token: 't' });

    render(<AccountMenu />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));

    expect(screen.getByText(/Create the first admin/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'supersecret1' } });
    fireEvent.click(screen.getByRole('button', { name: /Create admin/ }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith('admin', 'supersecret1'));
  });

  it('reports a failed login instead of silently staying signed out', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ ...SIGNED_OUT });
    vi.spyOn(dashboardAPI, 'adminLogin').mockResolvedValue({ ok: false, error: 'Invalid user or password.' });

    render(<AccountMenu />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'nobody' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrongwrong' } });
    fireEvent.click(screen.getByRole('button', { name: /🔐 Sign in/ }));

    await waitFor(() => expect(screen.getByText('Invalid user or password.')).toBeTruthy());
  });

  it('logs out from the top bar', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'dheeraj', role: 'admin' });
    const logout = vi.spyOn(dashboardAPI, 'adminLogout').mockResolvedValue();

    render(<AccountMenu />);
    await waitFor(() => expect(screen.getByRole('button', { name: /dheeraj · admin/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /dheeraj · admin/ }));
    fireEvent.click(screen.getByRole('button', { name: /Log out/ }));

    await waitFor(() => expect(logout).toHaveBeenCalled());
  });
});
