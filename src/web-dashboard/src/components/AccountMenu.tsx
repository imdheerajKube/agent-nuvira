/**
 * AccountMenu — the top-right sign-in control in the dashboard shell.
 *
 * The write surface (providers, skills, permissions, service keys) has always
 * required a user id + password, but the ONLY way to reach the login form was to
 * navigate to a page that gated something and trigger its inline form — so a
 * signed-in operator had no way to see WHO they were signed in as, and nobody
 * could log out without hunting for a page with a "Log out" button.
 *
 * This puts the conventional top-right affordance where every other site has it:
 * a "Sign in" button when signed out (setup form on first run) and the account
 * name + role with a "Log out" item when signed in.
 *
 * It deliberately holds no policy of its own — it reads the same
 * `/api/admin/auth-status` the Admin panel does and calls the same login/setup/
 * logout routes, so it can never disagree with them about who is signed in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { AdminAuthStatus } from '../types';

export default function AccountMenu() {
  const [status, setStatus] = useState<AdminAuthStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => setStatus(s));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Close on an outside click or Escape — a menu that only closes by clicking
  // its own trigger reads as stuck.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const authed = status?.authenticated === true;
  const configured = status?.configured === true;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const r = configured
      ? await dashboardAPI.adminLogin(user, password)
      : await dashboardAPI.adminSetup(user, password);
    if (r.ok) {
      setUser('');
      setPassword('');
      setOpen(false);
      load();
    } else {
      setError(r.error || (configured ? 'Login failed.' : 'Setup failed.'));
    }
    setBusy(false);
  };

  const logout = async () => {
    setOpen(false);
    await dashboardAPI.adminLogout();
    load();
  };

  const label = !status
    ? '👤 Account'
    : authed
      ? `👤 ${status.user || 'account'}${status.role ? ` · ${status.role}` : ''}`
      : '👤 Sign in';

  return (
    <div className="topbar-account" ref={rootRef}>
      <button
        type="button"
        className="topbar-action"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open ? (
        <div className="topbar-account-menu" role="menu">
          {authed ? (
            <>
              <div className="topbar-account-user">
                <span>{status?.user || 'account'}</span>
                {status?.role ? (
                  <span className={`admin-role-badge admin-role-${status.role}`}>{status.role}</span>
                ) : null}
              </div>
              {status?.mustChangePassword ? (
                <p className="topbar-account-hint">
                  Still on the first-run password — change it on the Admin page before writes will work.
                </p>
              ) : null}
              <button type="button" className="topbar-account-item" onClick={() => void logout()}>
                🚪 Log out
              </button>
            </>
          ) : (
            <form className="topbar-account-form" onSubmit={submit}>
              <p className="topbar-account-title">
                {configured ? 'Sign in' : 'Create the first admin'}
              </p>
              <label>
                <span>Username</span>
                <input
                  type="text"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  autoComplete="username"
                  placeholder="admin"
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={configured ? 'current-password' : 'new-password'}
                  placeholder="••••••••"
                />
              </label>
              {error ? <div className="admin-error">{error}</div> : null}
              <button type="submit" className="admin-refresh-btn" disabled={busy || !user || !password}>
                {busy ? '⏳ …' : configured ? '🔐 Sign in' : '🔐 Create admin'}
              </button>
              {!configured ? (
                <p className="topbar-account-hint">The first user is always an admin.</p>
              ) : null}
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
