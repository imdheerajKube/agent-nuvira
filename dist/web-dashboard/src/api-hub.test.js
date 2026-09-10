"use strict";
/**
 * Agent Hub API client tests (I4 + I5).
 *
 * fetchHub() — the aggregated read the 4-tab panel polls. setToolsetEnabled()
 * — the admin-gated write (PUT /api/admin/hub/toolsets/<name>) that persists
 * the toggle to buffconfig. Both follow the same stale-server contract as the
 * other dashboard fetches: HTML-200 / malformed / network failure degrade to
 * null or { ok:false }, never a crash.
 */
Object.defineProperty(exports, "__esModule", { value: true });
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
const HUB_PAYLOAD = {
    toolsets: {
        toolsets: [
            { name: 'core', label: 'Core', description: 'Pipeline actions', enabled: true, tools: ['build'], toolCount: 1 },
            { name: 'web', label: 'Web research', description: 'Search + read', enabled: true, tools: ['web_search'], toolCount: 1 },
        ],
        enabled: 2,
        disabled: 0,
        totalTools: 2,
    },
    channels: {
        delivery: { total: 1, pending: 1, sent: 0, failed: 0, recent: [] },
        aliases: [],
        reachable: [],
        platforms: [
            { platform: 'email', label: 'Email (SMTP)', configured: false, envVars: ['BUFF_SMTP_HOST', 'BUFF_SMTP_USER'] },
            { platform: 'signal', label: 'Signal (signal-cli-rest-api)', configured: true, envVars: ['BUFF_SIGNAL_ACCOUNT'] },
        ],
        policies: {},
        contacts: [],
        statusRecipients: [],
        statusRecipientDisplay: {},
        inbox: { total: 0, pipeline: 0, chat: 0, help: 0, refused: 0, recent: [] },
    },
    artifacts: { totalSessions: 0, totalArtifacts: 0, sessions: [] },
    skills: { compiled: [], hub: [], total: 0 },
    adminConfigured: false,
    serverTime: 123,
};
(0, vitest_1.describe)('DashboardAPI.fetchHub', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('parses a real /api/hub response', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(HUB_PAYLOAD));
        const api = new api_1.DashboardAPI('http://test');
        const data = await api.fetchHub();
        (0, vitest_1.expect)(data).not.toBeNull();
        (0, vitest_1.expect)(data.toolsets.toolsets).toHaveLength(2);
        (0, vitest_1.expect)(data.adminConfigured).toBe(false);
    });
    (0, vitest_1.it)('returns null when the payload lacks the toolsets array (stale server shape)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ serverTime: 1 }));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchHub()).toBeNull();
    });
    (0, vitest_1.it)('returns null on an HTML answer (stale server) — no crash', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchHub()).toBeNull();
    });
    (0, vitest_1.it)('returns null on network failure', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
        const api = new api_1.DashboardAPI('http://test');
        (0, vitest_1.expect)(await api.fetchHub()).toBeNull();
    });
});
(0, vitest_1.describe)('DashboardAPI.setToolsetEnabled', () => {
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.restoreAllMocks();
        (0, api_1.setAdminToken)(null);
    });
    (0, vitest_1.it)('PUTs { enabled } to the admin route with the bearer token', async () => {
        (0, api_1.setAdminToken)('tok-123');
        const fetchMock = vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, toolset: 'web', enabled: false }));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.setToolsetEnabled('web', false);
        (0, vitest_1.expect)(r.ok).toBe(true);
        const [url, init] = fetchMock.mock.calls[0];
        (0, vitest_1.expect)(String(url)).toBe('http://test/api/admin/hub/toolsets/web');
        (0, vitest_1.expect)(init?.method).toBe('PUT');
        (0, vitest_1.expect)(JSON.parse(String(init?.body))).toEqual({ enabled: false });
        (0, vitest_1.expect)((init?.headers).Authorization).toBe('Bearer tok-123');
    });
    (0, vitest_1.it)('surfaces 401 as unauthorized (session expired)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Not authenticated' }, 401));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.setToolsetEnabled('web', true);
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.unauthorized).toBe(true);
    });
    (0, vitest_1.it)('surfaces 403 as forbidden (role cannot change capabilities)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: false, error: 'Access denied' }, 403));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.setToolsetEnabled('web', true);
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.forbidden).toBe(true);
    });
    (0, vitest_1.it)('returns a friendly error on network failure', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
        const api = new api_1.DashboardAPI('http://test');
        const r = await api.setToolsetEnabled('web', true);
        (0, vitest_1.expect)(r.ok).toBe(false);
        (0, vitest_1.expect)(r.error).toContain('Could not reach');
    });
});
