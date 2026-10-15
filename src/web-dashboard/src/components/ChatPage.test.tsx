/**
 * P3 — ChatPage tests (dashboard chat console).
 *
 * The page threads a conversation through the mocked chat API: user bubbles,
 * assistant replies with followup chips (clicking sends the prompt), the
 * working state, error handling, and the auth gate. No LLM, no server.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ChatPage, { capabilityModeFromValue } from './ChatPage';
import { dashboardAPI, setAdminToken } from '../api';
import type { TraceFinding } from '../types';

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

/** The same subscription, with the handlers captured so a test can DRIVE the
 *  stream (the live `done` path). */
function mockChatStreamCapturing(): { handlers?: Parameters<typeof dashboardAPI.subscribeChat>[1] } {
  const captured: { handlers?: Parameters<typeof dashboardAPI.subscribeChat>[1] } = {};
  vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sessionId, handlers) => {
    captured.handlers = handlers;
    return () => {};
  });
  return captured;
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

describe('capabilityModeFromValue — the toggle mirrors the server parse', () => {
  it('reads a synonym of "go all out" as max', () => {
    expect(capabilityModeFromValue('max')).toBe('max');
    expect(capabilityModeFromValue('MAXIMUM')).toBe('max');
    expect(capabilityModeFromValue('unlimited')).toBe('max');
    expect(capabilityModeFromValue('performance-first')).toBe('max');
  });

  it('reads balanced and unset as the default', () => {
    expect(capabilityModeFromValue('balanced')).toBe('balanced');
    expect(capabilityModeFromValue(null)).toBe('balanced');
    expect(capabilityModeFromValue(undefined)).toBe('balanced');
    expect(capabilityModeFromValue('   ')).toBe('balanced');
  });
});

/**
 * A question the page never HEARD still has to reach it.
 *
 * The `question` event fires once — when the turn asks — so a page that
 * reloaded (or a second tab) never receives it. MEASURED (2026-10-14,
 * trace-1791996357488-wpm352): a turn sat in `ask_user` for 5m02s and was
 * cancelled in the end, while the reloaded page showed "⏳ Still working on the
 * server … the answer will appear here by itself" — a sentence that is false
 * twice over, because the answer was waiting for a click the page never offered.
 * The server now carries the open question with the session snapshot, and this
 * is the surface that has to act on it.
 */
describe('ChatPage — a question that outlived the page that heard it', () => {
  it('shows the open question from the session snapshot, not "still working"', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'getChatSession').mockResolvedValue({
      title: 'wallpaper',
      updatedAt: 5,
      busy: true,
      turns: [{ role: 'user' as const, content: 'add real photos to the wallpaper' }],
      pendingQuestion: {
        questionId: 'q-1',
        question: 'Which source should I use for the photos?',
        choices: [{ label: 'Download into assets/' }, { label: 'Remote URLs' }],
        multiSelect: false,
      },
    });
    render(<ChatPage />);

    // The turn is holding for THIS user, and the notice says so…
    //
    // Matched on a fragment that lives in ONE text node: the sentence emphasises
    // the word "your" (`Waiting for <strong>your</strong> answer`), and the default
    // `getByText` matcher only reads an element's DIRECT text nodes, so a regex
    // spanning the emphasis can never match — that is a fact about the matcher,
    // not about the notice.
    await waitFor(() =>
      expect(screen.getByText(/choose one of the options above/)).toBeTruthy(),
    );
    expect(screen.getByText('your').tagName).toBe('STRONG');
    // …the choice card is back, so the turn can actually be continued…
    expect(screen.getByText(/Which source should I use for the photos\?/)).toBeTruthy();
    expect(screen.getByText('Remote URLs')).toBeTruthy();
    // …and the false sentence is not on screen at the same time.
    expect(screen.queryByText(/Still working on the server/)).toBeNull();
  });

  it('does not invent a question when the resumed turn is simply working', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'getChatSession').mockResolvedValue({
      title: 'wallpaper',
      updatedAt: 5,
      busy: true,
      turns: [{ role: 'user' as const, content: 'add real photos to the wallpaper' }],
    });
    render(<ChatPage />);

    await waitFor(() => expect(screen.getByText(/Still working on the server/)).toBeTruthy());
    expect(screen.queryByText(/Waiting for your answer/)).toBeNull();
    expect(screen.queryByPlaceholderText(/Or type your own answer/)).toBeNull();
  });

  /**
   * The wait has to name its own age, and the TURN's start is the age.
   *
   * MEASURED (2026-10-14, trace-1791996974262-zdraep): a turn ran 664s while the
   * dashboard abandoned its own POST at the 5-minute ceiling and then counted the
   * wait from THAT instant — so the notice read "1m 25s elapsed" for a turn that
   * had already been running six and a half minutes, and the user reasonably read
   * it as a lie beside the 12-second trace of the turn before it. The server now
   * dates the running turn (`busySince`), so the notice can say how old the wait
   * really is — including one this page attached to long after it began.
   */
  it('dates a resumed wait from the TURN start, not from the moment this page attached', async () => {
    mockAuthed('admin');
    mockChatStream();
    vi.spyOn(dashboardAPI, 'getChatSession').mockResolvedValue({
      title: 'wallpaper',
      updatedAt: 5,
      busy: true,
      // The turn began 6m30s ago on the server — past the dashboard's own
      // 5-minute POST ceiling, and long before this page was rendered.
      busySince: Date.now() - 390_000,
      turns: [{ role: 'user' as const, content: 'add real photos to the wallpaper' }],
    });
    render(<ChatPage />);

    // "6m 30s" and not "0s": the age of the TURN, not of this visit. (The
    // negative is anchored on the notice's own phrasing — a bare /0s elapsed/,
    // would also match "3**0s elapsed**", i.e. the very number being asserted.)
    await waitFor(() => expect(screen.getByText(/6m 3\ds elapsed/)).toBeTruthy());
    expect(screen.queryByText(/server — 0s elapsed/)).toBeNull();
  });
});

