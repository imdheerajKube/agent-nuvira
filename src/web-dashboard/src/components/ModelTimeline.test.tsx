/**
 * ModelTimeline tests — the reachability view.
 *
 * The regression this file exists for: the page used to show a "Fresh (531)"
 * card and then badge 514 of those rows "Unverified", because the count and the
 * badge used different rules. So the assertions are about AGREEMENT — the filter
 * returns exactly the rows the card counted, and a never-verified model is never
 * described as unreachable.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import ModelTimeline from './ModelTimeline';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const COPY = {
  routable: { label: 'Routable', blurb: 'Verified within 7 days and not parked.', color: '#3fb950' },
  parked: { label: 'Parked', blurb: 'Resting on a quota window.', color: '#d29922' },
  'proof-expired': { label: 'Proof expired', blurb: 'Was verified, not within 7 days.', color: '#d29922' },
  'proven-dead': { label: 'Proven dead', blurb: 'A real call established this id does not work.', color: '#f85149' },
  'never-verified': { label: 'Never verified', blurb: 'The provider lists this id; nothing has been tried.', color: '#58a6ff' },
};

const FRESHNESS_COPY = {
  fresh: { label: 'Fresh', blurb: 'Probed within 7 days.', color: '#3fb950' },
  stale: { label: 'Stale', blurb: 'Not probed for over 7 days.', color: '#d29922' },
  'likely-removed': { label: 'Likely removed', blurb: 'Long unprobed and failing.', color: '#f85149' },
};

function entry(over: Partial<Record<string, unknown>>) {
  return {
    provider: 'local',
    model: 'm',
    status: 'unverified',
    reachability: 'never-verified',
    freshness: 'fresh',
    lastVerifiedAt: 0,
    lastProbedAt: NOW,
    lastUsedAt: 0,
    errorRate: 0,
    daysSinceVerify: null,
    ...over,
  };
}

const PAYLOAD = {
  lastUpdated: NOW,
  totalModels: 4,
  counts: { routable: 1, parked: 0, 'proof-expired': 1, 'proven-dead': 1, 'never-verified': 1 },
  freshnessCounts: { fresh: 3, stale: 1, 'likely-removed': 0 },
  reachabilityCopy: COPY,
  freshnessCopy: FRESHNESS_COPY,
  freshDays: 7,
  entries: [
    entry({ provider: 'local', model: 'gpt-oss:120b-cloud', status: 'verified', reachability: 'routable', lastVerifiedAt: NOW - DAY }),
    // Fresh AND unverified: the row the old page mislabelled, and the row the
    // word "unreachable" would have lied about.
    entry({ provider: 'openrouter', model: 'never-tried', reachability: 'never-verified' }),
    entry({ provider: 'local', model: 'aged-out', status: 'verified', reachability: 'proof-expired', lastVerifiedAt: NOW - 9 * DAY, daysSinceVerify: 9 }),
    entry({ provider: 'local', model: 'gone', status: 'unavailable', reachability: 'proven-dead', freshness: 'stale' }),
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** An idle run — what the server reports when nothing has been started. */
const IDLE_JOB = {
  status: 'idle',
  runId: null,
  requested: 0,
  planned: 0,
  processed: 0,
  verified: 0,
  unavailable: 0,
  skipped: 0,
  errored: 0,
  current: null,
  results: [],
  startedAt: null,
  finishedAt: null,
  refusal: null,
  remaining: null,
  defaultCount: 10,
  maxCount: 25,
};

const RUNNING_JOB = {
  ...IDLE_JOB,
  status: 'running',
  runId: 'verify-1',
  requested: 3,
  planned: 3,
  processed: 1,
  verified: 1,
  current: { provider: 'groq', model: 'llama-3.3-70b' },
  results: [{ provider: 'groq', model: 'mixtral', outcome: 'verified' }],
  startedAt: NOW,
};

const DONE_JOB = {
  ...RUNNING_JOB,
  status: 'done',
  processed: 3,
  verified: 2,
  unavailable: 1,
  current: null,
  finishedAt: NOW + 5_000,
  remaining: 512,
  results: [
    { provider: 'groq', model: 'mixtral', outcome: 'verified' },
    { provider: 'groq', model: 'llama-3.3-70b', outcome: 'verified' },
    { provider: 'groq', model: 'dead-id', outcome: 'unavailable' },
  ],
};

