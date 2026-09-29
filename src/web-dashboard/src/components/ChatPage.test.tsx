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
import type { TaskLogLine, TaskStatus, TraceFinding } from '../types';

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
  it('downloads the support bundle for THIS conversation, and says so', async () => {
    // WS2 (#24) — the log is written per turn, so the page has to be able to hand
    // the user the one for the chat they are looking at; that is the whole point
    // of the action, and the SESSION id is the argument that makes it scoped.
    mockAuthed('admin');
    const bundle = vi.spyOn(dashboardAPI, 'chatSupportBundle').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    const button = await screen.findByLabelText('Download support bundle');

    fireEvent.click(button);

    await waitFor(() => expect(bundle).toHaveBeenCalledTimes(1));
    expect(typeof bundle.mock.calls[0][0]).toBe('string');
    expect((bundle.mock.calls[0][0] as string).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/Support bundle downloaded/)).toBeTruthy());
  });

  it('shows the server`s refusal VERBATIM — "logging is off" is guidance, not a failed turn', async () => {
    // The interesting answer is usually "the instrument is off, here is how to
    // turn it on". Flattening it into "download failed" would throw away the only
    // actionable part of the response, so the sentence is rendered as-is.
    mockAuthed('admin');
    const note =
      'Session debug logging is off in the dashboard process, so there is nothing to attach yet. Set NUVIRA_DEBUG_LOG=1, restart the dashboard, send a message, then download again.';
    vi.spyOn(dashboardAPI, 'chatSupportBundle').mockResolvedValue({ ok: false, error: note });
    render(<ChatPage />);
    const button = await screen.findByLabelText('Download support bundle');

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(note)).toBeTruthy());
  });

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

  it('shows the error, KEEPS the user bubble, and offers Retry on failure', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend({ ok: false as const, error: 'The agent could not answer.' });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'boom' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText(/The agent could not answer/)).toBeTruthy());
    // P4 — the optimistic user bubble stays (the message was sent) so the
    // Retry affordance can re-send it.
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();

    // Clicking Retry re-sends the SAME message through the normal flow.
    send.mockResolvedValueOnce(OK_RESPONSE);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(send.mock.calls[1][1]).toBe('boom'));
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    // The Retry affordance cleared once the retry succeeded.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull());
  });

  it('new conversation starts a fresh thread (the old one stays persisted in the sidebar)', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend(OK_RESPONSE);
    // P4 — the just-abandoned session now appears in the sidebar.
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 'any-id', title: 'hi', turnCount: 2, createdAt: 1, updatedAt: 2, preview: 'I checked the repo', firstUser: 'hi' },
    ]);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hi' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New conversation/ }));
    await waitFor(() => expect(screen.queryByText('I checked the repo — the build is green.')).toBeNull());
    // The sidebar refreshes with the abandoned conversation.
    await waitFor(() => expect(screen.getAllByText('hi').length).toBeGreaterThan(0));
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

  it('P4 — Cancel aborts the in-flight turn and keeps the user bubble', async () => {
    mockAuthed('admin');
    mockChatStream();
    let signal: AbortSignal | null = null;
    // Mirror the real chatSend: an aborted fetch resolves ok:false (the
    // internal catch) rather than rejecting — the page then recognizes the
    // user-initiated cancel via the controller's signal.
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      (_sid, _msg, _opts, sig?: AbortSignal) =>
        // Typed as the real result, not cast to the OK fixture: an aborted turn is
        // a FAILED result, which is the whole point of this test.
        new Promise<ChatSendResult>((resolve) => {
          signal = sig ?? null;
          sig?.addEventListener('abort', () => resolve({ ok: false, error: 'Could not reach the dashboard server.' }));
        }),
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'long task' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy());
    // The turn's abort signal reaches chatSend (busy shows first, so wait).
    await waitFor(() => expect(signal).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(signal!.aborted).toBe(true));
    // The user bubble stays (the message was sent) and the input re-enables
    // (busy cleared) — the turn was abandoned, not failed.
    await waitFor(() => expect(screen.getByText('long task')).toBeTruthy());
    await waitFor(() => expect((screen.getByPlaceholderText(/Message the agent/) as HTMLInputElement).disabled).toBe(false));
    // No error banner and no Retry on a user-initiated cancel.
    expect(screen.queryByText(/could not answer|could not reach/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
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

  it('WS1 — renders live finding cards with the GATE verdict, and snapshots them into the reply', async () => {
    mockAuthed('admin');
    let findingCb: ((f: TraceFinding) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      findingCb = handlers.onFinding ?? null;
      unsub = vi.fn();
      return unsub;
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: ChatSendResult) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise<ChatSendResult>((resolve) => { resolveSend = resolve; }),
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'verify the harness' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(findingCb).toBeTruthy());

    // A finding the GATE confirmed: the card shows the EVIDENCE, never just the
    // word CONFIRMED — a verdict with nothing behind it is the defect WS1 closes.
    findingCb!({
      claim: 'the harness can drive every surface',
      verdict: 'CONFIRMED',
      outcome: 'checked by running the harness',
      evidence: [{ kind: 'observation', ref: 'all five surfaces agreed' }],
      source: 'agent',
    });
    await waitFor(() => expect(screen.getByText('the harness can drive every surface')).toBeTruthy());
    expect(screen.getByText('CONFIRMED')).toBeTruthy();
    expect(screen.getByText('all five surfaces agreed')).toBeTruthy();

    // An unearned claim stays PLAUSIBLE and SAYS SO — the gate's refusal has to
    // be visible in the thread, not silently upgraded by the renderer.
    findingCb!({
      claim: 'this guess was never checked',
      verdict: 'PLAUSIBLE',
      outcome: 'reported as a guess',
      evidence: [],
      source: 'agent',
    });
    await waitFor(() => expect(screen.getByText('this guess was never checked')).toBeTruthy());
    expect(screen.getByText('PLAUSIBLE')).toBeTruthy();
    expect(screen.getByText(/no evidence — reported as PLAUSIBLE, not verified/)).toBeTruthy();

    // The POST response is AUTHORITATIVE: it snapshots the findings into the
    // bubble, replacing the live cards (exactly like the streamed answer text).
    const snapshotted: ChatSendResult = {
      ...OK_RESPONSE,
      findings: [
        {
          claim: 'snapshotted claim',
          verdict: 'CONFIRMED',
          outcome: 'checked',
          evidence: [{ kind: 'file', ref: 'src/parity/drivers.ts' }],
          source: 'agent',
        },
      ],
    };
    resolveSend(snapshotted);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('snapshotted claim')).toBeTruthy());
    expect(screen.getByText('src/parity/drivers.ts')).toBeTruthy();
    expect(screen.queryByText('this guess was never checked')).toBeNull();
    expect(unsub).toHaveBeenCalled();
  });

  it('P6a — renders the skill draft preview card: accept saves, reject discards', async () => {
    mockAuthed('admin');
    let draftCb: ((d: { name: string; description: string; markdown: string; updatedAt: number }) => void) | null = null;
    let unsub: (() => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      draftCb = handlers.onSkillDraft ?? null;
      unsub = vi.fn();
      return unsub;
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    const acceptSpy = vi.spyOn(dashboardAPI, 'skillDraftAccept').mockResolvedValue({ ok: true });
    const rejectSpy = vi.spyOn(dashboardAPI, 'skillDraftReject').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'learn the S3 flow' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(draftCb).toBeTruthy());

    // skill_manage create emitted the draft — the preview card appears.
    draftCb!({ name: 's3-upload', description: 'Upload artifacts to S3.', markdown: '---\nname: s3-upload\ndescription: Upload artifacts to S3.\n---\n# Steps\n...', updatedAt: 123 });
    await waitFor(() => expect(screen.getByText('New skill draft: s3-upload')).toBeTruthy());
    expect(screen.getByText('Upload artifacts to S3.')).toBeTruthy();

    // ✅ Accept calls the accept endpoint and marks the card saved.
    fireEvent.click(screen.getByText('✅ Accept'));
    await waitFor(() => expect(acceptSpy).toHaveBeenCalledWith('s3-upload'));
    await waitFor(() => expect(screen.getByText(/Saved — the skill is live/)).toBeTruthy());
    expect(rejectSpy).not.toHaveBeenCalled();

    // On completion the draft snapshots into the assistant bubble.
    resolveSend(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('I checked the repo — the build is green.')).toBeTruthy());
    expect(unsub).toHaveBeenCalled();
  });

  it('P6a — rejecting a draft calls the reject endpoint and marks the card discarded', async () => {
    mockAuthed('admin');
    let draftCb: ((d: { name: string; description: string; markdown: string; updatedAt: number }) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      draftCb = handlers.onSkillDraft ?? null;
      return vi.fn();
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    const rejectSpy = vi.spyOn(dashboardAPI, 'skillDraftReject').mockResolvedValue({ ok: true });
    const acceptSpy = vi.spyOn(dashboardAPI, 'skillDraftAccept').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'learn the flow' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(draftCb).toBeTruthy());
    draftCb!({ name: 'schema-check', description: 'Validate schema drift.', markdown: '---\nname: schema-check\ndescription: Validate schema drift.\n---\n# Steps\n...', updatedAt: 1 });
    await waitFor(() => expect(screen.getByText('New skill draft: schema-check')).toBeTruthy());

    fireEvent.click(screen.getByText('↩ Reject'));
    await waitFor(() => expect(rejectSpy).toHaveBeenCalledWith('schema-check'));
    await waitFor(() => expect(screen.getByText(/Rejected — the draft was discarded/)).toBeTruthy());
    expect(acceptSpy).not.toHaveBeenCalled();
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

    // P6e — the skill suggestions are part of the empty state (the shipable
    // first-party batch is the onboarding entry point).
    const skillChip = screen.getByRole('button', { name: /load the code-assessment skill/ });
    expect(skillChip).toBeTruthy();
    const learnChip = screen.getByRole('button', { name: /learn a workflow as a skill/ });
    expect(learnChip).toBeTruthy();

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
      { path: '/tmp/my-app', name: 'my-app', kind: 'recent' },
    ]);
    const attach = vi.spyOn(dashboardAPI, 'attachProject').mockResolvedValue({
      ok: true,
      project: { path: '/tmp/my-app', name: 'my-app', fileCount: 42, symbolCount: 120, truncated: false },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    // The bar offers recent projects as one-click attach chips.
    await waitFor(() => expect(screen.getByRole('button', { name: /my-app/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-app/ }));

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
    await waitFor(() => expect(screen.getByText(/Select Project Folder/)).toBeTruthy());
  });

  it('Phase 4 — the session sidebar lists past conversations and resumes them', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend(OK_RESPONSE);
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 'sess-1', title: 'assess the repo', turnCount: 4, createdAt: 1, updatedAt: 2, preview: 'the build is green', firstUser: 'assess the repo' },
      { id: 'sess-2', title: 'fix the failing test', turnCount: 2, createdAt: 1, updatedAt: 1, preview: 'fixed it', firstUser: 'fix the failing test' },
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
    await waitFor(() => expect(screen.getAllByText('assess the repo').length).toBeGreaterThan(0));
    expect(screen.getAllByText('fix the failing test').length).toBeGreaterThan(0);
    expect(screen.getByText(/4 msgs · /)).toBeTruthy();

    // Click the session → its transcript loads into the thread (markdown-rendered).
    fireEvent.click(screen.getAllByText('assess the repo')[0]);
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

  it('P8 — large pasted text is offered as an attachment and becomes a chip', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    const longText = 'x'.repeat(2500);
    fireEvent.paste(screen.getByPlaceholderText(/Message the agent/), {
      clipboardData: { getData: () => longText },
    } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);

    // The prompt prints the length through the shared `formatCount` (pinned to
    // en-US), so the separator is a literal on every machine.
    const offer = await screen.findByText(/You pasted/);
    expect(offer.textContent).toContain('2,500 characters');
    fireEvent.click(screen.getByText(/Attach as text/));
    await waitFor(() => expect(screen.getByText(/pasted-text.txt/)).toBeTruthy());
  });

  it('P8 — smart rail: sidebar collapses while working and returns when done', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveTurn: (r: ChatSendResult) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise<ChatSendResult>((resolve) => { resolveTurn = resolve; }),
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByText('📁 Sessions')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'analyze' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    // While the turn is in flight the sidebar collapses to the rail.
    await waitFor(() => expect(screen.queryByText('📁 Sessions')).toBeNull());
    expect(screen.getByTitle('Show history')).toBeTruthy();

    resolveTurn(OK_RESPONSE);
    await waitFor(() => expect(screen.getByText('📁 Sessions')).toBeTruthy());
  });

  it('P8 — sidebar search filters sessions and date groups render', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 's-a', title: 'assess the repo', turnCount: 4, createdAt: Date.now(), updatedAt: Date.now(), preview: 'the build is green', firstUser: 'assess the repo' },
      { id: 's-b', title: 'deploy the site', turnCount: 2, createdAt: Date.now() - 86_400_000, updatedAt: Date.now() - 86_400_000, preview: 'deployed', firstUser: 'deploy the site' },
    ]);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getAllByText('assess the repo').length).toBeGreaterThan(0));

    // Date groups: Today + Yesterday.
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Yesterday')).toBeTruthy();

    // Search narrows the list.
    fireEvent.change(screen.getByPlaceholderText(/Search conversations/), { target: { value: 'deploy' } });
    await waitFor(() => expect(screen.queryByText('assess the repo')).toBeNull());
    expect(screen.getAllByText('deploy the site').length).toBeGreaterThan(0);
  });

  it('P8 — sidebar rename and delete manage the session list', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([
      { id: 's-1', title: 'old title', turnCount: 1, createdAt: 1, updatedAt: 2, preview: 'x', firstUser: 'old title' },
    ]);
    const delSpy = vi.spyOn(dashboardAPI, 'deleteChatSession').mockResolvedValue({ ok: true });
    const renSpy = vi.spyOn(dashboardAPI, 'renameChatSession').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getAllByText('old title').length).toBeGreaterThan(0));

    // Rename: pencil → inline input → Enter commits.
    fireEvent.click(screen.getByTitle('Rename'));
    const renameInput = await screen.findByPlaceholderText('Session title');
    fireEvent.change(renameInput, { target: { value: 'new title' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });
    await waitFor(() => expect(renSpy).toHaveBeenCalledWith('s-1', 'new title'));
    await waitFor(() => expect(screen.getAllByText('new title').length).toBeGreaterThan(0));

    // Delete: trash → API called + session removed from the list.
    fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('s-1'));
    await waitFor(() => expect(screen.queryByText('new title')).toBeNull());
  });

  it('P8 — New chat button resets the thread', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hello' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('You')).toBeTruthy());

    fireEvent.click(screen.getByText('＋ New'));
    await waitFor(() => expect(screen.queryByText('You')).toBeNull());
    expect(screen.getByText(/Say anything/)).toBeTruthy();
  });

  it('P2 — extracts artifact cards (diff/result/deploy) from the answer text', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
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
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the bug' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    // The ```diff block becomes a diff card, the test output a result card,
    // and the deploy line a 🚀 card — NOT just raw markdown.
    await waitFor(() => expect(screen.getByText('git diff')).toBeTruthy());
    expect(screen.getByText('src/fix.ts')).toBeTruthy();
    // The result card's verdict badge (the same block also renders as a
    // markdown code fence — both are expected, scope to the card's meta).
    await waitFor(() => expect(document.querySelector('.chat-result-meta')?.textContent).toBe('pass'));
    // The card link (the same URL also autolinks in the markdown text —
    // scope to the deploy card's dedicated anchor).
    const deployLink = document.querySelector('.chat-deploy-url') as HTMLAnchorElement;
    expect(deployLink).toBeTruthy();
    expect(deployLink.getAttribute('href')).toBe('https://preview.example.com');
  });

  it('P2 — extracted text diffs stay READ-ONLY without an attached project (prose cannot trigger commits)', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    mockChatSend({
      ...OK_RESPONSE,
      content: ['```diff', 'diff --git a/src/prose.ts b/src/prose.ts', '--- a/src/prose.ts', '+++ b/src/prose.ts', '@@ -1 +1 @@', '-x', '+y', '```'].join('\n'),
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show a diff' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('git diff')).toBeTruthy());

    // No attached project → no accept/reject toggles, no commit button, and
    // a hint explains why.
    expect(document.querySelectorAll('.chat-diff-toggle')).toHaveLength(0);
    expect(screen.queryByText(/Commit accepted/)).toBeNull();
    expect(screen.getByText(/Attach a project to review and commit these changes/)).toBeTruthy();
  });

  it('P2 — extracted text diffs become selectable WITH an attached project and commit there', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    vi.spyOn(dashboardAPI, 'listProjects').mockResolvedValue([{ path: '/tmp/my-app', name: 'my-app', kind: 'recent' }]);
    vi.spyOn(dashboardAPI, 'attachProject').mockResolvedValue({
      ok: true,
      project: { path: '/tmp/my-app', name: 'my-app', fileCount: 10, symbolCount: 20, truncated: false },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /my-app/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /my-app/ }));
    await waitFor(() => expect(screen.getByText('my-app')).toBeTruthy());

    // Now send a message whose answer contains a ```diff block.
    const send = mockChatSend({
      ...OK_RESPONSE,
      content: ['```diff', 'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', '```'].join('\n'),
    });
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'make the change' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText('git diff')).toBeTruthy());

    // With the project attached the extracted diff IS selectable.
    const toggles = screen.getAllByTitle(/Accepted — click to reject/);
    expect(toggles.length).toBe(1);

    // Commit accepted → the message names the ATTACHED PROJECT path so the
    // agent commits in that working tree, and only the accepted file.
    fireEvent.click(screen.getByText(/Commit accepted \(1\)/));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const commitMsg = send.mock.calls[1][1] as string;
    expect(commitMsg).toContain('/tmp/my-app');
    expect(commitMsg).toContain('src/a.ts');
  });

  it('P2 — the snapshotted diff card accepts/rejects files and commits the subset', async () => {
    mockAuthed('admin');
    let diffCb: ((d: { files: Array<{ path: string; body: string }>; summary: string }) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      diffCb = handlers.onDiff ?? null;
      return vi.fn();
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE) => void = () => {};
    const sendSpy = vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'show my changes' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(diffCb).toBeTruthy());
    diffCb!({ files: [{ path: 'a.ts', body: 'diff --git a/a.ts b/a.ts\n+new-a' }, { path: 'b.ts', body: 'diff --git a/b.ts b/b.ts\n+new-b' }], summary: '2 files changed' });
    resolveSend(OK_RESPONSE);

    // The snapshotted card shows per-file toggles, all accepted by default.
    await waitFor(() => expect(screen.getByText(/Commit accepted \(2\)/)).toBeTruthy());
    const toggles = screen.getAllByTitle(/Accepted — click to reject/);
    expect(toggles.length).toBe(2);

    // Reject b.ts → only a.ts remains accepted.
    fireEvent.click(toggles[1]);
    await waitFor(() => expect(screen.getByText(/Commit accepted \(1\)/)).toBeTruthy());

    // Committing sends a chat turn naming ONLY the accepted file.
    fireEvent.click(screen.getByText(/Commit accepted \(1\)/));
    await waitFor(() => expect(sendSpy.mock.calls.length).toBeGreaterThan(1));
    const commitMsg = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][1] as string;
    expect(commitMsg).toContain('a.ts');
    expect(commitMsg).not.toContain('b.ts');
  });

  it('P2 — the ⚡ Run path renders a live execution card with logs and exit code', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({
      ok: true,
      matches: [{ intent: 'run tests', summary: 'Run the test suite', command: 'test run', score: 0.9 }],
    });
    let statusCb: ((s: TaskStatus) => void) | null = null;
    let logCb: ((l: TaskLogLine) => void) | null = null;
    const taskBase = {
      id: 'task-1',
      command: 'test run',
      args: ['test', 'run'],
      cwd: '.',
      startedAt: 1,
      finishedAt: null,
      timeoutMs: 60000,
      logs: [] as Array<{ stream: 'stdout' | 'stderr' | 'system'; text: string; at: number }>,
    };
    const unsub = vi.fn();
    vi.spyOn(dashboardAPI, 'subscribeTask').mockImplementation((_id, handlers) => {
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
    const runningTask = { ...taskBase, status: 'running' as TaskStatus, exitCode: null, durationMs: null };
    vi.spyOn(dashboardAPI, 'getTask').mockImplementation(async () => ({
      status: 200,
      task: settled
        ? { ...taskBase, status: 'done' as TaskStatus, exitCode: 0, finishedAt: 2, durationMs: 100, logs: [{ stream: 'stdout', text: '1 test passed', at: 1 }] }
        : runningTask,
    }));
    vi.spyOn(dashboardAPI, 'startTask').mockResolvedValue({ ok: true, task: runningTask });
    const cancelSpy = vi.spyOn(dashboardAPI, 'cancelTask').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    // A confident command match shows the ⚡ confirm card.
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'run the tests' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(screen.getByText(/Run this command/)).toBeTruthy());

    // ▶ Run starts the task and inserts a LIVE execution card.
    fireEvent.click(screen.getByText('▶ Run'));
    await waitFor(() => expect(screen.getByText('test run')).toBeTruthy());
    expect(screen.getByText(/⏳ running/)).toBeTruthy();

    // Streamed logs land in the card.
    logCb!({ stream: 'stdout', text: '1 test passed', at: 1 });
    await waitFor(() => expect(screen.getByText('1 test passed')).toBeTruthy());

    // ANSI escapes are stripped, and a stream switch (stdout → stderr) shows
    // a separator + the error line is marked by stream.
    logCb!({ stream: 'stdout', text: '\u001b[32mstarting\u001b[0m', at: 2 });
    await waitFor(() => expect(screen.getByText('starting')).toBeTruthy());
    expect(screen.queryByText('\u001b[32mstarting\u001b[0m')).toBeNull();
    logCb!({ stream: 'stderr', text: '\u001b[31mboom\u001b[0m', at: 3 });
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
    expect(screen.getByText('stderr')).toBeTruthy();
    expect(document.querySelector('.chat-task-log-stderr')?.textContent).toBe('boom');

    // The copy button copies the FULL output, ANSI-stripped (clean text, no
    // color codes — matching what the card renders).
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copyBtn = document.querySelector('.chat-task-card .chat-card-copy') as HTMLButtonElement;
    expect(copyBtn).toBeTruthy();
    fireEvent.click(copyBtn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(['1 test passed', 'starting', 'boom'].join('\n')),
    );

    // Cancel is available while running (scope to the TASK card — the busy
    // composer also renders a ⏹ Cancel for the agent turn).
    const taskCancel = document.querySelector('.chat-task-card .admin-mini-btn') as HTMLButtonElement;
    expect(taskCancel).toBeTruthy();
    fireEvent.click(taskCancel);
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith('task-1'));

    // Settling the status shows the exit code and releases busy (the status
    // event itself carries no exit code — the final snapshot provides it).
    settled = true;
    statusCb!('done');
    await waitFor(() => expect(screen.getByText(/exit 0/)).toBeTruthy());
    expect(unsub).toHaveBeenCalled();
  });

  it('P2 — result and deploy cards have copy buttons that copy their content', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    const writeText = vi.fn().mockResolvedValue(undefined);
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
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'run it' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(document.querySelectorAll('.chat-card-copy').length).toBe(2));

    // The result card's copy button copies the OUTPUT body; the deploy card's
    // copies the URL.
    const resultCard = document.querySelector('.chat-result-card') as HTMLElement;
    const resultCopy = resultCard.querySelector('.chat-card-copy') as HTMLButtonElement;
    fireEvent.click(resultCopy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('PASS src/a.test.ts\n'));

    const deployCopy = document.querySelector('.chat-deploy-card .chat-card-copy') as HTMLButtonElement;
    fireEvent.click(deployCopy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://preview.example.com'));
    await waitFor(() => expect(screen.getAllByText(/Copied/).length).toBeGreaterThan(0));
  });

  it('P2 — artifact cards are keyboard-navigable: ↑/↓ moves focus between them', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
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
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'summarize' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(document.querySelectorAll('[data-artifact-card]').length).toBe(3));

    // Focus the first card, then ↓ moves to the second, ↑ back to the first,
    // and End jumps to the last.
    const cards = document.querySelectorAll<HTMLElement>('[data-artifact-card]');
    cards[0].focus();
    expect(document.activeElement).toBe(cards[0]);

    fireEvent.keyDown(cards[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[2]);
    fireEvent.keyDown(cards[2], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cards[1]);
    fireEvent.keyDown(cards[1], { key: 'Home' });
    expect(document.activeElement).toBe(cards[0]);
    fireEvent.keyDown(cards[0], { key: 'End' });
    expect(document.activeElement).toBe(cards[2]);
  });
});

