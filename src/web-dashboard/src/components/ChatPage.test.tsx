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
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText(/working/)).toBeTruthy());
    // The send button shows the busy label while a turn is in flight.
    expect((screen.getByRole('button', { name: /Working/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText(/Message the agent/) as HTMLInputElement).disabled).toBe(true);

    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
  });
});
