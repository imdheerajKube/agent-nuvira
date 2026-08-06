/**
 * Unit tests for the Requests Panel (Nuvira-Router P3-M3.2).
 * Covers: empty state (no data / older server), stats cards, row rendering,
 * the ≥3-samples latency percentile gate, and the action/search filters.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import RequestsPanel from './RequestsPanel';
import type { DashboardData, RequestsInsights } from '../types';

const makeRequests = (overrides: Partial<RequestsInsights> = {}): RequestsInsights => ({
  enabled: true,
  total: 3,
  rows: [
    {
      provider: 'groq', model: 'llama-3.3-70b-versatile', action: 'chat',
      requests: 10, errorRate: 0, partials: 3, costUsd: 0.00012, costCalls: 10,
      latency: { avg: 420, samples: 5, p50: 400, p95: 620, p99: 700 },
      callIds: ['call-1', 'call-2'], lastAt: 1750000000000,
    },
    {
      provider: 'gemini', model: 'gemini-2.0-flash', action: 'execute',
      requests: 4, errorRate: 0.25, partials: 0, costUsd: 0.0008, costCalls: 4,
      latency: { avg: 900, samples: 2 }, // < 3 samples → percentiles hidden
      callIds: [], lastAt: 1749990000000,
    },
    {
      provider: 'nim', model: 'llama-3.1-8b-instruct', action: 'plan',
      requests: 2, errorRate: 0.5, partials: 0, costCalls: 0,
      latency: undefined, callIds: [], lastAt: 1749980000000,
    },
  ],
  updatedAt: Date.now(),
  ...overrides,
});

const makeData = (requests?: RequestsInsights): DashboardData =>
  ({
    cost: { totalRequests: 0, totalCost: 0, totalTokens: 0, byProvider: {}, byModel: {}, byProviderMeasured: {}, measuredCalls: 0, estimatedCalls: 0, measuredCost: 0, estimatedCost: 0, recent: [] },
    history: { total: 0, recent: [] },
    benchmarks: { totalRuns: 0, latest: null, runs: [] },
    memory: { total: 0, avgScore: 0, byFingerprint: {} },
    health: { patterns: 0, feedback: 0, vectors: 0, agentStats: null, memoryDir: '' },
    requests,
    serverTime: Date.now(),
  }) as unknown as DashboardData;

describe('RequestsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows the empty state when the server sends no requests data (older server)', () => {
    render(<RequestsPanel data={makeData(undefined)} />);
    expect(screen.getByText(/No request telemetry yet/i)).toBeTruthy();
  });

  it('renders stats cards and per provider × model × action rows', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    // Stats: 10 + 4 + 2 = 16 requests.
    expect(screen.getByText('16')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy(); // groups
    // Rows (action chips render as "💬 chat" — match on the substring; the
    // action <select> also lists the action names, so assert multiplicity).
    expect(screen.getByText('groq')).toBeTruthy();
    expect(screen.getByText('gemini')).toBeTruthy();
    expect(screen.getByText('nim')).toBeTruthy();
    expect(screen.getAllByText((c) => c.includes('chat')).length).toBeGreaterThan(0);
    expect(screen.getAllByText((c) => c.includes('execute')).length).toBeGreaterThan(0);
    expect(screen.getAllByText((c) => c.includes('plan')).length).toBeGreaterThan(0);
  });

  it('shows percentile columns only when ≥3 latency samples exist, else —', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    // groq row has 5 samples → p95 = 620ms shown.
    expect(screen.getByText('620ms')).toBeTruthy();
    // gemini row has 2 samples → its p50 is a dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows a violet ⏸ partial chip on rows with mid-stream interruptions (P4 M4.4)', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    // groq row has 3 partials → the ⏸ 3 chip renders with the flaky tooltip.
    expect(screen.getByText(/⏸ 3/)).toBeTruthy();
    expect(screen.getByTitle(/mid-stream interruption\(s\)/)).toBeTruthy();
    expect(screen.getByTitle(/deprioritizes flaky providers/)).toBeTruthy();
  });

  it('filters by action via the select', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'execute' } });
    expect(screen.queryByText('groq')).toBeNull();
    expect(screen.getByText('gemini')).toBeTruthy();
  });

  it('filters by search query across provider/model/action', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    fireEvent.change(screen.getByPlaceholderText('Search provider, model or action...'), { target: { value: 'gemini' } });
    expect(screen.getByText('gemini')).toBeTruthy();
    expect(screen.queryByText('groq')).toBeNull();
  });

  it('renders empty-state text when no rows match the filter', () => {
    render(<RequestsPanel data={makeData(makeRequests())} />);
    fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'chat' } });
    fireEvent.change(screen.getByPlaceholderText('Search provider, model or action...'), { target: { value: 'nim' } });
    expect(screen.getByText(/No request groups match your filter/i)).toBeTruthy();
  });
});
