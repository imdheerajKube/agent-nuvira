"use strict";
/**
 * Unit tests for DashboardAPI.fetchAll() — the initial-data bootstrap path
 * every dashboard panel falls back to when SSE hasn't delivered a snapshot yet.
 *
 * Regression coverage for the reported "Failed to execute 'json' on
 * 'Response': Unexpected token '<'" crash: a STALE dashboard server (older
 * version missing newer routes) answers /api/all with the SPA index.html
 * (HTTP 200, text/html). fetchAll() must degrade to null (App waits for the
 * next SSE snapshot) instead of throwing.
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
(0, vitest_1.describe)('DashboardAPI.fetchAll', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('parses a real JSON /api/all response', async () => {
        const payload = { serverTime: Date.now(), cost: { totalRequests: 0 } };
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload));
        const api = new api_1.DashboardAPI('http://test');
        const data = await api.fetchAll();
        (0, vitest_1.expect)(data).toMatchObject(payload);
    });
    (0, vitest_1.it)('returns null (no crash) when the server answers /api/all with HTML (stale server)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
        const api = new api_1.DashboardAPI('http://test');
        // Must NOT throw — previously res.json() threw "Unexpected token '<'".
        const data = await api.fetchAll();
        (0, vitest_1.expect)(data).toBeNull();
    });
    (0, vitest_1.it)('returns null on HTTP non-ok and on malformed JSON bodies', async () => {
        const notOk = new Response('nope', { status: 500, headers: { 'Content-Type': 'application/json' } });
        const malformed = new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } });
        vitest_1.vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(notOk)
            .mockResolvedValueOnce(malformed);
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchAll()).toBeNull();
        (0, vitest_1.expect)(await api.fetchAll()).toBeNull();
    });
});
