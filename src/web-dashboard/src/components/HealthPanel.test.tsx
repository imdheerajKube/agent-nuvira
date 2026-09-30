/**
 * System tab tests — the doctor page.
 *
 * The regression this file exists for: the tab was titled "System Health" and
 * its **Status** row was the hardcoded string `● Connected`. A status that never
 * reads anything cannot be wrong, which made it worse than useless — it was a
 * green light for a stream that could be down. So the first assertion here is
 * that the state comes from the `connected` PROP and can say Reconnecting.
 *
 * The rest pins what the page now shows that it did not before: the pass/warn/fail
 * checks the Admin tab already rendered, with failures stated first; and
 * `health.agentStats`, which the server has always computed and nothing rendered.
 * The success-rate assertion is a units check — the stored value is a FRACTION
 * (0.875), so a page printing it raw would read "0.875%" and be wrong by 100×.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import HealthPanel from './HealthPanel';
import { dashboardAPI } from '../api';
import type { AdminChecksData, DashboardData, HealthData } from '../types';

const NOW = 1_800_000_000_000;

const CHECKS: AdminChecksData = {
  system: [
    { name: 'Node.js runtime', status: 'pass', message: 'v22.11.0' },
    { name: 'Config file', status: 'warn', message: 'No config.json yet', fix: 'Run nuvira config init' },
  ],
  enterprise: [
    {
      name: 'Audit log writable',
      status: 'fail',
      message: 'Write test failed',
      detail: 'EACCES',
      fix: 'Fix permissions on ~/.nuvira/audit.jsonl',
    },
  ],
  providers: [
    { type: 'groq', configured: true, keySource: 'env', keyMasked: 'gsk_…' },
    { type: 'openai', configured: false, keySource: 'none', keyMasked: null },
  ],
  serverTime: NOW,
};

function mockChecks(payload: AdminChecksData | null = CHECKS) {
  return vi.spyOn(dashboardAPI, 'fetchAdminChecks').mockResolvedValue(payload);
}

function dashboardData(health: Partial<HealthData> = {}): DashboardData {
  return {
    health: { patterns: 0, feedback: 0, vectors: 0, agentStats: null, memoryDir: '/tmp/mem', ...health },
  } as unknown as DashboardData;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HealthPanel — the real connection state', () => {
  it('says Reconnecting when the stream is down, instead of the old hardcoded Connected', async () => {
    mockChecks();
    render(<HealthPanel data={null} connected={false} lastUpdated="12:00:01" />);

    const state = await screen.findByTestId('connection-state');
    expect(state.textContent).toContain('Reconnecting');
    // The whole point: it must be ABLE to be wrong.
    expect(state.textContent?.toUpperCase()).not.toContain('CONNECTED');
  });

  it('says Connected only when the prop says the stream is up', async () => {
    mockChecks();
    render(<HealthPanel data={null} connected={true} lastUpdated="12:00:05" />);

    expect((await screen.findByTestId('connection-state')).textContent).toContain('Connected');
  });
});

describe('HealthPanel — doctor checks', () => {
  it('renders both check groups with their verdicts and fix lines', async () => {
    mockChecks();
    render(<HealthPanel data={null} connected={true} lastUpdated="--" />);

    expect(await screen.findByText('Node.js runtime')).toBeTruthy();
    expect(screen.getByText('Config file')).toBeTruthy();
    expect(screen.getByText('Audit log writable')).toBeTruthy();
    expect(screen.getByText(/Fix permissions on/)).toBeTruthy();
  });

  it('states failures FIRST in the rollup, so a green summary cannot bury one', async () => {
    mockChecks();
    render(<HealthPanel data={null} connected={true} lastUpdated="--" />);

    const verdict = await screen.findByTestId('doctor-verdict');
    expect(verdict.textContent).toContain('1 failing');
    // Order: failures, then warnings, then passes.
    expect(verdict.textContent).toMatch(/1 failing\s*·\s*1 warning\s*·\s*1 passing/);
  });

  it('counts providers from the payload the server already sends', async () => {
    mockChecks();
    render(<HealthPanel data={null} connected={true} lastUpdated="--" />);

    expect(await screen.findByText(/1 of 2 providers configured/)).toBeTruthy();
  });

  it('says when a group came back empty rather than hiding the section', async () => {
    mockChecks({ system: [], enterprise: [], providers: [], serverTime: NOW });
    render(<HealthPanel data={null} connected={true} lastUpdated="--" />);

    expect(await screen.findByText('No system checks returned.')).toBeTruthy();
    expect(screen.getByText('No enterprise checks returned.')).toBeTruthy();
  });

  it('reports an unreachable server instead of rendering an empty page', async () => {
    mockChecks(null);
    render(<HealthPanel data={null} connected={true} lastUpdated="--" />);

    expect(await screen.findByText(/Could not reach the dashboard server/)).toBeTruthy();
  });
});

describe('HealthPanel — agent stats (computed by the server, previously rendered nowhere)', () => {
  const withAgents = dashboardData({
    agentStats: {
      totalRuns: 42,
      overallSuccessRate: 0.9,
      agents: {
        implementer: {
          totalRuns: 40,
          successfulRuns: 35,
          failedRuns: 5,
          successRate: 0.875,
          modelPerformance: {},
          lastRun: NOW - 60_000,
        },
        reviewer: {
          totalRuns: 2,
          successfulRuns: 2,
          failedRuns: 0,
          successRate: 1,
          modelPerformance: {},
          lastRun: NOW - 3_600_000,
        },
      },
    },
  });

  it('renders the rates as PERCENTAGES — the stored value is a fraction', async () => {
    mockChecks();
    render(<HealthPanel data={withAgents} connected={true} lastUpdated="--" />);

    expect(await screen.findByText('Recorded runs')).toBeTruthy();
    expect(screen.getByText('90.0%')).toBeTruthy();
    // Printing the raw fraction would read as a 100× understatement.
    expect(screen.queryByText('0.9%')).toBeNull();
    expect(screen.queryByText('0.9')).toBeNull();
  });

  it('lists per-agent runs and rates, busiest first', async () => {
    mockChecks();
    render(<HealthPanel data={withAgents} connected={true} lastUpdated="--" />);

    const impl = await screen.findByTestId('agent-stats-implementer');
    expect(impl.textContent).toContain('40 runs');
    expect(impl.textContent).toContain('87.5%');
    expect(screen.getByTestId('agent-stats-reviewer').textContent).toContain('100.0%');
  });

  it('explains the empty case instead of showing a blank section', async () => {
    mockChecks();
    render(<HealthPanel data={dashboardData()} connected={true} lastUpdated="--" />);

    expect(await screen.findByText(/No agent-stats file yet/)).toBeTruthy();
  });
});

describe('HealthPanel — the store counters, demoted', () => {
  it('keeps them, labelled as sizes rather than as a health verdict', async () => {
    mockChecks();
    render(
      <HealthPanel
        data={dashboardData({ patterns: 12, feedback: 3, vectors: 900, memoryDir: '/home/u/.nuvira/memory' })}
        connected={true}
        lastUpdated="--"
      />,
    );

    expect(await screen.findByText('Learning Stores')).toBeTruthy();
    expect(screen.getByText('Coding Patterns')).toBeTruthy();
    expect(screen.getByText('User Feedback')).toBeTruthy();
    // Legitimately in two places: the Memory Directory store card and the
    // Server Info "Data Directory" row, so this is not getByText's single match.
    expect(screen.getAllByText('/home/u/.nuvira/memory').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sizes, not verdicts/)).toBeTruthy();
  });
});
