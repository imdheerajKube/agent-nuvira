/**
 * Chat survives TAB NAVIGATION — the whole point of the persistent mount.
 *
 * The bug: React Router unmounts a route's element when the path changes, so
 * opening Costs and coming back tore down the chat page — its transcript state,
 * its live turn, and its progress SSE subscription — and the conversation
 * restarted. The fix is to render ChatPage ONCE and keep it mounted, hidden with
 * `display:none` while the user is elsewhere.
 *
 * This is a jsdom test, not a browser smoke, ON PURPOSE. The property being
 * pinned is structural ("the chat element is still in the document after a
 * navigation"), and jsdom observes the document exactly. A Chrome smoke adds a
 * real turn, which needs a live dashboard AND provider credentials — so it
 * would be skipped in CI and could only assert the same structural fact when it
 * did run. The structural fact is what broke, so this is the test that would
 * have caught it.
 *
 * The `dashboardAPI` is mocked wholesale: this asserts NAVIGATION behaviour, and
 * every page's data reads are irrelevant to it. `subscribe`/`onConnectionChange`
 * must return an unsubscribe FUNCTION (App calls it during teardown), so they
 * are special-cased; everything else resolves null and pages render their
 * empty/degraded state, which still contains their real PageHeader.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

vi.mock('./api', async (importOriginal) => {
  // Partially mock: keep the module's non-`dashboardAPI` exports (e.g. the auth
  // version store `useAuthVersion` reads) and replace only the client object.
  const actual = await importOriginal<typeof import('./api')>();
  const noopUnsub = () => () => {};
  // Calls whose result the page iterates (`.find`/`.map`) must resolve to an
  // ARRAY, not null; everything else can be null (pages guard it).
  const ARRAY_RESULTS = new Set(['fetchProcessEnv', 'listChatSessions', 'listProjects']);
  const dashboardAPI = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        // Any method a page uses as an effect CLEANUP must return a function.
        if (prop === 'subscribe' || prop === 'onConnectionChange' || prop === 'subscribeChat' || prop === 'onChatRetryEvent') {
          return vi.fn(noopUnsub);
        }
        if (prop === 'connect' || prop === 'disconnect') return vi.fn();
        return ARRAY_RESULTS.has(prop)
          ? vi.fn(async () => [])
          : vi.fn(async () => null);
      },
    },
  );
  return { ...actual, dashboardAPI };
});

// Imported AFTER the mock so App + its pages resolve the mocked module.
import App from './App';

/** A button OUTSIDE App that drives the shared router. */
function GoTo({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

afterEach(cleanup);

// The model-counts hook (and any straggler) uses the GLOBAL fetch; give it a
// benign empty JSON answer so no test reaches the network.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

describe('App — chat stays mounted across navigation', () => {
  it('keeps the chat page in the DOM after navigating to another tab and back', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <GoTo to="/costs" label="go-costs" />
        <GoTo to="/chat" label="go-chat" />
        <App />
      </MemoryRouter>,
    );

    // The chat page is mounted at /chat.
    expect(screen.getByText('Chat with the agent')).toBeTruthy();

    // Navigate away to another tab.
    fireEvent.click(screen.getByText('go-costs'));

    // The chat element is STILL in the document (hidden, not unmounted) — this is
    // what keeps the transcript and the in-flight turn alive.
    await waitFor(() => expect(screen.getByText('Chat with the agent')).toBeTruthy());

    // And coming back shows the SAME node, not a fresh mount: its heading is the
    // one the original render produced.
    fireEvent.click(screen.getByText('go-chat'));
    await waitFor(() => expect(screen.getByText('Chat with the agent')).toBeTruthy());
  });

  it('lands on Overview by default (not Chat)', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    // `/` redirects to `/overview`, whose h1 names the system overview.
    await waitFor(() => expect(screen.getByText('System Overview')).toBeTruthy());
  });
});
