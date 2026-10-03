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
import type { AdminChecksData, AdminServiceRow } from '../types';

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

/** Service-provider rows for the new admin section (image + search). */
const SERVICES: AdminServiceRow[] = [
  {
    id: 'image-gemini',
    label: 'Google Gemini / Imagen (Nano Banana)',
    capability: 'image',
    icon: '🔷',
    description: 'Nano-Banana image generation.',
    keyless: false,
    free: false,
    configured: false,
    envVars: [{ varName: 'GEMINI_API_KEY', prompt: 'Google AI Studio API key', secret: true, set: false, value: '' }],
  },
  {
    id: 'search-brave',
    label: 'Brave Search',
    capability: 'search',
    icon: '🦁',
    description: 'Independent web index.',
    keyless: false,
    free: false,
    configured: false,
    envVars: [{ varName: 'BRAVE_SEARCH_API_KEY', prompt: 'Brave Search subscription token', secret: true, set: false, value: '' }],
  },
];

/** Authed status — the panel reaches the editor. */
function mockAuthedStatus(role: string = 'admin'): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'admin', role });
}

/** The editor's data endpoints (checks + catalog) — NEVER touches the status mock. */
function mockServerData(payload: AdminChecksData = VALID_PAYLOAD): { checks: ReturnType<typeof vi.spyOn>; catalog: ReturnType<typeof vi.spyOn>; services: ReturnType<typeof vi.spyOn> } {
  const checks = vi.spyOn(dashboardAPI, 'fetchAdminChecks').mockResolvedValue(payload);
  const catalog = vi.spyOn(dashboardAPI, 'fetchAdminCatalog').mockResolvedValue(CATALOG);
  const services = vi.spyOn(dashboardAPI, 'fetchAdminServices').mockResolvedValue({ ok: true, services: SERVICES });
  // The workspace read runs on every authed mount; mock it so the panel never
  // attempts a real request in a test.
  vi.spyOn(dashboardAPI, 'fetchAdminWorkspace').mockResolvedValue({
    configured: null,
    effective: null,
    processCwd: '/Users/tester',
    configuredValid: false,
  });
  // The cache listing is authed too. Empty by default; the cache tests override.
  vi.spyOn(dashboardAPI, 'fetchAdminCache').mockResolvedValue({ ok: true, total: 0, workspaces: [] });
  return { checks, catalog, services };
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

  // ─── Service Provider API keys (Admin) ──────────────────────────────────

  it('renders the Service Provider API Keys section and saves a service key', async () => {
    mockAuthedServer();
    const save = vi.spyOn(dashboardAPI, 'saveService').mockResolvedValue({
      ok: true,
      service: {
        ...SERVICES[0],
        configured: true,
        envVars: [{ ...SERVICES[0].envVars[0], set: true, value: '••••' }],
      },
    });
    render(<AdminPanel />);
    await screen.findByText(/Service Provider API Keys/);

    const input = screen.getByLabelText('image-gemini GEMINI_API_KEY');
    fireEvent.change(input, { target: { value: 'gkey-123' } });
    // The service row's own Save button (first button in its <tr>).
    const saveBtn = input.closest('tr')!.querySelector('button');
    fireEvent.click(saveBtn!);

    await waitFor(() => expect(save).toHaveBeenCalledWith('image-gemini', { GEMINI_API_KEY: 'gkey-123' }));
    expect(await screen.findByText(/Saved — the agent will use it/)).toBeTruthy();
  });

  it('renders the service section read-only for a viewer', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'view', role: 'viewer' });
    render(<AdminPanel />);
    await screen.findByText(/Service Provider API Keys/);
    expect(screen.queryByLabelText('image-gemini GEMINI_API_KEY')).toBeNull();
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

  // ─── Workspace (dashboard.cwd) ───────────────────────────────────────────

  it('shows where an unattached turn would run, and says so when unset', async () => {
    mockAuthedServer();
    render(<AdminPanel />);
    await screen.findByText(/Workspace/);

    // Unset is a REAL answer here, not an empty box: it is the state in which
    // the chat asks for a folder instead of scanning the server's own cwd.
    expect(
      await screen.findByText(/unattached project asks will ask for a folder/i),
    ).toBeTruthy();
    // The server's own cwd is named, so an operator can see what "unset" means.
    expect(screen.getByText('/Users/tester')).toBeTruthy();
  });

  it('saves a workspace and reports the effective directory', async () => {
    mockAuthedServer();
    const save = vi.spyOn(dashboardAPI, 'saveAdminWorkspace').mockResolvedValue({
      ok: true,
      workspace: {
        configured: '/tmp/proj',
        effective: '/tmp/proj',
        processCwd: '/Users/tester',
        configuredValid: true,
      },
    });
    render(<AdminPanel />);
    await screen.findByText(/Workspace/);

    fireEvent.change(screen.getByPlaceholderText('/Users/you/Documents/my-project'), {
      target: { value: '/tmp/proj' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save workspace/ }));

    await waitFor(() => expect(save).toHaveBeenCalledWith('/tmp/proj'));
    expect(await screen.findByText(/now run in \/tmp\/proj/)).toBeTruthy();
  });

  it('reports a rejected workspace path instead of pretending it saved', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'saveAdminWorkspace').mockResolvedValue({
      ok: false,
      error: 'Not a readable directory: /nope',
    });
    render(<AdminPanel />);
    await screen.findByText(/Workspace/);

    fireEvent.change(screen.getByPlaceholderText('/Users/you/Documents/my-project'), {
      target: { value: '/nope' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save workspace/ }));

    expect(await screen.findByText(/Not a readable directory/)).toBeTruthy();
  });

  // ─── Response cache, by workspace ────────────────────────────────────────

  it('shows which folder each cached answer came from', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'fetchAdminCache').mockResolvedValue({
      ok: true,
      total: 3,
      workspaces: [
        {
          scope: '/Users/tester/code/agent-nuvira',
          count: 2,
          newestAt: 1_700_000_000_000,
          oldestAt: 1_699_000_000_000,
          providers: ['gemini'],
          models: ['gemini-flash'],
          samples: [{ prompt: "what's the current status of this project", model: 'gemini-flash', provider: 'gemini', at: 1_700_000_000_000 }],
        },
        {
          scope: null,
          count: 1,
          newestAt: 1_698_000_000_000,
          oldestAt: 1_698_000_000_000,
          providers: ['gemini'],
          models: ['gemini-flash'],
          samples: [{ prompt: 'what is 2 + 2', model: 'gemini-flash', provider: 'gemini', at: 1_698_000_000_000 }],
        },
      ],
    });

    render(<AdminPanel />);
    await screen.findByText(/Response Cache/);

    // The FOLDER is the point of the list — an entry you cannot attribute is an
    // entry you cannot decide to clear.
    expect(await screen.findByText('/Users/tester/code/agent-nuvira')).toBeTruthy();
    expect(screen.getByText('no workspace attached')).toBeTruthy();
    expect(screen.getAllByText(/what's the current status of this project/).length).toBeGreaterThan(0);
  });

  it('clears ONE workspace and reports how many answers went', async () => {
    mockAuthedServer();
    vi.spyOn(dashboardAPI, 'fetchAdminCache').mockResolvedValue({
      ok: true,
      total: 2,
      workspaces: [
        {
          scope: '/repo',
          count: 2,
          newestAt: 1_700_000_000_000,
          oldestAt: 1_700_000_000_000,
          providers: ['gemini'],
          models: ['gemini-flash'],
          samples: [{ prompt: 'status', model: 'gemini-flash', provider: 'gemini', at: 1_700_000_000_000 }],
        },
      ],
    });
    const clear = vi.spyOn(dashboardAPI, 'clearAdminCache').mockResolvedValue({ ok: true, removed: 2 });

    render(<AdminPanel />);
    await screen.findByText('/repo');
    fireEvent.click(screen.getByRole('button', { name: /🗑 Clear/ }));

    await waitFor(() => expect(clear).toHaveBeenCalledWith('/repo'));
    expect(await screen.findByText(/Cleared 2 cached answer\(s\) for \/repo/)).toBeTruthy();
  });

  it('a viewer cannot clear the cache (the control is disabled)', async () => {
    mockAuthedServer();
    mockAuthedStatus('viewer');
    vi.spyOn(dashboardAPI, 'fetchAdminCache').mockResolvedValue({
      ok: true,
      total: 1,
      workspaces: [
        {
          scope: '/repo',
          count: 1,
          newestAt: 1_700_000_000_000,
          oldestAt: 1_700_000_000_000,
          providers: ['gemini'],
          models: ['gemini-flash'],
          samples: [{ prompt: 'status', model: 'gemini-flash', provider: 'gemini', at: 1_700_000_000_000 }],
        },
      ],
    });

    render(<AdminPanel />);
    await screen.findByText('/repo');
    expect((screen.getByRole('button', { name: /🗑 Clear/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
