"use strict";
/**
 * TasksPage — command console tests (P1).
 *
 * - Unauthenticated users see the login gate (running commands is a write
 *   action, like the Agent Hub toggles).
 * - Authenticated users get the run form + history table.
 * - Typing a command and hitting Run calls startTask with the parsed argv and
 *   subscribes to the task's SSE stream.
 * - The Run button is disabled while the command is empty / while starting.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const react_router_dom_1 = require("react-router-dom");
const TasksPage_1 = __importDefault(require("./TasksPage"));
const api_1 = require("../api");
const TASK = {
    id: 't1',
    command: 'eval run --task smoke',
    args: ['eval', 'run', '--task', 'smoke'],
    cwd: '/workspace',
    status: 'done',
    exitCode: 0,
    startedAt: Date.now() - 5000,
    finishedAt: Date.now(),
    durationMs: 5000,
    timeoutMs: 300000,
    logs: [{ stream: 'stdout', text: 'hello from fixture', at: Date.now() }],
};
function mockAuthed() {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
        configured: true,
        authenticated: true,
        user: 'admin',
        role: 'admin',
    });
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'listTasks').mockResolvedValue({ status: 200, tasks: [TASK] });
}
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    (0, api_1.setAdminToken)(null);
});
function renderPage() {
    (0, react_1.render)(<react_router_dom_1.MemoryRouter>
      <TasksPage_1.default />
    </react_router_dom_1.MemoryRouter>);
}
(0, vitest_1.describe)('TasksPage', () => {
    (0, vitest_1.it)('shows the login gate when unauthenticated', async () => {
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
            configured: true,
            authenticated: false,
            user: null,
            role: null,
        });
        renderPage();
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in to run tasks/)).toBeTruthy());
    });
    (0, vitest_1.it)('renders the run form and history when authed', async () => {
        mockAuthed();
        renderPage();
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/eval run --task smoke-test/)).toBeTruthy());
        // History table row shows the finished task.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('eval run --task smoke')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/✅ done/)).toBeTruthy();
    });
    (0, vitest_1.it)('disables Run while the command is empty', async () => {
        mockAuthed();
        renderPage();
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/eval run --task smoke-test/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /▶ Run/ }).disabled).toBe(true);
    });
    (0, vitest_1.it)('starts a task from the typed command and subscribes to its stream', async () => {
        mockAuthed();
        const startMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'startTask').mockResolvedValue({
            ok: true,
            task: { ...TASK, id: 't2', command: 'memory stats', args: ['memory', 'stats'], status: 'running', logs: [] },
        });
        const subMock = vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeTask').mockReturnValue(() => { });
        renderPage();
        const input = await react_1.screen.findByPlaceholderText(/eval run --task smoke-test/);
        react_1.fireEvent.change(input, { target: { value: 'memory stats' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /▶ Run/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(startMock).toHaveBeenCalledWith(['memory', 'stats'], 300000));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(subMock).toHaveBeenCalledWith('t2', vitest_1.expect.any(Object)));
        // The console header shows the running command.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('memory stats')).toBeTruthy());
    });
    (0, vitest_1.it)('shows a friendly error when start fails', async () => {
        mockAuthed();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'startTask').mockResolvedValue({ ok: false, error: 'Missing command args.' });
        renderPage();
        const input = await react_1.screen.findByPlaceholderText(/eval run --task smoke-test/);
        react_1.fireEvent.change(input, { target: { value: 'eval run' } });
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /▶ Run/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Missing command args/)).toBeTruthy());
    });
});
