/**
 * WS1 (#23) — the Trace tab must show the verdicts a run recorded.
 *
 * The capability `findings-verdicts` is proven at the surface boundary by the
 * parity suite, but a verdict nobody can read after the run is not auditable —
 * which is the whole reason findings are persisted on the trace at all. So this
 * pins the RENDERING: the count on the index row (so an audit is discoverable),
 * the evidence behind a CONFIRMED verdict, and the explicit "no evidence" line
 * for an unearned one (so the gate's refusal cannot read as a fact).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TracePanel from './TracePanel';
import { dashboardAPI } from '../api';
import type { TraceEntry } from '../types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** One chat trace that recorded two findings — one earned, one refused. */
const TRACE: TraceEntry = {
  id: 'trace-findings-1',
  goal: 'verify the harness',
  source: 'chat',
  startedAt: Date.now() - 1000,
  endedAt: Date.now(),
  durationMs: 1000,
  success: true,
  stepCount: 0,
  failedSteps: 0,
  totalTokens: 0,
  steps: [],
  findings: [
    {
      claim: 'the harness can drive every surface',
      verdict: 'CONFIRMED',
      outcome: 'checked by running the harness',
      evidence: [{ kind: 'observation', ref: 'all five surfaces agreed' }],
      source: 'agent',
    },
    {
      claim: 'this claim was never checked',
      verdict: 'PLAUSIBLE',
      outcome: 'reported as a guess',
      evidence: [],
      source: 'agent',
    },
  ],
};

describe('TracePanel — recorded findings (WS1)', () => {
  it('shows the confirmed/plausible split on the row, then the verdicts and evidence', async () => {
    vi.spyOn(dashboardAPI, 'fetchTraces').mockResolvedValue([TRACE]);
    render(<TracePanel />);

    // The index row carries the split so a reader can see an audit exists
    // WITHOUT opening the trace — "2 findings" would read as two facts.
    await waitFor(() => expect(screen.getByText('🔎 1/2 confirmed')).toBeTruthy());

    fireEvent.click(screen.getByText('verify the harness'));

    // The CONFIRMED verdict is shown WITH the check behind it.
    await waitFor(() =>
      expect(screen.getByText('the harness can drive every surface')).toBeTruthy(),
    );
    expect(screen.getByText('CONFIRMED')).toBeTruthy();
    expect(screen.getByText('all five surfaces agreed')).toBeTruthy();

    // An unearned claim says so instead of reading like a fact.
    expect(screen.getByText('PLAUSIBLE')).toBeTruthy();
    expect(screen.getByText('this claim was never checked')).toBeTruthy();
    expect(
      screen.getByText(/no evidence — reported as PLAUSIBLE, not verified/),
    ).toBeTruthy();
  });

  it('renders no findings section on a trace that recorded none', async () => {
    vi.spyOn(dashboardAPI, 'fetchTraces').mockResolvedValue([
      { ...TRACE, findings: undefined },
    ]);
    render(<TracePanel />);

    await waitFor(() => expect(screen.getByText('verify the harness')).toBeTruthy());
    // Absence is not a claim of zero: no section, no badge.
    expect(screen.queryByText(/confirmed/)).toBeNull();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
  });
});
