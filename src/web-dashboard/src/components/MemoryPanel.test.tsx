/**
 * MemoryPanel — now reachable at `/memory`.
 *
 * This component was fully built but had no route, so it rendered for nobody
 * while the server kept computing `readMemoryData()` on every payload. Worse,
 * `src/context/session-recall.ts` explicitly documents its recall-hit telemetry
 * as feeding "G2 dashboard memory panel" — the data had a designated consumer
 * that was never wired.
 *
 * These tests pin the panel's contract so the wiring cannot silently regress.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import MemoryPanel from './MemoryPanel';
import type { DashboardData } from '../types';

/** Only the fields this panel reads; the rest of DashboardData is irrelevant. */
function makeData(overrides: {
  memory?: Partial<DashboardData['memory']>;
  health?: Partial<DashboardData['health']>;
} = {}): DashboardData {
  return {
    memory: {
      total: 12400,
      avgScore: 0.873,
      byFingerprint: { 'node-ts': 120, 'python-ml': 40 },
      facts: { total: 310, byProject: { 'acme-api': 200, 'acme-web': 110 } },
      recall: { total: 96, today: 7, last7d: 33 },
      backend: 'local',
      ...overrides.memory,
    },
    health: { patterns: 58, feedback: 21, ...overrides.health },
  } as unknown as DashboardData;
}

describe('MemoryPanel', () => {
  it('shows a loading state before data arrives', () => {
    render(<MemoryPanel data={null} />);
    expect(screen.getByText(/loading memory data/i)).toBeTruthy();
  });

  it('renders the memory stats the server already computes', () => {
    render(<MemoryPanel data={makeData()} />);

    expect(screen.getByText('Trajectories')).toBeTruthy();
    expect(screen.getByText('12.4K')).toBeTruthy();
    expect(screen.getByText('Avg Score')).toBeTruthy();
    expect(screen.getByText('87.3%')).toBeTruthy();
    expect(screen.getByText('Facts')).toBeTruthy();
    expect(screen.getByText('Recall Hits')).toBeTruthy();
    // Health-sourced counters belong to this panel too.
    expect(screen.getByText('Coding Patterns')).toBeTruthy();
    expect(screen.getByText('Feedback Ratings')).toBeTruthy();
  });

  it('breaks trajectories and facts down by project', () => {
    render(<MemoryPanel data={makeData()} />);

    expect(screen.getByText('By Project Type')).toBeTruthy();
    expect(screen.getByText('node-ts')).toBeTruthy();
    expect(screen.getByText('120 trajectory(ies)')).toBeTruthy();

    expect(screen.getByText('Facts by Project')).toBeTruthy();
    expect(screen.getByText('acme-api')).toBeTruthy();
    expect(screen.getByText('200 fact(s)')).toBeTruthy();
  });

  it('surfaces recall activity and the active backend', () => {
    render(<MemoryPanel data={makeData()} />);
    // Recall is the direct evidence the agent has re-used past project work.
    expect(screen.getByText(/33 recall\(s\) this week, 7 today/)).toBeTruthy();
    expect(screen.getByText('local')).toBeTruthy();
  });

  it('says so plainly when nothing has been recalled yet', () => {
    render(<MemoryPanel data={makeData({ memory: { recall: { total: 0, today: 0, last7d: 0 } } })} />);
    expect(screen.getByText(/no recalls yet/)).toBeTruthy();
  });

  it('omits the breakdown sections when there is no memory yet', () => {
    render(<MemoryPanel data={makeData({ memory: { byFingerprint: {}, facts: { total: 0, byProject: {} } } })} />);
    expect(screen.queryByText('By Project Type')).toBeNull();
    expect(screen.queryByText('Facts by Project')).toBeNull();
  });
});
