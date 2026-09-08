/**
 * Tests for DAGView's Run Timeline integration.
 *
 * Regression coverage for the reviewer-flagged bug: the scrubbable phase
 * timeline must remain reachable for HISTORICAL runs even when no pipeline is
 * live — previously the empty-state early return hid every persisted run the
 * moment no DAG was active, defeating the whole point of persisting runs.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DAGView from './DAGView';
import type { DashboardData, PipelineRun } from '../types';

const makeRun = (): PipelineRun => ({
  id: 'run-1',
  goal: 'Refactor the router',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_030_000,
  success: true,
  totalDurationMs: 30_000,
  phases: [
    { id: 'a', agentType: 'planner', status: 'completed', description: 'Plan the refactor', durationMs: 10_000 },
    { id: 'b', agentType: 'writer', status: 'completed', description: 'Apply the refactor', durationMs: 20_000 },
  ],
});

const makeData = (partial: Partial<DashboardData>): DashboardData =>
  ({ cost: {}, history: {}, benchmarks: {}, memory: {}, health: {}, serverTime: Date.now(), ...partial }) as DashboardData;

describe('DAGView Run Timeline', () => {
  it('shows the timeline for historical runs even with no live DAG (regression)', () => {
    render(
      <DAGView
        data={makeData({ pipelineRuns: { total: 1, runs: [makeRun()] } })}
      />,
    );

    // Timeline + run goal render instead of the empty state
    expect(screen.getByText(/run timeline/i)).toBeTruthy();
    expect(screen.getByText('Refactor the router')).toBeTruthy();
    expect(screen.getByText('Plan the refactor')).toBeTruthy();
    expect(screen.queryByText('No Active Pipeline')).toBeNull();
  });

  it('falls back to the empty state when there are neither runs nor a live DAG', () => {
    render(<DAGView data={makeData({})} />);
    expect(screen.getByText('No Active Pipeline')).toBeTruthy();
    expect(screen.queryByText(/run timeline/i)).toBeNull();
  });

  it('renders both the live DAG and the timeline when a pipeline is active', () => {
    render(
      <DAGView
        data={makeData({
          dag: {
            pipeline: 'Fix the auth bug',
            nodes: [
              { id: 'n1', agentType: 'planner', status: 'completed', description: 'Plan the fix', startedAt: 100, completedAt: 500 },
              { id: 'n2', agentType: 'writer', status: 'running', description: 'Write the fix', startedAt: 500 },
            ],
            edges: [{ from: 'n1', to: 'n2' }],
            timestamp: 600,
            active: true,
          },
          pipelineRuns: { total: 0, runs: [] },
        })}
      />,
    );

    // Appears in the status bar AND the timeline run chip
    expect(screen.getAllByText('Fix the auth bug').length).toBeGreaterThan(0);
    // Live DAG status bar meta (badge includes the ▶ glyph)
    expect(screen.getByText(/1 running/)).toBeTruthy();
    // Timeline renders for the live run too
    expect(screen.getByText(/run timeline/i)).toBeTruthy();
  });

  // ─── Phase 4 (AGENTIC_CAPABILITY_ASSESSMENT Addendum v4) — engine badge +
  // loop-turn telemetry card.

  it('Phase 4 — badges the pipeline engine in the status bar', () => {
    render(
      <DAGView
        data={makeData({
          dag: {
            pipeline: 'CI run',
            nodes: [{ id: 'n1', agentType: 'planner', status: 'completed', description: 'Plan' }],
            edges: [],
            timestamp: 1,
            active: false,
            engine: 'pipeline',
            engineExplanation: 'CI pins the orchestrator',
          },
          pipelineRuns: { total: 0, runs: [] },
        })}
      />,
    );
    const badge = screen.getByTestId('dag-engine-badge');
    expect(badge.textContent).toContain('pipeline');
  });

  it('Phase 4 — renders the loop-turn telemetry card even with no DAG nodes', () => {
    render(
      <DAGView
        data={makeData({
          dag: {
            pipeline: null,
            nodes: [],
            edges: [],
            timestamp: 1,
            active: true,
            engine: 'loop',
            loopTurn: {
              turnId: 'turn-1',
              title: 'assess the code quality',
              startedAt: Date.now() - 5_000,
              active: true,
              toolCallCount: 3,
              erroredToolCount: 1,
              provider: 'groq',
              model: 'llama-3.3-70b',
              toolCalls: [
                { tool: 'read_file', ok: true, durationMs: 12 },
                { tool: 'code_search', ok: true, durationMs: 30 },
                { tool: 'edit_file', ok: false, error: 'match not found' },
              ],
            },
          },
          pipelineRuns: { total: 0, runs: [] },
        })}
      />,
    );

    // The turn card renders (not the empty state) — per-tool telemetry visible
    expect(screen.getByTestId('dag-loop-turn-card')).toBeTruthy();
    expect(screen.getByText(/assess the code quality/)).toBeTruthy();
    expect(screen.getByText(/3 tool calls/)).toBeTruthy();
    expect(screen.getByText(/1 errored/)).toBeTruthy();
    expect(screen.getByText('✓ read_file')).toBeTruthy();
    expect(screen.getByText('❌ edit_file')).toBeTruthy();
    // Provider chip
    expect(screen.getByText(/groq · llama-3.3-70b/)).toBeTruthy();
  });

  it('Phase 4 — the loop-turn card shows bounded / generation-failed chips', () => {
    render(
      <DAGView
        data={makeData({
          dag: {
            pipeline: null,
            nodes: [],
            edges: [],
            timestamp: 1,
            active: false,
            engine: 'loop',
            loopTurn: {
              turnId: 'turn-2',
              title: 'huge refactor',
              startedAt: Date.now() - 60_000,
              endedAt: Date.now(),
              active: false,
              toolCallCount: 17,
              erroredToolCount: 0,
              bounded: true,
              toolCalls: [],
            },
          },
          pipelineRuns: { total: 0, runs: [] },
        })}
      />,
    );
    expect(screen.getByTestId('dag-loop-turn-card')).toBeTruthy();
    expect(screen.getByText(/bounded/)).toBeTruthy();
    expect(screen.getByText(/17 tool calls/)).toBeTruthy();
  });
});
