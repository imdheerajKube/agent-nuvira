"use strict";
/**
 * P2 — EvalsPage tests (eval runner in the GUI).
 *
 * The page mounts the shared TaskConsole with the `buff eval run` presets and
 * renders past runs from the dashboard data feed. Page-specific behavior is
 * covered here; the console's run/stream/cancel mechanics live in
 * TaskConsole.test.tsx.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const EvalsPage_1 = __importDefault(require("./EvalsPage"));
const api_1 = require("../api");
const DATA = {
    evals: {
        totalRuns: 2,
        latest: null,
        runs: [
            {
                id: 'r1',
                provider: 'groq',
                model: 'llama-3.3-70b',
                startedAt: 1700000000000,
                summary: {
                    totalTasks: 4, tasksPassed: 3, completionRate: 0.75, testPassRate: 0.8,
                    avgTimeToFixMs: 1000, avgEditAccuracy: 0.9, avgTokenEfficiency: 0.5,
                    totalRollbacks: 1, dependencyInstallRate: 1, recoveryRate: 0.9,
                    avgCompositeScore: 0.72, totalCostUsd: 0.012,
                },
            },
        ],
    },
    serverTime: 1,
};
const TASK = {
    id: 'task-1',
    command: 'eval run --tasks quick --format text',
    args: ['eval', 'run', '--tasks', 'quick', '--format', 'text'],
    cwd: '/tmp',
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    timeoutMs: 900000,
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
(0, vitest_1.describe)('EvalsPage', () => {
    (0, vitest_1.it)('gates running behind the admin session', async () => {
        mockAuthed(false);
        (0, react_1.render)(<EvalsPage_1.default data={DATA}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Quick smoke/ })).toBeNull();
    });
    (0, vitest_1.it)('renders past runs from the data feed', async () => {
        mockAuthed();
        (0, react_1.render)(<EvalsPage_1.default data={DATA}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('groq')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('llama-3.3-70b')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('3/4')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('72%')).toBeTruthy();
    });
    (0, vitest_1.it)('a preset button starts the right eval task with the eval timeout', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<EvalsPage_1.default data={DATA}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Quick smoke/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Quick smoke/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['eval', 'run', '--tasks', 'quick', '--format', 'text'], 900_000));
    });
    (0, vitest_1.it)('the custom input runs a full eval command line', async () => {
        mockAuthed();
        mockRunApi();
        const start = vitest_1.vi.mocked(api_1.dashboardAPI.startTask);
        (0, react_1.render)(<EvalsPage_1.default data={DATA}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/eval run/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/eval run/), { target: { value: 'eval run --tasks my-task --format text' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: 'Run' }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(start).toHaveBeenCalledWith(['eval', 'run', '--tasks', 'my-task', '--format', 'text'], 900_000));
    });
    (0, vitest_1.it)('streams the live console and offers cancel while running', async () => {
        mockAuthed();
        mockRunApi();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'getTask').mockResolvedValue({
            status: 200,
            task: { ...TASK, logs: [{ stream: 'stdout', text: 'task 1/4 started', at: Date.now() }] },
        });
        const cancel = vitest_1.vi.spyOn(api_1.dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
        (0, react_1.render)(<EvalsPage_1.default data={DATA}/>);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Quick smoke/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Quick smoke/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('task 1/4 started')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Cancel/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(cancel).toHaveBeenCalledWith('task-1'));
    });
});
