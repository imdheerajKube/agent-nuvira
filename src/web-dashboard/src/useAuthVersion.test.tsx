/**
 * useAuthVersion — the shell's sign-in must refresh every open page.
 *
 * The defect: the login control lives in the shell, but a page that gates on the
 * session (Chat most visibly) read `/api/admin/auth-status` once on mount and held
 * that answer in local state. Signing in from the top bar updated the top bar and
 * nothing else, so an already-open Chat page kept showing its signed-out message
 * until a manual reload. This pins the fix: a token change notifies subscribers,
 * and a page wired to `useAuthVersion()` re-reads.
 */

// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

import { dashboardAPI, setAdminToken, getAuthVersion, subscribeAuthVersion } from './api';
import { useAuthVersion } from './useAuthVersion';

/** A minimal page that re-reads auth-status exactly like ChatPage does. */
function AuthGatedPage() {
  const authVersion = useAuthVersion();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => setAuthed(s?.authenticated === true));
  }, [authVersion]);

  return <p>{authed ? 'signed in' : 'signed out'}</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('useAuthVersion', () => {
  it('bumps the version and notifies subscribers when the token changes', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAuthVersion((v) => seen.push(v));
    const before = getAuthVersion();

    setAdminToken('tok-1');
    setAdminToken(null);

    unsubscribe();
    setAdminToken('tok-2'); // after unsubscribe — must not be recorded

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(before + 1);
    expect(seen[1]).toBe(before + 2);
  });

  it('re-reads the session after a login made elsewhere in the app', async () => {
    // Start signed out.
    const spy = vi
      .spyOn(dashboardAPI, 'fetchAdminAuthStatus')
      .mockResolvedValue({ configured: true, authenticated: false, user: null, role: null });

    render(<AuthGatedPage />);
    await waitFor(() => expect(screen.getByText('signed out')).toBeTruthy());

    // The top bar signs in — the page did not cause this and has no prop for it.
    spy.mockResolvedValue({ configured: true, authenticated: true, user: 'dheeraj', role: 'admin' });
    // The token change is what a login elsewhere in the app triggers; wrap it so
    // React flushes the resulting state update like it would in the browser.
    await act(async () => {
      setAdminToken('tok-signed-in');
    });

    await waitFor(() => expect(screen.getByText('signed in')).toBeTruthy());
  });
});