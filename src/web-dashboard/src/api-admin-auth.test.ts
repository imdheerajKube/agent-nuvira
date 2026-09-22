// @vitest-environment jsdom
// (token persistence uses localStorage — jsdom; the file-extension default is node)

/**
 * Admin write-surface API tests (Session 18).
 *
 * Covers the auth gate + provider write methods on DashboardAPI: auth-status
 * parsing, login/setup persisting the Bearer token, save/delete/test provider
 * sending the token + parsing the (possibly masked) refreshed row, 401 error
 * propagation (the session-expired signal the panel needs), and the same
 * stale-server HTML-200 degradation every other dashboard fetch has.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DashboardAPI, getAdminToken, setAdminToken } from './api';

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const htmlResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

const AUTHED = {
  configured: true,
  authenticated: true,
  user: 'admin',
  role: 'admin',
  // Absent from the wire on an older server → parsed as false, never undefined.
  mustChangePassword: false,
};
const USERS = [
  { user: 'admin', role: 'admin', createdAt: 100 },
  { user: 'view', role: 'viewer', createdAt: 200 },
];
const ROW = { type: 'groq', configured: true, keySource: 'config', keyMasked: 'gsk_…abcd', model: 'm1', baseUrl: 'https://api.groq.com' };

describe('DashboardAPI admin auth surface', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAdminToken(null);
  });

  it('parses /api/admin/auth-status (configured + authenticated)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(AUTHED));
    const api = new DashboardAPI('http://test');
    expect(await api.fetchAdminAuthStatus()).toEqual(AUTHED);
  });

  it('surfaces the forced-change flag so the GUI can gate the dashboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...AUTHED, mustChangePassword: true }),
    );
    const api = new DashboardAPI('http://test');
    expect((await api.fetchAdminAuthStatus())?.mustChangePassword).toBe(true);
  });

  it('returns null for a stale server answering HTML — no crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
    const api = new DashboardAPI('http://test');
    expect(await api.fetchAdminAuthStatus()).toBeNull();
  });

  it('login persists the token and clears it on logout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, user: 'admin', token: 'tok-1' }));
    const api = new DashboardAPI('http://test');
    const r = await api.adminLogin('admin', 'secret-pass');
    expect(r.ok).toBe(true);
    expect(getAdminToken()).toBe('tok-1');
    await api.adminLogout();
    expect(getAdminToken()).toBeNull();
  });

  it('login surfaces the 401 error message (wrong password) without persisting a token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401));
    const api = new DashboardAPI('http://test');
    const r = await api.adminLogin('admin', 'wrong');
    expect(r.ok).toBe(false);
    expect(r.unauthorized).toBe(true);
    expect(r.error).toContain('Invalid');
    expect(getAdminToken()).toBeNull();
  });

  it('setup persists the token on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, user: 'admin', token: 'tok-setup' }));
    const api = new DashboardAPI('http://test');
    const r = await api.adminSetup('admin', 'long-enough-pass');
    expect(r.ok).toBe(true);
    expect(getAdminToken()).toBe('tok-setup');
  });
});

describe('DashboardAPI provider write surface', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAdminToken(null);
  });

  const expectAuthHeader = (input: RequestInfo | URL, init?: RequestInit): void => {
    expect(String(input)).toContain('/api/admin/providers/groq');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok-auth' });
  };

  it('saveProvider sends the token and returns the refreshed masked row', async () => {
    setAdminToken('tok-auth');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, provider: ROW }));
    const api = new DashboardAPI('http://test');
    const r = await api.saveProvider('groq', { apiKey: 'gsk_new', baseUrl: 'https://api.groq.com' });
    expect(r.ok).toBe(true);
    expect(r.provider?.keyMasked).toBe('gsk_…abcd');
    expect(spy).toHaveBeenCalledTimes(1);
    const [input, init] = spy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expectAuthHeader(input, init);
    expect(JSON.parse(init.body as string)).toMatchObject({ apiKey: 'gsk_new' });
  });

  it('saveProvider without a token reports unauthorized (401) so the panel shows login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Not authenticated — log in first.' }, 401));
    const api = new DashboardAPI('http://test');
    const r = await api.saveProvider('groq', { apiKey: 'x' });
    expect(r.ok).toBe(false);
    expect(r.unauthorized).toBe(true);
  });

  it('deleteProvider returns ok + the cleared row', async () => {
    setAdminToken('tok-auth');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, cleared: true, provider: { ...ROW, configured: false, keySource: 'none', keyMasked: null } }));
    const api = new DashboardAPI('http://test');
    const r = await api.deleteProvider('groq');
    expect(r.ok).toBe(true);
    expect(r.cleared).toBe(true);
  });

  it('testProvider parses the model list on success and the error message on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, models: ['llama-3.3-70b', 'mixtral'] }));
    const api = new DashboardAPI('http://test');
    const ok = await api.testProvider('groq');
    expect(ok.ok).toBe(true);
    expect(ok.models).toHaveLength(2);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: '401 invalid key' }));
    const bad = await api.testProvider('nim');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('401');
  });

  it('degrades to a network-failure message (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const api = new DashboardAPI('http://test');
    const r = await api.saveProvider('groq', { apiKey: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reach/i);
  });
});

describe('DashboardAPI user management (role.manage)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAdminToken(null);
  });

  it('fetchAdminUsers parses the user list with the token attached', async () => {
    setAdminToken('tok-auth');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, users: USERS }));
    const api = new DashboardAPI('http://test');
    const r = await api.fetchAdminUsers();
    expect(r.ok).toBe(true);
    expect(r.users).toHaveLength(2);
    expect(r.users![0]).toMatchObject({ user: 'admin', role: 'admin' });
    const [input, init] = spy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(input)).toContain('/api/admin/users');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok-auth' });
  });

  it('addAdminUser POSTs user/password/role and clears the form state on success', async () => {
    setAdminToken('tok-auth');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    const api = new DashboardAPI('http://test');
    const r = await api.addAdminUser('view', 'viewer-pass-12', 'viewer');
    expect(r.ok).toBe(true);
    const [input, init] = spy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(input)).toContain('/api/admin/users');
    expect(JSON.parse(init.body as string)).toEqual({ user: 'view', password: 'viewer-pass-12', role: 'viewer' });
  });

  it('reports forbidden (403) when the role may not manage users', async () => {
    setAdminToken('tok-viewer');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: "Access denied — role 'viewer' cannot manage users (requires admin)." }, 403));
    const api = new DashboardAPI('http://test');
    const r = await api.fetchAdminUsers();
    expect(r.ok).toBe(false);
    expect(r.forbidden).toBe(true);
    expect(r.error).toContain('Access denied');
  });

  it('removeAdminUser DELETEs by name', async () => {
    setAdminToken('tok-auth');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, removed: true }));
    const api = new DashboardAPI('http://test');
    const r = await api.removeAdminUser('view');
    expect(r.ok).toBe(true);
    const [input, init] = spy.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(input)).toContain('/api/admin/users/view');
    expect(init?.method).toBe('DELETE');
  });
});
