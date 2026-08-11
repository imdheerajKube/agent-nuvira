/**
 * Admin panel tests (Sessions 17 + 18).
 *
 * Session 17: the command-runner (doctor checks + masked provider table).
 * Session 18: the user-id + password control layer — the panel now gates the
 * write surface behind setup/login, and the provider table is editable
 * (save/test/remove via the same ConfigManager the CLI writes through).
 * These tests cover the auth flows, the editor actions, and the stale-server
 * degradation (null → friendly error, never a crash).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import AdminPanel from './AdminPanel';
import { dashboardAPI, setAdminToken } from '../api';
import type { AdminChecksData } from '../types';

const VALID_PAYLOAD: AdminChecksData = {
  system: [
    { name: 'Config Directory', status: 'pass', message: '~/.buff/ exists', detail: '/Users/tester/.buff', fix: undefined },
    { name: 'Connectivity', status: 'warn', message: 'Slow probe', detail: '312ms to groq', fix: 'Check network' },
    { name: 'Docker', status: 'fail', message: 'not running', detail: undefined, fix: 'Start Docker Desktop' },
  ],
  enterprise: [
    { name: 'Secrets Backend', status: 'pass', message: 'keyring available' },
    { name: 'Audit Chain', status: 'warn', message: '2 files, 0 gaps', fix: undefined },
  ],
  providers: [
    { type: 'groq', configured: true, keySource: 'env', keyMasked: 'gsk_…abcd', model: 'llama-3.3-70b', baseUrl: 'https://api.groq.com/openai/v1' },
    { type: 'nim', configured: false, keySource: 'none', keyMasked: null, model: undefined, baseUrl: undefined },
  ],
  serverTime: 123,
};

const CATALOG = [
  { id: 'groq', label: 'Groq', icon: '🟢', envVar: 'GROQ_API_KEY', keyless: false },
  { id: 'gemini', label: 'Google Gemini', icon: '🔷', envVar: 'GEMINI_API_KEY', keyless: false },
];

/** Authed status — the panel reaches the editor. */
function mockAuthedStatus(role: string = 'admin'): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'admin', role });
}

/** The editor's data endpoints (checks + catalog) — NEVER touches the status mock. */
function mockServerData(payload: AdminChecksData = VALID_PAYLOAD): { checks: ReturnType<typeof vi.spyOn>; catalog: ReturnType<typeof vi.spyOn> } {
  const checks = vi.spyOn(dashboardAPI, 'fetchAdminChecks').mockResolvedValue(payload);
  const catalog = vi.spyOn(dashboardAPI, 'fetchAdminCatalog').mockResolvedValue(CATALOG);
  return { checks, catalog };
}

/** Full authed server: status + data. */
function mockAuthedServer(payload: AdminChecksData = VALID_PAYLOAD): { status: ReturnType<typeof vi.spyOn>; checks: ReturnType<typeof vi.spyOn>; catalog: ReturnType<typeof vi.spyOn> } {
  const status = mockAuthedStatus();
  const { checks, catalog } = mockServerData(payload);
  return { status, checks, catalog };
}

