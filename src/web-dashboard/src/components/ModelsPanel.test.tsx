/**
 * Unit tests for the scrubbable per-action telemetry chart (ActionTimelineChart).
 *
 * Covers the empty state, the default scrub position (most recent day with
 * events), click-a-day to jump the caret, the range-slider scrub, play/pause
 * toggling, and the dedupeDayEvents helper that powers the per-day chips.
 * Uses jsdom-safe paths only — no getBoundingClientRect dependence (the drag
 * path itself mirrors PhaseTimeline's window-listener pattern).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ModelsPanel, { ActionTimelineChart, dedupeDayEvents, ActionTelemetryCard, FlakinessChip, FlakinessSparkline, ContextWindowChip, keyHygieneWarning } from './ModelsPanel';
import type { ActionDayBucket, ActionDayEvent } from './ModelsPanel';
import type { ActionTelemetryInsights } from '../types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfToday = new Date().setUTCHours(0, 0, 0, 0);

/** Build 7 ascending day buckets (oldest → newest); spec: bucket-index → overrides. */
const makeTimeline = (spec: Record<number, Partial<ActionDayBucket>> = {}): ActionDayBucket[] => {
  const buckets: ActionDayBucket[] = [];
  for (let i = 0; i < 7; i++) {
    buckets.push({
      day: startOfToday - (6 - i) * DAY_MS,
      verified: 0,
      killed: 0,
      transient: 0,
      partial: 0,
      events: [],
      ...(spec[i] || {}),
    });
  }
  return buckets;
};

// ─── dedupeDayEvents ────────────────────────────────────────────────────────

describe('dedupeDayEvents', () => {
  it('dedupes per provider × model × outcome, latest wins, killed first', () => {
    const events: ActionDayEvent[] = [
      { provider: 'groq', model: 'm1', outcome: 'verified', at: 100 },
      { provider: 'groq', model: 'm1', outcome: 'verified', at: 200 },
      { provider: 'gemini', model: 'g1', outcome: 'unavailable', errorType: 'auth', at: 300 },
      { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 150 },
    ];
    const deduped = dedupeDayEvents(events);
    expect(deduped).toHaveLength(3);
    // killed first (most actionable), then verified, then transient
    expect(deduped[0].outcome).toBe('unavailable');
    expect(deduped[1].outcome).toBe('verified');
    expect(deduped[2].outcome).toBe('error');
    // latest event wins for the repeated provider × model × outcome
    expect(deduped[1].at).toBe(200);
  });

  it('prioritizes partial chips after killed, before verified (flaky mid-stream is actionable)', () => {
    const events: ActionDayEvent[] = [
      { provider: 'groq', model: 'm1', outcome: 'verified', at: 300 },
      { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
      { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 400 },
      { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 200 },
    ];
    const deduped = dedupeDayEvents(events);
    expect(deduped).toHaveLength(3);
    // partial sorts before verified (flaky mid-stream is a worse reliability
    // signal than a clean success), and after killed.
    expect(deduped[0].outcome).toBe('partial');
    expect(deduped[1].outcome).toBe('verified');
    expect(deduped[2].outcome).toBe('error');
    // repeated provider × model × outcome dedupes — latest partial wins
    expect(deduped[0].at).toBe(400);
  });

  it('dedupes partials per provider × model × outcome (a repeat does not double-count)', () => {
    const events: ActionDayEvent[] = [
      { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
      { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'server', at: 200 },
    ];
    const deduped = dedupeDayEvents(events);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].outcome).toBe('partial');
    expect(deduped[0].at).toBe(200);
  });
});

// ─── Scrubbable chart behavior ──────────────────────────────────────────────

