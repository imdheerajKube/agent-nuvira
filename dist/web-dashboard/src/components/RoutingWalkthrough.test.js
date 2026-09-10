"use strict";
/**
 * Unit tests for the RoutingWalkthroughSection — the narrated "why did the
 * router pick this?" playback rendered by RoutingInsightsPanel.
 *
 * Covers: empty state (no decisions → nothing rendered), the 4-step playback
 * (request → candidates → exclusions → pick), prev/next + play controls, the
 * decision selector, and the builder's real-history vs profile fallback.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const RoutingInsightsPanel_1 = __importDefault(require("./RoutingInsightsPanel"));
const RoutingWalkthrough_1 = require("./RoutingWalkthrough");
// ─── Helpers ────────────────────────────────────────────────────────────────
function makeData(routing) {
    return { routing };
}
const historyEntry = {
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
const baseRouting = {
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
(0, vitest_1.describe)('RoutingWalkthroughSection (via RoutingInsightsPanel)', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('renders nothing when there is no history and no preference', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData({ providers: [], bestModels: [], preference: [], updatedAt: Date.now() })}/>);
        (0, vitest_1.expect)(react_1.screen.queryByText('Why did the router pick this?')).toBeNull();
    });
    (0, vitest_1.it)('plays back a real decision starting with the request step', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(baseRouting)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Why did the router pick this?')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('✓ real decision')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText(/1\. Request/)).toBeTruthy();
        // Task text appears in both the walkthrough step and the panel's audit table
        (0, vitest_1.expect)(react_1.screen.getAllByText('implement JWT auth middleware').length).toBeGreaterThan(0);
        // "🤖 writer" — emoji and label share one text node, so match loosely
        (0, vitest_1.expect)(react_1.screen.getAllByText(/writer/).length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('advances through candidates → exclusions → pick with the Next button', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(baseRouting)}/>);
        // Step 2: candidates
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        (0, vitest_1.expect)(react_1.screen.getByText(/2\. Candidates/)).toBeTruthy();
        // Gemini appears in the candidate row and in the reason list
        (0, vitest_1.expect)(react_1.screen.getAllByText(/gemini/i).length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getAllByText('0.870').length).toBeGreaterThan(0);
        // Step 3: exclusions — local is scored but known providers that aren't
        // candidates are excluded; with only these three scored, show the note.
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        (0, vitest_1.expect)(react_1.screen.getByText(/3\. Exclusions/)).toBeTruthy();
        // Step 4: pick — the winner callout
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        (0, vitest_1.expect)(react_1.screen.getByText(/4\. Pick/)).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('🏆 ROUTER PICK')).toBeTruthy();
        // Winner shows in the walkthrough callout and the panel's best-models table
        (0, vitest_1.expect)(react_1.screen.getAllByText(/gemini\/gemini-2\.0-flash-exp/).length).toBeGreaterThan(0);
        (0, vitest_1.expect)(react_1.screen.getByText(/composite score/)).toBeTruthy();
    });
    (0, vitest_1.it)('wraps around at the end of the step list', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(baseRouting)}/>);
        for (let i = 0; i < 4; i++)
            react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        (0, vitest_1.expect)(react_1.screen.getByText(/1\. Request/)).toBeTruthy();
    });
    (0, vitest_1.it)('auto-plays through steps while playing, then stops on pause', () => {
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(baseRouting)}/>);
        react_1.fireEvent.click(react_1.screen.getByLabelText('Play playback'));
        // First advance happens after one tick — still on step 1 right now
        (0, vitest_1.expect)(react_1.screen.getByText(/1\. Request/)).toBeTruthy();
        (0, react_1.act)(() => { vitest_1.vi.advanceTimersByTime(2400); });
        (0, vitest_1.expect)(react_1.screen.getByText(/2\. Candidates/)).toBeTruthy();
        (0, react_1.act)(() => { vitest_1.vi.advanceTimersByTime(2400); });
        (0, vitest_1.expect)(react_1.screen.getByText(/3\. Exclusions/)).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByLabelText('Pause playback'));
        (0, react_1.act)(() => { vitest_1.vi.advanceTimersByTime(2400); });
        // Still on the same step after pause
        (0, vitest_1.expect)(react_1.screen.getByText(/3\. Exclusions/)).toBeTruthy();
    });
    (0, vitest_1.it)('switches decisions via the selector', () => {
        const second = {
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
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData({ ...baseRouting, history: [second, historyEntry] })}/>);
        // Second entry is first in history (most recent first)
        (0, vitest_1.expect)(react_1.screen.getAllByText('design a distributed architecture').length).toBeGreaterThan(0);
        react_1.fireEvent.change(react_1.screen.getByLabelText('Routing decision to replay'), {
            target: { value: 'route-test-1' },
        });
        (0, vitest_1.expect)(react_1.screen.getAllByText('implement JWT auth middleware').length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('falls back to complexity profiles when no real history exists', () => {
        const noHistory = {
            ...baseRouting,
            history: [],
        };
        (0, react_1.render)(<RoutingInsightsPanel_1.default data={makeData(noHistory)}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('Why did the router pick this?')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.queryByText('✓ real decision')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText(/moderate — what the router would pick/)).toBeTruthy();
        // Pick step shows profile preview marker
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        react_1.fireEvent.click(react_1.screen.getByLabelText('Next step'));
        (0, vitest_1.expect)(react_1.screen.getByText(/profile preview/)).toBeTruthy();
    });
});
// ─── Builder unit tests ─────────────────────────────────────────────────────
(0, vitest_1.describe)('buildWalkthroughDecisions', () => {
    (0, vitest_1.it)('builds a real decision from history with candidates from the matching profile', () => {
        const decisions = (0, RoutingWalkthrough_1.buildWalkthroughDecisions)(baseRouting);
        (0, vitest_1.expect)(decisions).toHaveLength(1);
        (0, vitest_1.expect)(decisions[0].real).toBe(true);
        (0, vitest_1.expect)(decisions[0].winner).toBe('gemini/gemini-2.0-flash-exp');
        (0, vitest_1.expect)(decisions[0].candidates.map((c) => c.provider)).toEqual(['gemini', 'groq', 'local']);
    });
    (0, vitest_1.it)('derives exclusions from providers known to the system but not scored', () => {
        const routing = {
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
        const decisions = (0, RoutingWalkthrough_1.buildWalkthroughDecisions)(routing);
        (0, vitest_1.expect)(decisions[0].exclusions.map((e) => e.provider)).toContain('nim');
        (0, vitest_1.expect)(decisions[0].exclusions.find((e) => e.provider === 'nim')?.reason).toMatch(/quota/);
    });
    (0, vitest_1.it)('appends the real winner to candidates when it is missing from the profile', () => {
        // History pick is openrouter, but the moderate profile only scores
        // gemini/groq/local — the winner must still appear in the scored list.
        const drifted = {
            ...baseRouting,
            history: [{ ...historyEntry, provider: 'openrouter', model: 'openai/gpt-4o' }],
        };
        const decisions = (0, RoutingWalkthrough_1.buildWalkthroughDecisions)(drifted);
        (0, vitest_1.expect)(decisions[0].winner).toBe('openrouter/openai/gpt-4o');
        (0, vitest_1.expect)(decisions[0].candidates.map((c) => c.provider)).toContain('openrouter');
        // The appended winner is not double-listed and uses the recorded score/reason
        (0, vitest_1.expect)(decisions[0].candidates.filter((c) => c.provider === 'openrouter')).toHaveLength(1);
        (0, vitest_1.expect)(decisions[0].winnerReason).toBe('actual pick recorded');
    });
    (0, vitest_1.it)('returns profile decisions when history is empty and caps real decisions', () => {
        const empty = { ...baseRouting, history: [] };
        const profileDecisions = (0, RoutingWalkthrough_1.buildWalkthroughDecisions)(empty);
        (0, vitest_1.expect)(profileDecisions).toHaveLength(1);
        (0, vitest_1.expect)(profileDecisions[0].real).toBe(false);
        // Cap: only the 8 most recent history entries become replayable decisions
        const many = Array.from({ length: 12 }, (_, i) => ({
            ...historyEntry,
            id: `route-${i}`,
            task: `task ${i}`,
            // Distinct timestamps so "most recent first" ordering is deterministic
            timestamp: Date.now() - (11 - i) * 60_000,
        }));
        const capped = (0, RoutingWalkthrough_1.buildWalkthroughDecisions)({ ...baseRouting, history: many });
        (0, vitest_1.expect)(capped).toHaveLength(8);
        (0, vitest_1.expect)(capped[0].task).toBe('task 11'); // most recent first
    });
});
