/**
 * P3 — ChatPage tests (dashboard chat console).
 *
 * The page threads a conversation through the mocked chat API: user bubbles,
 * assistant replies with followup chips (clicking sends the prompt), the
 * working state, error handling, and the auth gate. No LLM, no server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ChatPage from './ChatPage';
import { dashboardAPI, setAdminToken } from '../api';

function mockAuthed(role: 'admin' | 'operator' | 'viewer' = 'admin', authenticated = true) {
  vi.spyOn(dashboardAPI, 'fetchAdminAuthStatus').mockResolvedValue({
    configured: true,
    authenticated,
    user: authenticated ? 'admin' : null,
    role: authenticated ? role : null,
  });
}

/** The page subscribes to live progress via EventSource before each turn. */
function mockChatStream() {
  vi.spyOn(dashboardAPI, 'subscribeChat').mockReturnValue(() => {});
}

type ChatSendResult = Awaited<ReturnType<typeof dashboardAPI.chatSend>>;

function mockChatSend(result: ChatSendResult) {
  return vi.spyOn(dashboardAPI, 'chatSend').mockResolvedValue(result);
}

const OK_RESPONSE = {
  ok: true as const,
  content: 'I checked the repo — the build is green.',
  followups: [
    { prompt: 'Run the full test suite', label: 'Run tests' },
    { prompt: 'Explain the routing changes', label: 'Explain routing' },
  ],
  provider: 'groq',
  model: 'llama-3.3-70b',
  generationFailed: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setAdminToken(null);
});

