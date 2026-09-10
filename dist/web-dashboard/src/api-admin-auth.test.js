"use strict";
// @vitest-environment jsdom
// (token persistence uses localStorage — jsdom; the file-extension default is node)
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Admin write-surface API tests (Session 18).
 *
 * Covers the auth gate + provider write methods on DashboardAPI: auth-status
 * parsing, login/setup persisting the Bearer token, save/delete/test provider
 * sending the token + parsing the (possibly masked) refreshed row, 401 error
 * propagation (the session-expired signal the panel needs), and the same
 * stale-server HTML-200 degradation every other dashboard fetch has.
 */
const vitest_1 = require("vitest");
const api_1 = require("./api");
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
});
const htmlResponse = () => new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
});
const AUTHED = { configured: true, authenticated: true, user: 'admin', role: 'admin' };
const USERS = [
    { user: 'admin', role: 'admin', createdAt: 100 },
    { user: 'view', role: 'viewer', createdAt: 200 },
];
const ROW = { type: 'groq', configured: true, keySource: 'config', keyMasked: 'gsk_…abcd', model: 'm1', baseUrl: 'https://api.groq.com' };
(0, vitest_1.describe)('DashboardAPI admin auth surface', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
        (0, api_1.setAdminToken)(null);
    });
    (0, vitest_1.it)('parses /api/admin/auth-status (configured + authenticated)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(AUTHED));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAdminAuthStatus()).toEqual(AUTHED);
    });
    (0, vitest_1.it)('returns null for a stale server answering HTML — no crash', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAdminAuthStatus()).toBeNull();
    });
    (0, vitest_1.it)('login persists the token and clears it on logout', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, user: 'admin', token: 'tok-1' }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.adminLogin('admin', 'secret-pass');
        (0, vitest_1.expect)(r.ok).toBe(true);
        (0, vitest_1.expect)((0, api_1.getAdminToken)()).toBe('tok-1');
        await api.adminLogout();
        (0, vitest_1.expect)((0, api_1.getAdminToken)()).toBeNull();
    });
    (0, vitest_1.it)('login surfaces the 401 error message (wrong password) without persisting a token', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Invalid username or password.' }, 401));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.adminLogin('admin', 'wrong');
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.unauthorized).toBe(true);
        (0, vitest_1.expect)(r.error).toContain('Invalid');
        (0, vitest_1.expect)((0, api_1.getAdminToken)()).toBeNull();
    });
    (0, vitest_1.it)('setup persists the token on success', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, user: 'admin', token: 'tok-setup' }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.adminSetup('admin', 'long-enough-pass');
        (0, vitest_1.expect)(r.ok).toBe(true);
        (0, vitest_1.expect)((0, api_1.getAdminToken)()).toBe('tok-setup');
    });
});
(0, vitest_1.describe)('DashboardAPI provider write surface', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
        (0, api_1.setAdminToken)(null);
    });
    const expectAuthHeader = (input, init) => {
        (0, vitest_1.expect)(String(input)).toContain('/api/admin/providers/groq');
        (0, vitest_1.expect)(init?.headers).toMatchObject({ Authorization: 'Bearer tok-auth' });
    };
    (0, vitest_1.it)('saveProvider sends the token and returns the refreshed masked row', async () => {
        (0, api_1.setAdminToken)('tok-auth');
        const spy = vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, provider: ROW }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.saveProvider('groq', { apiKey: 'gsk_new', baseUrl: 'https://api.groq.com' });
        (0, vitest_1.expect)(r.ok).toBe(true);
        (0, vitest_1.expect)(r.provider?.keyMasked).toBe('gsk_…abcd');
        (0, vitest_1.expect)(spy).toHaveBeenCalledTimes(1);
        const [input, init] = spy.mock.calls[0];
        expectAuthHeader(input, init);
        (0, vitest_1.expect)(JSON.parse(init.body)).toMatchObject({ apiKey: 'gsk_new' });
    });
    (0, vitest_1.it)('saveProvider without a token reports unauthorized (401) so the panel shows login', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Not authenticated — log in first.' }, 401));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.saveProvider('groq', { apiKey: 'x' });
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.unauthorized).toBe(true);
    });
    (0, vitest_1.it)('deleteProvider returns ok + the cleared row', async () => {
        (0, api_1.setAdminToken)('tok-auth');
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, cleared: true, provider: { ...ROW, configured: false, keySource: 'none', keyMasked: null } }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.deleteProvider('groq');
        (0, vitest_1.expect)(r.ok).toBe(true);
        (0, vitest_1.expect)(r.cleared).toBe(true);
    });
    (0, vitest_1.it)('testProvider parses the model list on success and the error message on failure', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, models: ['llama-3.3-70b', 'mixtral'] }));
        const api = new api_1.DashboardAPI('http://test');
        const ok = await api.testProvider('groq');
        (0, vitest_1.expect)(ok.ok).toBe(true);
        (0, vitest_1.expect)(ok.models).toHaveLength(2);
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: '401 invalid key' }));
        const bad = await api.testProvider('nim');
        (0, vitest_1.expect)(bad.ok).toBe(false);
        (0, vitest_1.expect)(bad.error).toContain('401');
    });
    (0, vitest_1.it)('degrades to a network-failure message (never throws)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.saveProvider('groq', { apiKey: 'x' });
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.error).toMatch(/reach/i);
    });
});
(0, vitest_1.describe)('DashboardAPI user management (role.manage)', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
        (0, api_1.setAdminToken)(null);
    });
    (0, vitest_1.it)('fetchAdminUsers parses the user list with the token attached', async () => {
        (0, api_1.setAdminToken)('tok-auth');
        const spy = vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, users: USERS }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.fetchAdminUsers();
        (0, vitest_1.expect)(r.ok).toBe(true);
        (0, vitest_1.expect)(r.users).toHaveLength(2);
        (0, vitest_1.expect)(r.users[0]).toMatchObject({ user: 'admin', role: 'admin' });
        const [input, init] = spy.mock.calls[0];
        (0, vitest_1.expect)(String(input)).toContain('/api/admin/users');
        (0, vitest_1.expect)(init?.headers).toMatchObject({ Authorization: 'Bearer tok-auth' });
    });
    (0, vitest_1.it)('addAdminUser POSTs user/password/role and clears the form state on success', async () => {
        (0, api_1.setAdminToken)('tok-auth');
        const spy = vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.addAdminUser('view', 'viewer-pass-12', 'viewer');
        (0, vitest_1.expect)(r.ok).toBe(true);
        const [input, init] = spy.mock.calls[0];
        (0, vitest_1.expect)(String(input)).toContain('/api/admin/users');
        (0, vitest_1.expect)(JSON.parse(init.body)).toEqual({ user: 'view', password: 'viewer-pass-12', role: 'viewer' });
    });
    (0, vitest_1.it)('reports forbidden (403) when the role may not manage users', async () => {
        (0, api_1.setAdminToken)('tok-viewer');
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: "Access denied — role 'viewer' cannot manage users (requires admin)." }, 403));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.fetchAdminUsers();
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.forbidden).toBe(true);
        (0, vitest_1.expect)(r.error).toContain('Access denied');
    });
    (0, vitest_1.it)('removeAdminUser DELETEs by name', async () => {
        (0, api_1.setAdminToken)('tok-auth');
        const spy = vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, removed: true }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.removeAdminUser('view');
        (0, vitest_1.expect)(r.ok).toBe(true);
        const [input, init] = spy.mock.calls[0];
        (0, vitest_1.expect)(String(input)).toContain('/api/admin/users/view');
        (0, vitest_1.expect)(init?.method).toBe('DELETE');
    });
});
