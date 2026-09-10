"use strict";
/**
 * Admin command-runner fetch tests (Session 17).
 *
 * fetchAdminChecks() drives the dashboard's /api/admin/checks endpoint — the
 * on-demand execution of ALL state commands (doctor system + enterprise
 * checks + masked provider summary). Regression coverage for the same
 * parseJsonOrNull contract every other dashboard fetch uses: a stale server
 * answering HTML must degrade to null, never crash.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const api_1 = require("./api");
const jsonResponse = (data) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});
const htmlResponse = () => new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
});
const VALID_PAYLOAD = {
    system: [{ name: 'Config Directory', status: 'pass', message: '~/.nuvira/ exists' }],
    enterprise: [{ name: 'Secrets Backend', status: 'warn', message: 'keys in config' }],
    providers: [{ type: 'groq', configured: true, keySource: 'env', keyMasked: 'gsk_…abcd' }],
    serverTime: 123,
};
(0, vitest_1.describe)('DashboardAPI.fetchAdminChecks', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('parses a real /api/admin/checks response', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(VALID_PAYLOAD));
        const api = new api_1.DashboardAPI('http://test');
        const data = await api.fetchAdminChecks();
        (0, vitest_1.expect)(data).toMatchObject({ serverTime: 123 });
        (0, vitest_1.expect)(data.system[0].status).toBe('pass');
        (0, vitest_1.expect)(data.providers[0].keySource).toBe('env');
    });
    (0, vitest_1.it)('returns null when the server answers HTML (stale server) — no crash', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
        const api = new api_1.DashboardAPI('http://test');
        const data = await api.fetchAdminChecks();
        (0, vitest_1.expect)(data).toBeNull();
    });
    (0, vitest_1.it)('returns null when the payload lacks the checks arrays', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ serverTime: 1 }));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAdminChecks()).toBeNull();
    });
    (0, vitest_1.it)('returns null when the payload lacks the providers array (panel would crash on .length)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
            system: [],
            enterprise: [],
            serverTime: 1,
        }));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAdminChecks()).toBeNull();
    });
    (0, vitest_1.it)('returns null on network failure', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAdminChecks()).toBeNull();
    });
});
