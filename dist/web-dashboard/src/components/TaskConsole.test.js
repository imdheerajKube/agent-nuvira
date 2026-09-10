"use strict";
/**
 * P2/P3 — TaskConsole tests (the shared CLI-run console).
 *
 * Used by the Evals tab and the Gateway ops tab: preset buttons + a custom
 * command input start the REAL CLI through the mocked task API, and the live
 * SSE console (subscribeTask) streams output with cancel. The console is the
 * shared surface, so its mechanics are tested here once.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const TaskConsole_1 = __importDefault(require("./TaskConsole"));
const api_1 = require("../api");
const PRESETS = [
    { label: '🌐 Gateway status', args: ['gateway', 'status'] },
    { label: '▶️ Start gateway (foreground)', args: ['gateway', 'start', '--no-events'] },
];
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
(0, vitest_1.describe)('TaskConsole', () => {
    (0, vitest_1.it)('gates running behind admin/operator roles', async () => {
        mockAuthed(false);
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something"/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
        mockAuthed(true, 'viewer');
        (0, react_1.cleanup)();
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something"/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/view but not run/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Gateway status/ })).toBeNull();
    });
    (0, vitest_1.it)('a preset button starts its args with the timeout', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something" timeoutMs={123456}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Gateway status/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['gateway', 'status'], 123456));
    });
    (0, vitest_1.it)('the custom input splits the command line into args', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something"/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText('run something')).toBeTruthy());
        const input = react_1.screen.getByPlaceholderText('run something');
        react_1.fireEvent.change(input, { target: { value: 'admin cron run nightly' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: 'Run' }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['admin', 'cron', 'run', 'nightly'], 300_000));
    });
    (0, vitest_1.it)('streams the live console, offers cancel, and stops on completion', async () => {
        mockAuthed();
        mockRunApi();
        let onLog = null;
        let onStatus = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeTask').mockImplementation((_id, handlers) => {
            onLog = handlers.onLog;
            onStatus = handlers.onStatus;
            return vitest_1.vi.fn();
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'getTask').mockResolvedValue({
            status: 200,
            task: { ...TASK, logs: [{ stream: 'stdout', text: 'gateway: channels loaded', at: Date.now() }] },
        });
        const cancel = vitest_1.vi.spyOn(api_1.dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something"/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Gateway status/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('gateway: channels loaded')).toBeTruthy());
        // Live line streams in while running.
        onLog({ stream: 'stdout', text: 'telegram: connected' });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('telegram: connected')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Cancel/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(cancel).toHaveBeenCalledWith('task-1'));
        // Completion turns the console to done and drops the cancel button.
        onStatus('done');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/done/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    });
    (0, vitest_1.it)('surfaces a start failure instead of streaming', async () => {
        mockAuthed();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'startTask').mockResolvedValue({ ok: false, error: 'CLI not found' });
        (0, react_1.render)(<TaskConsole_1.default presets={PRESETS} customPlaceholder="run something"/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Gateway status/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Gateway status/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/CLI not found/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    });
});