describe('ChatPage', () => {
  it('shows the login gate when unauthenticated', async () => {
    mockAuthed('admin', false);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText(/Log in \(admin or operator\)/)).toBeTruthy());
    expect(screen.queryByPlaceholderText(/Message the agent/)).toBeNull();
  });

  it('sends a message and renders the assistant reply with followup chips', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'check the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1]).toBe('check the repo');
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run tests/ })).toBeTruthy();
    expect(screen.getByText(/groq \/ llama-3.3-70b/)).toBeTruthy();
  });

  it('clicking a followup chip sends its prompt as the next message', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Run tests/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Run tests/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][1]).toBe('Run the full test suite');
  });

  it('shows the error and drops the optimistic bubble on failure', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend({ ok: false as const, error: 'The agent could not answer.' });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'boom' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText(/The agent could not answer/)).toBeTruthy());
    expect(screen.queryByText('You')).toBeNull();
  });

  it('new conversation starts a fresh thread (the old one stays persisted in the sidebar)', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend(OK_RESPONSE);
    // P4 — the just-abandoned session now appears in the sidebar.
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 'any-id', title: 'hi', turnCount: 2, createdAt: 1, updatedAt: 2, preview: 'I checked the repo' },
    ]);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    await waitFor(() => expect(screen.queryByText('I checked the repo — the build is green.')).toBeNull());
    // The sidebar refreshes with the abandoned conversation.
    await waitFor(() => expect(screen.getByText('hi')).toBeTruthy());
  });

  it('disables the send button while a turn is in flight', async () => {
    mockAuthed('admin');
    mockChatStream();
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Working/ })).toBeTruthy());
    // The send button shows the busy label while a turn is in flight.
    expect((screen.getByRole('button', { name: /Working/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText(/Message the agent/) as HTMLInputElement).disabled).toBe(true);

    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
  });

  it('streams the agent working steps live and snapshots them into the reply', async () => {
    mockAuthed('admin');
    let progressCb: ((line: string) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      progressCb = handlers.onProgress ?? null;
      unsub = vi.fn();
      return unsub;
    });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the test' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(progressCb).toBeTruthy());

    // The engine's live working steps stream in while the turn is in flight.
    progressCb!('→ calling tool: read_file');
    progressCb!('→ running tests: npm test');
    await waitFor(() => expect(screen.getByText('→ calling tool: read_file')).toBeTruthy());
    expect(screen.getByText('→ running tests: npm test')).toBeTruthy();

    // On completion, the steps snapshot into the assistant bubble's collapsible.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/2 steps/)).toBeTruthy());
    expect(unsub).toHaveBeenCalled();
  });

  it('P4 — streams answer tokens into a live bubble, then the POST response replaces them', async () => {
    mockAuthed('admin');
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let tokenCb: ((text: string) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      tokenCb = handlers.onToken ?? null;
      return vi.fn();
    });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'write it' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(tokenCb).toBeTruthy());

    // Tokens typewrite into the LIVE assistant bubble while the POST is in flight.
    tokenCb!('Here');
    tokenCb!(' is ');
    tokenCb!('the answer.');
    await waitFor(() => expect(screen.getByText('Here is the answer.')).toBeTruthy());

    // The POST response is AUTHORITATIVE — the final message renders it and
    // the streamed preview is replaced (not merged), exactly like the engine's
    // S1 longest-substantive selection.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Here is the answer.')).toBeNull());
  });

  it('P0.6 — renders live tool-call cards and snapshots them into the reply', async () => {
    mockAuthed('admin');
    let toolCb: ((t: { id: string; tool: string; phase: 'started' | 'called'; args?: string; ok?: boolean; result?: string; error?: string; durationMs?: number }) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      toolCb = handlers.onTool ?? null;
      unsub = vi.fn();
      return unsub;
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'inspect the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(toolCb).toBeTruthy());

    // read_file starts (running card) and completes (ok + duration).
    toolCb!({ id: 'call_1', tool: 'read_file', phase: 'started', args: "{path: 'src/foo.ts'}" });
    await waitFor(() => expect(screen.getByText('read_file')).toBeTruthy());
    expect(screen.getByText("{path: 'src/foo.ts'}")).toBeTruthy();
    toolCb!({ id: 'call_1', tool: 'read_file', phase: 'called', ok: true, result: '1 | export const x = 1;', durationMs: 12 });
    await waitFor(() => expect(screen.getByText('12ms')).toBeTruthy());

    // run_terminal fails → the card shows the error body.
    toolCb!({ id: 'call_2', tool: 'run_terminal', phase: 'started', args: "{command: 'npm test'}" });
    toolCb!({ id: 'call_2', tool: 'run_terminal', phase: 'called', ok: false, error: 'exit 1', durationMs: 300 });
    await waitFor(() => expect(screen.getByText('Error')).toBeTruthy());

    // On completion the two cards snapshot into the assistant bubble.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/2 tool calls/)).toBeTruthy());
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('run_terminal')).toBeTruthy();
    expect(unsub).toHaveBeenCalled();
  });

  it('P0.7 — renders the live plan checklist and snapshots it into the reply', async () => {
    mockAuthed('admin');
    let planCb: ((p: { goal: string; steps: Array<{ id: string; description: string; status: string }>; revision: number }) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      planCb = handlers.onPlan ?? null;
      unsub = vi.fn();
      return unsub;
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the failing test' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(planCb).toBeTruthy());

    // The plan is created — the checklist card appears live with the goal.
    planCb!({ goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce the failure', status: 'pending' }], revision: 1 });
    await waitFor(() => expect(screen.getByText('Fix the failing test')).toBeTruthy());
    expect(screen.getByText('0/1 done')).toBeTruthy();
    expect(screen.getByText('Reproduce the failure')).toBeTruthy();

    // A later mutation updates the card IN PLACE (revision 2, status done).
    planCb!({ goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce the failure', status: 'done' }], revision: 2 });
    await waitFor(() => expect(screen.getByText('1/1 done')).toBeTruthy());

    // On completion the plan snapshots into the assistant bubble.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Plan: Fix the failing test/)).toBeTruthy());
    expect(unsub).toHaveBeenCalled();
  });

  it('P3b — renders the git diff card live and snapshots it into the reply', async () => {
    mockAuthed('admin');
    let diffCb: ((d: { files: Array<{ path: string; body: string }>; summary: string }) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      diffCb = handlers.onDiff ?? null;
      unsub = vi.fn();
      return unsub;
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show my changes' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(diffCb).toBeTruthy());

    // The git tool emitted a diff — the card appears live with +/− lines.
    diffCb!({ files: [{ path: 'a.txt', body: 'diff --git a/a.txt b/a.txt\n+three\n-one' }], summary: '1 file changed' });
    await waitFor(() => expect(screen.getByText('git diff')).toBeTruthy());
    expect(screen.getByText(/1 file · \+1 −1/)).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.getByText('+three')).toBeTruthy();
    expect(screen.getByText('-one')).toBeTruthy();

    // On completion the diff snapshots into the assistant bubble.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/Changes: 1 file changed/)).toBeTruthy());
    expect(unsub).toHaveBeenCalled();
  });

  it('P0.1 — renders the agent question card and answers it via chatRespond', async () => {
    mockAuthed('admin');
    let questionCb: ((q: { questionId: string; question: string; choices: Array<{ label: string }>; multiSelect: boolean }) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      questionCb = handlers.onQuestion ?? null;
      return vi.fn();
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    vi.spyOn(dashboardAPI, 'chatSend').mockResolvedValue(OK_RESPONSE);
    const respondSpy = vi.spyOn(dashboardAPI, 'chatRespond').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the failing test' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(questionCb).toBeTruthy());

    // The agent asks "Should I fix it?"; the card appears with both choices.
    questionCb!({ questionId: 'q-1', question: 'Should I fix it?', choices: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false });
    await waitFor(() => expect(screen.getByText(/Should I fix it\?/)).toBeTruthy());
    expect(screen.getByText('Yes')).toBeTruthy();
    expect(screen.getByText('No')).toBeTruthy();

    // Picking a choice + submit answers the question through the API.
    fireEvent.click(screen.getByText('Yes'));
    fireEvent.click(screen.getByText('Choose'));
    await waitFor(() => expect(respondSpy).toHaveBeenCalledWith(expect.any(String), 'q-1', { index: 0 }));
    await waitFor(() => expect(screen.queryByText(/Should I fix it\?/)).toBeNull());
  });

  it('Phase 1 — renders the assistant reply as markdown (headings, code, lists)', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend({
      ...OK_RESPONSE,
      content: '## Result\n\nHere is the **fix**:\n\n```ts\nconst x = 1;\n```\n\n- one\n- two',
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix it' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(screen.getByText('Result')).toBeTruthy());
    // Bold rendered as <strong>, code fence as a block with the lang label.
    expect(screen.getByText('fix').tagName).toBe('STRONG');
    expect(screen.getByText('ts')).toBeTruthy();
    // rehype-highlight tokenizes the body; the raw text is on the <code>.
    expect(document.querySelector('.md-code-pre code')?.textContent?.trim()).toBe('const x = 1;');
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two')).toBeTruthy();
  });

  it('Phase 5 — empty-state onboarding chips send their prompt', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    const chip = screen.getByRole('button', { name: /assess this project/ });
    expect(chip).toBeTruthy();
    fireEvent.click(chip);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1]).toBe("what's the state of this project?");
  });

  it('Phase 6 — Enter sends, Shift+Enter does not, ↑ recalls the last message', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
    const box = screen.getByPlaceholderText(/Message the agent/) as HTMLTextAreaElement;

    // Send the first message with Enter.
    fireEvent.change(box, { target: { value: 'first ask' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][1]).toBe('first ask');
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());

    // Shift+Enter must NOT submit (newline in the box instead).
    fireEvent.change(box, { target: { value: 'multi\nline' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(send).toHaveBeenCalledTimes(1);

    // Clear the box, press ↑ → the last sent message comes back.
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('first ask');
  });

  it('Phase 3 — the project bar attaches a directory and sends its path with the message', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    vi.spyOn(dashboardAPI, 'listProjects').mockResolvedValue([
      { path: '/tmp/my-app', name: 'my-app', kind: 'cwd' },
    ]);
    const attach = vi.spyOn(dashboardAPI, 'attachProject').mockResolvedValue({
      ok: true,
      project: { path: '/tmp/my-app', name: 'my-app', fileCount: 42, symbolCount: 120, truncated: false },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    // The bar offers the current dir as a one-click attach.
    await waitFor(() => expect(screen.getByRole('button', { name: /current dir/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /current dir/ }));

    // Attached state shows the project + its stats.
    await waitFor(() => expect(attach).toHaveBeenCalledWith('/tmp/my-app'));
    await waitFor(() => expect(screen.getByText('my-app')).toBeTruthy());
    expect(screen.getByText(/42 files · 120 symbols/)).toBeTruthy();

    // The message carries the attached path so the server injects context.
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess this project' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][2]?.projectPath).toBe('/tmp/my-app');

    // Detaching clears the bar back to the picker.
    fireEvent.click(screen.getByRole('button', { name: /detach/ }));
    await waitFor(() => expect(screen.getByText(/Attach a project/)).toBeTruthy());
  });

  it('Phase 4 — the session sidebar lists past conversations and resumes them', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend(OK_RESPONSE);
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 'sess-1', title: 'assess the repo', turnCount: 4, createdAt: 1, updatedAt: 2, preview: 'the build is green' },
      { id: 'sess-2', title: 'fix the failing test', turnCount: 2, createdAt: 1, updatedAt: 1, preview: 'fixed it' },
    ]);
    const getSession = vi.spyOn(dashboardAPI, 'getChatSession').mockResolvedValue({
      title: 'assess the repo',
      updatedAt: 2,
      turns: [
        { role: 'user' as const, content: 'assess the repo' },
        { role: 'assistant' as const, content: '**all green**' },
        { role: 'user' as const, content: 'what about tests?' },
        { role: 'assistant' as const, content: '220 pass' },
      ],
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText('assess the repo')).toBeTruthy());
    expect(screen.getByText('fix the failing test')).toBeTruthy();
    expect(screen.getByText(/4 msgs · /)).toBeTruthy();

    // Click the session → its transcript loads into the thread (markdown-rendered).
    fireEvent.click(screen.getByText('assess the repo'));
    await waitFor(() => expect(getSession).toHaveBeenCalledWith('sess-1'));
    await waitFor(() => expect(screen.getByText('all green')).toBeTruthy());
    expect(screen.getByText('what about tests?')).toBeTruthy();
    expect(screen.getByText('220 pass')).toBeTruthy();
  });

  it('P0.1 — skip lets the agent proceed on best judgment (index -1)', async () => {
    mockAuthed('admin');
    let questionCb: ((q: { questionId: string; question: string; choices: Array<{ label: string }>; multiSelect: boolean }) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      questionCb = handlers.onQuestion ?? null;
      return vi.fn();
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    vi.spyOn(dashboardAPI, 'chatSend').mockResolvedValue(OK_RESPONSE);
    const respondSpy = vi.spyOn(dashboardAPI, 'chatRespond').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'add rahul to whatsapp' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(questionCb).toBeTruthy());

    questionCb!({ questionId: 'q-2', question: 'Verified list or send-by-name?', choices: [{ label: 'Verified list' }, { label: 'Send-by-name' }], multiSelect: false });
    await waitFor(() => expect(screen.getByText(/Verified list or send-by-name\?/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Skip/));
    await waitFor(() => expect(respondSpy).toHaveBeenCalledWith(expect.any(String), 'q-2', { index: -1 }));
  });
});