/**
 * Route the two endpoints the panel calls. They must not share a body: a single
 * canned response makes the run state look like a timeline payload, which is how
 * a URL-blind mock hides a real shape mismatch.
 */
function mockApi(opts: {
  timeline?: unknown;
  job?: unknown;
  /** Successive GET responses, so a poll can observe progress landing. */
  jobSequence?: unknown[];
  start?: { ok: boolean; error?: string; refusal?: string; state?: unknown };
  onStart?: (body: { count?: number }) => void;
} = {}) {
  // `'job' in opts` rather than `?? IDLE_JOB`: an explicit `null` job means
  // "this server has no such endpoint", which is a different case from "idle".
  const responses = opts.jobSequence ?? ('job' in opts ? [opts.job] : [IDLE_JOB]);
  let reads = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/models/verify-next')) {
      if (method === 'POST') {
        if (init?.body) opts.onStart?.(JSON.parse(String(init.body)));
        return jsonResponse(opts.start ?? { ok: true, state: RUNNING_JOB });
      }
      const body = responses[Math.min(reads, responses.length - 1)];
      reads += 1;
      return jsonResponse(body);
    }
    return jsonResponse(opts.timeline ?? PAYLOAD);
  });
}

function mockFetch(payload: unknown = PAYLOAD) {
  return mockApi({ timeline: payload });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ModelTimeline — reachability', () => {
  it('counts routable and not-routable, and breaks the second down by reason', async () => {
    mockFetch();
    render(<ModelTimeline />);

    expect(await screen.findByText('Routable now')).toBeTruthy();
    // Deliberately two: the card's label and the filter button that opens the
    // same set. They name one set, computed once — "Routable now" vs the button's
    // bare "Routable" is what keeps those two distinguishable.
    const labels = screen.getAllByText('Not routable');
    expect(labels).toHaveLength(2);
    // The tile's label, found by the metric-tile class — the value it heads sits
    // on the same row, so this is the number the tile reports.
    const card = labels.find((el) => el.className === 'metric-tile-label');
    expect(card?.parentElement?.textContent).toContain('3');
    // The breakdown is what replaces the old contradictory "Fresh / Stale /
    // Likely Removed" cards.
    expect(screen.getByText('Proven dead:')).toBeTruthy();
    expect(screen.getByText('Never verified:')).toBeTruthy();
    expect(screen.getByText('Proof expired:')).toBeTruthy();
  });

  it('filters to exactly the rows the Routable card counted', async () => {
    mockFetch();
    render(<ModelTimeline />);
    await screen.findByText('gpt-oss:120b-cloud');

    fireEvent.click(screen.getByRole('button', { name: 'Routable' }));

    await waitFor(() => expect(screen.queryByText('never-tried')).toBeNull());
    expect(screen.getByText('gpt-oss:120b-cloud')).toBeTruthy();
    expect(screen.queryByText('aged-out')).toBeNull();
    expect(screen.queryByText('gone')).toBeNull();
  });

  it('filters to the not-routable rows without dropping the routable one from view elsewhere', async () => {
    mockFetch();
    render(<ModelTimeline />);
    await screen.findByText('gpt-oss:120b-cloud');

    fireEvent.click(screen.getByRole('button', { name: 'Not routable' }));

    await waitFor(() => expect(screen.queryByText('gpt-oss:120b-cloud')).toBeNull());
    expect(screen.getByText('never-tried')).toBeTruthy();
    expect(screen.getByText('aged-out')).toBeTruthy();
    expect(screen.getByText('gone')).toBeTruthy();
  });

  it('badges a fresh, never-tested model as NEVER VERIFIED — never as unreachable', async () => {
    mockFetch();
    render(<ModelTimeline />);
    await screen.findByText('never-tried');

    const badge = screen.getByTestId('reachability-openrouter-never-tried');
    expect(badge.textContent).toContain('NEVER VERIFIED');
    // The page must not assert a failure it never tested for.
    expect(badge.textContent?.toUpperCase()).not.toContain('UNREACHABLE');
    expect(
      screen.getByText(/a fresh model that was never verified is an unknown, not a failure/i),
    ).toBeTruthy();
  });

  it('ignores probe-age Freshness when reading routability', async () => {
    mockFetch();
    render(<ModelTimeline />);
    await screen.findByText('aged-out');

    // "aged-out" is freshly probed but its PROOF expired — the old page counted
    // it as Fresh while refusing to route to it.
    const row = screen.getByTestId('timeline-row-local-aged-out');
    expect(row.textContent).toContain('Fresh');
    expect(row.textContent).toContain('PROOF EXPIRED');
    expect(screen.getByTestId('reachability-local-aged-out').textContent).toContain('PROOF EXPIRED');
  });

  it('says so plainly when the server predates the classifier', async () => {
    mockFetch({ entries: [], lastUpdated: NOW, totalModels: 0, freshCount: 0, staleCount: 0, removedCount: 0 });
    render(<ModelTimeline />);

    expect(await screen.findByText(/predates the reachability view/i)).toBeTruthy();
  });
});

