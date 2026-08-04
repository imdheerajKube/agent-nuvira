/**
 * Unit tests for the RoutingWalkthroughSection — the narrated "why did the
 * router pick this?" playback rendered by RoutingInsightsPanel.
 *
 * Covers: empty state (no decisions → nothing rendered), the 4-step playback
 * (request → candidates → exclusions → pick), prev/next + play controls, the
 * decision selector, and the builder's real-history vs profile fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import RoutingInsightsPanel from './RoutingInsightsPanel';
import { buildWalkthroughDecisions } from './RoutingWalkthrough';
import type { DashboardData, RoutingInsights, RoutingHistoryEntry } from '../types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeData(routing: RoutingInsights): DashboardData {
  return { routing } as unknown as DashboardData;
}

const historyEntry: RoutingHistoryEntry = {
  id: 'route-test-1',
  timestamp: Date.now(),
  source: 'chat',
  agentType: 'writer',
  task: 'implement JWT auth middleware',
  complexity: 'moderate',
  provider: 'gemini',
  model: 'gemini-2.0-flash-exp',
  score: 0.87,
};

const baseRouting: RoutingInsights = {
  providers: [],
  bestModels: [],
  preference: [
    {
      complexity: 'moderate',
      winner: 'gemini/gemini-2.0-flash-exp',
      score: 0.87,
      providers: [
        { provider: 'gemini', score: 0.87, reason: 'gemini: strongest reasoning' },
        { provider: 'groq', score: 0.71, reason: 'groq: fastest' },
        { provider: 'local', score: 0.52, reason: 'local: fully private/local' },
      ],
    },
  ],
  history: [historyEntry],
  updatedAt: Date.now(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RoutingWalkthroughSection (via RoutingInsightsPanel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when there is no history and no preference', () => {
    render(<RoutingInsightsPanel data={makeData({ providers: [], bestModels: [], preference: [], updatedAt: Date.now() })} />);

    expect(screen.queryByText('Why did the router pick this?')).toBeNull();
  });

  it('plays back a real decision starting with the request step', () => {
    render(<RoutingInsightsPanel data={makeData(baseRouting)} />);

    expect(screen.getByText('Why did the router pick this?')).toBeTruthy();
    expect(screen.getByText('✓ real decision')).toBeTruthy();
    expect(screen.getByText(/1\. Request/)).toBeTruthy();
    // Task text appears in both the walkthrough step and the panel's audit table
    expect(screen.getAllByText('implement JWT auth middleware').length).toBeGreaterThan(0);
    // "🤖 writer" — emoji and label share one text node, so match loosely
    expect(screen.getAllByText(/writer/).length).toBeGreaterThan(0);
  });

  it('advances through candidates → exclusions → pick with the Next button', () => {
    render(<RoutingInsightsPanel data={makeData(baseRouting)} />);

    // Step 2: candidates
    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText(/2\. Candidates/)).toBeTruthy();
    // Gemini appears in the candidate row and in the reason list
    expect(screen.getAllByText(/gemini/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.870').length).toBeGreaterThan(0);

    // Step 3: exclusions — local is scored but known providers that aren't
    // candidates are excluded; with only these three scored, show the note.
    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText(/3\. Exclusions/)).toBeTruthy();

    // Step 4: pick — the winner callout
    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText(/4\. Pick/)).toBeTruthy();
    expect(screen.getByText('🏆 ROUTER PICK')).toBeTruthy();
    // Winner shows in the walkthrough callout and the panel's best-models table
    expect(screen.getAllByText(/gemini\/gemini-2\.0-flash-exp/).length).toBeGreaterThan(0);
    expect(screen.getByText(/composite score/)).toBeTruthy();
  });

  it('wraps around at the end of the step list', () => {
    render(<RoutingInsightsPanel data={makeData(baseRouting)} />);

    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText(/1\. Request/)).toBeTruthy();
  });

  it('auto-plays through steps while playing, then stops on pause', () => {
    render(<RoutingInsightsPanel data={makeData(baseRouting)} />);

    fireEvent.click(screen.getByLabelText('Play playback'));
    // First advance happens after one tick — still on step 1 right now
    expect(screen.getByText(/1\. Request/)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(2400); });
    expect(screen.getByText(/2\. Candidates/)).toBeTruthy();

    act(() => { vi.advanceTimersByTime(2400); });
    expect(screen.getByText(/3\. Exclusions/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Pause playback'));
    act(() => { vi.advanceTimersByTime(2400); });
    // Still on the same step after pause
    expect(screen.getByText(/3\. Exclusions/)).toBeTruthy();
  });

  it('switches decisions via the selector', () => {
    const second: RoutingHistoryEntry = {
      ...historyEntry,
      id: 'route-test-2',
      source: 'orchestrator',
      agentType: 'planner',
      task: 'design a distributed architecture',
      complexity: 'complex',
      provider: 'openrouter',
      model: 'openai/gpt-4o',
      score: 0.92,
    };
    render(<RoutingInsightsPanel data={makeData({ ...baseRouting, history: [second, historyEntry] })} />);

    // Second entry is first in history (most recent first)
    expect(screen.getAllByText('design a distributed architecture').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Routing decision to replay'), {
      target: { value: 'route-test-1' },
    });
    expect(screen.getAllByText('implement JWT auth middleware').length).toBeGreaterThan(0);
  });

  it('falls back to complexity profiles when no real history exists', () => {
    const noHistory: RoutingInsights = {
      ...baseRouting,
      history: [],
    };
    render(<RoutingInsightsPanel data={makeData(noHistory)} />);

    expect(screen.getByText('Why did the router pick this?')).toBeTruthy();
    expect(screen.queryByText('✓ real decision')).toBeNull();
    expect(screen.getByText(/moderate — what the router would pick/)).toBeTruthy();
    // Pick step shows profile preview marker
    fireEvent.click(screen.getByLabelText('Next step'));
    fireEvent.click(screen.getByLabelText('Next step'));
    fireEvent.click(screen.getByLabelText('Next step'));
    expect(screen.getByText(/profile preview/)).toBeTruthy();
  });
});

// ─── Builder unit tests ─────────────────────────────────────────────────────

describe('buildWalkthroughDecisions', () => {
  it('builds a real decision from history with candidates from the matching profile', () => {
    const decisions = buildWalkthroughDecisions(baseRouting);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].real).toBe(true);
    expect(decisions[0].winner).toBe('gemini/gemini-2.0-flash-exp');
    expect(decisions[0].candidates.map((c) => c.provider)).toEqual(['gemini', 'groq', 'local']);
  });

  it('derives exclusions from providers known to the system but not scored', () => {
    const routing: RoutingInsights = {
      ...baseRouting,
      // A provider known via usage that is NOT among the scored candidates
      usage: {
        total: 5, last24h: 2,
        byProvider: { gemini: 3, nim: 2 },
        byModel: {}, bySource: {}, byComplexity: {},
        updatedAt: Date.now(),
      },
      quota: {
        enabled: true,
        entries: [{ provider: 'nim', model: 'x', tokensConsumed: 0, requests: 0, windowLengthMs: 0, resetsInMs: 0, parked: true, cooldownRemaining: 0 }],
        updatedAt: Date.now(),
      },
    };
    const decisions = buildWalkthroughDecisions(routing);

    expect(decisions[0].exclusions.map((e) => e.provider)).toContain('nim');
    expect(decisions[0].exclusions.find((e) => e.provider === 'nim')?.reason).toMatch(/quota/);
  });

  it('appends the real winner to candidates when it is missing from the profile', () => {
    // History pick is openrouter, but the moderate profile only scores
    // gemini/groq/local — the winner must still appear in the scored list.
    const drifted: RoutingInsights = {
      ...baseRouting,
      history: [{ ...historyEntry, provider: 'openrouter', model: 'openai/gpt-4o' }],
    };
    const decisions = buildWalkthroughDecisions(drifted);

    expect(decisions[0].winner).toBe('openrouter/openai/gpt-4o');
    expect(decisions[0].candidates.map((c) => c.provider)).toContain('openrouter');
    // The appended winner is not double-listed and uses the recorded score/reason
    expect(decisions[0].candidates.filter((c) => c.provider === 'openrouter')).toHaveLength(1);
    expect(decisions[0].winnerReason).toBe('actual pick recorded');
  });

  it('returns profile decisions when history is empty and caps real decisions', () => {
    const empty: RoutingInsights = { ...baseRouting, history: [] };
    const profileDecisions = buildWalkthroughDecisions(empty);

    expect(profileDecisions).toHaveLength(1);
    expect(profileDecisions[0].real).toBe(false);

    // Cap: only the 8 most recent history entries become replayable decisions
    const many: RoutingHistoryEntry[] = Array.from({ length: 12 }, (_, i) => ({
      ...historyEntry,
      id: `route-${i}`,
      task: `task ${i}`,
      // Distinct timestamps so "most recent first" ordering is deterministic
      timestamp: Date.now() - (11 - i) * 60_000,
    }));
    const capped = buildWalkthroughDecisions({ ...baseRouting, history: many });

    expect(capped).toHaveLength(8);
    expect(capped[0].task).toBe('task 11'); // most recent first
  });
});