/**
 * Deferred retries land in the OPEN conversation.
 *
 * After a failed turn the server keeps checking for a model and re-runs the ask
 * when one frees — minutes or hours later, long after the per-turn chat stream
 * was torn down — then pushes the result over the app-wide SSE channel. Without
 * this the dashboard's failure bubble was a dead end: the reader had to wait and
 * re-send the message themselves.
 */
describe('ChatPage — background retries', () => {
  type RetryHandler = (e: { sessionId: string; kind: 'answer' | 'failed' | 'abandoned'; content: string }) => void;

  function captureRetryHandler(): () => RetryHandler | null {
    let handler: RetryHandler | null = null;
    vi.spyOn(dashboardAPI, 'onChatRetryEvent').mockImplementation(((cb: RetryHandler) => {
      handler = cb;
      return () => {};
    }) as never);
    return () => handler;
  }

  it('appends a retry answer to the thread it belongs to', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    const readHandler = captureRetryHandler();
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    // Send once so the page has a real session id (it generates its own).
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'check the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalled());
    const sessionId = send.mock.calls[0]![0] as string;
    await waitFor(() => expect(readHandler()).toBeTruthy());

    readHandler()!({
      sessionId,
      kind: 'answer',
      content: '🔁 Trying again now (attempt 1 of at most 4)\n\nHere is the answer.',
    });

    await waitFor(() => expect(screen.getByText(/Here is the answer\./)).toBeTruthy());
  });

  it('a failure the SERVER is already retrying offers no manual ↻ Retry', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend({
      ok: true as const,
      content:
        "😞 I couldn't finish: explain the router\n\nI tried 2 models:\n  • gemini/model-0 — rate limited (quota)\n\nA model frees up in about 44s. Want me to keep checking? Reply *yes* and I will keep trying until it is done.",
      followups: [],
      provider: null,
      model: null,
      generationFailed: true,
      // The server queued the ask — re-sending it by hand would run it twice.
      retryQueued: true,
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'explain the router' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(screen.getByText(/I tried 2 models/)).toBeTruthy());
    expect(screen.getByText(/Reply/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not put another session's retry into THIS thread", async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    const list = vi.spyOn(dashboardAPI, 'listChatSessions').mockResolvedValue([]);
    const readHandler = captureRetryHandler();
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'check the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalled());
    await waitFor(() => expect(readHandler()).toBeTruthy());
    const before = list.mock.calls.length;

    readHandler()!({ sessionId: 'some-other-session', kind: 'answer', content: '🔁 Not mine.' });

    // The rail is refreshed for the other session, and THIS thread is untouched.
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByText(/Not mine\./)).toBeNull();
  });
});
