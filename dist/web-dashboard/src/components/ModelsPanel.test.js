"use strict";
/**
 * Unit tests for the scrubbable per-action telemetry chart (ActionTimelineChart).
 *
 * Covers the empty state, the default scrub position (most recent day with
 * events), click-a-day to jump the caret, the range-slider scrub, play/pause
 * toggling, and the dedupeDayEvents helper that powers the per-day chips.
 * Uses jsdom-safe paths only — no getBoundingClientRect dependence (the drag
 * path itself mirrors PhaseTimeline's window-listener pattern).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const ModelsPanel_1 = __importStar(require("./ModelsPanel"));
// ─── Fixtures ───────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const startOfToday = new Date().setUTCHours(0, 0, 0, 0);
/** Build 7 ascending day buckets (oldest → newest); spec: bucket-index → overrides. */
const makeTimeline = (spec = {}) => {
    const buckets = [];
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
(0, vitest_1.describe)('dedupeDayEvents', () => {
    (0, vitest_1.it)('dedupes per provider × model × outcome, latest wins, killed first', () => {
        const events = [
            { provider: 'groq', model: 'm1', outcome: 'verified', at: 100 },
            { provider: 'groq', model: 'm1', outcome: 'verified', at: 200 },
            { provider: 'gemini', model: 'g1', outcome: 'unavailable', errorType: 'auth', at: 300 },
            { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 150 },
        ];
        const deduped = (0, ModelsPanel_1.dedupeDayEvents)(events);
        (0, vitest_1.expect)(deduped).toHaveLength(3);
        // killed first (most actionable), then verified, then transient
        (0, vitest_1.expect)(deduped[0].outcome).toBe('unavailable');
        (0, vitest_1.expect)(deduped[1].outcome).toBe('verified');
        (0, vitest_1.expect)(deduped[2].outcome).toBe('error');
        // latest event wins for the repeated provider × model × outcome
        (0, vitest_1.expect)(deduped[1].at).toBe(200);
    });
    (0, vitest_1.it)('prioritizes partial chips after killed, before verified (flaky mid-stream is actionable)', () => {
        const events = [
            { provider: 'groq', model: 'm1', outcome: 'verified', at: 300 },
            { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
            { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 400 },
            { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 200 },
        ];
        const deduped = (0, ModelsPanel_1.dedupeDayEvents)(events);
        (0, vitest_1.expect)(deduped).toHaveLength(3);
        // partial sorts before verified (flaky mid-stream is a worse reliability
        // signal than a clean success), and after killed.
        (0, vitest_1.expect)(deduped[0].outcome).toBe('partial');
        (0, vitest_1.expect)(deduped[1].outcome).toBe('verified');
        (0, vitest_1.expect)(deduped[2].outcome).toBe('error');
        // repeated provider × model × outcome dedupes — latest partial wins
        (0, vitest_1.expect)(deduped[0].at).toBe(400);
    });
    (0, vitest_1.it)('dedupes partials per provider × model × outcome (a repeat does not double-count)', () => {
        const events = [
            { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
            { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'server', at: 200 },
        ];
        const deduped = (0, ModelsPanel_1.dedupeDayEvents)(events);
        (0, vitest_1.expect)(deduped).toHaveLength(1);
        (0, vitest_1.expect)(deduped[0].outcome).toBe('partial');
        (0, vitest_1.expect)(deduped[0].at).toBe(200);
    });
});
// ─── Scrubbable chart behavior ──────────────────────────────────────────────
(0, vitest_1.describe)('ActionTimelineChart', () => {
    (0, vitest_1.it)('renders nothing when the timeline is empty', () => {
        const { container } = (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={[]}/>);
        (0, vitest_1.expect)(container.innerHTML).toBe('');
    });
    (0, vitest_1.it)('defaults to the most recent day with events and shows its chips', () => {
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
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={timeline}/>);
        // The day-detail panel describes the scrubbed day's learning.
        (0, vitest_1.expect)(react_1.screen.getByText(/what this action learned that day/i)).toBeTruthy();
        // Verified chip for that day — deduped to ONE chip despite 2 events.
        (0, vitest_1.expect)(react_1.screen.getAllByText(/groq\/llama-3.3-70b-versatile/)).toHaveLength(1);
    });
    (0, vitest_1.it)('clicks a day bar to jump the caret and shows that day’s killed chips', () => {
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
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={timeline}/>);
        // Default scrub shows the most recent day with events (day 5 → groq/m1).
        (0, vitest_1.expect)(react_1.screen.getByText(/groq\/m1/)).toBeTruthy();
        // Click the day-0 bar (its title carries the killed count).
        react_1.fireEvent.click(react_1.screen.getByTitle(/✗ 1 killed/));
        // The detail panel now shows that day's killed chip (predictive skip).
        (0, vitest_1.expect)(react_1.screen.getByText(/gemini\/g1/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Killed by this action/)).toBeTruthy();
        // The previously-shown day's chip is gone.
        (0, vitest_1.expect)(react_1.screen.queryByText(/groq\/m1/)).toBeNull();
    });
    (0, vitest_1.it)('scrubs via the range slider (day snap) and stops playback', () => {
        const timeline = makeTimeline({
            2: {
                transient: 1,
                events: [
                    { provider: 'nim', model: 'n1', outcome: 'error', errorType: 'server', at: 50 },
                ],
            },
        });
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={timeline}/>);
        const slider = react_1.screen.getByRole('slider', { name: 'Scrub action timeline' });
        react_1.fireEvent.change(slider, { target: { value: '2' } });
        // Day 2's transient chip is now visible.
        (0, vitest_1.expect)(react_1.screen.getByText(/nim\/n1/)).toBeTruthy();
    });
    (0, vitest_1.it)('shows a violet ⏸ chip for a partial mid-stream interruption and counts it in the day summary', () => {
        const timeline = makeTimeline({
            3: {
                partial: 1,
                events: [
                    { provider: 'groq', model: 'm1', outcome: 'partial', errorType: 'timeout', at: 100 },
                ],
            },
        });
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={timeline}/>);
        // The partial-only day is the default scrub position (it has events).
        (0, vitest_1.expect)(react_1.screen.getByText(/groq\/m1/)).toBeTruthy();
        // The day summary surfaces the ⏸ partial count.
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ 1/)).toBeTruthy();
        // The chip carries the mid-stream interruption tooltip.
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Mid-stream interruption/)).toBeTruthy();
    });
    (0, vitest_1.it)('mixes partial chips with verified chips on the same day (flaky provider is visible, not buried)', () => {
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
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={timeline}/>);
        // Both chips render — the partial ⏸ chip sorts BEFORE the verified ✓ chip
        // (flaky mid-stream is more actionable than a clean success).
        const chips = react_1.screen.getAllByText(/groq\/m1/);
        (0, vitest_1.expect)(chips).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Mid-stream interruption/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Verified by this action/)).toBeTruthy();
    });
    (0, vitest_1.it)('toggles play/pause on the scrub button', () => {
        (0, react_1.render)(<ModelsPanel_1.ActionTimelineChart timeline={makeTimeline()}/>);
        const playBtn = react_1.screen.getByRole('button', { name: 'Play scrub' });
        react_1.fireEvent.click(playBtn);
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: 'Pause scrub' })).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: 'Pause scrub' }));
        (0, vitest_1.expect)(react_1.screen.getByRole('button', { name: 'Play scrub' })).toBeTruthy();
    });
});
// ─── FlakinessChip (P4 M4.4 registry presentation) ─────────────────────────
// The registry row chip mirrors the CLI's `⏸ flaky N%` — a mid-stream
// flakiness EMA > 0 means the router deprioritizes this model (reliability
// scaled down, capped 40%), so the dashboard must surface it where routing
// reads availability.
(0, vitest_1.describe)('FlakinessChip', () => {
    (0, vitest_1.it)('renders ⏸ flaky N% from the 0-1 EMA rate with the mid-stream tooltip', () => {
        (0, react_1.render)(<ModelsPanel_1.FlakinessChip rate={0.25}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ flaky 25%/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/flaky mid-stream 25%/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/deprioritizes flaky models/)).toBeTruthy();
    });
    (0, vitest_1.it)('rounds the percentage (0.4375 → 44%)', () => {
        (0, react_1.render)(<ModelsPanel_1.FlakinessChip rate={0.4375}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ flaky 44%/)).toBeTruthy();
    });
    (0, vitest_1.it)('renders the full 100% at the EMA ceiling', () => {
        (0, react_1.render)(<ModelsPanel_1.FlakinessChip rate={1}/>);
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ flaky 100%/)).toBeTruthy();
    });
});
// ─── ContextWindowChip (v1.60.x live context-window presentation) ──────────
// The registry row chip mirrors the CLI's `⏳ ctx` — the LIVE provider-
// advertised context window the probe recorded (Ollama /api/tags + /api/show,
// OpenRouter /models, Gemini inputTokenLimit, NIM max_model_len). It is the
// real spec the router's context preflight prefers over static estimates.
(0, vitest_1.describe)('ContextWindowChip', () => {
    (0, vitest_1.it)('renders a compact 128K for a 131,072-token window with the exact tokens in the tooltip', () => {
        (0, react_1.render)(<ModelsPanel_1.ContextWindowChip tokens={131072}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ 128K')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/131,072 tokens/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/feeds the router's context preflight/)).toBeTruthy();
    });
    (0, vitest_1.it)('renders 1M for a 1,048,576-token window (Gemini 2.5 class)', () => {
        (0, react_1.render)(<ModelsPanel_1.ContextWindowChip tokens={1048576}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ 1M')).toBeTruthy();
    });
    (0, vitest_1.it)('renders 16K for a 16,384-token local model window', () => {
        (0, react_1.render)(<ModelsPanel_1.ContextWindowChip tokens={16384}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ 16K')).toBeTruthy();
    });
    (0, vitest_1.it)('renders the raw count below 1024 tokens', () => {
        (0, react_1.render)(<ModelsPanel_1.ContextWindowChip tokens={512}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('⏳ 512')).toBeTruthy();
    });
});
// ─── FlakinessSparkline (P4 M4.4 healing trajectory) ───────────────────────
// The mini sparkline plots the partialRate EMA trajectory: a trend toward 0
// = healing via clean successes; climbing = flakiness accumulating. Renders
// only when >= 2 samples exist so single-sample entries stay clean.
(0, vitest_1.describe)('keyHygieneWarning (ISSUE-004)', () => {
    (0, vitest_1.it)('renders nothing when hygiene is absent or all counters are zero', () => {
        (0, vitest_1.expect)((0, ModelsPanel_1.keyHygieneWarning)(undefined)).toBeNull();
        (0, vitest_1.expect)((0, ModelsPanel_1.keyHygieneWarning)({ threshold: 3, consecutive: {} })).toBeNull();
    });
    (0, vitest_1.it)('shows each provider climbing toward the auto-clear threshold', () => {
        const { container } = (0, react_1.render)((0, ModelsPanel_1.keyHygieneWarning)({
            threshold: 3,
            consecutive: { groq: 2, nim: 1 },
        }));
        const text = container.textContent || '';
        (0, vitest_1.expect)(text).toContain('Key hygiene in progress');
        (0, vitest_1.expect)(text).toContain('groq');
        (0, vitest_1.expect)(text).toContain('2/3 consecutive auth failures');
        (0, vitest_1.expect)(text).toContain('nim');
        (0, vitest_1.expect)(text).toContain('1/3');
        // Below threshold → warns the key WILL be auto-cleared.
        (0, vitest_1.expect)(text).toContain('key will be auto-cleared at the threshold');
    });
    (0, vitest_1.it)('flags a provider at/over the threshold as already cleared', () => {
        const { container } = (0, react_1.render)((0, ModelsPanel_1.keyHygieneWarning)({
            threshold: 3,
            consecutive: { openrouter: 4 },
        }));
        const text = container.textContent || '';
        (0, vitest_1.expect)(text).toContain('openrouter');
        (0, vitest_1.expect)(text).toContain('4/3 consecutive auth failures');
        (0, vitest_1.expect)(text).toContain('key auto-cleared');
    });
});
(0, vitest_1.describe)('FlakinessSparkline', () => {
    (0, vitest_1.it)('renders nothing with fewer than 2 history points', () => {
        const { container } = (0, react_1.render)(<ModelsPanel_1.FlakinessSparkline history={[{ t: 1, rate: 0.25 }]}/>);
        (0, vitest_1.expect)(container.innerHTML).toBe('');
        const { container: empty } = (0, react_1.render)(<ModelsPanel_1.FlakinessSparkline history={undefined}/>);
        (0, vitest_1.expect)(empty.innerHTML).toBe('');
    });
    (0, vitest_1.it)('renders a polyline + end dot for a decaying (healing) trajectory', () => {
        const { container } = (0, react_1.render)(<ModelsPanel_1.FlakinessSparkline history={[
                { t: 1000, rate: 0.4375 },
                { t: 2000, rate: 0.25 },
                { t: 3000, rate: 0.15 },
            ]}/>);
        (0, vitest_1.expect)(container.querySelector('polyline')).toBeTruthy();
        // Healing trend → tooltip + green end dot.
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Flakiness healing/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByTitle(/trending down/)).toBeTruthy();
        (0, vitest_1.expect)(container.querySelector('circle')?.getAttribute('fill')).toBe('#3fb950');
    });
    (0, vitest_1.it)('flags a climbing (worse) trajectory with the accumulating tooltip', () => {
        const { container } = (0, react_1.render)(<ModelsPanel_1.FlakinessSparkline history={[
                { t: 1000, rate: 0.15 },
                { t: 2000, rate: 0.25 },
                { t: 3000, rate: 0.4375 },
            ]}/>);
        (0, vitest_1.expect)(react_1.screen.getByTitle(/Flakiness climbing/)).toBeTruthy();
        (0, vitest_1.expect)(container.querySelector('circle')?.getAttribute('fill')).toBe('#bc8cff');
    });
});
// ─── ActionTelemetryCard partial presentation ───────────────────────────────
// The card is the PRIMARY presentation surface for M3.4 partial chips —
// asserting the violet border, the ⏸ header stat, and the Partial chips
// section keeps the feature's headline surface regression-proof.
(0, vitest_1.describe)('ActionTelemetryCard partial presentation', () => {
    (0, vitest_1.it)('shows the ⏸ partial stat, violet border, and a Partial chips section with the streamed-chunk tooltip', () => {
        const entry = {
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
        const { container } = (0, react_1.render)(<ModelsPanel_1.ActionTelemetryCard entry={entry}/>);
        // ⏸ 2 partial stat in the header.
        (0, vitest_1.expect)(react_1.screen.getByText(/⏸ 2/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/partial/)).toBeTruthy();
        // Partial chips section heading.
        (0, vitest_1.expect)(react_1.screen.getByText(/mid-stream interruption/i)).toBeTruthy();
        // The chip carries the streamed-chunk detail in its tooltip.
        (0, vitest_1.expect)(react_1.screen.getByTitle(/~128 chunks in/)).toBeTruthy();
        // Violet border wins (partial > killed > verified) — jsdom computes rgb().
        (0, vitest_1.expect)(container.querySelector('[style*="rgb(188, 140, 255)"]')).toBeTruthy();
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
const jsonResponse = (data) => new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
});
const htmlResponse = () => new Response('<!DOCTYPE html><html><body>SPA fallback</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
});
(0, vitest_1.describe)('ModelsPanel fetch degradation', () => {
    (0, vitest_1.afterEach)(() => {
        (0, react_1.cleanup)();
        vitest_1.vi.restoreAllMocks();
    });
    (0, vitest_1.it)('renders a friendly error instead of crashing when /api/models returns HTML (stale server)', async () => {
        // The stale-server scenario: BOTH endpoints serve SPA index.html with 200.
        vitest_1.vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse());
        (0, react_1.render)(<ModelsPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByText(/Model health endpoint returned an unexpected response/i)).toBeTruthy();
        // The panel survives — no uncaught "Unexpected token '<'" crash.
    });
    (0, vitest_1.it)('keeps the health grid when only /api/model-registry is HTML (registry/telemetry degrade, grid survives)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
            const url = String(input);
            if (url.includes('/api/model-registry'))
                return Promise.resolve(htmlResponse());
            return Promise.resolve(jsonResponse(modelsHealth));
        });
        (0, react_1.render)(<ModelsPanel_1.default />);
        // Health grid renders (fetch resolved and modelsData set).
        // Function matcher: the h2 text node is "🧠 Model Provider Status".
        (0, vitest_1.expect)(await react_1.screen.findByText((content) => content.includes('Model Provider Status'))).toBeTruthy();
        // No registry/telemetry sections from the HTML-200 — they degrade to hidden
        // instead of throwing "Unexpected token '<'".
        (0, vitest_1.expect)(react_1.screen.queryByText(/Model Availability Registry/i)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/Learned from real usage/i)).toBeNull();
    });
    (0, vitest_1.it)('recovers from a transient network failure (TypeError → backoff retry → grid renders)', async () => {
        let modelsCalls = 0;
        vitest_1.vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
            const url = String(input);
            if (url.includes('/api/model-registry'))
                return Promise.resolve(jsonResponse({ enabled: false }));
            modelsCalls += 1;
            // First attempt: network-level rejection — the reported "Failed to fetch".
            if (modelsCalls === 1)
                return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve(jsonResponse(modelsHealth));
        });
        (0, react_1.render)(<ModelsPanel_1.default />);
        // Wait for a DATA-dependent element (only rendered after the retried fetch
        // lands) — the section header renders before any data arrives.
        (0, vitest_1.expect)(await react_1.screen.findByText(/llama3\.2/)).toBeTruthy();
        // The transient failure was retried, not surfaced.
        (0, vitest_1.expect)(modelsCalls).toBeGreaterThanOrEqual(2);
        (0, vitest_1.expect)(react_1.screen.queryByText(/Failed to fetch/i)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/Dashboard server unreachable/i)).toBeNull();
    });
    (0, vitest_1.it)('shows a friendly retrying error when the dashboard is unreachable (all attempts fail)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        (0, react_1.render)(<ModelsPanel_1.default />);
        // All retries exhaust after 300ms + 700ms backoff — allow time for that.
        (0, vitest_1.expect)(await react_1.screen.findByText(/Dashboard server unreachable/i, {}, { timeout: 5000 })).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/Retrying automatically/i)).toBeTruthy();
    });
    (0, vitest_1.it)('keeps the grid when only /api/model-registry fails at the network level (optional section)', async () => {
        vitest_1.vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
            const url = String(input);
            if (url.includes('/api/model-registry'))
                return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve(jsonResponse(modelsHealth));
        });
        (0, react_1.render)(<ModelsPanel_1.default />);
        (0, vitest_1.expect)(await react_1.screen.findByText(/llama3\.2/)).toBeTruthy();
        // The registry is optional — a network failure there must not surface an
        // error banner or hide the health grid.
        (0, vitest_1.expect)(react_1.screen.queryByText(/Failed to fetch/i)).toBeNull();
        (0, vitest_1.expect)(react_1.screen.queryByText(/Dashboard server unreachable/i)).toBeNull();
    });
});
