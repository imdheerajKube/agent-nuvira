"use strict";
/**
 * P2/P3 — GatewayPage tests (gateway ops in the GUI).
 *
 * The page mounts the shared TaskConsole with `buff gateway` presets. Its own
 * surface is thin (page title + presets); the console mechanics live in
 * TaskConsole.test.tsx.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const GatewayPage_1 = __importDefault(require("./GatewayPage"));
const api_1 = require("../api");
const TASK = {
    id: 'task-1',
    command: 'gateway status',
    args: ['gateway', 'status'],
    cwd: '/tmp',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    timeoutMs: 300000,
    logs: [],
};
function mockAuthed(authenticated = true, role = 'admin') {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
        configured: true,
        authenticated,
        user: authenticated ? 'admin' : null,
        role: authenticated ? role : null,
    });
}
function mockRunApi() {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'startTask').mockResolvedValue({ ok: true, task: TASK });
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'getTask').mockResolvedValue({ status: 200, task: TASK });
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeTask').mockReturnValue(() => { });
}
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    (0, api_1.setAdminToken)(null);
});
(0, vitest_1.describe)('GatewayPage', () => {
    (0, vitest_1.it)('gates ops behind the admin session', async () => {
        mockAuthed(false);
        (0, react_1.render)(<GatewayPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Gateway status/ })).toBeNull();
    });
    (0, vitest_1.it)('preset buttons run the real gateway CLI commands', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<GatewayPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Gateway status/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['gateway', 'status'], 300_000));
    });
    (0, vitest_1.it)('the custom input runs an arbitrary gateway/admin command', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<GatewayPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/admin cron run/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/admin cron run/), { target: { value: 'admin cron run nightly' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: 'Run' }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['admin', 'cron', 'run', 'nightly'], 300_000));
    });
});