describe('ModelTimeline — verify next N', () => {
  it('offers the action with the server\'s default count and cap', async () => {
    mockApi();
    render(<ModelTimeline />);

    const button = await screen.findByTestId('verify-backlog-start');
    expect(button.textContent).toContain('Verify next 10 now');
    const input = (await screen.findByLabelText('how many models to verify')) as HTMLInputElement;
    expect(input.max).toBe('25');
    expect(input.min).toBe('1');
  });

  it('starts a run with the CHOSEN count and follows it to the summary', async () => {
    const posts: Array<{ count?: number }> = [];
    mockApi({ jobSequence: [IDLE_JOB, DONE_JOB], onStart: (b) => posts.push(b) });
    render(<ModelTimeline />);

    const input = (await screen.findByLabelText('how many models to verify')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    // The label has to follow the field, or the button says 10 while sending 3.
    expect(screen.getByTestId('verify-backlog-start').textContent).toContain('Verify next 3 now');
    fireEvent.click(screen.getByTestId('verify-backlog-start'));

    await waitFor(() => expect(posts).toEqual([{ count: 3 }]));
    // Progress comes from the SERVER, not from the click: the run happens there.
    expect(await screen.findByTestId('verify-backlog-progress')).toBeTruthy();
    expect(screen.getByTestId('verify-backlog-progress').textContent).toContain('groq/llama-3.3-70b');

    const summary = await screen.findByTestId('verify-backlog-summary', {}, { timeout: 3_000 });
    expect(summary.textContent).toContain('2 verified');
    expect(summary.textContent).toContain('1 proven unavailable');
    // The number the user is trying to move.
    expect(summary.textContent).toContain('512 still never verified');
    // And WHICH models changed, not just how many.
    expect(screen.getByText('groq/dead-id')).toBeTruthy();
  });

  it('words an empty backlog as good news rather than a failure', async () => {
    mockApi({
      start: {
        ok: false,
        refusal:
          'Nothing to verify — every tracked model is either already proven, proven dead, parked, throttled, or behind a provider you have no credentials for.',
      },
    });
    render(<ModelTimeline />);

    fireEvent.click(await screen.findByTestId('verify-backlog-start'));

    const msg = await screen.findByTestId('verify-backlog-message');
    expect(msg.textContent).toMatch(/nothing to verify/i);
    // Informational, not an error — the user asked for work and there was none.
    expect(msg.className).not.toContain('env-var-notice-error');
  });

  it('surfaces a real refusal (not logged in) as an error', async () => {
    mockApi({ start: { ok: false, error: 'Not authenticated — log in first.' } });
    render(<ModelTimeline />);

    fireEvent.click(await screen.findByTestId('verify-backlog-start'));

    const msg = await screen.findByTestId('verify-backlog-message');
    expect(msg.textContent).toContain('Not authenticated');
    expect(msg.className).toContain('env-var-notice-error');
  });

  it('renders no action at all when the server predates the endpoint', async () => {
    mockApi({ job: null });
    render(<ModelTimeline />);

    await screen.findByText('Routable now');
    expect(screen.queryByTestId('verify-backlog-panel')).toBeNull();
  });
});