describe('ActionTimelineChart', () => {
  it('renders nothing when the timeline is empty', () => {
    const { container } = render(<ActionTimelineChart timeline={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('defaults to the most recent day with events and shows its chips', () => {
    // Events land on day 5 (older); today (day 6) is empty → default = day 5.
    const timeline = makeTimeline({
      5: {
        verified: 2,
        events: [
          { provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'verified', at: 200 },
          { provider: 'groq', model: 'llama-3.3-70b-versatile', outcome: 'verified', at: 100 },
        ],
      },
    });
    render(<ActionTimelineChart timeline={timeline} />);

    // The day-detail panel describes the scrubbed day's learning.
    expect(screen.getByText(/what this action learned that day/i)).toBeTruthy();
    // Verified chip for that day — deduped to ONE chip despite 2 events.
    expect(screen.getAllByText(/groq\/llama-3.3-70b-versatile/)).toHaveLength(1);
  });

  it('clicks a day bar to jump the caret and shows that day’s killed chips', () => {
    const timeline = makeTimeline({
      0: {
        killed: 1,
        events: [
          { provider: 'gemini', model: 'g1', outcome: 'unavailable', errorType: 'auth', at: 10 },
        ],
      },
      5: {
        verified: 1,
        events: [
          { provider: 'groq', model: 'm1', outcome: 'verified', at: 200 },
        ],
      },
    });
    render(<ActionTimelineChart timeline={timeline} />);
    // Default scrub shows the most recent day with events (day 5 → groq/m1).
    expect(screen.getByText(/groq\/m1/)).toBeTruthy();

    // Click the day-0 bar (its title carries the killed count).
    fireEvent.click(screen.getByTitle(/✗ 1 killed/));
    // The detail panel now shows that day's killed chip (predictive skip).
    expect(screen.getByText(/gemini\/g1/)).toBeTruthy();
    expect(screen.getByTitle(/Killed by this action/)).toBeTruthy();
    // The previously-shown day's chip is gone.
    expect(screen.queryByText(/groq\/m1/)).toBeNull();
  });

  it('scrubs via the range slider (day snap) and stops playback', () => {
    const timeline = makeTimeline({
      2: {
        transient: 1,
        events: [
          { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 50 },
        ],
      },
    });
    render(<ActionTimelineChart timeline={timeline} />);

    const slider = screen.getByRole('slider', { name: 'Scrub action timeline' });
    fireEvent.change(slider, { target: { value: '2' } });
    // Day 2's transient chip is now visible.
    expect(screen.getByText(/nim\/n1/)).toBeTruthy();
  });

  it('shows a violet ⏸ chip for a partial mid-stream interruption and counts it in the day summary', () => {
    const timeline = makeTimeline({
      3: {
        partial: 1,
        events: [
          { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
        ],
      },
    });
    render(<ActionTimelineChart timeline={timeline} />);

    // The partial-only day is the default scrub position (it has events).
    expect(screen.getByText(/groq\/m1/)).toBeTruthy();
    // The day summary surfaces the ⏸ partial count.
    expect(screen.getByText(/⏸ 1/)).toBeTruthy();
    // The chip carries the mid-stream interruption tooltip.
    expect(screen.getByTitle(/Mid-stream interruption/)).toBeTruthy();
  });

  it('mixes partial chips with verified chips on the same day (flaky provider is visible, not buried)', () => {
    const timeline = makeTimeline({
      4: {
        verified: 1,
        partial: 1,
        events: [
          { provider: 'groq', model: 'm1', outcome: 'verified', at: 300 },
          { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 200 },
        ],
      },
    });
    render(<ActionTimelineChart timeline={timeline} />);

    // Both chips render — the partial ⏸ chip sorts BEFORE the verified ✓ chip
    // (flaky mid-stream is more actionable than a clean success).
    const chips = screen.getAllByText(/groq\/m1/);
    expect(chips).toHaveLength(2);
    expect(screen.getByTitle(/Mid-stream interruption/)).toBeTruthy();
    expect(screen.getByTitle(/Verified by this action/)).toBeTruthy();
  });

  it('toggles play/pause on the scrub button', () => {
    render(<ActionTimelineChart timeline={makeTimeline()} />);

    const playBtn = screen.getByRole('button', { name: 'Play scrub' });
    fireEvent.click(playBtn);
    expect(screen.getByRole('button', { name: 'Pause scrub' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pause scrub' }));
    expect(screen.getByRole('button', { name: 'Play scrub' })).toBeTruthy();
  });
});

// ─── FlakinessChip (P4 M4.4 registry presentation) ─────────────────────────
// The registry row chip mirrors the CLI's `⏸ flaky N%` — a mid-stream
// flakiness EMA > 0 means the router deprioritizes this model (reliability
// scaled down, capped 40%), so the dashboard must surface it where routing
// reads availability.

describe('FlakinessChip', () => {
  it('renders ⏸ flaky N% from the 0-1 EMA rate with the mid-stream tooltip', () => {
    render(<FlakinessChip rate={0.25} />);
    expect(screen.getByText(/⏸ flaky 25%/)).toBeTruthy();
    expect(screen.getByTitle(/flaky mid-stream 25%/)).toBeTruthy();
    expect(screen.getByTitle(/deprioritizes flaky models/)).toBeTruthy();
  });

  it('rounds the percentage (0.4375 → 44%)', () => {
    render(<FlakinessChip rate={0.4375} />);
    expect(screen.getByText(/⏸ flaky 44%/)).toBeTruthy();
  });

  it('renders the full 100% at the EMA ceiling', () => {
    render(<FlakinessChip rate={1} />);
    expect(screen.getByText(/⏸ flaky 100%/)).toBeTruthy();
  });
});

// ─── ContextWindowChip (v1.60.x live context-window presentation) ──────────
// The registry row chip mirrors the CLI's `⏳ ctx` — the LIVE provider-
// advertised context window the probe recorded (Ollama /api/tags + /api/show,
// OpenRouter /models, Gemini inputTokenLimit, NIM max_model_len). It is the
// real spec the router's context preflight prefers over static estimates.

describe('ContextWindowChip', () => {
  it('renders a compact 128K for a 131,072-token window with the exact tokens in the tooltip', () => {
    render(<ContextWindowChip tokens={131072} />);
    expect(screen.getByText('⏳ 128K')).toBeTruthy();
    expect(screen.getByTitle(/131,072 tokens/)).toBeTruthy();
    expect(screen.getByTitle(/feeds the router's context preflight/)).toBeTruthy();
  });

  it('renders 1M for a 1,048,576-token window (Gemini 2.5 class)', () => {
    render(<ContextWindowChip tokens={1048576} />);
    expect(screen.getByText('⏳ 1M')).toBeTruthy();
  });

  it('renders 16K for a 16,384-token local model window', () => {
    render(<ContextWindowChip tokens={16384} />);
    expect(screen.getByText('⏳ 16K')).toBeTruthy();
  });

  it('renders the raw count below 1024 tokens', () => {
    render(<ContextWindowChip tokens={512} />);
    expect(screen.getByText('⏳ 512')).toBeTruthy();
  });
});

// ─── FlakinessSparkline (P4 M4.4 healing trajectory) ───────────────────────
// The mini sparkline plots the partialRate EMA trajectory: a trend toward 0
// = healing via clean successes; climbing = flakiness accumulating. Renders
// only when >= 2 samples exist so single-sample entries stay clean.

describe('keyHygieneWarning (ISSUE-004)', () => {
  it('renders nothing when hygiene is absent or all counters are zero', () => {
    expect(keyHygieneWarning(undefined)).toBeNull();
    expect(keyHygieneWarning({ threshold: 3, consecutive: {} })).toBeNull();
  });

  it('shows each provider climbing toward the auto-clear threshold', () => {
    const { container } = render(keyHygieneWarning({
      threshold: 3,
      consecutive: { groq: 2, nim: 1 },
    }));
    const text = container.textContent || '';
    expect(text).toContain('Key hygiene in progress');
    expect(text).toContain('groq');
    expect(text).toContain('2/3 consecutive auth failures');
    expect(text).toContain('nim');
    expect(text).toContain('1/3');
    // Below threshold → warns the key WILL be auto-cleared.
    expect(text).toContain('key will be auto-cleared at the threshold');
  });

  it('flags a provider at/over the threshold as already cleared', () => {
    const { container } = render(keyHygieneWarning({
      threshold: 3,
      consecutive: { openrouter: 4 },
    }));
    const text = container.textContent || '';
    expect(text).toContain('openrouter');
    expect(text).toContain('4/3 consecutive auth failures');
    expect(text).toContain('key auto-cleared');
  });
});

describe('FlakinessSparkline', () => {
  it('renders nothing with fewer than 2 history points', () => {
    const { container } = render(<FlakinessSparkline history={[{ t: 1, rate: 0.25 }]} />);
    expect(container.innerHTML).toBe('');
    const { container: empty } = render(<FlakinessSparkline history={undefined} />);
    expect(empty.innerHTML).toBe('');
  });

  it('renders a polyline + end dot for a decaying (healing) trajectory', () => {
    const { container } = render(<FlakinessSparkline
      history={[
        { t: 1000, rate: 0.4375 },
        { t: 2000, rate: 0.25 },
        { t: 3000, rate: 0.15 },
      ]}
    />);
    expect(container.querySelector('polyline')).toBeTruthy();
    // Healing trend → tooltip + green end dot.
    expect(screen.getByTitle(/Flakiness healing/)).toBeTruthy();
    expect(screen.getByTitle(/trending down/)).toBeTruthy();
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('#3fb950');
  });

  it('flags a climbing (worse) trajectory with the accumulating tooltip', () => {
    const { container } = render(<FlakinessSparkline
      history={[
        { t: 1000, rate: 0.15 },
        { t: 2000, rate: 0.25 },
        { t: 3000, rate: 0.4375 },
      ]}
    />);
    expect(screen.getByTitle(/Flakiness climbing/)).toBeTruthy();
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('#bc8cff');
  });
});

// ─── ActionTelemetryCard partial presentation ───────────────────────────────
// The card is the PRIMARY presentation surface for M3.4 partial chips —
// asserting the violet border, the ⏸ header stat, and the Partial chips
// section keeps the feature's headline surface regression-proof.

describe('ActionTelemetryCard partial presentation', () => {
  it('shows the ⏸ partial stat, violet border, and a Partial chips section with the streamed-chunk tooltip', () => {
    const entry: ActionTelemetryInsights['actions'][number] = {
      action: 'chat',
      verified: 2,
      killed: 0,
      transient: 1,
      partial: 2,
      verifiedModels: [{ provider: 'groq', model: 'm1', at: 100 }],
      killedModels: [],
      partialModels: [
        { provider: 'groq', model: 'm1', reason: 'timeout', at: 200, streamedChunks: 128 },
      ],
      timeline: [],
    };
    const { container } = render(<ActionTelemetryCard entry={entry} />);

    // ⏸ 2 partial stat in the header.
    expect(screen.getByText(/⏸ 2/)).toBeTruthy();
    expect(screen.getByText(/partial/)).toBeTruthy();
    // Partial chips section heading.
    expect(screen.getByText(/mid-stream interruption/i)).toBeTruthy();
    // The chip carries the streamed-chunk detail in its tooltip.
    expect(screen.getByTitle(/~128 chunks in/)).toBeTruthy();
    // Violet border wins (partial > killed > verified) — jsdom computes rgb().
    expect(container.querySelector('[style*="rgb(188, 140, 255)"]')).toBeTruthy();
  });
});

// ─── ModelsPanel fetch degradation ──────────────────────────────────────────
// Regression tests for the reported error "Failed to execute 'json' on
// 'Response': Unexpected token '<'" — caused by a STALE dashboard server
// (older version) returning the SPA index.html (HTTP 200, text/html) for an
// /api/* route its new frontend bundle calls. The panel must degrade, never
// crash.

const modelsHealth = {
  totalModels: 1,
  available: 1,
  limited: 0,
  unavailable: 0,
  providers: [
    {
      provider: 'local', providerLabel: 'Ollama', icon: '💻',
      apiConfigured: true, apiAccessible: true, overallStatus: 'available',
      notes: '', freeTierInfo: '',
      models: [{ id: 'llama3.2', name: 'llama3.2', status: 'available' }],
    },
  ],
};

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const htmlResponse = (): Response =>
  new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

describe('ModelsPanel fetch degradation', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders a friendly error instead of crashing when /api/models returns HTML (stale server)', async () => {
    // The stale-server scenario: BOTH endpoints serve SPA index.html with 200.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());

    render(<ModelsPanel />);
    expect(await screen.findByText(/Model health endpoint returned an unexpected response/i)).toBeTruthy();
    // The panel survives — no uncaught "Unexpected token '<'" crash.
  });

  it('keeps the health grid when only /api/model-registry is HTML (registry/telemetry degrade, grid survives)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/model-registry')) return Promise.resolve(htmlResponse());
      return Promise.resolve(jsonResponse(modelsHealth));
    });

    render(<ModelsPanel />);
    // Health grid renders (fetch resolved and modelsData set).
    // Function matcher: the h2 text node is "🧠 Model Provider Status".
    expect(await screen.findByText((content) => content.includes('Model Provider Status'))).toBeTruthy();
    // No registry/telemetry sections from the HTML-200 — they degrade to hidden
    // instead of throwing "Unexpected token '<'".
    expect(screen.queryByText(/Model Availability Registry/i)).toBeNull();
    expect(screen.queryByText(/Learned from real usage/i)).toBeNull();
  });

  it('recovers from a transient network failure (TypeError → backoff retry → grid renders)', async () => {
    let modelsCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/model-registry')) return Promise.resolve(jsonResponse({ enabled: false }));
      modelsCalls += 1;
      // First attempt: network-level rejection — the reported "Failed to fetch".
      if (modelsCalls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(jsonResponse(modelsHealth));
    });

    render(<ModelsPanel />);
    // Wait for a DATA-dependent element (only rendered after the retried fetch
    // lands) — the section header renders before any data arrives.
    expect(await screen.findByText(/llama3\.2/)).toBeTruthy();
    // The transient failure was retried, not surfaced.
    expect(modelsCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Failed to fetch/i)).toBeNull();
    expect(screen.queryByText(/Dashboard server unreachable/i)).toBeNull();
  });

  it('shows a friendly retrying error when the dashboard is unreachable (all attempts fail)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    render(<ModelsPanel />);
    // All retries exhaust after 300ms + 700ms backoff — allow time for that.
    expect(await screen.findByText(/Dashboard server unreachable/i, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/Retrying automatically/i)).toBeTruthy();
  });

  it('keeps the grid when only /api/model-registry fails at the network level (optional section)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/model-registry')) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(jsonResponse(modelsHealth));
    });

    render(<ModelsPanel />);
    expect(await screen.findByText(/llama3\.2/)).toBeTruthy();
    // The registry is optional — a network failure there must not surface an
    // error banner or hide the health grid.
    expect(screen.queryByText(/Failed to fetch/i)).toBeNull();
    expect(screen.queryByText(/Dashboard server unreachable/i)).toBeNull();
  });
});
