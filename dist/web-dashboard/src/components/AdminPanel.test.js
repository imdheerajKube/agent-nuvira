"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const AdminPanel_1 = __importDefault(require("./AdminPanel"));
const api_1 = require("../api");
const VALID_PAYLOAD = {
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
function mockAuthedStatus(role = 'admin') {
    return vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'admin', role });
}
/** The editor's data endpoints (checks + catalog) — NEVER touches the status mock. */
function mockServerData(payload = VALID_PAYLOAD) {
    const checks = vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminChecks').mockResolvedValue(payload);
    const catalog = vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminCatalog').mockResolvedValue(CATALOG);
    return { checks, catalog };
}
/** Full authed server: status + data. */
function mockAuthedServer(payload = VALID_PAYLOAD) {
    const status = mockAuthedStatus();
    const { checks, catalog } = mockServerData(payload);
    return { status, checks, catalog };
}
(0, vitest_1.describe)('AdminPanel', () => {
    (0, vitest_1.afterEach)(() => {
        (0, react_1.cleanup)();
        vitest_1.vi.restoreAllMocks();
        (0, api_1.setAdminToken)(null);
    });
    // ─── Auth gate (Session 18) ─────────────────────────────────────────────
    (0, vitest_1.it)('shows the SETUP form when no admin credential exists', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
        (0, react_1.render)(<AdminPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByText(/Set up access/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText('admin')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getAllByPlaceholderText('••••••••')).toHaveLength(2); // password + confirm
    });
    (0, vitest_1.it)('setup submits the user-id + password (and validates the confirm match)', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
        const setup = vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminSetup').mockResolvedValue({ ok: true, user: 'admin', token: 'tok' });
        mockServerData(); // post-setup fetchAdminChecks/catalog
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/Set up access/);
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
        const [pw, confirm] = react_1.screen.getAllByPlaceholderText('••••••••');
        react_1.fireEvent.change(pw, { target: { value: 'long-pass-1' } });
        react_1.fireEvent.change(confirm, { target: { value: 'long-pass-1' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Create admin/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(setup).toHaveBeenCalledWith('admin', 'long-pass-1'));
        // Authed → editor renders.
        await react_1.screen.findByText(/System Checks/);
    });
    (0, vitest_1.it)('rejects a mismatched confirm password without calling setup', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: false, authenticated: false, user: null });
        const setup = vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminSetup');
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/Set up access/);
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
        const [pw, confirm] = react_1.screen.getAllByPlaceholderText('••••••••');
        react_1.fireEvent.change(pw, { target: { value: 'long-pass-1' } });
        react_1.fireEvent.change(confirm, { target: { value: 'different-pass' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Create admin/ }));
        (0, vitest_1.expect)(await react_1.screen.findByText(/Passwords do not match/)).toBeTruthy();
        (0, vitest_1.expect)(setup).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('shows the LOGIN form when configured but not authenticated', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
        (0, react_1.render)(<AdminPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByRole('button', { name: /Log in/ })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getAllByPlaceholderText('••••••••')).toHaveLength(1);
    });
    (0, vitest_1.it)('login succeeds and reaches the editor', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
        const login = vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminLogin').mockResolvedValue({ ok: true, user: 'admin', token: 'tok' });
        mockServerData();
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByRole('button', { name: /Log in/ });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('••••••••'), { target: { value: 'secret-pass' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Log in/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(login).toHaveBeenCalledWith('admin', 'secret-pass'));
        await react_1.screen.findByText(/System Checks/);
    });
    (0, vitest_1.it)('login shows the server error on a bad password', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: false, user: null });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminLogin').mockResolvedValue({ ok: false, error: 'Invalid username or password.', unauthorized: true });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByRole('button', { name: /Log in/ });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('admin'), { target: { value: 'admin' } });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Log in/ }));
        (0, vitest_1.expect)(await react_1.screen.findByText(/Invalid username or password/)).toBeTruthy();
    });
    (0, vitest_1.it)('degrades to a friendly error when the auth-status fetch fails (stale server) — no crash', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue(null);
        (0, react_1.render)(<AdminPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByText(/Could not reach the dashboard server/i)).toBeTruthy();
    });
    // ─── Command-runner (Session 17, authed) ────────────────────────────────
    (0, vitest_1.it)('renders check rows with pass/warn/fail badges and the provider table (keys masked)', async () => {
        mockAuthedServer();
        (0, react_1.render)(<AdminPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findAllByText('2')).toHaveLength(3); // passing + warnings + providers
        (0, vitest_1.expect)(react_1.screen.getByText('1')).toBeTruthy(); // failing count
        (0, vitest_1.expect)(react_1.screen.getByText(/System Checks/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/Enterprise Self-Check/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/Provider Configuration/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getAllByText(/✅ PASS/)).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getAllByText(/⚠️ WARN/)).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getAllByText(/❌ FAIL/)).toHaveLength(1);
        (0, vitest_1.expect)(react_1.screen.getByText(/💡 Start Docker Desktop/)).toBeTruthy();
        // Provider table: masked key (input placeholder) + source label — the real
        // key never appears anywhere.
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText('gsk_…abcd')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/Environment/)).toBeTruthy(); // 'groq · Environment'
        (0, vitest_1.expect)(react_1.screen.getAllByText(/Not configured/)).toHaveLength(2); // nim badge + table cell
        (0, vitest_1.expect)(react_1.screen.queryByText(/gsk_[A-Za-z0-9]{10,}/)).toBeNull();
    });
    (0, vitest_1.it)('re-runs all checks when Refresh is clicked', async () => {
        const { checks } = mockAuthedServer();
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Refresh \(run all commands\)/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(checks).toHaveBeenCalledTimes(2));
        await react_1.screen.findByRole('button', { name: /Refresh \(run all commands\)/ });
    });
    (0, vitest_1.it)('shows empty states when no providers / no enterprise checks', async () => {
        mockAuthedServer({ ...VALID_PAYLOAD, providers: [], enterprise: [] });
        (0, react_1.render)(<AdminPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByText(/No providers configured yet/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/No enterprise checks returned/)).toBeTruthy();
    });
    // ─── Provider editor (Session 18, authed) ───────────────────────────────
    (0, vitest_1.it)('saves an edited provider (key/baseUrl/model) and shows the refreshed row', async () => {
        mockAuthedServer();
        const save = vitest_1.vi.spyOn(api_1.dashboardAPI, 'saveProvider').mockResolvedValue({
            ok: true,
            provider: { ...VALID_PAYLOAD.providers[0], keyMasked: 'gsk_…wxyz' },
        });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        // Edit groq's row via its stable aria-labels: new key + model (baseUrl untouched).
        react_1.fireEvent.change(react_1.screen.getByLabelText('groq API key'), { target: { value: 'gsk_new-secret-key' } });
        react_1.fireEvent.change(react_1.screen.getByLabelText('groq model'), { target: { value: 'llama-4' } });
        react_1.fireEvent.click(react_1.screen.getAllByRole('button', { name: /💾 Save/ })[0]);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(save).toHaveBeenCalledWith('groq', { apiKey: 'gsk_new-secret-key', model: 'llama-4' }));
        (0, vitest_1.expect)(await react_1.screen.findByText('✅ Saved')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText('gsk_…wxyz')).toBeTruthy(); // refreshed masked row
    });
    (0, vitest_1.it)('tests a provider and shows the model count', async () => {
        mockAuthedServer();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'testProvider').mockResolvedValue({ ok: true, models: ['llama-3.3-70b', 'mixtral'] });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getAllByRole('button', { name: /🔌 Test/ })[0]);
        (0, vitest_1.expect)(await react_1.screen.findByText(/✅ Connected — 2 model/)).toBeTruthy();
    });
    (0, vitest_1.it)('removes a provider after confirm', async () => {
        mockAuthedServer();
        const del = vitest_1.vi.spyOn(api_1.dashboardAPI, 'deleteProvider').mockResolvedValue({
            ok: true,
            cleared: true,
            provider: { ...VALID_PAYLOAD.providers[0], configured: false, keySource: 'none', keyMasked: null },
        });
        vitest_1.vi.spyOn(window, 'confirm').mockReturnValue(true);
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getAllByRole('button', { name: /🗑 Remove/ })[0]);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(del).toHaveBeenCalledWith('groq'));
        // The removed row (with its masked-key placeholder) disappears.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByPlaceholderText('gsk_…abcd')).toBeNull());
    });
    (0, vitest_1.it)('shows the session-expired gate when a write returns 401', async () => {
        mockAuthedServer();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'saveProvider').mockResolvedValue({ ok: false, error: 'Not authenticated — log in first.', unauthorized: true });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getAllByRole('button', { name: /💾 Save/ })[0]);
        (0, vitest_1.expect)(await react_1.screen.findByText(/Session expired — log in again/)).toBeTruthy();
    });
    // ─── RBAC roles (Session 19) ────────────────────────────────────────────
    (0, vitest_1.it)('shows the role badge and hides the editor for a VIEWER session (read-only note)', async () => {
        mockAuthedServer();
        // Override the status with a viewer role (authed but read-only).
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({ configured: true, authenticated: true, user: 'view', role: 'viewer' });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        // Role badge + read-only note.
        (0, vitest_1.expect)(react_1.screen.getByText(/view · viewer/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/read-only here/)).toBeTruthy();
        // No editor controls, no user management.
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /💾 Save/ })).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /🗑 Remove/ })).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /➕ Add/ })).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/Dashboard Users/)).toBeNull();
        // Read-only masked value still renders.
        (0, vitest_1.expect)(react_1.screen.getByText('gsk_…abcd')).toBeTruthy();
    });
    (0, vitest_1.it)('admin can add a dashboard user with a role', async () => {
        mockAuthedServer();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminUsers').mockResolvedValue({ ok: true, users: [{ user: 'admin', role: 'admin', createdAt: 1 }] });
        const add = vitest_1.vi.spyOn(api_1.dashboardAPI, 'addAdminUser').mockResolvedValue({ ok: true });
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/Dashboard Users/);
        react_1.fireEvent.change(react_1.screen.getByLabelText('Username'), { target: { value: 'ops' } });
        react_1.fireEvent.change(react_1.screen.getByLabelText(/Password \(min 8 chars\)/), { target: { value: 'ops-pass-123' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Add user/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(add).toHaveBeenCalledWith('ops', 'ops-pass-123', 'viewer'));
        (0, vitest_1.expect)(await react_1.screen.findByText('✅ User added')).toBeTruthy();
    });
    (0, vitest_1.it)('admin can remove another dashboard user (not self)', async () => {
        mockAuthedServer();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminUsers').mockResolvedValue({
            ok: true,
            users: [
                { user: 'admin', role: 'admin', createdAt: 1 },
                { user: 'ops', role: 'operator', createdAt: 2 },
            ],
        });
        const remove = vitest_1.vi.spyOn(api_1.dashboardAPI, 'removeAdminUser').mockResolvedValue({ ok: true, removed: true });
        vitest_1.vi.spyOn(window, 'confirm').mockReturnValue(true);
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/Dashboard Users/);
        // 'you' marker on the own user; remove button only on the other.
        (0, vitest_1.expect)(react_1.screen.getByText('you')).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /🗑 Remove user/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(remove).toHaveBeenCalledWith('ops'));
        (0, vitest_1.expect)(await react_1.screen.findByText(/✅ Removed ops/)).toBeTruthy();
    });
    (0, vitest_1.it)('warns instead of hiding the row when removing an ENV-sourced key (env re-injects)', async () => {
        mockAuthedServer();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'deleteProvider').mockResolvedValue({
            ok: true,
            cleared: false,
            envSourced: true,
            envVar: 'GROQ_API_KEY',
            provider: { ...VALID_PAYLOAD.providers[0] }, // row stays (still configured via env)
        });
        vitest_1.vi.spyOn(window, 'confirm').mockReturnValue(true);
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getAllByRole('button', { name: /🗑 Remove/ })[0]);
        // The row is NOT removed — the env note explains how to actually remove it.
        (0, vitest_1.expect)(await react_1.screen.findByText(/\$GROQ_API_KEY — unset it there/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText('gsk_…abcd')).toBeTruthy();
    });
    (0, vitest_1.it)('logs out back to the login form', async () => {
        mockAuthedServer();
        const logout = vitest_1.vi.spyOn(api_1.dashboardAPI, 'adminLogout').mockResolvedValue(undefined);
        (0, react_1.render)(<AdminPanel_1.default />);
        await react_1.screen.findByText(/System Checks/);
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /🚪 Log out/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(logout).toHaveBeenCalled());
        (0, vitest_1.expect)(await react_1.screen.findByRole('button', { name: /Log in/ })).toBeTruthy();
    });
});
