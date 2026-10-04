/**
 * Overview — the landing page's summary row and quick actions.
 *
 * Three things on this page can be wrong while the page still "renders":
 *
 *  - The summary cards read from TWO sources that can arrive (or fail)
 *    independently — the shared `/api/all` payload and the hub aggregate — so
 *    each card must appear only when its source did, not as an empty shell.
 *  - Every number in the Task Summary is admin-gated. A 401 is a REAL answer and
 *    must be said out loud ("sign in"), because the alternative — rendering it
 *    as "0 running" — is a confident lie about the task queue.
 *  - The quick actions are the page's whole point (it is a launch pad). They are
 *    `<Link>`s, so the thing to assert is the ROUTE they navigate to, not that
 *    some anchor exists.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Overview from './Overview';
import { dashboardAPI } from '../api';
import type { DashboardData, HubData, TaskRecord } from '../types';

const TASK = (over: Partial<TaskRecord>): TaskRecord =>
  ({
    id: 't',
    command: 'doing work',
    args: [],
    cwd: '/workspace',
    status: 'done',
    exitCode: 0,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    durationMs: 1000,
    timeoutMs: 300000,
    logs: [],
    ...over,
  }) as unknown as TaskRecord;

/** The `/api/all` payload, with the fields Overview reads. */
const DATA: DashboardData = {
  cost: { totalCost: 1290, totalRequests: 4200, byProvider: { local: 1.5, groq: 2.5 } },
  history: { total: 7 },
  benchmarks: { totalRuns: 3 },
  memory: {
    total: 11,
    byFingerprint: { typescript: 5 },
    facts: { total: 9 },
    recall: { last7d: 4 },
    backend: 'local',
  },
  health: { vectors: 100, patterns: 6 },
  modelRegistry: {
    enabled: true,
    total: 20,
    verified: 15,
    routableNow: 11,
    unverified: 4,
    unavailable: 1,
    parked: 2,
    providers: [],
    updatedAt: 0,
  },
} as unknown as DashboardData;

/** The hub aggregate the Gateway card and the tiles read. */
const HUB = {
  toolsets: { toolsets: [], enabled: 3, disabled: 1, totalTools: 9 },
  channels: {
    platforms: [
      { platform: 'slack', label: 'Slack', configured: true, envVars: [] },
      { platform: 'email', label: 'Email (SMTP)', configured: false, envVars: [] },
    ],
  },
  skills: { compiled: [], hub: [], total: 12, enabled: 10, disabled: 2 },
  conversations: { total: 4, recent: [] },
} as unknown as HubData;

/**
 * recharts' ResponsiveContainer measures itself with a ResizeObserver, which
 * jsdom does not implement — the page throws on mount without one. The charts
 * are not what this suite asserts, so a no-op observer is enough.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Mock both fetch paths. A null `tasks` means "the read never answered". */
function mockReads(hub: HubData | null = HUB, tasks: { status: number; tasks: TaskRecord[] } | null = { status: 200, tasks: [] }) {
  vi.spyOn(dashboardAPI, 'fetchHub').mockResolvedValue(hub);
  vi.spyOn(dashboardAPI, 'listTasks').mockResolvedValue(tasks);
}

function renderPage(data: DashboardData | null = DATA): void {
  render(
    <MemoryRouter>
      <Overview data={data} />
    </MemoryRouter>,
  );
}

/** Read the value rendered beside a summary row's label. */
function valueFor(label: string): string {
  const el = screen.getByText(label);
  return el.previousElementSibling?.textContent ?? '';
}