describe('AdminPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setAdminToken(null);
  });

  // ─── Auth gate (Session 18) ─────────────────────────────────────────────

  it('shows the SETUP form when no admin credential exists', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
    render(<AdminPanel />);
    expect(await screen.findByText(/Set up access/)).toBeTruthy();
    expect(screen.getByPlaceholderText('admin')).toBeTruthy();
    expect(screen.getAllByPlaceholderText('••••••••')).toHaveLength(2); // password + confirm
  });

  it('setup submits the user-id + password (and validates the confirm match)', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
    const setup = vi.spyOn(dashboardAPI, 'adminSetup').mockResolvedValue({ ok: true, user: 'admin', token: 'tok' });
    mockServerData(); // post-setup fetchAdminChecks/catalog

    render(<AdminPanel />);
    await screen.findByText(/Set up access/);

    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    const [pw, confirm] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.change(pw, { target: { value: 'long-pass-1' } });
    fireEvent.change(confirm, { target: { value: 'long-pass-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Create admin/ }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith('admin', 'long-pass-1'));
    // Authed → editor renders.
    await screen.findByText(/System Checks/);
  });

  it('rejects a mismatched confirm password without calling setup', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
    const setup = vi.spyOn(dashboardAPI, 'adminSetup');

    render(<AdminPanel />);
    await screen.findByText(/Set up access/);
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    const [pw, confirm] = screen.getAllByPlaceholderText('••••••••');
    fireEvent.change(pw, { target: { value: 'long-pass-1' } });
    fireEvent.change(confirm, { target: { value: 'different-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /Create admin/ }));

    expect(await screen.findByText(/Passwords do not match/)).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
  });

  it('shows the LOGIN form when configured but not authenticated', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
    render(<AdminPanel />);
    expect(await screen.findByRole('button', { name: /Log in/ })).toBeTruthy();
    expect(screen.getAllByPlaceholderText('••••••••')).toHaveLength(1);
  });

  it('login succeeds and reaches the editor', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
    const login = vi.spyOn(dashboardAPI, 'adminLogin').mockResolvedValue({ ok: true, user: 'admin', token: 'tok' });
    mockServerData();

    render(<AdminPanel />);
    await screen.findByRole('button', { name: /Log in/ });
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /Log in/ }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('admin', 'secret-pass'));
    await screen.findByText(/System Checks/);
  });

  it('login shows the server error on a bad password', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
    vi.spyOn(dashboardAPI, 'adminLogin').mockResolvedValue({ ok: false, error: 'Invalid username or password.', unauthorized: true });
    render(<AdminPanel />);
    await screen.findByRole('button', { name: /Log in/ });
    fireEvent.change(screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /Log in/ }));
    expect(await screen.findByText(/Invalid username or password/)).toBeTruthy();
  });

  it('degrades to a friendly error when the auth-status fetch fails (stale server) — no crash', async () => {
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue(null);
    render(<AdminPanel />);
    expect(await screen.findByText(/Could not reach the dashboard server/i)).toBeTruthy();
  });

  // ─── Command-runner (Session 17, authed) ────────────────────────────────

  it('renders check rows with pass/warn/fail badges and the provider table (keys masked)', async () => {
    mockAuthedServer();
    render(<AdminPanel />);

    expect(await screen.findAllByText('2')).toHaveLength(3); // passing + warnings + providers
    expect(screen.getByText('1')).toBeTruthy(); // failing count
    expect(screen.getByText(/System Checks/)).toBeTruthy();
    expect(screen.getByText(/Enterprise Self-Check/)).toBeTruthy();
    expect(screen.getByText(/Provider Configuration/)).toBeTruthy();
    expect(screen.getAllByText(/✅ PASS/)).toHaveLength(2);
    expect(screen.getAllByText(/⚠️ WARN/)).toHaveLength(2);
    expect(screen.getAllByText(/❌ FAIL/)).toHaveLength(1);
    expect(screen.getByText(/💡 Start Docker Desktop/)).toBeTruthy();
    // Provider table: masked key (input placeholder) + source label — the real
    // key never appears anywhere.
    expect(screen.getByPlaceholderText('gsk_…abcd')).toBeTruthy();
    expect(screen.getByText(/Environment/)).toBeTruthy(); // 'groq · Environment'
    expect(screen.getAllByText(/Not configured/)).toHaveLength(2); // nim badge + table cell
    expect(screen.queryByText(/gsk_[A-Za-z0-9]{10,}/)).toBeNull();
  });

  it('re-runs all checks when Refresh is clicked', async () => {
    const { checks } = mockAuthedServer();
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getByRole('button', { name: /Refresh \(run all commands\)/ }));
    await waitFor(() => expect(checks).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: /Refresh \(run all commands\)/ });
  });

  it('shows empty states when no providers / no enterprise checks', async () => {
    mockAuthedServer({ ...VALID_PAYLOAD, providers: [], enterprise: [] });
    render(<AdminPanel />);
    expect(await screen.findByText(/No providers configured yet/)).toBeTruthy();
    expect(screen.getByText(/No enterprise checks returned/)).toBeTruthy();
  });

  // ─── Provider editor (Session 18, authed) ───────────────────────────────

  it('saves an edited provider (key/baseUrl/model) and shows the refreshed row', async () => {
    mockAuthedServer();
    const save = vi.spyOn(dashboardAPI, 'saveProvider').mockResolvedValue({
      ok: true,
      provider: { ...VALID_PAYLOAD.providers[0], keyMasked: 'gsk_…wxyz' },
    });
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    // Edit groq's row via its stable aria-labels: new key + model (baseUrl untouched).
    fireEvent.change(screen.getByLabelText('groq API key'), { target: { value: 'gsk_new-secret-key' } });
    fireEvent.change(screen.getByLabelText('groq model'), { target: { value: 'llama-4' } });
    fireEvent.click(screen.getAllByRole('button', { name: /💾 Save/ })[0]);

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('groq', { apiKey: 'gsk_new-secret-key', model: 'llama-4' }),
    );
    expect(await screen.findByText('✅ Saved')).toBeTruthy();
    expect(screen.getByPlaceholderText('gsk_…wxyz')).toBeTruthy(); // refreshed masked row
  });

  it('tests a provider and shows the model count', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'testProvider').mockResolvedValue({ ok: true, models: ['llama-3.3-70b', 'mixtral'] });
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getAllByRole('button', { name: /🔌 Test/ })[0]);
    expect(await screen.findByText(/✅ Connected — 2 model/)).toBeTruthy();
  });

  it('removes a provider after confirm', async () => {
    mockAuthedServer();
    const del = vi.spyOn(dashboardAPI, 'deleteProvider').mockResolvedValue({
      ok: true,
      cleared: true,
      provider: { ...VALID_PAYLOAD.providers[0], configured: false, keySource: 'none', keyMasked: null },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getAllByRole('button', { name: /🗑 Remove/ })[0]);
    await waitFor(() => expect(del).toHaveBeenCalledWith('groq'));
    // The removed row (with its masked-key placeholder) disappears.
    await waitFor(() => expect(screen.queryByPlaceholderText('gsk_…abcd')).toBeNull());
  });

  it('shows the session-expired gate when a write returns 401', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'saveProvider').mockResolvedValue({ ok: false, error: 'Not authenticated — log in first.', unauthorized: true });
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getAllByRole('button', { name: /💾 Save/ })[0]);
    expect(await screen.findByText(/Session expired — log in again/)).toBeTruthy();
  });

  // ─── RBAC roles (Session 19) ────────────────────────────────────────────

  it('shows the role badge and hides the editor for a VIEWER session (read-only note)', async () => {
    mockAuthedServer();
    // Override the status with a viewer role (authed but read-only).
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'view', role: 'viewer' });
    render(<AdminPanel />);

    await screen.findByText(/System Checks/);
    // Role badge + read-only note.
    expect(screen.getByText(/view · viewer/)).toBeTruthy();
    expect(screen.getByText(/read-only here/)).toBeTruthy();
    // No editor controls, no user management.
    expect(screen.queryByRole('button', { name: /💾 Save/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /🗑 Remove/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /➕ Add/ })).toBeNull();
    expect(screen.queryByText(/Dashboard Users/)).toBeNull();
    // Read-only masked value still renders.
    expect(screen.getByText('gsk_…abcd')).toBeTruthy();
  });

  it('admin can add a dashboard user with a role', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'fetchAdminUsers').mockResolvedValue({ ok: true, users: [{ user: 'admin', role: 'admin', createdAt: 1 }] });
    const add = vi.spyOn(dashboardAPI, 'addAdminUser').mockResolvedValue({ ok: true });
    render(<AdminPanel />);
    await screen.findByText(/Dashboard Users/);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ops' } });
    fireEvent.change(screen.getByLabelText(/Password \(min 8 chars\)/), { target: { value: 'ops-pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: /Add user/ }));

    await waitFor(() => expect(add).toHaveBeenCalledWith('ops', 'ops-pass-123', 'viewer'));
    expect(await screen.findByText('✅ User added')).toBeTruthy();
  });

  it('admin can remove another dashboard user (not self)', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'fetchAdminUsers').mockResolvedValue({
      ok: true,
      users: [
        { user: 'admin', role: 'admin', createdAt: 1 },
        { user: 'ops', role: 'operator', createdAt: 2 },
      ],
    });
    const remove = vi.spyOn(dashboardAPI, 'removeAdminUser').mockResolvedValue({ ok: true, removed: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPanel />);
    await screen.findByText(/Dashboard Users/);

    // 'you' marker on the own user; remove button only on the other.
    expect(screen.getByText('you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /🗑 Remove user/ }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('ops'));
    expect(await screen.findByText(/✅ Removed ops/)).toBeTruthy();
  });

  it('warns instead of hiding the row when removing an ENV-sourced key (env re-injects)', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'deleteProvider').mockResolvedValue({
      ok: true,
      cleared: false,
      envSourced: true,
      envVar: 'GROQ_API_KEY',
      provider: { ...VALID_PAYLOAD.providers[0] }, // row stays (still configured via env)
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getAllByRole('button', { name: /🗑 Remove/ })[0]);
    // The row is NOT removed — the env note explains how to actually remove it.
    expect(await screen.findByText(/\$GROQ_API_KEY — unset it there/)).toBeTruthy();
    expect(screen.getByPlaceholderText('gsk_…abcd')).toBeTruthy();
  });

  it('logs out back to the login form', async () => {
    mockAuthedServer();
    const logout = vi.spyOn(dashboardAPI, 'adminLogout').mockResolvedValue(undefined);
    render(<AdminPanel />);
    await screen.findByText(/System Checks/);

    fireEvent.click(screen.getByRole('button', { name: /🚪 Log out/ }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Log in/ })).toBeTruthy();
  });
});
