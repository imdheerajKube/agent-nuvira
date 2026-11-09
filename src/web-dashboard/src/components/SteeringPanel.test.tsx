/**
 * The backlog half of the Guidance panel.
 *
 * The state that stranded users: "Create task" marked an item `scheduled` and
 * disabled the only button on it, so a backlog item could never be acted on
 * again. These tests pin the three ways out — re-copy, start a new chat, dismiss
 * — and that each one goes through the server's backlog endpoint.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { steeringBacklog, steeringDiscuss, steeringGet } from '../api';
import SteeringPanel from './SteeringPanel';
import type { SteeringProjection } from '../types';

vi.mock('../api', () => ({
  steeringGet: vi.fn(),
  steeringGuide: vi.fn(),
  steeringDecide: vi.fn(),
  steeringDiscuss: vi.fn(),
  steeringInterpret: vi.fn(),
  steeringClose: vi.fn(),
  steeringBacklog: vi.fn(),
}));

const OPEN_ITEM = {
  id: 'B-open01',
  title: 'Receipt upload app',
  description: 'A mobile client for uploading receipts.',
  reason: 'Unrelated to the CSV import hardening.',
  sourceRunId: 'run-1',
  status: 'open',
  createdAt: '2026-11-09T10:00:00.000Z',
};

const SCHEDULED_ITEM = {
  id: 'B-sched02',
  title: 'Parquet export',
  description: 'Nightly export of the audit log in Parquet.',
  reason: 'A new task; the current run is editing the importer.',
  sourceRunId: 'run-1',
  status: 'scheduled',
  createdAt: '2026-11-09T09:00:00.000Z',
};

function view(backlog = [OPEN_ITEM, SCHEDULED_ITEM]): SteeringProjection {
  return {
    enabled: true,
    run: {
      runId: 'run-1',
      status: 'completed',
      goal: 'Harden the CSV import path',
      engine: 'loop',
      surface: 'dashboard',
      sessionId: 'run-1',
    },
    plan: {
      version: 1,
      steps: [{ id: '1', description: 'Reject bad rows', status: 'done' }],
    },
    changes: [],
    backlog,
    counts: {
      received: 0,
      triaged: 0,
      needsApproval: 0,
      accepted: 0,
      applied: 0,
      deferred: 0,
      answerOnly: 0,
      backlog: backlog.length,
      rejected: 0,
      stale: 0,
      failed: 0,
      withdrawn: 0,
      open: 0,
    },
    metrics: {
      guidanceReceived: 2,
      applied: 0,
      rejected: 0,
      deferred: 0,
      backlogged: 2,
      needsApproval: 0,
      planVersions: 1,
      avgTriageLatencyMs: 10,
      p95TriageLatencyMs: 13,
      avgTimeToApplyMs: 0,
      staleRate: 0,
      avgApprovalLatencyMs: 0,
      abandonedApprovals: 0,
      lowConfidenceCount: 0,
      replansPerAppliedChange: 0,
      highImpactFalseAccepts: 0,
    },
  };
}

function viewWithStatus(status: string): SteeringProjection {
  const projection = view();
  projection.run = { ...projection.run!, status };
  return projection;
}

function mockProjection(projection: SteeringProjection) {
  vi.mocked(steeringGet).mockImplementation(async (runId?: string) =>
    runId
      ? ({ ok: true, enabled: true, projection } as never)
      : ({ ok: true, enabled: true, runs: [] } as never),
  );
}

async function rowFor(title: string): Promise<HTMLElement> {
  // The first paint has no projection yet; wait for refresh() to land.
  return (await screen.findByText(title)).closest('li') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SteeringPanel guidance controls', () => {
  it('keeps Send guidance / Ask a question / New task available while the turn is busy', async () => {
    mockProjection(viewWithStatus('running'));
    render(<SteeringPanel sessionId="run-1" busy onStartTask={vi.fn()} />);

    expect(await screen.findByLabelText('Guidance text')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send guidance' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask a question' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New task' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '⏸ Pause run' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '⏹ Stop run' })).toBeTruthy();
  });

  it('moves a read-only answer into the visible guidance field while the turn is busy', async () => {
    mockProjection(viewWithStatus('running'));
    vi.mocked(steeringDiscuss).mockResolvedValue({
      ok: true,
      answer: 'The plan targets the appropriate components, not every section.',
      source: 'model',
    });
    render(<SteeringPanel sessionId="run-1" busy onStartTask={vi.fn()} />);

    fireEvent.click(await screen.findByText(/Ask about this run/));
    fireEvent.change(screen.getByLabelText('Read-only question about this run'), {
      target: { value: 'Are you adding images to all sections?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Promote to guidance' }));

    // The old bug: this state landed in a textarea that was not rendered while
    // the turn was busy, so the click looked inert. Now the field is visible
    // and carries the question for the user to edit before sending.
    await waitFor(() =>
      expect((screen.getByLabelText('Guidance text') as HTMLTextAreaElement).value).toBe(
        'Are you adding images to all sections?',
      ),
    );
    expect(screen.getByRole('status').textContent).toMatch(/moved the question into the guidance field/i);
  });
});

describe('SteeringPanel backlog actions', () => {
  it('keeps a scheduled item actionable: it offers Copy task again, not a dead button', async () => {
    mockProjection(view());
    render(<SteeringPanel sessionId="run-1" busy={false} onStartTask={vi.fn()} />);

    const scheduled = await rowFor('Parquet export');
    const copyAgain = within(scheduled).getByRole('button', { name: 'Copy task again' });
    expect((copyAgain as HTMLButtonElement).disabled).toBe(false);

    vi.mocked(steeringBacklog).mockResolvedValue({
      ok: true,
      command: 'nuvira chat "Parquet export"',
      prompt: 'Parquet export',
      projection: view(),
    });
    fireEvent.click(copyAgain);

    await waitFor(() =>
      expect(steeringBacklog).toHaveBeenCalledWith({
        runId: 'run-1',
        backlogId: 'B-sched02',
        action: 'create-task',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/copied again/i),
    );
  });

  it('starts a new chat with the server-built prompt (and marks the item scheduled)', async () => {
    mockProjection(view());
    const onStartTask = vi.fn();
    render(<SteeringPanel sessionId="run-1" busy={false} onStartTask={onStartTask} />);

    vi.mocked(steeringBacklog).mockResolvedValue({
      ok: true,
      prompt: 'Receipt upload app\n\nA mobile client for uploading receipts.',
      projection: view(),
    });
    const openRow = await rowFor('Receipt upload app');
    fireEvent.click(within(openRow).getByRole('button', { name: 'Start as new task' }));

    await waitFor(() =>
      expect(steeringBacklog).toHaveBeenCalledWith({
        runId: 'run-1',
        backlogId: 'B-open01',
        action: 'create-task',
      }),
    );
    await waitFor(() =>
      expect(onStartTask).toHaveBeenCalledWith(
        'Receipt upload app\n\nA mobile client for uploading receipts.',
      ),
    );
  });

  it('dismisses an item and stops rendering it', async () => {
    mockProjection(view());
    render(<SteeringPanel sessionId="run-1" busy={false} onStartTask={vi.fn()} />);

    vi.mocked(steeringBacklog).mockResolvedValue({
      ok: true,
      item: { ...OPEN_ITEM, status: 'dismissed' },
      projection: view([SCHEDULED_ITEM]),
    });
    const openRow = await rowFor('Receipt upload app');
    fireEvent.click(within(openRow).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(steeringBacklog).toHaveBeenCalledWith({
        runId: 'run-1',
        backlogId: 'B-open01',
        action: 'dismiss',
      }),
    );
    await waitFor(() => expect(screen.queryByText('Receipt upload app')).toBeNull());
    expect(screen.getByText('Parquet export')).toBeTruthy();
  });
});
