/**
 * Unit tests for the scrubbable PhaseTimeline component (llm-viz-inspired).
 *
 * Covers the empty state, run rendering (phase blocks + meta), scrub-to-phase
 * via block click (the jsdom-safe path — no getBoundingClientRect needed),
 * run switching, play/pause toggling, and the dagToPipelineRun /
 * collectPipelineRuns helpers that derive runs from the live DAG + persisted
 * pipeline-runs.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import PhaseTimeline, { dagToPipelineRun, collectPipelineRuns } from './PhaseTimeline';
import type { DAGData, PipelineRun } from '../types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const makeRun = (overrides: Partial<PipelineRun> = {}): PipelineRun => ({
  id: 'run-1',
  goal: 'Implement JWT auth middleware',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  success: true,
  totalDurationMs: 60_000,
  phases: [
    {
      id: 'p1',
      agentType: 'planner',
      status: 'completed',
      description: 'Break the goal into tasks',
      complexity: 'moderate',
      summary: 'Planned 4 steps',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_010_000,
      durationMs: 10_000,
    },
    {
      id: 'p2',
      agentType: 'writer',
      status: 'completed',
      description: 'Write the middleware',
      complexity: 'simple',
      summary: 'Wrote src/middleware/auth.ts',
      startedAt: 1_700_000_010_000,
      completedAt: 1_700_000_040_000,
      durationMs: 30_000,
    },
    {
      id: 'p3',
      agentType: 'tester',
      status: 'failed',
      description: 'Run the test suite',
      complexity: 'simple',
      startedAt: 1_700_000_040_000,
      completedAt: 1_700_000_060_000,
      durationMs: 20_000,
    },
  ],
  ...overrides,
});

// ─── Component behavior ─────────────────────────────────────────────────────

describe('PhaseTimeline', () => {
  it('renders the empty state when there are no runs', () => {
    render(<PhaseTimeline runs={[]} />);
    expect(screen.getByText(/no pipeline runs yet/i)).toBeTruthy();
  });

  it('renders phase blocks, step meta, and the run goal', () => {
    render(<PhaseTimeline runs={[makeRun()]} />);

    // Run chip with goal
    expect(screen.getByText('Implement JWT auth middleware')).toBeTruthy();
    // Meta: 3 steps, 2 done, 1 failed, total duration
    expect(screen.getByText('3 steps')).toBeTruthy();
    expect(screen.getByText('✅ 2')).toBeTruthy();
    expect(screen.getByText('❌ 1')).toBeTruthy();
    // Phase labels on blocks (also appear in the detail panel — use *AllBy*)
    expect(screen.getAllByText('Planner').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Writer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tester').length).toBeGreaterThan(0);
    // Default detail panel shows the first phase under the caret
    expect(screen.getByText('Break the goal into tasks')).toBeTruthy();
  });

  it('scrubs to a phase on block click and notifies the parent via onScrub', () => {
    const onScrub = vi.fn();
    render(<PhaseTimeline runs={[makeRun()]} onScrub={onScrub} />);

    const testerBlock = screen.getByText('Tester').closest('button')!;
    fireEvent.click(testerBlock);

    expect(onScrub).toHaveBeenCalledWith('p3');
    // Detail panel now describes the scrubbed phase
    expect(screen.getByText('Run the test suite')).toBeTruthy();
    expect(screen.getByText('❌ Failed')).toBeTruthy();
  });

  it('switches runs via the selector chips and resets the caret', () => {
    const second = makeRun({ id: 'run-2', goal: 'Fix flaky test', phases: [
      { id: 'q1', agentType: 'reviewer', status: 'completed', description: 'Review the diff', durationMs: 5_000 },
    ] });
    const onSelectRun = vi.fn();
    render(<PhaseTimeline runs={[makeRun(), second]} onSelectRun={onSelectRun} />);

    fireEvent.click(screen.getByText('Fix flaky test'));
    expect(onSelectRun).toHaveBeenCalledWith('run-2');
    expect(screen.getByText('Review the diff')).toBeTruthy();
  });

  it('toggles play/pause on the scrub button', () => {
    render(<PhaseTimeline runs={[makeRun()]} />);

    const playBtn = screen.getByRole('button', { name: 'Play scrub' });
    fireEvent.click(playBtn);
    expect(screen.getByRole('button', { name: 'Pause scrub' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause scrub' }));
    expect(screen.getByRole('button', { name: 'Play scrub' })).toBeTruthy();
  });
});

// ─── Run derivation helpers ─────────────────────────────────────────────────

describe('dagToPipelineRun', () => {
  it('returns null for empty/missing DAGs', () => {
    expect(dagToPipelineRun(null)).toBeNull();
    expect(dagToPipelineRun(undefined)).toBeNull();
    expect(dagToPipelineRun({ nodes: [] } as unknown as DAGData)).toBeNull();
  });

  it('derives a run with proportional phases from live DAG nodes', () => {
    const dag: DAGData = {
      pipeline: 'Refactor router',
      nodes: [
        { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 400 },
        { id: 'b', agentType: 'writer', status: 'completed', description: 'Write', startedAt: 400, completedAt: 700 },
      ],
      edges: [{ from: 'a', to: 'b' }],
      timestamp: 700,
      active: false,
    };

    const run = dagToPipelineRun(dag)!;
    expect(run.id).toMatch(/^live-/);
    expect(run.goal).toBe('Refactor router');
    expect(run.phases).toHaveLength(2);
    expect(run.phases[0].durationMs).toBe(300);
    expect(run.totalDurationMs).toBe(600);
    expect(run.success).toBe(true);
  });

  it('marks a run failed when any node failed', () => {
    const dag: DAGData = {
      pipeline: 'X',
      nodes: [
        { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 200 },
        { id: 'b', agentType: 'tester', status: 'failed', description: 'Test', startedAt: 200, completedAt: 300 },
      ],
      edges: [],
      timestamp: 300,
      active: false,
    };
    expect(dagToPipelineRun(dag)!.success).toBe(false);
  });
});

describe('collectPipelineRuns', () => {
  it('places the live run first and de-duplicates by id', () => {
    // Live-run id is derived from the DAG start time (live-<startedAt>).
    const dag: DAGData = {
      pipeline: 'Live run',
      nodes: [
        { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan', startedAt: 100, completedAt: 400 },
      ],
      edges: [],
      timestamp: 400,
      active: false,
    };
    const storedRun = makeRun({ id: 'run-9' });

    const runs = collectPipelineRuns(dag, { total: 2, runs: [storedRun, makeRun({ id: 'live-100', goal: 'duplicate' })] });
    expect(runs.map((r) => r.id)).toEqual(['live-100', 'run-9']);
  });

  it('falls back to stored runs only when there is no live DAG', () => {
    const storedRun = makeRun();
    const runs = collectPipelineRuns(null, { total: 1, runs: [storedRun] });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('run-1');
  });

  it('returns an empty list when both inputs are empty', () => {
    expect(collectPipelineRuns(null, undefined)).toEqual([]);
  });
});