/**
 * A turn can outlive the dashboard's own wait for it.
 *
 * The chat POST is capped at 5 minutes client-side (`chatSend`), and a real
 * agentic turn routinely runs longer (measured on this machine: p95 516s,
 * longest 2571s). The server deliberately keeps running such a turn and persists
 * its answer, so the two things that used to go wrong here were pure delivery
 * faults: the answer had no route back to the page (only a reload showed it), and
 * the failure path offered a Retry that the still-busy server refused —
 * "A message is already being answered in this session".
 */
describe('ChatPage — a turn that outlives the 5-minute POST ceiling', () => {
  const CEILING_RESULT = {
    ok: false as const,
    turnStillRunning: true,
    error:
      'The dashboard stopped waiting after 5 minutes — the turn is STILL RUNNING on the server. ' +
      'Its answer will appear here when it lands (nothing was lost — the turn keeps running).',
  };

  /**
   * A session whose turn stays RUNNING until the test completes it — the real
   * shape of a long turn (there is no deadline to run out; the work simply ends
   * when it ends). Returns a control the test uses to land the turn.
   *
   * The reads are keyed on the POST having been sent, not on call ORDER: the page
   * also reads a session once on mount (its resume path), and a test that assumed
   * which of the two reads came first would be testing the test.
   */
  function mockRunningTurnThen(outcome: 'answered' | 'no-answer') {
    let postSent = false;
    let landed = false;
    const user = { role: 'user' as const, content: 'a long job' };
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(async () => {
      postSent = true;
      return CEILING_RESULT;
    });
    vi.spyOn(dashboardAPI, 'getChatSession').mockImplementation(async () => {
      // Before the turn: nothing to resume (the page is not reattaching).
      if (!postSent) return null;
      // While it runs: the server reports the turn live, with no answer yet.
      if (!landed) return { title: 'long job', updatedAt: 1, busy: true, turns: [user] };
      return {
        title: 'long job',
        updatedAt: 2,
        busy: false,
        turns:
          outcome === 'answered'
            ? [user, { role: 'assistant' as const, content: 'Finished after the ceiling — the review is in the doc.' }]
            : [user],
      };
    });
    return { land: () => { landed = true; } };
  }

  it('keeps waiting through a running turn, then collects the answer from the transcript', async () => {
    mockAuthed('admin');
    mockChatStream();
    const turn = mockRunningTurnThen('answered');
    render(<ChatPage ceilingRecovery={{ pollMs: 5 }} />);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    fireEvent.change(box, { target: { value: 'a long job' } });
    fireEvent.submit(box.closest('form')!);

    // The turn is live on the server: the page says so (and not that it failed),
    // with the elapsed wait on screen so a long wait is visibly alive.
    await waitFor(() => expect(screen.getByText(/Still working on the server/)).toBeTruthy());
    expect(screen.getByText(/elapsed/)).toBeTruthy();
    // No Retry while the turn runs: re-sending is refused by the busy server, and
    // offering it was the dead end this replaces.
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();

    // The turn finishes on the server; its answer is picked up from the
    // transcript with no reload and no second request from the user.
    turn.land();
    await waitFor(() => expect(screen.getByText(/Finished after the ceiling/)).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(/Still working on the server/)).toBeNull());
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('takes the answer from the live stream when the done event arrives first', async () => {
    mockAuthed('admin');
    const stream = mockChatStreamCapturing();
    mockChatSend(CEILING_RESULT);
    // The poll must not be the path under test: it is made both slow and
    // useless (a null transcript), so an answer can only come from the stream.
    vi.spyOn(dashboardAPI, 'getChatSession').mockResolvedValue(null);
    render(<ChatPage ceilingRecovery={{ pollMs: 60_000 }} />);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    fireEvent.change(box, { target: { value: 'a long job' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(screen.getByText(/Still working on the server/)).toBeTruthy());

    // The server finishes and the stream carries the answer.
    stream.handlers?.onTurnDone?.({
      content: 'Streamed finish — the doc is updated.',
      followups: [],
      generationFailed: false,
    });

    // Nothing else could produce this bubble: the transcript read is null and the
    // poll is 60s away.
    await waitFor(() => expect(screen.getByText(/Streamed finish/)).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(/Still working on the server/)).toBeNull());
  });

  it('offers a real Retry when the recovered turn ended without an answer', async () => {
    mockAuthed('admin');
    mockChatStream();
    const turn = mockRunningTurnThen('no-answer');
    render(<ChatPage ceilingRecovery={{ pollMs: 5 }} />);
    const box = await screen.findByPlaceholderText(/Message the agent/);
    fireEvent.change(box, { target: { value: 'a long job' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(screen.getByText(/Still working on the server/)).toBeTruthy());

    // The turn ENDED with no answer at all — that IS a failed turn, so the Retry
    // affordance is correct (and the server is no longer busy).
    turn.land();
    await waitFor(() => expect(screen.getByRole('button', { name: /↻ Retry/ })).toBeTruthy());
    expect(screen.queryByText(/Still working on the server/)).toBeNull();
  });
});

describe('ChatPage capability toggle', () => {
  const row = {
    name: 'NUVIRA_CAPABILITY_MODE',
    label: 'Capability mode',
    group: 'turn' as const,
    kind: 'text' as const,
    description: '',
    unsetMeans: '',
    fileValue: 'max',
    processValue: 'max',
    state: 'set' as const,
    shadowed: false,
  };

  it('opens on the mode the runs use, then writes the switch on toggle', async () => {
    mockAuthed('admin');
    vi.spyOn(dashboardAPI, 'fetchProcessEnv').mockResolvedValue([row]);
    const save = vi.spyOn(dashboardAPI, 'saveProcessEnvVar').mockResolvedValue({ ok: true });
    render(<ChatPage />);
    const btn = await screen.findByLabelText('Capability mode: balanced or max');
    await waitFor(() => expect(btn.textContent).toContain('max'));

    fireEvent.click(btn);

    await waitFor(() => expect(save).toHaveBeenCalledWith('NUVIRA_CAPABILITY_MODE', 'balanced'));
    await waitFor(() => expect((screen.getByLabelText('Capability mode: balanced or max')).textContent).toContain('balanced'));
  });

  it('reports a refused write instead of pretending the mode changed', async () => {
    mockAuthed('admin');
    vi.spyOn(dashboardAPI, 'fetchProcessEnv').mockResolvedValue([]);
    vi.spyOn(dashboardAPI, 'saveProcessEnvVar').mockResolvedValue({ ok: false, error: 'Access denied.' });
    render(<ChatPage />);
    const btn = await screen.findByLabelText('Capability mode: balanced or max');

    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText('Access denied.')).toBeTruthy());
    expect(btn.textContent).toContain('balanced');
  });
});

describe('ChatPage model picker — Auto by default, pin only routable models', () => {
  it('offers Auto plus the routable pairs, and pins the chosen pair on the next send', async () => {
    mockAuthed('admin');
    vi.spyOn(dashboardAPI, 'fetchProcessEnv').mockResolvedValue([]);
    vi.spyOn(dashboardAPI, 'listRoutableModels').mockResolvedValue([
      { provider: 'gemini', model: 'gemini-3.1-flash-lite', capability: 0.65, band: 'medium' },
      { provider: 'groq', model: 'openai/gpt-oss-120b', capability: 0.9, band: 'high' },
    ]);
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);

    const picker = await screen.findByLabelText('Model: Auto or a specific routable model');
    // Auto is the default and stays the first option.
    expect((picker as HTMLSelectElement).value).toBe('');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /groq\/openai\/gpt-oss-120b/ })).toBeTruthy(),
    );

    fireEvent.change(picker, { target: { value: 'groq|openai/gpt-oss-120b' } });

    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'hello' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(send).toHaveBeenCalled());
    const opts = send.mock.calls[0][2] as { provider?: string; model?: string };
    expect(opts.provider).toBe('groq');
    expect(opts.model).toBe('openai/gpt-oss-120b');
  });
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
    expect(screen.getByText(/0\/1 done/)).toBeTruthy();
    expect(screen.getByText('Reproduce the failure')).toBeTruthy();
    // The card is a PROGRESS TABLE, not a bare checklist.
    expect(screen.getByText('Status')).toBeTruthy();

    // A later mutation updates the card IN PLACE (revision 2, status done).
    planCb!({ goal: 'Fix the failing test', steps: [{ id: 'reproduce', description: 'Reproduce the failure', status: 'done' }], revision: 2 });
    await waitFor(() => expect(screen.getByText(/1\/1 done/)).toBeTruthy());
    // Completion is announced in plain English.
    await waitFor(() => expect(screen.getByText(/Plan complete — 1\/1 steps achieved/)).toBeTruthy());

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

  it('E — renders the TurnReport card from the authoritative POST response', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend({
      ...OK_RESPONSE,
      turnReport: {
        goal: 'fix add in math.js',
        planned: true,
        steps: [
          { id: 's1', description: 'fix add in math.js', status: 'done' },
          { id: 's2', description: 'run the test', status: 'done' },
        ],
        stepCounts: { done: 2, blocked: 0, pending: 0, running: 0, total: 2 },
        toolCalls: ['edit_file', 'run_terminal'],
        successfulToolCalls: ['edit_file', 'run_terminal'],
        mutations: 1,
        changedPaths: ['math.js'],
        verification: 'verified',
        flags: {},
        summary: '2/2 steps done · 1 file(s) changed · verification: verified',
      },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix add' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    // The report renders as a dedicated card with the VERIFIED verdict…
    await waitFor(() => expect(screen.getByText('Turn report')).toBeTruthy());
    expect(screen.getByText('VERIFIED')).toBeTruthy();
    expect(screen.getByText('fix add in math.js')).toBeTruthy();
    // The count badge and the summary both say "2/2 steps" — either proves it.
    expect(screen.getAllByText(/2\/2 steps/).length).toBeGreaterThan(0);
    // …and the changed file, straight off the report.
    expect(screen.getByText(/1 file changed/)).toBeTruthy();
  });

  it('E — an unverified report renders UNVERIFIED with the honesty flag chips', async () => {
    mockAuthed('admin');
    mockChatStream();
    mockChatSend({
      ...OK_RESPONSE,
      turnReport: {
        goal: 'fix the build',
        planned: false,
        steps: [],
        stepCounts: { done: 0, blocked: 0, pending: 0, running: 0, total: 0 },
        toolCalls: ['edit_file'],
        successfulToolCalls: ['edit_file'],
        mutations: 1,
        changedPaths: ['src/x.ts'],
        verification: 'unverified',
        flags: { unverifiedEdit: true },
        summary: '1 file(s) changed · verification: unverified',
      },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'fix the build' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    // A change nothing verified must NOT read like a verified one — the verdict
    // badge says UNVERIFIED and the honesty flag is a visible chip.
    await waitFor(() => expect(screen.getByText('UNVERIFIED')).toBeTruthy());
    expect(screen.getByText(/edited without verifying/)).toBeTruthy();
  });

  it('E — the heavy evidence sections start COLLAPSED (answer + tracker own the screen)', async () => {
    // Measured 2026-10-09: a turn with 34 tool calls, a resume card, a turn
    // report and findings expanded every section up front, so the user had to
    // scroll past a screenful of evidence to reach the answer and the plan
    // tracker. The verdict, the counts and the summary stay on the header line;
    // the DETAILS are one click away instead of always on screen.
    mockAuthed('admin');
    let toolCb: ((t: { id: string; tool: string; phase: 'started' | 'called'; ok?: boolean; result?: string; durationMs?: number }) => void) | null = null;
    vi.spyOn(dashboardAPI, 'subscribeChat').mockImplementation((_sid, handlers) => {
      toolCb = handlers.onTool ?? null;
      return () => {};
    });
    vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({ ok: true, matches: [] });
    let resolveSend: (v: typeof OK_RESPONSE & Record<string, unknown>) => void = () => {};
    vi.spyOn(dashboardAPI, 'chatSend').mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve as never; }) as Promise<typeof OK_RESPONSE>,
    );
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(toolCb).toBeTruthy());
    // Two completed tool calls — the evidence behind the answer.
    toolCb!({ id: 'call_1', tool: 'read_file', phase: 'started' });
    toolCb!({ id: 'call_1', tool: 'read_file', phase: 'called', ok: true, result: 'x', durationMs: 5 });
    toolCb!({ id: 'call_2', tool: 'list_dir', phase: 'started' });
    toolCb!({ id: 'call_2', tool: 'list_dir', phase: 'called', ok: true, result: 'y', durationMs: 3 });
    resolveSend({
      ...OK_RESPONSE,
      resume: { id: 'cp-1', replayed: 0, modelCalls: 2, saved: true, notice: 'recorded' },
      findings: [
        { claim: 'the build is green', outcome: 'ran it', verdict: 'PLAUSIBLE', evidence: [] },
      ],
      turnReport: {
        goal: 'assess the repo',
        planned: true,
        steps: [{ id: 's1', description: 'read the entry point', status: 'done' }],
        stepCounts: { done: 1, blocked: 0, pending: 0, running: 0, total: 1 },
        toolCalls: ['read_file'],
        successfulToolCalls: ['read_file'],
        mutations: 0,
        changedPaths: [],
        verification: 'not-applicable',
        flags: {},
        summary: '1/1 steps done · verification: not-applicable',
      },
    });
    await waitFor(() => expect(screen.getByText('Turn report')).toBeTruthy());

    // Every evidence section is present in the DOM but CLOSED by default.
    for (const cls of ['.chat-tool-details', '.chat-turn-card', '.chat-resume-card', '.chat-findings']) {
      const el = document.querySelector(cls) as HTMLDetailsElement | null;
      expect(el, `${cls} should render`).toBeTruthy();
      expect(el!.open, `${cls} should start collapsed`).toBe(false);
    }
    // The gist is on the collapsed header, so nothing needs expanding to read it.
    expect(screen.getByText('0 steps replayed')).toBeTruthy();
    expect(screen.getByText(/2 findings?|1 findings?: 0 confirmed, 1 plausible/)).toBeTruthy();
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
      // P8 — the server-persisted pin must come back with the session.
      pinnedProvider: 'groq',
      pinnedModel: 'openai/gpt-oss-120b',
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

    // P8 — resuming the session restores its pinned model into the picker.
    const picker = screen.getByRole('combobox', {
      name: /Model: Auto or a specific routable model/,
    }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('groq|openai/gpt-oss-120b'));
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

  it('Cluster G — the workspace notice renders, and one click dismisses it', async () => {
    // The server resolves the turn's folder (attached → session → message → default) and returns
    // `workspaceNotice` whenever the answer did NOT come from a folder this chat attached. That notice
    // is the only place the user learns which folder the work went into — the whole subject of Cluster
    // G, where an attached-but-empty folder read as "no project" — so it has to actually render, not
    // just travel in the response. The routing notice beside it has been covered since it existed.
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend({
      ...OK_RESPONSE,
      workspaceNotice: 'Using the folder named in your message: /tmp/empty-project',
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), {
      target: { value: 'create the files' },
    });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Using the folder named in your message/)).toBeTruthy());
    expect(screen.getByText(/\/tmp\/empty-project/)).toBeTruthy();

    // Per-turn state, like the routing notice: dismissing clears it.
    fireEvent.click(screen.getByLabelText('Dismiss workspace notice'));
    await waitFor(() => expect(screen.queryByText(/Using the folder named in your message/)).toBeNull());
  });

  it('WS5 (#27) — the reply card reports what the ledger REPLAYED, which the composer cannot know', async () => {
    // Asking to resume and replaying nothing look identical from the composer, so
    // the card is the only place the distinction can be made — and it states the
    // counts the LEDGER reported, not the request the client made.
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend({
      ...OK_RESPONSE,
      resume: {
        id: 'cp-abc123',
        replayed: 2,
        modelCalls: 1,
        saved: true,
        notice: '↩️  resume cp-abc123: replayed 2, made 1 model call(s)',
      },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess the repo again' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    // The turn was NOT asked to resume (the control is off), so the key is absent
    // from the request and the deployment's own NUVIRA_RESUME stays in charge.
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const opts = send.mock.calls[0][2] as { resume?: unknown } | undefined;
    expect(opts && 'resume' in opts).toBe(false);

    // The card renders on the reply the server reported one on.
    await waitFor(() => expect(screen.getByText('Resumed a recorded run')).toBeTruthy());
    expect(screen.getByText('2 steps replayed')).toBeTruthy();
    expect(screen.getByText('1 model call made')).toBeTruthy();
    expect(screen.getByText('cp-abc123')).toBeTruthy();
    expect(screen.getByText('recorded')).toBeTruthy();
    expect(screen.getByText(/replayed 2, made 1 model call/)).toBeTruthy();
  });

  it('WS5 (#27) — resume is asked for only when the control is on, and a named record wins over the automatic one', async () => {
    mockAuthed('admin');
    mockChatStream();
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    const toggle = screen.getByLabelText("Replay this ask's recorded steps instead of paying for them again");
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // No id box until the mode is on: the control shows what it actually carries.
    expect(screen.queryByLabelText('Checkpoint id to resume')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const idBox = await screen.findByLabelText('Checkpoint id to resume');
    fireEvent.change(idBox, { target: { value: 'cp-named' } });

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess the repo' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0][2] as { resume?: unknown }).resume).toBe('cp-named');

    // A blank box asks for the AUTOMATIC record — `true`, not the empty string,
    // which is what the CLI's bare `--resume` means.
    fireEvent.change(idBox, { target: { value: '   ' } });
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'assess it again' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect((send.mock.calls[1][2] as { resume?: unknown }).resume).toBe(true);
  });

  it('WS5 (#27) — a record that could NOT be written says so, instead of reading as a no-op resume', async () => {
    // `saved: false` means the turn happened but its record was not written back,
    // so the NEXT resume will replay nothing from it. A reader who is not told that
    // reads the missing replay as the feature not working.
    mockAuthed('admin');
    mockChatStream();
    mockChatSend({
      ...OK_RESPONSE,
      resume: {
        id: 'cp-xyz',
        replayed: 0,
        modelCalls: 3,
        saved: false,
        notice: '↩️  resume cp-xyz: no record for this ask in this directory yet — recording now',
      },
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'a fresh ask' } });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(screen.getByText('not recorded')).toBeTruthy());
    expect(screen.getByText('0 steps replayed')).toBeTruthy();
    expect(screen.getByText(/no record for this ask in this directory yet/)).toBeTruthy();
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

  it('never intercepts an ask with a command card — the resolver is not consulted at all', async () => {
    // The nag a user reads as the agent refusing to act: the pre-model resolver
    // matching a message to a CLI command and showing "⚡ Run this command? /
    // ✕ No — ask the agent" BEFORE the model saw it. Gating that to messages
    // beginning with the CLI name was not enough — prose ABOUT the CLI also
    // begins with it ("agent-nuvira is hosted in <dir>, have a read"), and the
    // scorer counts alias words anywhere in the message, so that ask resolved
    // to `nuvira trace list` at score 1.0. The resolver is gone from the send
    // path entirely; every ask goes to the agent, which runs what it needs.
    mockAuthed('admin');
    mockChatStream();
    const resolve = vi.spyOn(dashboardAPI, 'chatResolve').mockResolvedValue({
      ok: true,
      matches: [{ intent: 'run tests', summary: 'Run the test suite', command: 'test run', score: 1 }],
    });
    const startTask = vi.spyOn(dashboardAPI, 'startTask');
    const send = mockChatSend(OK_RESPONSE);
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    // The plain ask AND the CLI-shaped one — the case that used to be
    // intercepted — both go straight to the agent.
    const input = screen.getByPlaceholderText(/Message the agent/);
    fireEvent.change(input, { target: { value: 'build the mac app' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const lived = 'agent-nuvira is hosted in /tmp/project, have a read';
    fireEvent.change(input, { target: { value: lived } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // Let the second turn land (the reply renders, busy clears) so nothing
    // updates state after the test's last assertion.
    await waitFor(() => expect(screen.getAllByText(/build is green/).length).toBe(2));

    // No confirm card, no resolver round-trip, no command started behind the
    // agent's back — the CLI-shaped ask reached the agent like any other.
    expect(send.mock.calls[1][1]).toBe(lived);
    expect(resolve).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
    expect(screen.queryByText(/Run this command/)).toBeNull();
    expect(screen.queryByText(/No — ask the agent/)).toBeNull();
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

describe('Cluster G — the temporary (scratch) workspace', () => {
  /**
   * A turn that PRODUCED something with no project folder attached runs in a
   * temporary folder. The client must not adopt it silently — that would scope
   * every later turn of this chat to a throwaway directory — so the response is
   * surfaced as an OFFER with the two real answers ("keep this" / "attach my own").
   */
  it('offers the temporary workspace instead of attaching it, and adopts it only when asked', async () => {
    mockAuthed('admin');
    mockChatStream();
    const attach = vi.spyOn(dashboardAPI, 'attachProject').mockResolvedValue({
      ok: true,
      project: { path: '/tmp/nuvira-scratch/chat-1', name: 'chat-1', fileCount: 0, symbolCount: 0 },
    } as Awaited<ReturnType<typeof dashboardAPI.attachProject>>);
    const send = mockChatSend({
      ...OK_RESPONSE,
      workspaceNotice: 'No project folder is attached, so this turn used a TEMPORARY workspace (/tmp/nuvira-scratch/chat-1).',
      workspacePath: '/tmp/nuvira-scratch/chat-1',
      workspaceSource: 'scratch',
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), {
      target: { value: 'create a react app' },
    });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // The banner names the real path, and nothing was adopted behind the user's back.
    await waitFor(() => expect(screen.getByTestId('chat-scratch-notice')).toBeTruthy());
    expect(screen.getByText('/tmp/nuvira-scratch/chat-1')).toBeTruthy();
    expect(attach).not.toHaveBeenCalled();

    // One click keeps it: the folder is attached to this chat.
    fireEvent.click(screen.getByText(/Use as my project path/));
    await waitFor(() => expect(attach).toHaveBeenCalledWith('/tmp/nuvira-scratch/chat-1'));
    await waitFor(() => expect(screen.queryByTestId('chat-scratch-notice')).toBeNull());
  });

  it('leave-a-folder-request turns a NON-scratch resolved workspace into an attach, as before', async () => {
    // The previous behaviour must survive: a folder the user NAMED in the message
    // is one they want to keep working in, so it is attached without asking.
    mockAuthed('admin');
    mockChatStream();
    const attach = vi.spyOn(dashboardAPI, 'attachProject').mockResolvedValue({
      ok: true,
      project: { path: '/tmp/named-app', name: 'named-app', fileCount: 3, symbolCount: 9 },
    } as Awaited<ReturnType<typeof dashboardAPI.attachProject>>);
    mockChatSend({
      ...OK_RESPONSE,
      workspacePath: '/tmp/named-app',
      workspaceSource: 'message',
      workspaceNotice: 'Workspace: /tmp/named-app — taken from the folder the user named in their message.',
    });
    render(<ChatPage />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Message the agent/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), {
      target: { value: `create the app in /tmp/named-app` },
    });
    fireEvent.submit(screen.getByPlaceholderText(/Message the agent/).closest('form')!);

    await waitFor(() => expect(attach).toHaveBeenCalledWith('/tmp/named-app'));
    expect(screen.queryByTestId('chat-scratch-notice')).toBeNull();
  });
});