describe('Overview — summary cards', () => {
  it('shows the header and a connecting state before any data arrives', () => {
    // Both reads answer null, so the component does not set state after the test
    // returns (which is an act() warning rather than a failure).
    mockReads(null, null);
    renderPage(null);
    expect(screen.getByRole('heading', { level: 1, name: /System Overview/ })).toBeTruthy();
    expect(screen.getByText(/Connecting to dashboard/)).toBeTruthy();
  });

  it('fills the Task Summary from the task list, counting today by local day', async () => {
    mockReads(HUB, {
      status: 200,
      tasks: [
        TASK({ id: 'run', status: 'running', finishedAt: null }),
        TASK({ id: 'done' }), // finished today
        TASK({ id: 'fail', status: 'failed' }), // finished today
        TASK({ id: 'old', status: 'failed', finishedAt: Date.now() - 3 * 24 * 3600_000 }),
      ],
    });
    renderPage();

    await screen.findByText('Task Summary');
    await waitFor(() => expect(valueFor('Running now')).toBe('1'));
    expect(valueFor('Completed today')).toBe('1');
    expect(valueFor('Failed today')).toBe('1'); // the stale failure is not today
  });

  it('hides the Failed row entirely when nothing failed today', async () => {
    mockReads(HUB, { status: 200, tasks: [TASK({ id: 'done' })] });
    renderPage();
    await screen.findByText('Task Summary');
    await waitFor(() => expect(valueFor('Completed today')).toBe('1'));
    expect(screen.queryByText('Failed today')).toBeNull();
  });

  it('renders the Models card from the registry', async () => {
    mockReads();
    renderPage();
    await screen.findByText('Models');
    // Settle the task read too, so no state update escapes the test.
    await waitFor(() => expect(screen.getByText('Completed today')).toBeTruthy());
    // Two DISTINCT numbers: verified (proven) and the staleness-gated subset
    // the router can actually pick now. Reporting one under a "routable" label
    // is the bug this split removes.
    expect(valueFor('Verified (proven)')).toBe('15');
    expect(valueFor('Routable now')).toBe('11');
    expect(valueFor('Tracked models (registry)')).toBe('20');
    expect(valueFor('Quota-parked')).toBe('2');
  });

  it('omits the Models card when that source is absent, rather than showing zeros', async () => {
    mockReads();
    const { modelRegistry: _drop, ...withoutRegistry } = DATA;
    renderPage(withoutRegistry as DashboardData);
    expect(screen.getByText('Task Summary')).toBeTruthy();
    // The hub read settles after mount; wait for it before judging absence.
    await screen.findByText('Gateway Status');
    expect(screen.queryByText('Models')).toBeNull();
  });

  it('renders the Gateway Status card from the hub aggregate', async () => {
    mockReads();
    renderPage();
    await screen.findByText('Gateway Status');
    await waitFor(() => expect(valueFor('Platforms configured')).toBe('1/2'));
    expect(valueFor('Skills loaded')).toBe('12');
    expect(valueFor('Toolsets enabled')).toBe('3');
  });

  it('omits the Gateway card while the hub read is still outstanding', async () => {
    mockReads(null);
    renderPage();
    await screen.findByText('Task Summary');
    await waitFor(() => expect(screen.getByText('Completed today')).toBeTruthy());
    expect(screen.queryByText('Gateway Status')).toBeNull();
  });
});

describe('Overview — Quick Actions', () => {
  it('points every quick action at its route', async () => {
    mockReads();
    renderPage();
    await screen.findByText('Task Summary');
    await screen.findByText('Gateway Status');

    const expected: Array<[RegExp, string]> = [
      [/Run a CLI command/, '/tasks'],
      [/Skills & channels/, '/hub'],
      [/Model registry/, '/models'],
      [/Reasoning traces/, '/traces'],
      [/Doctor checks/, '/system'],
    ];
    for (const [name, href] of expected) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(href);
    }
  });

  it('wires each summary card to the page that can act on it', async () => {
    mockReads();
    renderPage();
    await screen.findByText('Task Summary');
    await screen.findByText('Gateway Status');

    expect(screen.getByRole('link', { name: /Open console/ }).getAttribute('href')).toBe('/tasks');
    expect(screen.getByRole('link', { name: /Manage/ }).getAttribute('href')).toBe('/models');
    expect(screen.getByRole('link', { name: /Gateway ops/ }).getAttribute('href')).toBe('/gateway');
  });
});

describe('Overview — admin-gated task history', () => {
  it('says to sign in on a 401 instead of reporting an empty queue', async () => {
    mockReads(HUB, { status: 401, tasks: [] });
    renderPage();

    await screen.findByText('Task Summary');
    await waitFor(() => expect(screen.getByText(/Sign in to Admin to see task history/)).toBeTruthy());
    // The lie this guards against: a 401 rendering as "0 running".
    expect(screen.queryByText('Running now')).toBeNull();
    expect(screen.queryByText('Completed today')).toBeNull();
  });

  it('shows a loading note while the admin read has not answered yet', async () => {
    mockReads(HUB, null);
    renderPage();
    await screen.findByText('Task Summary');
    await screen.findByText('Gateway Status');
    expect(screen.getByText(/Loading task history/)).toBeTruthy();
  });

  it('does not gate the rest of the page on the task read', async () => {
    mockReads(HUB, { status: 401, tasks: [] });
    // A signed-out viewer still gets quick actions and the live metric tiles.
    renderPage();
    await screen.findByText('Task Summary');
    expect(screen.getByRole('link', { name: /Run a CLI command/ })).toBeTruthy();
    await screen.findByText('Gateway Status');
  });
});
