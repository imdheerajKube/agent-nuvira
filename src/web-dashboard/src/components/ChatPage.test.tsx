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

  it('new conversation resets the thread and the server session', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend(OK_RESPONSE);
    const reset = vi.spyOn(dashboardAPI, 'chatReset').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    await waitFor(() => expect(reset).toHaveBeenCalled());
    expect(screen.queryByText('I checked the repo — the build is green.')).toBeNull();
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
