"use strict";
/**
 * P3 — ChatPage tests (dashboard chat console).
 *
 * The page threads a conversation through the mocked chat API: user bubbles,
 * assistant replies with followup chips (clicking sends the prompt), the
 * working state, error handling, and the auth gate. No LLM, no server.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const ChatPage_1 = __importDefault(require("./ChatPage"));
const api_1 = require("../api");
function mockAuthed(role = 'admin', authenticated = true) {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
        configured: true,
        authenticated,
        user: authenticated ? 'admin' : null,
        role: authenticated ? role : null,
    });
}
/** The page subscribes to live progress via EventSource before each turn. */
function mockChatStream() {
    vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockReturnValue(() => { });
}
function mockChatSend(result) {
    return vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockResolvedValue(result);
}
const OK_RESPONSE = {
    ok: true,
    content: 'I checked the repo — the build is green.',
    followups: [
        { prompt: 'Run the full test suite', label: 'Run tests' },
        { prompt: 'Explain the routing changes', label: 'Explain routing' },
    ],
    provider: 'groq',
    model: 'llama-3.3-70b',
    generationFailed: false,
};
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
    (0, api_1.setAdminToken)(null);
});
(0, vitest_1.describe)('ChatPage', () => {
    (0, vitest_1.it)('shows the login gate when unauthenticated', async () => {
        mockAuthed('admin', false);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByPlaceholderText(/Message the agent/)).toBeNull();
    });
    (0, vitest_1.it)('sends a message and renders the assistant reply with followup chips', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'check the repo' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalled());
        (0, vitest_1.expect)(send.mock.calls[0][1]).toBe('check the repo');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('You')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Run tests/ })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/groq \/ llama-3.3-70b/)).toBeTruthy();
    });
    (0, vitest_1.it)('clicking a followup chip sends its prompt as the next message', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Run tests/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Run tests/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalledTimes(2));
        (0, vitest_1.expect)(send.mock.calls[1][1]).toBe('Run the full test suite');
    });
    (0, vitest_1.it)('shows the error, KEEPS the user bubble, and offers Retry on failure', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend({ ok: false, error: 'The agent could not answer.' });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'boom' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/The agent could not answer/)).toBeTruthy());
        // P4 — the optimistic user bubble stays (the message was sent) so the
        // Retry affordance can re-send it.
        (0, vitest_1.expect)(react_1.screen.getByText('You')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('boom')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
        // Clicking Retry re-sends the SAME message through the normal flow.
        send.mockResolvedValueOnce(OK_RESPONSE);
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Retry/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send.mock.calls[1][1]).toBe('boom'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        // The Retry affordance cleared once the retry succeeded.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Retry/ })).toBeNull());
    });
    (0, vitest_1.it)('new conversation starts a fresh thread (the old one stays persisted in the sidebar)', async () => {
        mockAuthed('admin');
        mockChatStream();
        mockChatSend(OK_RESPONSE);
        // P4 — the just-abandoned session now appears in the sidebar.
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listChatSessions').mockResolvedValue([
            { id: 'any-id', title: 'hi', turnCount: 2, createdAt: 1, updatedAt: 2, preview: 'I checked the repo', firstUser: 'hi' },
        ]);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /New conversation/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('I checked the repo — the build is green.')).toBeNull());
        // The sidebar refreshes with the abandoned conversation.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('hi').length).toBeGreaterThan(0));
    });
    (0, vitest_1.it)('disables the send button while a turn is in flight', async () => {
        mockAuthed('admin');
        mockChatStream();
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Working/ })).toBeTruthy());
        // The send button shows the busy label while a turn is in flight.
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Working/ }).disabled).toBe(true);
        (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/).disabled).toBe(true);
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    });
    (0, vitest_1.it)('P4 — Cancel aborts the in-flight turn and keeps the user bubble', async () => {
        mockAuthed('admin');
        mockChatStream();
        let signal = null;
        // Mirror the real chatSend: an aborted fetch resolves ok:false (the
        // internal catch) rather than rejecting — the page then recognizes the
        // user-initiated cancel via the controller's signal.
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation((_sid, _msg, _opts, sig) => new Promise((resolve) => {
            signal = sig ?? null;
            sig?.addEventListener('abort', () => resolve({ ok: false, error: 'Could not reach the dashboard server.' }));
        }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'long task' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /Cancel/ })).toBeTruthy());
        // The turn's abort signal reaches chatSend (busy shows first, so wait).
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(signal).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Cancel/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(signal.aborted).toBe(true));
        // The user bubble stays (the message was sent) and the input re-enables
        // (busy cleared) — the turn was abandoned, not failed.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('long task')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/).disabled).toBe(false));
        // No error banner and no Retry on a user-initiated cancel.
        (0, vitest_1.expect)(react_1.screen.queryByText(/could not answer|could not reach/i)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    });
    (0, vitest_1.it)('streams the agent working steps live and snapshots them into the reply', async () => {
        mockAuthed('admin');
        let progressCb = null;
        let unsub = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            progressCb = handlers.onProgress ?? null;
            unsub = vitest_1.vi.fn();
            return unsub;
        });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the test' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(progressCb).toBeTruthy());
        // The engine's live working steps stream in while the turn is in flight.
        progressCb('→ calling tool: read_file');
        progressCb('→ running tests: npm test');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('→ calling tool: read_file')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('→ running tests: npm test')).toBeTruthy();
        // On completion, the steps snapshot into the assistant bubble's collapsible.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/2 steps/)).toBeTruthy());
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P4 — streams answer tokens into a live bubble, then the POST response replaces them', async () => {
        mockAuthed('admin');
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let tokenCb = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            tokenCb = handlers.onToken ?? null;
            return vitest_1.vi.fn();
        });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'write it' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(tokenCb).toBeTruthy());
        // Tokens typewrite into the LIVE assistant bubble while the POST is in flight.
        tokenCb('Here');
        tokenCb(' is ');
        tokenCb('the answer.');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Here is the answer.')).toBeTruthy());
        // The POST response is AUTHORITATIVE — the final message renders it and
        // the streamed preview is replaced (not merged), exactly like the engine's
        // S1 longest-substantive selection.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('Here is the answer.')).toBeNull());
    });
    (0, vitest_1.it)('P0.6 — renders live tool-call cards and snapshots them into the reply', async () => {
        mockAuthed('admin');
        let toolCb = null;
        let unsub = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            toolCb = handlers.onTool ?? null;
            unsub = vitest_1.vi.fn();
            return unsub;
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'inspect the repo' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(toolCb).toBeTruthy());
        // read_file starts (running card) and completes (ok + duration).
        toolCb({ id: 'call_1', tool: 'read_file', phase: 'started', args: "{path: 'src/foo.ts'}" });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('read_file')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText("{path: 'src/foo.ts'}")).toBeTruthy();
        toolCb({ id: 'call_1', tool: 'read_file', phase: 'called', ok: true, result: '1 | export const x = 1;', durationMs: 12 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('12ms')).toBeTruthy());
        // run_terminal fails → the card shows the error body.
        toolCb({ id: 'call_2', tool: 'run_terminal', phase: 'started', args: "{command: 'npm test'}" });
        toolCb({ id: 'call_2', tool: 'run_terminal', phase: 'called', ok: false, error: 'exit 1', durationMs: 300 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Error')).toBeTruthy());
        // On completion the two cards snapshot into the assistant bubble.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/2 tool calls/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('read_file')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('run_terminal')).toBeTruthy();
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P0.7 — renders the live plan checklist and snapshots it into the reply', async () => {
        mockAuthed('admin');
        let planCb = null;
        let unsub = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            planCb = handlers.onPlan ?? null;
            unsub = vitest_1.vi.fn();
            return unsub;
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the failing test' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(planCb).toBeTruthy());
        // The plan is created — the checklist card appears live with the goal.
        planCb({ goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce the failure', status: 'pending' }], revision: 1 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Fix the failing test')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('0/1 done')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Reproduce the failure')).toBeTruthy();
        // A later mutation updates the card IN PLACE (revision 2, status done).
        planCb({ goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce the failure', status: 'done' }], revision: 2 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('1/1 done')).toBeTruthy());
        // On completion the plan snapshots into the assistant bubble.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Plan: Fix the failing test/)).toBeTruthy());
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P3b — renders the git diff card live and snapshots it into the reply', async () => {
        mockAuthed('admin');
        let diffCb = null;
        let unsub = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            diffCb = handlers.onDiff ?? null;
            unsub = vitest_1.vi.fn();
            return unsub;
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show my changes' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(diffCb).toBeTruthy());
        // The git tool emitted a diff — the card appears live with +/− lines.
        diffCb({ files: [{ path: 'a.txt', body: 'diff --git a/a.txt b/a.txt\n+three\n-one' }], summary: '1 file changed' });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('git diff')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/1 file · \+1 −1/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('a.txt')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('+three')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('-one')).toBeTruthy();
        // On completion the diff snapshots into the assistant bubble.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Changes: 1 file changed/)).toBeTruthy());
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P6a — renders the skill draft preview card: accept saves, reject discards', async () => {
        mockAuthed('admin');
        let draftCb = null;
        let unsub = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            draftCb = handlers.onSkillDraft ?? null;
            unsub = vitest_1.vi.fn();
            return unsub;
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        const acceptSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'skillDraftAccept').mockResolvedValue({ ok: true });
        const rejectSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'skillDraftReject').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'learn the S3 flow' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(draftCb).toBeTruthy());
        // skill_manage create emitted the draft — the preview card appears.
        draftCb({ name: 's3-upload', description: 'Upload artifacts to S3.', markdown: '---\nname: s3-upload\ndescription: Upload artifacts to S3.\n---\n# Steps\n...', updatedAt: 123 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('New skill draft: s3-upload')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('Upload artifacts to S3.')).toBeTruthy();
        // ✅ Accept calls the accept endpoint and marks the card saved.
        react_1.fireEvent.click(react_1.screen.getByText('✅ Accept'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(acceptSpy).toHaveBeenCalledWith('s3-upload'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Saved — the skill is live/)).toBeTruthy());
        (0, vitest_1.expect)(rejectSpy).not.toHaveBeenCalled();
        // On completion the draft snapshots into the assistant bubble.
        resolveSend(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P6a — rejecting a draft calls the reject endpoint and marks the card discarded', async () => {
        mockAuthed('admin');
        let draftCb = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            draftCb = handlers.onSkillDraft ?? null;
            return vitest_1.vi.fn();
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        const rejectSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'skillDraftReject').mockResolvedValue({ ok: true });
        const acceptSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'skillDraftAccept').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'learn the flow' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(draftCb).toBeTruthy());
        draftCb({ name: 'schema-check', description: 'Validate schema drift.', markdown: '---\nname: schema-check\ndescription: Validate schema drift.\n---\n# Steps\n...', updatedAt: 1 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('New skill draft: schema-check')).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByText('↩ Reject'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(rejectSpy).toHaveBeenCalledWith('schema-check'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Rejected — the draft was discarded/)).toBeTruthy());
        (0, vitest_1.expect)(acceptSpy).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('P0.1 — renders the agent question card and answers it via chatRespond', async () => {
        mockAuthed('admin');
        let questionCb = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            questionCb = handlers.onQuestion ?? null;
            return vitest_1.vi.fn();
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockResolvedValue(OK_RESPONSE);
        const respondSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatRespond').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the failing test' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(questionCb).toBeTruthy());
        // The agent asks "Should I fix it?"; the card appears with both choices.
        questionCb({ questionId: 'q-1', question: 'Should I fix it?', choices: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Should I fix it\?/)).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('Yes')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('No')).toBeTruthy();
        // Picking a choice + submit answers the question through the API.
        react_1.fireEvent.click(react_1.screen.getByText('Yes'));
        react_1.fireEvent.click(react_1.screen.getByText('Choose'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(respondSpy).toHaveBeenCalledWith(vitest_1.expect.any(String), 'q-1', { index: 0 }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText(/Should I fix it\?/)).toBeNull());
    });
    (0, vitest_1.it)('Phase 1 — renders the assistant reply as markdown (headings, code, lists)', async () => {
        mockAuthed('admin');
        mockChatStream();
        mockChatSend({
            ...OK_RESPONSE,
            content: '## Result\n\nHere is the **fix**:\n\n```ts\nconst x = 1;\n```\n\n- one\n- two',
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix it' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('Result')).toBeTruthy());
        // Bold rendered as <strong>, code fence as a block with the lang label.
        (0, vitest_1.expect)(react_1.screen.getByText('fix').tagName).toBe('STRONG');
        (0, vitest_1.expect)(react_1.screen.getByText('ts')).toBeTruthy();
        // rehype-highlight tokenizes the body; the raw text is on the <code>.
        (0, vitest_1.expect)(document.querySelector('.md-code-pre code')?.textContent?.trim()).toBe('const x = 1;');
        (0, vitest_1.expect)(react_1.screen.getByText('one')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('two')).toBeTruthy();
    });
    (0, vitest_1.it)('Phase 5 — empty-state onboarding chips send their prompt', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        // P6e — the skill suggestions are part of the empty state (the shipable
        // first-party batch is the onboarding entry point).
        const skillChip = react_1.screen.getByRole('button', { name: /load the code-assessment skill/ });
        (0, vitest_1.expect)(skillChip).toBeTruthy();
        const learnChip = react_1.screen.getByRole('button', { name: /learn a workflow as a skill/ });
        (0, vitest_1.expect)(learnChip).toBeTruthy();
        const chip = react_1.screen.getByRole('button', { name: /assess this project/ });
        (0, vitest_1.expect)(chip).toBeTruthy();
        react_1.fireEvent.click(chip);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalled());
        (0, vitest_1.expect)(send.mock.calls[0][1]).toBe("what's the state of this project?");
    });
    (0, vitest_1.it)('Phase 6 — Enter sends, Shift+Enter does not, ↑ recalls the last message', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        const box = react_1.screen.getByPlaceholderText(/Message the agent/);
        // Send the first message with Enter.
        react_1.fireEvent.change(box, { target: { value: 'first ask' } });
        react_1.fireEvent.keyDown(box, { key: 'Enter' });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalledTimes(1));
        (0, vitest_1.expect)(send.mock.calls[0][1]).toBe('first ask');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
        // Shift+Enter must NOT submit (newline in the box instead).
        react_1.fireEvent.change(box, { target: { value: 'multi\nline' } });
        react_1.fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
        (0, vitest_1.expect)(send).toHaveBeenCalledTimes(1);
        // Clear the box, press ↑ → the last sent message comes back.
        react_1.fireEvent.change(box, { target: { value: '' } });
        react_1.fireEvent.keyDown(box, { key: 'ArrowUp' });
        (0, vitest_1.expect)(box.value).toBe('first ask');
    });
    (0, vitest_1.it)('Phase 3 — the project bar attaches a directory and sends its path with the message', async () => {
        mockAuthed('admin');
        mockChatStream();
        const send = mockChatSend(OK_RESPONSE);
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listProjects').mockResolvedValue([
            { path: '/tmp/my-app', name: 'my-app', kind: 'recent' },
        ]);
        const attach = vitest_1.vi.spyOn(api_1.dashboardAPI, 'attachProject').mockResolvedValue({
            ok: true,
            project: { path: '/tmp/my-app', name: 'my-app', fileCount: 42, symbolCount: 120, truncated: false },
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        // The bar offers recent projects as one-click attach chips.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /my-app/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /my-app/ }));
        // Attached state shows the project + its stats.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(attach).toHaveBeenCalledWith('/tmp/my-app'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('my-app')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/42 files · 120 symbols/)).toBeTruthy();
        // The message carries the attached path so the server injects context.
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess this project' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalled());
        (0, vitest_1.expect)(send.mock.calls[0][2]?.projectPath).toBe('/tmp/my-app');
        // Detaching clears the bar back to the picker.
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /detach/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Select Project Folder/)).toBeTruthy());
    });
    (0, vitest_1.it)('Phase 4 — the session sidebar lists past conversations and resumes them', async () => {
        mockAuthed('admin');
        mockChatStream();
        mockChatSend(OK_RESPONSE);
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listChatSessions').mockResolvedValue([
            { id: 'sess-1', title: 'assess the repo', turnCount: 4, createdAt: 1, updatedAt: 2, preview: 'the build is green', firstUser: 'assess the repo' },
            { id: 'sess-2', title: 'fix the failing test', turnCount: 2, createdAt: 1, updatedAt: 1, preview: 'fixed it', firstUser: 'fix the failing test' },
        ]);
        const getSession = vitest_1.vi.spyOn(api_1.dashboardAPI, 'getChatSession').mockResolvedValue({
            title: 'assess the repo',
            updatedAt: 2,
            turns: [
                { role: 'user', content: 'assess the repo' },
                { role: 'assistant', content: '**all green**' },
                { role: 'user', content: 'what about tests?' },
                { role: 'assistant', content: '220 pass' },
            ],
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('assess the repo').length).toBeGreaterThan(0));
        (0, vitest_1.expect)(react_1.screen.getAllByText('fix the failing test').length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getByText(/4 msgs · /)).toBeTruthy();
        // Click the session → its transcript loads into the thread (markdown-rendered).
        react_1.fireEvent.click(react_1.screen.getAllByText('assess the repo')[0]);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(getSession).toHaveBeenCalledWith('sess-1'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('all green')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('what about tests?')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('220 pass')).toBeTruthy();
    });
    (0, vitest_1.it)('P0.1 — skip lets the agent proceed on best judgment (index -1)', async () => {
        mockAuthed('admin');
        let questionCb = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            questionCb = handlers.onQuestion ?? null;
            return vitest_1.vi.fn();
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockResolvedValue(OK_RESPONSE);
        const respondSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatRespond').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'add rahul to whatsapp' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(questionCb).toBeTruthy());
        questionCb({ questionId: 'q-2', question: 'Verified list or send-by-name?', choices: [{ label: 'Verified list' }, { label: 'Send-by-name' }], multiSelect: false });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Verified list or send-by-name\?/)).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByText(/Skip/));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(respondSpy).toHaveBeenCalledWith(vitest_1.expect.any(String), 'q-2', { index: -1 }));
    });
    (0, vitest_1.it)('P8 — large pasted text is offered as an attachment and becomes a chip', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        const longText = 'x'.repeat(2500);
        react_1.fireEvent.paste(react_1.screen.getByPlaceholderText(/Message the agent/), {
            clipboardData: { getData: () => longText },
        });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/2,500 characters/)).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByText(/Attach as text/));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/pasted-text.txt/)).toBeTruthy());
    });
    (0, vitest_1.it)('P8 — smart rail: sidebar collapses while working and returns when done', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveTurn = () => { };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveTurn = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('📁 Sessions')).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'analyze' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        // While the turn is in flight the sidebar collapses to the rail.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('📁 Sessions')).toBeNull());
        (0, vitest_1.expect)(react_1.screen.getByTitle('Show history')).toBeTruthy();
        resolveTurn(OK_RESPONSE);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('📁 Sessions')).toBeTruthy());
    });
    (0, vitest_1.it)('P8 — sidebar search filters sessions and date groups render', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listChatSessions').mockResolvedValue([
            { id: 's-a', title: 'assess the repo', turnCount: 4, createdAt: Date.now(), updatedAt: Date.now(), preview: 'the build is green', firstUser: 'assess the repo' },
            { id: 's-b', title: 'deploy the site', turnCount: 2, createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000, preview: 'deployed', firstUser: 'deploy the site' },
        ]);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('assess the repo').length).toBeGreaterThan(0));
        // Date groups: Today + Yesterday.
        (0, vitest_1.expect)(react_1.screen.getByText('Today')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('Yesterday')).toBeTruthy();
        // Search narrows the list.
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Search conversations/), { target: { value: 'deploy' } });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('assess the repo')).toBeNull());
        (0, vitest_1.expect)(react_1.screen.getAllByText('deploy the site').length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('P8 — sidebar rename and delete manage the session list', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listChatSessions').mockResolvedValue([
            { id: 's-1', title: 'old title', turnCount: 1, createdAt: 1, updatedAt: 2, preview: 'x', firstUser: 'old title' },
        ]);
        const delSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'deleteChatSession').mockResolvedValue({ ok: true });
        const renSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'renameChatSession').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('old title').length).toBeGreaterThan(0));
        // Rename: pencil → inline input → Enter commits.
        react_1.fireEvent.click(react_1.screen.getByTitle('Rename'));
        const renameInput = await react_1.screen.findByPlaceholderText('Session title');
        react_1.fireEvent.change(renameInput, { target: { value: 'new title' } });
        react_1.fireEvent.keyDown(renameInput, { key: 'Enter' });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(renSpy).toHaveBeenCalledWith('s-1', 'new title'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText('new title').length).toBeGreaterThan(0));
        // Delete: trash → API called + session removed from the list.
        react_1.fireEvent.click(react_1.screen.getByTitle('Delete'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(delSpy).toHaveBeenCalledWith('s-1'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('new title')).toBeNull());
    });
    (0, vitest_1.it)('P8 — New chat button resets the thread', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        mockChatSend(OK_RESPONSE);
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hello' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('You')).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByText('＋ New'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.queryByText('You')).toBeNull());
        (0, vitest_1.expect)(react_1.screen.getByText(/Say anything/)).toBeTruthy();
    });
    (0, vitest_1.it)('P2 — extracts artifact cards (diff/result/deploy) from the answer text', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        mockChatSend({
            ...OK_RESPONSE,
            content: [
                'I fixed the bug:',
                '```diff',
                'diff --git a/src/fix.ts b/src/fix.ts',
                '--- a/src/fix.ts',
                '+++ b/src/fix.ts',
                '@@ -1 +1 @@',
                '-broken',
                '+fixed',
                '```',
                '```',
                'PASS src/fix.test.ts',
                '```',
                '🚀 Preview: https://preview.example.com',
            ].join('\n'),
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the bug' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        // The ```diff block becomes a diff card, the test output a result card,
        // and the deploy line a 🚀 card — NOT just raw markdown.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('git diff')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('src/fix.ts')).toBeTruthy();
        // The result card's verdict badge (the same block also renders as a
        // markdown code fence — both are expected, scope to the card's meta).
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(document.querySelector('.chat-result-meta')?.textContent).toBe('pass'));
        // The card link (the same URL also autolinks in the markdown text —
        // scope to the deploy card's dedicated anchor).
        const deployLink = document.querySelector('.chat-deploy-url');
        (0, vitest_1.expect)(deployLink).toBeTruthy();
        (0, vitest_1.expect)(deployLink.getAttribute('href')).toBe('https://preview.example.com');
    });
    (0, vitest_1.it)('P2 — extracted text diffs stay READ-ONLY without an attached project (prose cannot trigger commits)', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        mockChatSend({
            ...OK_RESPONSE,
            content: ['```diff', 'diff --git a/src/prose.ts b/src/prose.ts', '--- a/src/prose.ts', '+++ b/src/prose.ts', '@@ -1 +1 @@', '-x', '+y', '```'].join('\n'),
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show a diff' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('git diff')).toBeTruthy());
        // No attached project → no accept/reject toggles, no commit button, and
        // a hint explains why.
        (0, vitest_1.expect)(document.querySelectorAll('.chat-diff-toggle')).toHaveLength(0);
        (0, vitest_1.expect)(react_1.screen.queryByText(/Commit accepted/)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText(/Attach a project to review and commit these changes/)).toBeTruthy();
    });
    (0, vitest_1.it)('P2 — extracted text diffs become selectable WITH an attached project and commit there', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'listProjects').mockResolvedValue([{ path: '/tmp/my-app', name: 'my-app', kind: 'recent' }]);
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'attachProject').mockResolvedValue({
            ok: true,
            project: { path: '/tmp/my-app', name: 'my-app', fileCount: 10, symbolCount: 20, truncated: false },
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: /my-app/ })).toBeTruthy());
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /my-app/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('my-app')).toBeTruthy());
        // Now send a message whose answer contains a ```diff block.
        const send = mockChatSend({
            ...OK_RESPONSE,
            content: ['```diff', 'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', '```'].join('\n'),
        });
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'make the change' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('git diff')).toBeTruthy());
        // With the project attached the extracted diff IS selectable.
        const toggles = react_1.screen.getAllByTitle(/Accepted — click to reject/);
        (0, vitest_1.expect)(toggles.length).toBe(1);
        // Commit accepted → the message names the ATTACHED PROJECT path so the
        // agent commits in that working tree, and only the accepted file.
        react_1.fireEvent.click(react_1.screen.getByText(/Commit accepted \(1\)/));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(send).toHaveBeenCalledTimes(2));
        const commitMsg = send.mock.calls[1][1];
        (0, vitest_1.expect)(commitMsg).toContain('/tmp/my-app');
        (0, vitest_1.expect)(commitMsg).toContain('src/a.ts');
    });
    (0, vitest_1.it)('P2 — the snapshotted diff card accepts/rejects files and commits the subset', async () => {
        mockAuthed('admin');
        let diffCb = null;
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
            diffCb = handlers.onDiff ?? null;
            return vitest_1.vi.fn();
        });
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        let resolveSend = () => { };
        const sendSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatSend').mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show my changes' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(diffCb).toBeTruthy());
        diffCb({ files: [{ path: 'a.ts', body: 'diff --git a/a.ts b/a.ts\n+new-a' }, { path: 'b.ts', body: 'diff --git a/b.ts b/b.ts\n+new-b' }], summary: '2 files changed' });
        resolveSend(OK_RESPONSE);
        // The snapshotted card shows per-file toggles, all accepted by default.
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Commit accepted \(2\)/)).toBeTruthy());
        const toggles = react_1.screen.getAllByTitle(/Accepted — click to reject/);
        (0, vitest_1.expect)(toggles.length).toBe(2);
        // Reject b.ts → only a.ts remains accepted.
        react_1.fireEvent.click(toggles[1]);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Commit accepted \(1\)/)).toBeTruthy());
        // Committing sends a chat turn naming ONLY the accepted file.
        react_1.fireEvent.click(react_1.screen.getByText(/Commit accepted \(1\)/));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(sendSpy.mock.calls.length).toBeGreaterThan(1));
        const commitMsg = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][1];
        (0, vitest_1.expect)(commitMsg).toContain('a.ts');
        (0, vitest_1.expect)(commitMsg).not.toContain('b.ts');
    });
    (0, vitest_1.it)('P2 — the ⚡ Run path renders a live execution card with logs and exit code', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({
            ok: true,
            matches: [{ intent: 'run tests', summary: 'Run the test suite', command: 'test run', score: 0.9 }],
        });
        let statusCb = null;
        let logCb = null;
        const taskBase = {
            id: 'task-1',
            command: 'test run',
            args: ['test', 'run'],
            cwd: '.',
            startedAt: 1,
            finishedAt: null,
            timeoutMs: 60000,
            logs: [],
        };
        const unsub = vitest_1.vi.fn();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'subscribeTask').mockImplementation((_id, handlers) => {
            statusCb = handlers.onStatus ?? null;
            logCb = handlers.onLog ?? null;
            return unsub;
        });
        void statusCb;
        void logCb;
        // The task runs then SETTLES: the mock stays running until the test flips
        // `settled` (before firing onStatus('done')), after which snapshots carry
        // the exit code + final logs — exactly what the real server returns.
        let settled = false;
        const runningTask = { ...taskBase, status: 'running', exitCode: null, durationMs: null };
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'getTask').mockImplementation(async () => ({
            status: 200,
            task: settled
                ? { ...taskBase, status: 'done', exitCode: 0, finishedAt: 2, durationMs: 100, logs: [{ stream: 'stdout', text: '1 test passed', at: 1 }] }
                : runningTask,
        }));
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'startTask').mockResolvedValue({ ok: true, task: runningTask });
        const cancelSpy = vitest_1.vi.spyOn(api_1.dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        // A confident command match shows the ⚡ confirm card.
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'run the tests' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Run this command/)).toBeTruthy());
        // ▶ Run starts the task and inserts a LIVE execution card.
        react_1.fireEvent.click(react_1.screen.getByText('▶ Run'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('test run')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText(/⏳ running/)).toBeTruthy();
        // Streamed logs land in the card.
        logCb({ stream: 'stdout', text: '1 test passed', at: 1 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('1 test passed')).toBeTruthy());
        // ANSI escapes are stripped, and a stream switch (stdout → stderr) shows
        // a separator + the error line is marked by stream.
        logCb({ stream: 'stdout', text: '\u001b[32mstarting\u001b[0m', at: 2 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('starting')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.queryByText('\u001b[32mstarting\u001b[0m')).toBeNull();
        logCb({ stream: 'stderr', text: '\u001b[31mboom\u001b[0m', at: 3 });
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText('boom')).toBeTruthy());
        (0, vitest_1.expect)(react_1.screen.getByText('stderr')).toBeTruthy();
        (0, vitest_1.expect)(document.querySelector('.chat-task-log-stderr')?.textContent).toBe('boom');
        // The copy button copies the FULL output, ANSI-stripped (clean text, no
        // color codes — matching what the card renders).
        const writeText = vitest_1.vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const copyBtn = document.querySelector('.chat-task-card .chat-card-copy');
        (0, vitest_1.expect)(copyBtn).toBeTruthy();
        react_1.fireEvent.click(copyBtn);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(writeText).toHaveBeenCalledWith(['1 test passed', 'starting', 'boom'].join('\n')));
        // Cancel is available while running (scope to the TASK card — the busy
        // composer also renders a ⏹ Cancel for the agent turn).
        const taskCancel = document.querySelector('.chat-task-card .admin-mini-btn');
        (0, vitest_1.expect)(taskCancel).toBeTruthy();
        react_1.fireEvent.click(taskCancel);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(cancelSpy).toHaveBeenCalledWith('task-1'));
        // Settling the status shows the exit code and releases busy (the status
        // event itself carries no exit code — the final snapshot provides it).
        settled = true;
        statusCb('done');
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/exit 0/)).toBeTruthy());
        (0, vitest_1.expect)(unsub).toHaveBeenCalled();
    });
    (0, vitest_1.it)('P2 — result and deploy cards have copy buttons that copy their content', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        const writeText = vitest_1.vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        mockChatSend({
            ...OK_RESPONSE,
            content: [
                '```',
                'PASS src/a.test.ts',
                '```',
                '🚀 Preview: https://preview.example.com',
            ].join('\n'),
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'run it' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(document.querySelectorAll('.chat-card-copy').length).toBe(2));
        // The result card's copy button copies the OUTPUT body; the deploy card's
        // copies the URL.
        const resultCard = document.querySelector('.chat-result-card');
        const resultCopy = resultCard.querySelector('.chat-card-copy');
        react_1.fireEvent.click(resultCopy);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(writeText).toHaveBeenCalledWith('PASS src/a.test.ts\n'));
        const deployCopy = document.querySelector('.chat-deploy-card .chat-card-copy');
        react_1.fireEvent.click(deployCopy);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(writeText).toHaveBeenCalledWith('https://preview.example.com'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getAllByText(/Copied/).length).toBeGreaterThan(0));
    });
    (0, vitest_1.it)('P2 — artifact cards are keyboard-navigable: ↑/↓ moves focus between them', async () => {
        mockAuthed('admin');
        mockChatStream();
        vitest_1.vi.spyOn(api_1.dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
        mockChatSend({
            ...OK_RESPONSE,
            content: [
                '```diff',
                'diff --git a/a.ts b/a.ts',
                '--- a/a.ts',
                '+++ b/a.ts',
                '@@ -1 +1 @@',
                '-x',
                '+y',
                '```',
                '```',
                'PASS src/a.test.ts',
                '```',
                '🚀 Preview: https://preview.example.com',
            ].join('\n'),
        });
        (0, react_1.render)(<ChatPage_1.default />);
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
        react_1.fireEvent.change(react_1.screen.getByPlaceholderText(/Message the agent/), { target: { value: 'summarize' } });
        react_1.fireEvent.submit(react_1.screen.getByPlaceholderText(/Message the agent/).closest('form'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(document.querySelectorAll('[data-artifact-card]').length).toBe(3));
        // Focus the first card, then ↓ moves to the second, ↑ back to the first,
        // and End jumps to the last.
        const cards = document.querySelectorAll('[data-artifact-card]');
        cards[0].focus();
        (0, vitest_1.expect)(document.activeElement).toBe(cards[0]);
        react_1.fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
        (0, vitest_1.expect)(document.activeElement).toBe(cards[1]);
        react_1.fireEvent.keyDown(cards[1], { key: 'ArrowDown' });
        (0, vitest_1.expect)(document.activeElement).toBe(cards[2]);
        react_1.fireEvent.keyDown(cards[2], { key: 'ArrowUp' });
        (0, vitest_1.expect)(document.activeElement).toBe(cards[1]);
        react_1.fireEvent.keyDown(cards[1], { key: 'Home' });
        (0, vitest_1.expect)(document.activeElement).toBe(cards[0]);
        react_1.fireEvent.keyDown(cards[0], { key: 'End' });
        (0, vitest_1.expect)(document.activeElement).toBe(cards[2]);
    });
});
